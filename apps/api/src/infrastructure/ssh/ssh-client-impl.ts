import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { CommandResult, SshClient } from '../../domain/ports';
import { isDiagnosticSshContext, withSshContext } from './ssh-context';
import {
  TEMPORARY_DIAGNOSTIC_PAGING,
  confirmedDiagnosticPreparation,
} from './diagnostic-session-preparation';

const diagnosticLoginNotice = 'Info: Lastest accessed IP: -  Time: -  Password will expire in: -';

export interface SshExecutionMetrics {
  connectionMs: number | null;
  commandMs: number | null;
  totalMs: number;
  ok: boolean;
  timeout: boolean;
  retries: 0;
}
interface SshClientOptions {
  metrics?: (metrics: SshExecutionMetrics) => void;
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
  /** Opt-in on-demand diagnostics; legacy/configuration callers are unchanged. */
  diagnostic?: {
    fingerprint: string;
    initialPrompt: string;
    expectedPrompt: string;
    allowedCommands: readonly string[];
    outputBytes: number;
    signal: AbortSignal;
    onCommand: (command: string) => void;
    /** Bounded, password-redacted partial stdout for private homologation evidence. */
    onOutput?: (stdout: string) => void;
    /** Private evidence callback after an approved prompt; failure prevents the next command. */
    onCommandComplete?: (result: { command: string; stdout: string; completedAt: string }) => void;
    /** Private conditional AC read, after a completed VSI only; exact allowlist still applies. */
    interfaceAfterVsi?: (result: {
      command: string;
      stdout: string;
      completedAt: string;
    }) => string | null;
    sessionPreparation?: 'screen-length 0 temporary';
  };
}

export class SshClientImpl implements SshClient {
  constructor(private readonly options: SshClientOptions) {}

  async execute(host: string, commands: string[]): Promise<CommandResult[]> {
    const start = Date.now();
    let connectionMs: number | null = null,
      commandStarted: number | null = null,
      ok = false,
      timeout = false;
    const diagnostic = this.options.diagnostic;
    if (
      diagnostic &&
      (this.options.exitMode === 'return-quit' ||
        (this.options.contextCommand != null &&
          !isDiagnosticSshContext(this.options.contextCommand)) ||
        !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(diagnostic.fingerprint) ||
        ![diagnostic.initialPrompt, diagnostic.expectedPrompt].every((p) =>
          /^<[A-Za-z0-9_.:-]{1,120}>$/.test(p),
        ) ||
        commands.some(
          (c) =>
            !diagnostic.allowedCommands.includes(c) ||
            !/^(?:display |ping -a |tracert -a )/.test(c) ||
            /[\r\n;|&]/.test(c),
        ))
    )
      throw new Error('SSH_DIAGNOSTIC_POLICY_BLOCKED');
    diagnostic?.signal.throwIfAborted();
    if (
      diagnostic?.sessionPreparation !== undefined &&
      diagnostic.sessionPreparation !== 'screen-length 0 temporary'
    )
      throw new Error('SSH_DIAGNOSTIC_POLICY_BLOCKED');
    const preparedCommands = withSshContext(
      diagnostic?.sessionPreparation ? [diagnostic.sessionPreparation, ...commands] : commands,
      this.options.contextCommand,
    );
    let diagnosticKeyRejected = false;
    const connection = new Client();
    const config: ConnectConfig = {
      host,
      port: this.options.port,
      username: this.options.username,
      password: this.options.password,
      readyTimeout: this.options.readyTimeout ?? 8_000,
      keepaliveInterval: 2_000,
      keepaliveCountMax: 2,
      ...(diagnostic
        ? {
            tryKeyboard: false,
            hostVerifier: (key: Buffer) => {
              const actual = Buffer.from(
                'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
              );
              const expected = Buffer.from(diagnostic.fingerprint.replace(/=+$/, ''));
              const matches =
                actual.length === expected.length && timingSafeEqual(actual, expected);
              diagnosticKeyRejected = !matches;
              return matches;
            },
          }
        : {}),
    };

    let rejectConnectionFailure: (error: Error) => void = () => undefined;
    const connectionFailure = new Promise<never>((_resolve, reject) => {
      rejectConnectionFailure = reject;
    });

    connection.on('error', (error) => {
      rejectConnectionFailure(
        diagnosticKeyRejected
          ? new Error('SSH_DIAGNOSTIC_HOST_KEY_MISMATCH')
          : this.safeError(error),
      );
    });
    const abort = () => {
      rejectConnectionFailure(
        new Error(
          diagnostic?.signal.reason === 'COMMAND_TIMEOUT'
            ? 'SSH_DIAGNOSTIC_TIMEOUT'
            : diagnostic?.signal.reason === 'PROFILE_EXPIRED'
              ? 'PROFILE_EXPIRED'
              : 'SSH_DIAGNOSTIC_CANCELLED',
        ),
      );
      connection.destroy();
    };
    diagnostic?.signal.addEventListener('abort', abort, { once: true });
    connection.once('close', () => rejectConnectionFailure(new Error('SSH transport closed')));

    const ready = new Promise<void>((resolve) => {
      connection.once('ready', resolve);
      connection.connect(config);
    });

    try {
      await Promise.race([ready, connectionFailure]);
      connectionMs = Date.now() - start;
      commandStarted = Date.now();
      const result = await Promise.race([
        this.executeShell(connection, preparedCommands),
        connectionFailure,
      ]);
      ok = true;
      return [result];
    } catch (error) {
      timeout = error instanceof Error && /timeout/i.test(error.message);
      throw error;
    } finally {
      diagnostic?.signal.removeEventListener('abort', abort);
      if (diagnostic) connection.destroy();
      else connection.end();
      try {
        this.options.metrics?.({
          connectionMs,
          commandMs: commandStarted === null ? null : Date.now() - commandStarted,
          totalMs: Date.now() - start,
          ok,
          timeout,
          retries: 0,
        });
      } catch {
        /* Observability must not affect a completed SSH operation. */
      }
    }
  }

