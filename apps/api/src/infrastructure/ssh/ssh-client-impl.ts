import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import type { CommandResult, SshClient } from '../../domain/ports';
import { withSshContext } from './ssh-context';

interface SshClientOptions {
  port: number;
  username: string;
  password: string;
  readyTimeout?: number;
  /** Optional host context command executed before the real commands. */
  contextCommand?: string | null;
  /**
   * Finalizacao da sessao depois dos comandos (nunca faz parte da lista
   * canonica de configuracao):
   *
   *  - 'quit' (default): sessao que termina em USER VIEW (todo READ-ONLY) — o
   *    proprio `quit` encerra a sessao.
   *
   *  - 'return-quit': sessao de ESCRITA, que termina em SYSTEM-VIEW depois do
   *    `commit`: `return` volta para a user view e `quit` encerra. Sem isso o
   *    canal fica aberto, o cliente espera o timeout e uma escrita JA aplicada
   *    e reportada como falha.
   */
  exitMode?: 'quit' | 'return-quit';
  /** Timeout do shell depois da conexao (escrita com commit pode demorar). */
  shellTimeoutMs?: number;
  /**
   * Ocioso (ms) sem dados depois do comando para considerar a saida terminada
   * quando o PROMPT nao volta a aparecer. O `quit` so e enviado depois disso.
   */
  commandIdleMs?: number;
}

export class SshClientImpl implements SshClient {
  constructor(private readonly options: SshClientOptions) {}

  async execute(host: string, commands: string[]): Promise<CommandResult[]> {
    const preparedCommands = withSshContext(commands, this.options.contextCommand);
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
        this.executeShell(connection, preparedCommands),
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
        let exiting = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        /** Indice do PROXIMO comando a enviar; 0 = nada enviado ainda. */
        let commandIndex = 0;
        /** Offset em stdout onde o comando atual comecou (echo + saida). */
        let commandStartOffset = 0;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          stream.close();
          reject(new Error('SSH command timeout'));
        }, this.options.shellTimeoutMs ?? (this.options.readyTimeout ?? 8_000) + 7_000);

        const initialPasswordPrompt = /(initial password poses security risks|password needs to be changed|change now\?\s*\[y\/n\]\s*:)/i;
        const cliPrompt = /(?:^|[\r\n])\s*(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;
        const quitSequence =
          this.options.exitMode === 'return-quit'
            ? 'return\r\nquit\r\n'
            : this.options.contextCommand
              ? 'quit\r\nquit\r\n'
              : 'quit\r\n';
        const idleMs = this.options.commandIdleMs ?? 2_500;

        const clearIdle = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };

        // O VRP ABORTA a saida que ainda esta sendo impressa quando recebe o
        // PROXIMO comando. Por isso a lista e enviada UMA POR VEZ: cada comando
        // so vai depois que o prompt do comando anterior volta.
        const armIdle = (): void => {
          clearIdle();
          idleTimer = setTimeout(advance, idleMs);
        };

        // EXITING/DONE: so depois do ULTIMO comando terminar.
        const sendQuit = (): void => {
          if (exiting || settled) return;
          exiting = true;
          clearIdle();
          stream.end(quitSequence);
        };

        /**
         * Proximo passo: ainda ha comando -> envia SOMENTE ele e espera o
         * prompt; acabaram -> envia o quitSequence.
         */
        const advance = (): void => {
          if (settled || exiting) return;
          clearIdle();
          if (commandIndex >= commands.length) {
            sendQuit();
            return;
          }
          const command = commands[commandIndex] ?? '';
          commandStartOffset = stdout.length;
          stream.write(`${command}\r\n`);
          commandIndex += 1;
          armIdle();
        };

        /**
         * O comando ATUAL terminou? Aceita apenas um prompt que apareca depois
         * do echo do proprio comando (nunca um prompt antigo) e somente com o
         * stdout recebido depois do envio dele.
         */
        const commandFinished = (): boolean => {
          if (commandIndex === 0 || exiting) return false;
          const current = commands[commandIndex - 1] ?? '';
          const slice = stdout.slice(commandStartOffset);
          if (current.length > 0 && !slice.includes(current)) return false;
          return cliPrompt.test(slice);
        };

        const onCommandOutput = (): void => {
          if (settled || exiting) return;
          if (commandFinished()) advance();
          else armIdle();
        };

        const handleStdout = (chunk: string): void => {
          stdout += chunk;

          if (!declinedInitialPasswordChange && initialPasswordPrompt.test(stdout)) {
            declinedInitialPasswordChange = true;
            stream.write('N\r\n');
            return;
          }

          // WAIT_INITIAL_PROMPT: nada foi enviado ainda.
          if (commandIndex === 0) {
            if (!exiting && cliPrompt.test(stdout)) advance();
            return;
          }

          onCommandOutput();
        };

        stream.setEncoding('utf8');
        stream.on('data', (data: string | Buffer) => handleStdout(data.toString()));
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (data: string | Buffer) => { stderr += data.toString(); });

        stream.once('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearIdle();
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
