import type { PrismaClient } from '../../generated/prisma/index.js';

/**
 * Retenção das OBSERVAÇÕES FAST.
 *
 * Escopo ESTRUTURAL: o único alvo é a tabela `MitigationTrafficObservation` do
 * banco de observação. Auditoria (`BgpMitigationEvent`), histórico de runtime
 * (`BgpMitigationRuntime`) e revisões de direção (`MitigationDirectionAudit`)
 * vivem no banco OPERACIONAL, que este processo acessa em transação read-only —
 * portanto não existe caminho de código capaz de apagá-los aqui.
 *
 * A limpeza é sempre em LOTES ordenados por `collectedAt`, com limite por
 * execução: nunca um DELETE indiscriminado, nunca sem corte temporal explícito.
 */
export const FAST_RETENTION_LIMITS = {
  minDays: 1,
  maxDays: 90,
  minBatch: 100,
  maxBatch: 50_000,
  maxBatches: 200,
  minIntervalMs: 60_000,
  maxIntervalMs: 24 * 60 * 60 * 1000,
} as const;

export interface FastRetentionConfig {
  /** Dias de observação mantidos (mínimo 1, máximo 90). */
  retentionDays: number;
  /** Linhas por DELETE. */
  batchSize: number;
  /** Teto de lotes por execução (proteção contra uma execução sem fim). */
  maxBatches: number;
  /** Intervalo entre execuções da limpeza. */
  intervalMs: number;
}

function integer(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

export function fastRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): FastRetentionConfig {
  const limits = FAST_RETENTION_LIMITS;
  return {
    retentionDays: integer(env, 'MITIGATION_FAST_RETENTION_DAYS', 7, limits.minDays, limits.maxDays),
    batchSize: integer(env, 'MITIGATION_FAST_RETENTION_BATCH', 10_000, limits.minBatch, limits.maxBatch),
    maxBatches: integer(env, 'MITIGATION_FAST_RETENTION_MAX_BATCHES', 12, 1, limits.maxBatches),
    intervalMs: integer(
      env,
      'MITIGATION_FAST_RETENTION_INTERVAL_MS',
      3_600_000,
      limits.minIntervalMs,
      limits.maxIntervalMs,
    ),
  };
}

/** Corte temporal da retenção. Nunca aceita valor não inteiro ou fora da faixa. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  const limits = FAST_RETENTION_LIMITS;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < limits.minDays ||
    retentionDays > limits.maxDays
  )
    throw new Error('INVALID_RETENTION_DAYS');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('INVALID_RETENTION_CLOCK');
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

/** Porta mínima: a retenção só sabe apagar observações anteriores ao corte. */
export interface FastObservationPurgePort {
  deleteObservationsBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface FastObservationPurgeResult {
  cutoff: Date;
  deleted: number;
  batches: number;
  /** `true` quando o teto de lotes foi atingido e ainda havia linhas elegíveis. */
  backlogRemaining: boolean;
}

export async function purgeFastObservations(
  port: FastObservationPurgePort,
  options: FastRetentionConfig & { now?: () => Date },
): Promise<FastObservationPurgeResult> {
  const cutoff = retentionCutoff(options.now?.() ?? new Date(), options.retentionDays);
  let deleted = 0;
  let batches = 0;
  for (; batches < options.maxBatches; ) {
    const removed = await port.deleteObservationsBefore(cutoff, options.batchSize);
    batches += 1;
    deleted += removed;
    if (removed < options.batchSize) {
      return { cutoff, deleted, batches, backlogRemaining: false };
    }
  }
  return { cutoff, deleted, batches, backlogRemaining: true };
}

/** Adaptador Prisma do banco de OBSERVAÇÃO (nunca o operacional). */
export class PrismaFastObservationPurge implements FastObservationPurgePort {
  constructor(private readonly db: PrismaClient) {}

  async deleteObservationsBefore(cutoff: Date, limit: number): Promise<number> {
    const safeLimit = Math.trunc(limit);
    if (!Number.isInteger(safeLimit) || safeLimit <= 0) throw new Error('INVALID_RETENTION_BATCH');
    return this.db.$executeRaw`
      WITH doomed AS (
        SELECT id FROM "MitigationTrafficObservation"
        WHERE "collectedAt" < ${cutoff}
        ORDER BY "collectedAt"
        LIMIT ${safeLimit}
      )
      DELETE FROM "MitigationTrafficObservation" obs USING doomed
      WHERE obs.id = doomed.id`;
  }
}
