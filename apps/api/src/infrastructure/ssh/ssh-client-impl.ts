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

    await new Promise<void>((resolve, reject) => {
      connection.once('ready', resolve);
      connection.once('error', (error) => reject(this.safeError(error)));
      connection.connect(config);
    });

    try {
      // Huawei VRP is a stateful CLI. A single shell channel ensures the
      // screen-length command applies to the display command that follows.
      return [await this.executeShell(connection, commands)];
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
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          stream.close();
          reject(new Error('SSH command timeout'));
        }, (this.options.readyTimeout ?? 8_000) + 7_000);
        stream.setEncoding('utf8');
        stream.on('data', (data: string | Buffer) => { stdout += data.toString(); });
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
        stream.end(`${commands.join('\n')}\nquit\n`);
      });
    });
  }

  private safeError(error: Error & { code?: string }): Error {
    const code = error.code?.toLowerCase() ?? '';
    const message = error.message.toLowerCase();
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
