import {
  PersistentHuaweiSession,
  type PersistentHuaweiSessionOptions,
} from './persistent-huawei-session';
import {
  WorkerHealthTracker,
  type MitigationWorkerHealth,
  type MitigationWorkerHealthSnapshot,
  type MitigationWorkerState,
} from './worker-health';

/**
 * Worker de mitigação — esqueleto da Fase 3.
 *
 * Nesta fase ele é READ-ONLY e SIMULATION_ONLY: mantém a sessão SSH persistente
 * viva, expõe health em memória e permite executar leituras. O loop real de
 * mitigação (amostragem, máquina de estados, publicação de notificação) entra
 * numa fase seguinte, sem mudar esta base.
 */

export interface MitigationSessionStateDetail {
  safeError: string | null;
}

export interface MitigationSessionHandlers {
  onStateChange: (state: MitigationWorkerState, detail: MitigationSessionStateDetail) => void;
}

/** Porta mínima da sessão, para o worker não depender de detalhe de transporte. */
export interface MitigationSessionPort {
  connect(): Promise<void>;
  executeReadOnly(command: string): Promise<string>;
  isAlive(): boolean;
  close(): Promise<void>;
}

export interface MitigationWorkerOptions {
  createSession: (handlers: MitigationSessionHandlers) => MitigationSessionPort;
  health?: WorkerHealthTracker;
  logger?: (message: string) => void;
}

export class MitigationWorker {
  private readonly health: WorkerHealthTracker;
  private readonly session: MitigationSessionPort;
  private started = false;

  constructor(private readonly options: MitigationWorkerOptions) {
    this.health = options.health ?? new WorkerHealthTracker();
    this.session = options.createSession({
      onStateChange: (state, detail) => this.onSessionStateChange(state, detail),
    });
  }

  getSession(): MitigationSessionPort {
    return this.session;
  }

  getHealth(): MitigationWorkerHealth {
    return this.health.get();
  }

  getHealthSnapshot(): MitigationWorkerHealthSnapshot {
    return this.health.snapshot();
  }

  isRunning(): boolean {
    return this.started && this.session.isAlive();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.options.logger?.('worker de mitigação iniciando (SIMULATION_ONLY, READ-ONLY)');
    await this.session.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.session.close();
    this.health.markDisconnected();
    this.options.logger?.('sessão SSH de mitigação encerrada');
  }

  /** Comando de leitura avulso (registra `lastCommandAt`). */
  async executeReadOnly(command: string): Promise<string> {
    const output = await this.session.executeReadOnly(command);
    this.health.markCommand();
    return output;
  }

  /** Leitura de amostragem (registra `lastSampleAt`) — base do futuro loop. */
  async sampleReadOnly(command: string): Promise<string> {
    const output = await this.session.executeReadOnly(command);
    this.health.markSample();
    return output;
  }

  private onSessionStateChange(
    state: MitigationWorkerState,
    detail: MitigationSessionStateDetail,
  ): void {
    switch (state) {
      case 'CONNECTING':
        this.health.markConnecting();
        break;
      case 'READY':
        this.health.markReady();
        break;
      case 'RECONNECTING':
        this.health.markReconnecting(detail.safeError);
        break;
      case 'FAILED':
        this.health.markFailed(detail.safeError);
        break;
      case 'DISCONNECTED':
        this.health.markDisconnected();
        break;
    }
  }
}

export interface MitigationWorkerEnvLike {
  MITIGATION_MODE?: string;
  MITIGATION_SSH_HOST?: string;
  MITIGATION_SSH_PORT?: string;
  MITIGATION_SSH_USERNAME?: string;
  MITIGATION_SSH_PASSWORD?: string;
  MITIGATION_SSH_READY_TIMEOUT_MS?: string;
  MITIGATION_SSH_COMMAND_TIMEOUT_MS?: string;
}

function requiredEnv(env: MitigationWorkerEnvLike, key: keyof MitigationWorkerEnvLike): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`variável de ambiente obrigatória ausente: ${key}`);
  return value;
}

function optionalNumber(env: MitigationWorkerEnvLike, key: keyof MitigationWorkerEnvLike): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Monta o worker a partir do ambiente. Recusa explicitamente sair de
 * SIMULATION_ONLY — nesta fase não existe caminho de escrita.
 */
export function createMitigationWorkerFromEnv(
  env: MitigationWorkerEnvLike = process.env,
): MitigationWorker {
  // `MITIGATION_MODE` é lido por `mitigationConfigFromEnv` (default fail-closed
  // SIMULATION_ONLY). `AUTO` é aceito: o motor AUTO roda no processo da API, no
  // mesmo caminho canônico do ACTIVATE (MitigationCommandService). Este processo
  // segue apenas mantendo a sessão SSH de LEITURA (guard READ-ONLY intacto).

  const sessionOptions: Omit<PersistentHuaweiSessionOptions, 'onStateChange'> = {
    host: requiredEnv(env, 'MITIGATION_SSH_HOST'),
    username: requiredEnv(env, 'MITIGATION_SSH_USERNAME'),
    password: requiredEnv(env, 'MITIGATION_SSH_PASSWORD'),
  };
  const port = optionalNumber(env, 'MITIGATION_SSH_PORT');
  if (port !== null) sessionOptions.port = port;
  const readyTimeoutMs = optionalNumber(env, 'MITIGATION_SSH_READY_TIMEOUT_MS');
  if (readyTimeoutMs !== null) sessionOptions.readyTimeoutMs = readyTimeoutMs;
  const commandTimeoutMs = optionalNumber(env, 'MITIGATION_SSH_COMMAND_TIMEOUT_MS');
  if (commandTimeoutMs !== null) sessionOptions.commandTimeoutMs = commandTimeoutMs;

  return new MitigationWorker({
    createSession: (handlers) =>
      new PersistentHuaweiSession({ ...sessionOptions, onStateChange: handlers.onStateChange }),
  });
}
