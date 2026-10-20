import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FAST_RETENTION_LIMITS,
  fastRetentionConfig,
  purgeFastObservations,
  retentionCutoff,
  type FastObservationPurgePort,
} from './fast-observation-retention';

const NOW = new Date('2026-10-20T12:00:00Z');

function port(total: number, onDelete?: (cutoff: Date, limit: number) => void) {
  let remaining = total;
  const calls: { cutoff: Date; limit: number }[] = [];
  const adapter: FastObservationPurgePort = {
    deleteObservationsBefore: async (cutoff, limit) => {
      calls.push({ cutoff, limit });
      onDelete?.(cutoff, limit);
      const removed = Math.min(limit, remaining);
      remaining -= removed;
      return removed;
    },
  };
  return { adapter, calls, remaining: () => remaining };
}

const config = (over: Partial<ReturnType<typeof fastRetentionConfig>> = {}) => ({
  ...fastRetentionConfig({}),
  ...over,
});

describe('retenção FAST: política explícita e conservadora', () => {
  it('defaults: 7 dias, lotes de 10.000, até 12 lotes, execução horária', () => {
    expect(fastRetentionConfig({})).toEqual({
      retentionDays: 7,
      batchSize: 10_000,
      maxBatches: 12,
      intervalMs: 3_600_000,
    });
  });

  it('aceita configuração explícita dentro das faixas', () => {
    expect(
      fastRetentionConfig({
        MITIGATION_FAST_RETENTION_DAYS: '14',
        MITIGATION_FAST_RETENTION_BATCH: '5000',
        MITIGATION_FAST_RETENTION_MAX_BATCHES: '4',
        MITIGATION_FAST_RETENTION_INTERVAL_MS: '600000',
      }),
    ).toEqual({ retentionDays: 14, batchSize: 5000, maxBatches: 4, intervalMs: 600_000 });
  });

  it.each([
    ['MITIGATION_FAST_RETENTION_DAYS', '0'],
    ['MITIGATION_FAST_RETENTION_DAYS', '91'],
    ['MITIGATION_FAST_RETENTION_DAYS', '3.5'],
    ['MITIGATION_FAST_RETENTION_BATCH', '99'],
    ['MITIGATION_FAST_RETENTION_BATCH', '50001'],
    ['MITIGATION_FAST_RETENTION_MAX_BATCHES', '0'],
    ['MITIGATION_FAST_RETENTION_INTERVAL_MS', '59999'],
    ['MITIGATION_FAST_RETENTION_INTERVAL_MS', 'x'],
  ])('recusa %s=%s', (key, value) => {
    expect(() => fastRetentionConfig({ [key]: value })).toThrow(`Invalid ${key}`);
  });

  it('corte temporal é exato e nunca aceita valor inválido', () => {
    expect(retentionCutoff(NOW, 7).toISOString()).toBe('2026-10-13T12:00:00.000Z');
    expect(retentionCutoff(NOW, FAST_RETENTION_LIMITS.minDays).getTime()).toBeLessThan(NOW.getTime());
    expect(() => retentionCutoff(NOW, 0)).toThrow('INVALID_RETENTION_DAYS');
    expect(() => retentionCutoff(NOW, 7.5)).toThrow('INVALID_RETENTION_DAYS');
    expect(() => retentionCutoff(new Date('invalid'), 7)).toThrow('INVALID_RETENTION_CLOCK');
  });

  it('apaga em lotes até esvaziar o backlog elegível', async () => {
    const p = port(25_000);
    const result = await purgeFastObservations(p.adapter, {
      ...config({ batchSize: 10_000 }),
      now: () => NOW,
    });
    expect(result).toMatchObject({ deleted: 25_000, batches: 3, backlogRemaining: false });
    expect(p.remaining()).toBe(0);
    expect(p.calls.map((call) => call.limit)).toEqual([10_000, 10_000, 10_000]);
    expect(p.calls.every((call) => call.cutoff.toISOString() === '2026-10-13T12:00:00.000Z')).toBe(
      true,
    );
  });

  it('respeita o teto de lotes por execução e sinaliza backlog restante', async () => {
    const p = port(100_000);
    const result = await purgeFastObservations(p.adapter, {
      ...config({ batchSize: 10_000, maxBatches: 2 }),
      now: () => NOW,
    });
    expect(result).toMatchObject({ deleted: 20_000, batches: 2, backlogRemaining: true });
    expect(p.remaining()).toBe(80_000);
  });

  it('não faz nenhuma chamada quando o lote é maior que o backlog', async () => {
    const p = port(0);
    const result = await purgeFastObservations(p.adapter, {
      ...config(),
      now: () => NOW,
    });
    expect(result).toMatchObject({ deleted: 0, batches: 1, backlogRemaining: false });
  });

  it('porta de limpeza só expõe a exclusão de observações por corte (estrutural)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./fast-observation-retention.ts', import.meta.url)),
      'utf8',
    );
    // Auditoria e histórico operacional não são alcançáveis por este módulo.
    for (const forbidden of [
      'mitigationDirectionAudit',
      'bgpMitigationEvent',
      'bgpMitigationRuntime',
      'mitigationFastDecision',
    ])
      expect(source).not.toContain(forbidden);
    expect(source).toContain('MitigationTrafficObservation');
    // O único verbo de escrita é o DELETE em lotes com corte e limite.
    expect(source).toContain('DELETE FROM "MitigationTrafficObservation"');
    expect(source).toContain('LIMIT');
  });
});
