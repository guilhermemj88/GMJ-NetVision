import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { assertReadOnlyCommand } from './read-only-command-guard';
import { toSafeError, type MitigationWorkerState } from './worker-health';

/**
 * Sessão SSH persistente com um Huawei VRP, exclusivamente READ-ONLY.
 *
 * Diferenças deliberadas em relação ao `SshClientImpl` (que NÃO é alterado):
 * aqui a conexão fica aberta indefinidamente enquanto saudável, mantém um shell
 * interativo único, serializa comandos e reconecta com backoff progressivo.
 * Nenhum comando de escrita passa: a allowlist é checada antes de tocar o SSH.
 */

/** Backoff de reconexão: 1s, 2s, 5s, 10s, 30s e depois 30s indefinidamente. */
export const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Desliga o paging para que os displays voltem de uma vez. */
export const DEFAULT_INITIAL_COMMAND = 'screen-length 0 temporary';

/** Prompt VRP: `<HOSTNAME>` (view) ou `[HOSTNAME]` (system-view). */
const PROMPT_PATTERN = /(?:^|[\r\n])\s*(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;

const MAX_BUFFER_LENGTH = 1_000_000;

export interface PersistentHuaweiSessionOptions {
  host: string;
  username: string;
  password: string;
  port?: number;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  initialCommand?: string;
  reconnectDelaysMs?: readonly number[];
  /** Injeção para teste; em produção usa o `Client` real do ssh2. */
  connectionFactory?: () => Client;
  onStateChange?: (state: MitigationWorkerState, detail: { safeError: string | null }) => void;
  logger?: (message: string) => void;
}

interface ResolvedSessionOptions {
  host: string;
  username: string;
  password: string;
  port: number;
  readyTimeoutMs: number;
  commandTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  initialCommand: string;
  reconnectDelaysMs: readonly number[];
}

interface ActiveCommand {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectionSettlement {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Backoff progressivo e não agressivo. `attempt` 0 → 1s; cresce até o teto de
 * 30s e permanece lá (sem reconexão em rajada).
 */
export function nextReconnectDelayMs(
  attempt: number,
  delays: readonly number[] = DEFAULT_RECONNECT_DELAYS_MS,
): number {
  const last = delays[delays.length - 1] ?? 0;
  if (attempt <= 0) return delays[0] ?? last;
  return delays[Math.min(attempt, delays.length - 1)] ?? last;
}

export class PersistentHuaweiSession {
  private readonly options: ResolvedSessionOptions;
  private client: Client | null = null;
  private stream: ClientChannel | null = null;
  private state: MitigationWorkerState = 'DISCONNECTED';
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private activeCommand: ActiveCommand | null = null;
  private stdout = '';
  private connectSettlement: ConnectionSettlement | null = null;
  private connectPromise: Promise<void> | null = null;
  private initialPromptWaiter: (() => void) | null = null;

  constructor(options: PersistentHuaweiSessionOptions) {
    this.options = {
      host: options.host,
      username: options.username,
      password: options.password,
      port: options.port ?? 22,
      readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 20_000,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 5_000,
      keepaliveCountMax: options.keepaliveCountMax ?? 3,
      initialCommand: options.initialCommand ?? DEFAULT_INITIAL_COMMAND,
      reconnectDelaysMs: options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS,
    };
    this.connectionFactory = options.connectionFactory ?? (() => new Client());
    this.onStateChange = options.onStateChange;
    this.logger = options.logger;
  }

  private readonly connectionFactory: () => Client;
  private readonly onStateChange:
    | ((state: MitigationWorkerState, detail: { safeError: string | null }) => void)
    | undefined;
  private readonly logger: ((message: string) => void) | undefined;

  getState(): MitigationWorkerState {
    return this.state;
  }

  isAlive(): boolean {
    return this.state === 'READY' && this.stream !== null && this.client !== null;
  }

  /** Abre a sessão. Idempotente: enquanto READY não cria um segundo login. */
  async connect(): Promise<void> {
    if (this.state === 'READY' && this.stream) return;
    if (this.connectPromise) return this.connectPromise;
    const pending = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    this.connectPromise = pending;
    return pending;
  }

  /**
   * Executa um comando de leitura. O comando é validado contra a allowlist
   * ANTES de qualquer interação com o SSH; comandos proibidos são rejeitados
   * localmente. Comandos são serializados: nunca há dois em voo no mesmo shell.
   */
  async executeReadOnly(command: string): Promise<string> {
    const normalized = assertReadOnlyCommand(command);
    return this.enqueue(async () => {
      await this.ensureReady();
      return this.runCommand(normalized);
    });
  }

  /** Reconexão explícita, reutilizando o mesmo backoff do caminho automático. */
  async reconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.intentionalClose = false;
    this.rejectActiveCommand(new Error('SSH session closed'));
    this.teardownConnection();
    this.setState('RECONNECTING');
    await this.connect();
  }

  /** Encerramento gracioso: não agenda reconexão. */
  async close(): Promise<void> {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.rejectActiveCommand(new Error('SSH session closed'));
    this.teardownConnection();
    this.setState('DISCONNECTED');
  }

  private async doConnect(): Promise<void> {
    this.intentionalClose = false;
    this.setState('CONNECTING');

    const connection = this.connectionFactory();
    this.client = connection;
    this.stdout = '';
    this.attachConnectionHandlers(connection);

    try {
      await new Promise<void>((resolve, reject) => {
        this.connectSettlement = { resolve, reject };
        connection.connect(this.connectConfig());
      });
      await this.openShell(connection);
      await this.handshake();
    } catch (error) {
      this.connectSettlement = null;
      this.teardownConnection();
      this.setState('FAILED', toSafeError(error));
      this.scheduleReconnect(error);
      throw error instanceof Error ? error : new Error(toSafeError(error));
    }

    this.connectSettlement = null;
    this.reconnectAttempt = 0;
    this.setState('READY');
  }

  private connectConfig(): ConnectConfig {
    return {
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      password: this.options.password,
      readyTimeout: this.options.readyTimeoutMs,
      keepaliveInterval: this.options.keepaliveIntervalMs,
      keepaliveCountMax: this.options.keepaliveCountMax,
    };
  }

  private attachConnectionHandlers(connection: Client): void {
    connection.on('ready', () => {
      if (this.client !== connection) return;
      this.connectSettlement?.resolve();
    });
    connection.on('error', (error: Error) => {
      if (this.client !== connection) return;
      if (this.connectSettlement) {
        this.connectSettlement.reject(error);
        return;
      }
      this.handleUnexpectedDisconnect(error);
    });
    connection.on('close', () => {
      if (this.client !== connection) return;
      this.handleTransportLost(new Error('SSH session closed'));
    });
    connection.on('end', () => {
      if (this.client !== connection) return;
      this.handleTransportLost(new Error('SSH session closed'));
    });
    connection.on('timeout', () => {
      if (this.client !== connection) return;
      this.handleTransportLost(new Error('SSH connection timeout'));
    });
  }

  private handleTransportLost(error: Error): void {
    if (this.connectSettlement) {
      this.connectSettlement.reject(error);
      return;
    }
    this.handleUnexpectedDisconnect(error);
  }

  private handleUnexpectedDisconnect(error: Error): void {
    if (this.intentionalClose) return;
    this.stream = null;
    this.client = null;
    this.rejectActiveCommand(error);
    this.setState('FAILED', toSafeError(error));
    this.scheduleReconnect(error);
  }

  private openShell(connection: Client): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      connection.shell({ term: 'vt100', rows: 200, cols: 240 }, (error, stream) => {
        if (error || !stream) {
          reject(new Error('SSH shell unavailable'));
          return;
        }
        this.stream = stream;
        this.attachStreamHandlers(stream);
        resolve();
      });
    });
  }

  private attachStreamHandlers(stream: ClientChannel): void {
    stream.setEncoding('utf8');
    stream.stderr.setEncoding('utf8');
    stream.stderr.on('data', () => undefined);
    stream.on('data', (chunk: string) => this.handleStdout(chunk));
    stream.on('close', () => this.handleStreamClosed());
    stream.on('end', () => this.handleStreamClosed());
    stream.on('error', (error: Error) => this.handleStreamClosed(error));
  }

  private handleStreamClosed(error?: Error): void {
    if (this.intentionalClose) return;
    if (this.connectSettlement) {
      this.connectSettlement.reject(error ?? new Error('SSH session closed'));
      return;
    }
    this.handleUnexpectedDisconnect(error ?? new Error('SSH session closed'));
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    if (this.stdout.length > MAX_BUFFER_LENGTH) {
      this.stdout = this.stdout.slice(-MAX_BUFFER_LENGTH);
    }

    this.initialPromptWaiter?.();

    const active = this.activeCommand;
    if (!active) return;
    if (!PROMPT_PATTERN.test(this.stdout)) return;

    this.activeCommand = null;
    clearTimeout(active.timer);
    active.resolve(this.stdout);
  }

  private async handshake(): Promise<void> {
    await this.waitForInitialPrompt();
    await this.runCommand(this.options.initialCommand);
  }

  private waitForInitialPrompt(): Promise<void> {
    if (PROMPT_PATTERN.test(this.stdout)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initialPromptWaiter = null;
        reject(new Error('SSH prompt timeout'));
      }, this.options.readyTimeoutMs);
      this.initialPromptWaiter = () => {
        if (!PROMPT_PATTERN.test(this.stdout)) return;
        this.initialPromptWaiter = null;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.isAlive()) return;
    await this.connect();
  }

  private runCommand(command: string): Promise<string> {
    const stream = this.stream;
    if (!stream) return Promise.reject(new Error('SSH shell unavailable'));

    this.stdout = '';
    const output = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.activeCommand?.timer !== timer) return;
        this.activeCommand = null;
        reject(new Error('SSH command timeout'));
        this.handleCommandTimeout();
      }, this.options.commandTimeoutMs);
      this.activeCommand = { resolve, reject, timer };
    });

    stream.write(`${command}\r\n`);
    return output;
  }

  private handleCommandTimeout(): void {
    this.logger?.('comando excedeu o timeout; reciclando sessão');
    this.stream = null;
    this.client = null;
    this.setState('FAILED', 'SSH command timeout');
    this.scheduleReconnect(new Error('SSH command timeout'));
  }

  private scheduleReconnect(_error: unknown): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;
    const delay = nextReconnectDelayMs(this.reconnectAttempt, this.options.reconnectDelaysMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect().catch(() => undefined);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownConnection(): void {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        stream.end();
      } catch {
        /* conexão já morta */
      }
    }
    const connection = this.client;
    this.client = null;
    if (connection) {
      try {
        connection.end();
      } catch {
        /* conexão já morta */
      }
    }
    this.stdout = '';
  }

  private rejectActiveCommand(reason: unknown): void {
    const active = this.activeCommand;
    if (!active) return;
    this.activeCommand = null;
    clearTimeout(active.timer);
    active.reject(new Error(toSafeError(reason)));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private setState(state: MitigationWorkerState, safeError: string | null = null): void {
    this.state = state;
    this.onStateChange?.(state, { safeError });
  }
}
