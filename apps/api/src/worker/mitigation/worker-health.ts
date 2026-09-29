/**
 * Estado/health em memória do worker de mitigação (Fase 3, READ-ONLY).
 *
 * Nada aqui é persistido: é o retrato instantâneo do processo para observação e
 * para o futuro loop de mitigação. `safeError` nunca carrega mensagem crua de
 * transporte nem credencial.
 */

export type MitigationWorkerState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'READY'
  | 'RECONNECTING'
  | 'FAILED';

export interface MitigationWorkerHealth {
  state: MitigationWorkerState;
  connectedAt: Date | null;
  lastCommandAt: Date | null;
  lastSampleAt: Date | null;
  lastReconnectAt: Date | null;
  reconnectCount: number;
  safeError: string | null;
}

/** Snapshot serializável (datas em ISO) para log/API futura. */
export interface MitigationWorkerHealthSnapshot {
  state: MitigationWorkerState;
  connectedAt: string | null;
  lastCommandAt: string | null;
  lastSampleAt: string | null;
  lastReconnectAt: string | null;
  reconnectCount: number;
  safeError: string | null;
}

export interface HealthClock {
  now(): Date;
}

const systemClock: HealthClock = { now: () => new Date() };

export class WorkerHealthTracker {
  private state: MitigationWorkerState = 'DISCONNECTED';
  private connectedAt: Date | null = null;
  private lastCommandAt: Date | null = null;
  private lastSampleAt: Date | null = null;
  private lastReconnectAt: Date | null = null;
  private reconnectCount = 0;
  private safeError: string | null = null;

  constructor(private readonly clock: HealthClock = systemClock) {}

  getState(): MitigationWorkerState {
    return this.state;
  }

  get(): MitigationWorkerHealth {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      lastCommandAt: this.lastCommandAt,
      lastSampleAt: this.lastSampleAt,
      lastReconnectAt: this.lastReconnectAt,
      reconnectCount: this.reconnectCount,
      safeError: this.safeError,
    };
  }

  snapshot(): MitigationWorkerHealthSnapshot {
    const health = this.get();
    return {
      state: health.state,
      connectedAt: health.connectedAt?.toISOString() ?? null,
      lastCommandAt: health.lastCommandAt?.toISOString() ?? null,
      lastSampleAt: health.lastSampleAt?.toISOString() ?? null,
      lastReconnectAt: health.lastReconnectAt?.toISOString() ?? null,
      reconnectCount: health.reconnectCount,
      safeError: health.safeError,
    };
  }

  markConnecting(): void {
    this.state = 'CONNECTING';
    this.safeError = null;
  }

  markReady(): void {
    this.state = 'READY';
    this.connectedAt = this.clock.now();
    this.safeError = null;
  }

  markReconnecting(safeError: string | null): void {
    this.state = 'RECONNECTING';
    this.lastReconnectAt = this.clock.now();
    this.reconnectCount += 1;
    this.safeError = safeError;
  }

  markFailed(safeError: string | null): void {
    this.state = 'FAILED';
    this.safeError = safeError;
  }

  markDisconnected(): void {
    this.state = 'DISCONNECTED';
    this.connectedAt = null;
  }

  markCommand(): void {
    this.lastCommandAt = this.clock.now();
  }

  markSample(): void {
    this.lastSampleAt = this.clock.now();
    this.lastCommandAt = this.lastSampleAt;
  }
}

/**
 * Normaliza qualquer erro de transporte em uma mensagem curta e segura. Nunca
 * devolve output SSH, comando executado ou credencial.
 */
export function toSafeError(error: unknown): string {
  const code = String((error as { code?: unknown } | null | undefined)?.code ?? '').toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const haystack = `${code} ${message}`;

  if (haystack.includes('auth')) return 'SSH authentication failed';
  if (haystack.includes('timeout')) return 'SSH connection timeout';
  if (haystack.includes('refused')) return 'SSH host refused connection';
  if (haystack.includes('unreachable')) return 'SSH host is unreachable';
  if (haystack.includes('shell')) return 'SSH shell unavailable';
  if (haystack.includes('read_only_violation')) return 'read-only policy violation';
  if (haystack.includes('closed')) return 'SSH session closed';
  return 'SSH transport failed';
}
