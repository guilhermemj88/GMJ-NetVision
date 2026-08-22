import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import type { CommandResult, SshClient } from '../../domain/ports';

interface SshClientOptions {
  port: number;
  username: string;
  password: string;
  readyTimeout?: number;
}

export class SshClientImpl implements SshClient {
  constructor(private readonly options: SshClientOptions) {}

  async execute(host: string, commands: string[]): Promise<CommandResult[]> {
    const connection = new Client();
    const config: ConnectConfig = {
      host,
      port: this.options.port,
      username: this.options.username,
      password: this.options.password,
      readyTimeout: this.options.readyTimeout ?? 8_000,
      keepaliveInterval: 2_000,
      keepaliveCountMax: 2,
    };

    let rejectConnectionFailure: (error: Error) => void = () => undefined;
    const connectionFailure = new Promise<never>((_resolve, reject) => {
      rejectConnectionFailure = reject;
    });

    connection.on('error', (error) => {
      rejectConnectionFailure(this.safeError(error));
    });

    const ready = new Promise<void>((resolve) => {
      connection.once('ready', resolve);
      connection.connect(config);
    });

    try {
      await Promise.race([ready, connectionFailure]);
      const result = await Promise.race([
        this.executeShell(connection, commands),
        connectionFailure,
      ]);
      return [result];
    } finally {
      connection.end();
    }
  }

  private executeShell(connection: Client, commands: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      connection.shell({ term: 'vt100', rows: 200, cols: 240 }, (error, stream: ClientChannel) => {
        if (error) {
          reject(this.safeError(error));
          return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let declinedInitialPasswordChange = false;
        let commandsSent = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          stream.close();
          reject(new Error('SSH command timeout'));
        }, (this.options.readyTimeout ?? 8_000) + 7_000);

        const initialPasswordPrompt = /(initial password poses security risks|password needs to be changed|change now\?\s*\[y\/n\]\s*:)/i;
        const cliPrompt = /(?:^|[\r\n])\s*(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;

        const handleStdout = (chunk: string): void => {
          stdout += chunk;

          if (!declinedInitialPasswordChange && initialPasswordPrompt.test(stdout)) {
            declinedInitialPasswordChange = true;
            stream.write('N\r\n');
            return;
          }

          if (!commandsSent && cliPrompt.test(stdout)) {
            commandsSent = true;
            stream.end(`${commands.join('\r\n')}\r\nquit\r\n`);
          }
        };

        stream.setEncoding('utf8');
        stream.on('data', (data: string | Buffer) => handleStdout(data.toString()));
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (data: string | Buffer) => { stderr += data.toString(); });

        stream.once('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: 0 });
        });

        stream.once('error', (streamError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(this.safeError(streamError));
        });
      });
    });
  }

  private safeError(error: Error & { code?: unknown }): Error {
    const code = String(error.code ?? '').toLowerCase();
    const message = String(error.message ?? '').toLowerCase();
    if (code.includes('auth') || message.includes('authentication')) {
      return new Error('SSH authentication failed');
    }
    if (code.includes('timeout') || message.includes('timeout')) return new Error('SSH connection timeout');
    if (code.includes('refused') || message.includes('refused') || message.includes('unreachable')) {
      return new Error('SSH host is unreachable');
    }
    return new Error('SSH transport failed');
  }
}
