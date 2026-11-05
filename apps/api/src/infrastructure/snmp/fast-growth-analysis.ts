/**
 * Analise de CRESCIMENTO do trafego para enriquecer alertas n8n.
 *
 * Exclusivamente INFORMATIVA: nada aqui participa de gate, lifecycle, lease,
 * confirmacao, decisao BGP ou estado ENFORCE. O motor AUTO nao importa este
 * modulo; ele apenas alimenta o payload de notificacao.
 *
 * Sem SNMP, sem SSH, sem PostgreSQL: o buffer vive em memoria e e alimentado
 * pelas MESMAS observacoes que o FastTrafficPoller ja produziu.
 */

export const GROWTH_WINDOW_MS = 5 * 60_000;
export const GROWTH_WINDOW_SAMPLES = 60;
export const GROWTH_RECENT_MS = 30_000;
/** Tolerancia para achar a amostra de ~30 s atras. */
export const GROWTH_RECENT_TOLERANCE_MS = 10_000;

export type GrowthClassification = 'BRUSCO' | 'MODERADO' | 'GRADUAL_OU_ESTAVEL' | 'INDETERMINADO';

export interface GrowthThresholds {
  /** Pontos percentuais em 30 s para classificar como BRUSCO. */
  sudden: number;
  /** Pontos percentuais em 30 s para classificar como MODERADO. */
  moderate: number;
}

/** Valores iniciais configuraveis — nao sao regra de deteccao de ataque. */
export const DEFAULT_GROWTH_THRESHOLDS: GrowthThresholds = Object.freeze({
  sudden: 30,
  moderate: 10,
});

export interface GrowthSample {
  atMs: number;
  utilizationPct: number | null;
}

export interface GrowthAnalysis {
  baselineAverage5mPct: number | null;
  currentUtilizationPct: number | null;
  deltaPercentagePoints: number | null;
  delta30sPercentagePoints: number | null;
  growthClassification: GrowthClassification;
  /** Quantas amostras validas entraram em cada janela. */
  samples5m: number;
  samples30s: number;
  frozen: boolean;
}

export function emptyAnalysis(): GrowthAnalysis {
  return {
    baselineAverage5mPct: null,
    currentUtilizationPct: null,
    deltaPercentagePoints: null,
    delta30sPercentagePoints: null,
    growthClassification: 'INDETERMINADO',
    samples5m: 0,
    samples30s: 0,
    frozen: false,
  };
}