  private executeShell(connection: Client, commands: string[]): Promise<CommandResult> {
    const contextIndex = this.options.contextCommand
      ? commands.indexOf(this.options.contextCommand.trim())
      : -1;
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
        let conditionalInterfaceAdded = false;
        /** Offset em stdout onde o comando atual comecou (echo + saida). */
        let commandStartOffset = 0;

        const timeout = setTimeout(
          () => {
            if (settled) return;
            if (this.options.diagnostic) {
              failDiagnostic('SSH_DIAGNOSTIC_TIMEOUT');
              return;
            }
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            stream.close();
            reject(new Error('SSH command timeout'));
          },
          this.options.shellTimeoutMs ?? (this.options.readyTimeout ?? 8_000) + 7_000,
        );

        const initialPasswordPrompt =
          /(initial password poses security risks|password needs to be changed|change now\?\s*\[y\/n\]\s*:)/i;
        const cliPrompt = /(?:^|[\r\n])\s*(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;
        const quitSequence =
          this.options.exitMode === 'return-quit'
            ? 'return\r\nquit\r\n'
            : this.options.contextCommand
              ? 'quit\r\nquit\r\n'
              : 'quit\r\n';
        const idleMs = this.options.commandIdleMs ?? 2_500;
        const diagnostic = this.options.diagnostic;
        const captureOutput = (): void => {
          diagnostic?.onOutput?.(
            stripVTControlCharacters(stdout).split(this.options.password).join('[REMOVIDO]'),
          );
        };
        const failDiagnostic = (message: string): void => {
          if (settled) return;
          try {
            captureOutput();
          } catch {
            message = 'SSH_DIAGNOSTIC_AUDIT_FAILED';
          }
          settled = true;
          clearTimeout(timeout);
          clearIdle();
          stream.close();
          reject(new Error(message));
        };

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
          idleTimer = setTimeout(
            () => (diagnostic ? failDiagnostic('SSH_DIAGNOSTIC_INCOMPLETE') : advance()),
            idleMs,
          );
        };

        // EXITING/DONE: so depois do ULTIMO comando terminar.
        const sendQuit = (): void => {
          if (exiting || settled) return;
          exiting = true;
          clearIdle();
          if (diagnostic) {
            try {
              captureOutput();
            } catch {
              failDiagnostic('SSH_DIAGNOSTIC_AUDIT_FAILED');
              return;
            }
            settled = true;
            clearTimeout(timeout);
            // The final approved prompt is completion evidence. Do not race it with
            // a remote transport disconnect caused by closing the shell channel.
            resolve({ stdout, stderr, exitCode: 0 });
            stream.close();
            return;
          }
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
          if (diagnostic) {
            try {
              diagnostic.onCommand(command);
            } catch {
              failDiagnostic('SSH_DIAGNOSTIC_AUDIT_FAILED');
              return;
            }
          }
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
          if (!commandFinished()) {
            armIdle();
            return;
          }
          if (diagnostic) {
            const command = commands[commandIndex - 1]!;
            const output = stripVTControlCharacters(stdout.slice(commandStartOffset));
            if (
              command === TEMPORARY_DIAGNOSTIC_PAGING &&
              !confirmedDiagnosticPreparation(output, diagnostic.initialPrompt)
            ) {
              failDiagnostic('SSH_DIAGNOSTIC_PREPARATION_UNCONFIRMED');
              return;
            }
            try {
              diagnostic.onCommandComplete?.({
                command,
                stdout: output.split(this.options.password).join('[REMOVIDO]'),
                completedAt: new Date().toISOString(),
              });
            } catch {
              failDiagnostic('SSH_DIAGNOSTIC_AUDIT_FAILED');
              return;
            }
            if (diagnostic.interfaceAfterVsi) {
              try {
                const next = diagnostic.interfaceAfterVsi({
                  command,
                  stdout: output.split(this.options.password).join('[REMOVIDO]'),
                  completedAt: new Date().toISOString(),
                });
                if (next !== null) {
                  if (
                    conditionalInterfaceAdded ||
                    commandIndex !== commands.length ||
                    !/^display vsi name [A-Za-z0-9_.:-]{1,64} verbose$/.test(command) ||
                    !/^display interface [A-Za-z][A-Za-z0-9/.-]{1,63}$/.test(next) ||
                    !diagnostic.allowedCommands.includes(next) ||
                    commands.includes(next)
                  )
                    throw new Error('CONDITIONAL_COMMAND_BLOCKED');
                  commands.push(next);
                  conditionalInterfaceAdded = true;
                }
              } catch {
                failDiagnostic('SSH_DIAGNOSTIC_POLICY_BLOCKED');
                return;
              }
            }
          }
          advance();
        };

        const handleStdout = (chunk: string): void => {
          if (settled) return;
          if (diagnostic && Buffer.byteLength(stdout + stderr + chunk) > diagnostic.outputBytes) {
            failDiagnostic('SSH_DIAGNOSTIC_OUTPUT_LIMIT');
            return;
          }
          stdout += chunk;
          if (diagnostic) {
            const slice = stripVTControlCharacters(stdout.slice(commandStartOffset));
            // Exact, noninteractive notice observed on BHE-VTA, only before the first command.
            // Unknown password text and any interactive suffix remain blocked.
            const passwordText =
              commandIndex === 0
                ? slice
                    .split(/\r?\n/)
                    .map((line, index, lines) => {
                      const pending = line.replace(/\r$/, '');
                      return line === diagnosticLoginNotice ||
                        (index === lines.length - 1 && diagnosticLoginNotice.startsWith(pending))
                        ? ''
                        : line;
                    })
                    .join('\n')
                : slice;
            // Empty diagnostic sessions cannot write anything, including context/preparation.
            // Let a passive banner observation distinguish notices from credential prompts.
            const passwordInteraction =
              commands.length === 0
                ? initialPasswordPrompt.test(slice) ||
                  /(?:^|[\r\n])[^\r\n]*password[^\r\n]*[:?]\s*$/i.test(slice)
                : /password/i.test(passwordText);
            if (
              passwordInteraction ||
              /----\s*More\s*----|--More--|\[Y\/N\]|\(y\/n\)|^\s*(?:Error:|%\s*Error)/im.test(slice)
            ) {
              failDiagnostic('SSH_DIAGNOSTIC_INTERACTION_OR_ERROR');
              return;
            }
            const last = slice.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? '';
            if (/^(?:<[^>]+>|\[[^\]]+\])$/.test(last)) {
              const expected =
                commandIndex === 0 || (contextIndex >= 0 && commandIndex <= contextIndex)
                  ? diagnostic.initialPrompt
                  : diagnostic.expectedPrompt;
              if (last !== expected) {
                failDiagnostic('SSH_DIAGNOSTIC_CONTEXT_MISMATCH');
                return;
              }
            }
          }

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
        stream.stderr.on('data', (data: string | Buffer) => {
          if (diagnostic) {
            failDiagnostic('SSH_DIAGNOSTIC_STDERR');
            return;
          }
          stderr += data.toString();
        });

        stream.once('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearIdle();
          if (diagnostic) {
            try {
              captureOutput();
            } catch {
              reject(new Error('SSH_DIAGNOSTIC_AUDIT_FAILED'));
              return;
            }
          }
          if (diagnostic && !exiting) {
            reject(new Error('SSH_DIAGNOSTIC_INCOMPLETE'));
            return;
          }
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
    if (code.includes('timeout') || message.includes('timeout'))
      return new Error('SSH connection timeout');
    if (
      code.includes('refused') ||
      message.includes('refused') ||
      message.includes('unreachable')
    ) {
      return new Error('SSH host is unreachable');
    }
    return new Error('SSH transport failed');
  }
}
