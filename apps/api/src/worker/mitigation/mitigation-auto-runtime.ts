import type { MitigationAutoDecision, MitigationAutoEngine } from './mitigation-auto-engine';

/**
 * Runtime do motor AUTO dentro do processo da API.
 *
 * Características (requisitos da janela AUTO):
 *  - inicia SOMENTE quando a configuração é válida (o chamador decide);
 *  - intervalo configurável;
 *  - SEM sobreposição de ticks (guard `ticking`);
 *  - shutdown limpo (`stop()` limpa o timer);
 *  - uma única instância por processo (o processo cria um runtime e `start()`
 *    é idempotente);
 *  - erro em um ciclo/profile não derruba o loop (o motor isola por target e o
 *    runtime registra `lastError`).
 */

export type MitigationAutoEngineState = 'OFF' | 'RUNNING' | 'STOPPED';

export interface MitigationAutoRuntimeStatus {
  state: MitigationAutoEngineState;
  evaluationIntervalMs: number;
  startedAt: string | null;
  lastTickAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastError: string | null;
  tickCount: number;
  skippedTicks: number;
  lastDecision: MitigationAutoDecision | null;
  /** Decisao mais recente POR profile (dry run / auditoria). */
  decisions: MitigationAutoDecision[];
  lastAutoActivateAt: string | null;
  lastAutoActivateProfileId: string | null;
}

export interface MitigationAutoRuntimeOptions {
  engine: Pick<MitigationAutoEngine, 'tick'>;
  intervalMs: number;
  now?: () => Date;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  /** Injetáveis para teste (evita depender de timers reais). */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class MitigationAutoRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private state: MitigationAutoEngineState = 'OFF';
  private startedAt: string | null = null;
  private lastTickAt: string | null = null;
  private lastSuccessfulTickAt: string | null = null;
  private lastError: string | null = null;
  private tickCount = 0;
  private skippedTicks = 0;
  private lastDecision: MitigationAutoDecision | null = null;
  private readonly decisionsByProfile = new Map<string, MitigationAutoDecision>();
  private lastAutoActivateAt: string | null = null;
  private lastAutoActivateProfileId: string | null = null;
  private readonly now: () => Date;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;

  constructor(private readonly options: MitigationAutoRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.setIntervalImpl = options.setInterval ?? setInterval;
    this.clearIntervalImpl = options.clearInterval ?? clearInterval;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getStatus(): MitigationAutoRuntimeStatus {
    return {
      state: this.state,
      evaluationIntervalMs: this.options.intervalMs,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastSuccessfulTickAt: this.lastSuccessfulTickAt,
      lastError: this.lastError,
      tickCount: this.tickCount,
      skippedTicks: this.skippedTicks,
      lastDecision: this.lastDecision,
      decisions: [...this.decisionsByProfile.values()],
      lastAutoActivateAt: this.lastAutoActivateAt,
      lastAutoActivateProfileId: this.lastAutoActivateProfileId,
    };
  }

  /** Idempotente: chamar duas vezes não cria um segundo timer. */
  start(): void {
    if (this.timer) return;
    this.state = 'RUNNING';
    this.startedAt = this.now().toISOString();
    this.timer = this.setIntervalImpl(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    const handle = this.timer as unknown as { unref?: () => void };
    handle.unref?.();
    this.options.logger?.('motor AUTO iniciado', { intervalMs: this.options.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
      this.options.logger?.('motor AUTO parado');
    }
    this.state = 'STOPPED';
  }

  /** Um ciclo. Nunca sobrepõe: se já existe tick em andamento, retorna vazio. */
  async tickOnce(): Promise<MitigationAutoDecision[]> {
    if (this.ticking) {
      this.skippedTicks += 1;
      return [];
    }
    this.ticking = true;
    try {
      const decisions = await this.options.engine.tick();
      const at = this.now().toISOString();
      this.tickCount += 1;
      this.lastTickAt = at;
      this.lastSuccessfulTickAt = at;
      this.lastError = null;
      if (decisions.length > 0) {
        this.lastDecision = decisions.reduce((latest, item) =>
          item.at > latest.at ? item : latest,
        );
        for (const item of decisions) this.decisionsByProfile.set(item.profileId, item);
      }
      const activated = decisions.find((decision) => decision.outcome === 'ACTIVATED');
      if (activated) {
        this.lastAutoActivateAt = at;
        this.lastAutoActivateProfileId = activated.profileId;
      }
      return decisions;
    } catch (error) {
      this.lastTickAt = this.now().toISOString();
      this.lastError = error instanceof Error ? error.message : 'falha no ciclo do motor';
      this.options.logger?.('motor AUTO: falha no ciclo', { safeError: this.lastError });
      return [];
    } finally {
      this.ticking = false;
    }
  }
}