export function classifyGrowth(
  delta30s: number | null,
  thresholds: GrowthThresholds = DEFAULT_GROWTH_THRESHOLDS,
): GrowthClassification {
  if (delta30s === null || !Number.isFinite(delta30s)) return 'INDETERMINADO';
  if (delta30s >= thresholds.sudden) return 'BRUSCO';
  if (delta30s >= thresholds.moderate) return 'MODERADO';
  return 'GRADUAL_OU_ESTAVEL';
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Buffer circular por interface. Alimentado uma vez por amostra do poller.
 * `analyze` nunca lanca e nunca bloqueia: historico insuficiente vira
 * INDETERMINADO com os campos nulos.
 */
export class FastGrowthTracker {
  private readonly samples = new Map<string, GrowthSample[]>();
  private readonly frozen = new Map<string, GrowthAnalysis>();

  record(interfaceId: string, atMs: number, utilizationPct: number | null): void {
    if (!Number.isFinite(atMs)) return;
    const buffer = this.samples.get(interfaceId) ?? [];
    if (buffer.length && atMs <= buffer.at(-1)!.atMs) return;
    const valid = utilizationPct !== null && Number.isFinite(utilizationPct) && utilizationPct >= 0;
    buffer.push({ atMs, utilizationPct: valid ? utilizationPct : null });
    while (buffer.length && buffer[0]!.atMs < atMs - GROWTH_WINDOW_MS) buffer.shift();
    // Circular: mantem no maximo 60 amostras (5 min a 5 s).
    while (buffer.length > GROWTH_WINDOW_SAMPLES) buffer.shift();
    this.samples.set(interfaceId, buffer);
  }

  /** Analise corrente; nao congela. */
  analyze(
    interfaceId: string,
    thresholds: GrowthThresholds = DEFAULT_GROWTH_THRESHOLDS,
    nowMs?: number,
  ): GrowthAnalysis {
    const buffer = this.samples.get(interfaceId) ?? [];
    const current = buffer.at(-1);
    const now = nowMs ?? current?.atMs ?? 0;
    const recent = buffer.filter((s) => s.atMs >= now - GROWTH_WINDOW_MS);
    const valid = recent.filter((s) => s.utilizationPct !== null && Number.isFinite(s.utilizationPct));
    if (valid.length < 2 || current?.utilizationPct === null || current === undefined)
      return {
        ...emptyAnalysis(),
        currentUtilizationPct: current?.utilizationPct == null ? null : round1(current.utilizationPct),
        samples5m: valid.length,
      };

    const currentPct = current.utilizationPct as number;
    // Baseline exclui a amostra atual: a referencia e o ANTES do disparo.
    const previous = valid.filter((s) => s.atMs < current.atMs || s !== current);
    const baselineSamples = previous.filter((s) => s.atMs >= now - GROWTH_WINDOW_MS);
    if (baselineSamples.length === 0) return { ...emptyAnalysis(), samples5m: valid.length };
    const baseline =
      baselineSamples.reduce((sum, s) => sum + (s.utilizationPct as number), 0) /
      baselineSamples.length;

    const reference = buffer
      .filter(
        (s) =>
          s.utilizationPct !== null &&
          s.atMs <= now - GROWTH_RECENT_MS &&
          s.atMs >= now - GROWTH_RECENT_MS - GROWTH_RECENT_TOLERANCE_MS,
      )
      .at(-1);
    const recentSamples = reference ? 2 : 1;
    const delta30s =
      reference && reference.utilizationPct !== null
        ? round1(currentPct - reference.utilizationPct)
        : null;

    return {
      baselineAverage5mPct: round1(baseline),
      currentUtilizationPct: round1(currentPct),
      deltaPercentagePoints: round1(currentPct - baseline),
      delta30sPercentagePoints: delta30s,
      growthClassification: classifyGrowth(delta30s, thresholds),
      samples5m: baselineSamples.length,
      samples30s: recentSamples,
      frozen: false,
    };
  }

  /**
   * Congela a referencia no PRIMEIRO disparo. Chamadas seguintes devolvem o
   * mesmo snapshot: amostras posteriores nao contaminam o alerta.
   */
  freezeAtThreshold(
    interfaceId: string,
    thresholds: GrowthThresholds = DEFAULT_GROWTH_THRESHOLDS,
    nowMs?: number,
    observedCrossing = true,
  ): GrowthAnalysis {
    const existing = this.frozen.get(interfaceId);
    if (existing) return existing;
    const current = this.analyze(interfaceId, thresholds, nowMs);
    const analysis = Object.freeze({
      ...(observedCrossing ? current : { ...emptyAnalysis(),
        currentUtilizationPct: current.currentUtilizationPct, samples5m: current.samples5m }),
      frozen: true,
    });
    this.frozen.set(interfaceId, analysis);
    return analysis;
  }

  /** Libera o congelamento quando o cliente volta ao normal. */
  clearFreeze(interfaceId: string): void {
    this.frozen.delete(interfaceId);
  }

  /** Missing telemetry breaks history continuity, never proves recovery. */
  clearSamples(interfaceId: string): void {
    this.samples.delete(interfaceId);
  }

  frozenAnalysis(interfaceId: string): GrowthAnalysis | null {
    return this.frozen.get(interfaceId) ?? null;
  }

  size(interfaceId: string): number {
    return this.samples.get(interfaceId)?.length ?? 0;
  }

  reset(interfaceId?: string): void {
    if (interfaceId === undefined) {
      this.samples.clear();
      this.frozen.clear();
      return;
    }
    this.samples.delete(interfaceId);
    this.frozen.delete(interfaceId);
  }
}
