import { describe, expect, it } from 'vitest';
import { OPERATIONAL_OCCURRENCE_QUIET_MS } from '@gmj/shared';
import {
  bestIntervalBasisMs,
  isOccurrenceStateCurrent,
  occurrenceDeltaFor,
  occurrenceRatePerMinute,
  planOperationalOccurrence,
  resolveIntervalMs,
  supersedeFor,
  type OccurrenceSampleDelta,
  type OperationalOccurrenceState,
} from './operational-occurrence-rules';

const T0 = Date.parse('2026-10-12T12:00:00.000Z');

function sample(patch: Partial<OccurrenceSampleDelta> = {}): OccurrenceSampleDelta {
  return {
    interfaceId: 'iface-1',
    timestampMs: T0,
    fcsErrorsDelta: 0n,
    inDiscardsDelta: 0n,
    outDiscardsDelta: 0n,
    ...patch,
  };
}

function state(patch: Partial<OperationalOccurrenceState> = {}): OperationalOccurrenceState {
  return {
    id: 'occ-1',
    firstSeenAtMs: T0,
    lastSeenAtMs: T0,
    lastSampleAtMs: T0,
    occurrenceCount: 1,
    crcDeltaTotal: 1n,
    rxDiscardDeltaTotal: 0n,
    txDiscardDeltaTotal: 0n,
    currentRatePerMin: 1,
    peakRatePerMin: 1,
    ...patch,
  };
}

describe('occurrenceDeltaFor', () => {
  it('separa CRC de DISCARD: mesmo delta alimenta tipos diferentes', () => {
    const source = sample({ fcsErrorsDelta: 2n, inDiscardsDelta: 3n, outDiscardsDelta: 4n });
    expect(occurrenceDeltaFor('CRC_FCS', source)).toEqual({ crc: 2n, rx: 0n, tx: 0n, total: 2n });
    expect(occurrenceDeltaFor('DISCARDS', source)).toEqual({ crc: 0n, rx: 3n, tx: 4n, total: 7n });
  });

  it('RX e TX de discard sao o MESMO episodio (total = rx + tx)', () => {
    const source = sample({ inDiscardsDelta: 1n, outDiscardsDelta: 5n });
    expect(occurrenceDeltaFor('DISCARDS', source).total).toBe(6n);
  });

  it('FCS nao coletado (null) nunca vira ocorrencia', () => {
    expect(occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: null })).total).toBe(0n);
  });

  it('delta negativo (contador descontinuo) vira zero', () => {
    expect(occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: -5n })).total).toBe(0n);
    expect(occurrenceDeltaFor('DISCARDS', sample({ inDiscardsDelta: -1n })).total).toBe(0n);
  });
});

describe('taxa por minuto', () => {
  it('1 evento em 60s = 1/min e em 120s = 0.5/min', () => {
    expect(occurrenceRatePerMinute(1n, 60_000)).toBe(1);
    expect(occurrenceRatePerMinute(1n, 120_000)).toBe(0.5);
    expect(occurrenceRatePerMinute(3n, 60_000)).toBe(3);
  });

  it('sem base de intervalo a taxa e 0, nunca NaN/Infinity', () => {
    for (const interval of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rate = occurrenceRatePerMinute(5n, interval as number | null);
      expect(rate).toBe(0);
      expect(Number.isFinite(rate)).toBe(true);
    }
  });

  it('resolucao do intervalo ignora bases invalidas ou futuras', () => {
    expect(resolveIntervalMs(T0, T0 - 60_000)).toBe(60_000);
    expect(resolveIntervalMs(T0, T0)).toBeNull();
    expect(resolveIntervalMs(T0, T0 + 1000)).toBeNull();
    expect(resolveIntervalMs(T0, undefined)).toBeNull();
    expect(resolveIntervalMs(T0, Number.NaN)).toBeNull();
  });

  it('escolhe a base valida mais recente', () => {
    expect(bestIntervalBasisMs(T0, [T0 - 300_000, T0 - 60_000, T0, null, undefined])).toBe(
      T0 - 60_000,
    );
    expect(bestIntervalBasisMs(T0, [])).toBeNull();
  });
});

describe('planOperationalOccurrence', () => {
  it('cria episodio no primeiro delta com taxa pelo intervalo conhecido', () => {
    const plan = planOperationalOccurrence({
      current: null,
      latest: null,
      supersede: null,
      timestampMs: T0,
      delta: occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: 1n })),
      intervalBasisMs: T0 - 60_000,
    });
    expect(plan).toEqual({
      action: 'CREATE',
      close: null,
      values: {
        firstSeenAtMs: T0,
        lastSeenAtMs: T0,
        lastSampleAtMs: T0,
        occurrenceCount: 1,
        crcDeltaTotal: 1n,
        rxDiscardDeltaTotal: 0n,
        txDiscardDeltaTotal: 0n,
        currentRatePerMin: 1,
        peakRatePerMin: 1,
      },
    });
  });

  it('acumula no episodio vigente mantendo o primeiro instante', () => {
    const current = state({ currentRatePerMin: 1, peakRatePerMin: 1 });
    const plan = planOperationalOccurrence({
      current,
      latest: current,
      supersede: null,
      timestampMs: T0 + 60_000,
      delta: occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: 2n })),
      intervalBasisMs: T0,
    });
    expect(plan.action).toBe('UPDATE');
    if (plan.action !== 'UPDATE') return;
    expect(plan.targetId).toBe('occ-1');
    expect(plan.values).toMatchObject({
      firstSeenAtMs: T0,
      lastSeenAtMs: T0 + 60_000,
      lastSampleAtMs: T0 + 60_000,
      occurrenceCount: 2,
      crcDeltaTotal: 3n,
      currentRatePerMin: 2,
      peakRatePerMin: 2,
    });
  });

  it('amostra atrasada soma o evento sem rejuvenescer tempo, taxa ou pico', () => {
    const current = state({
      lastSeenAtMs: T0 + 600_000,
      lastSampleAtMs: T0 + 600_000,
      occurrenceCount: 3,
      crcDeltaTotal: 3n,
      currentRatePerMin: 4,
      peakRatePerMin: 9,
    });
    const plan = planOperationalOccurrence({
      current,
      latest: current,
      supersede: null,
      timestampMs: T0 + 120_000,
      delta: occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: 1n })),
      intervalBasisMs: T0 + 60_000,
    });
    expect(plan.action).toBe('UPDATE');
    if (plan.action !== 'UPDATE') return;
    expect(plan.values).toMatchObject({
      lastSeenAtMs: T0 + 600_000,
      lastSampleAtMs: T0 + 600_000,
      occurrenceCount: 4,
      crcDeltaTotal: 4n,
      currentRatePerMin: 4,
      peakRatePerMin: 9,
    });
  });

  it('amostra antiga sem episodio vigente e ignorada (nao reabre o passado)', () => {
    const latest = state({ lastSampleAtMs: T0 + 600_000, lastSeenAtMs: T0 + 600_000 });
    expect(
      planOperationalOccurrence({
        current: null,
        latest,
        supersede: null,
        timestampMs: T0 + 120_000,
        delta: occurrenceDeltaFor('CRC_FCS', sample({ fcsErrorsDelta: 1n })),
        intervalBasisMs: null,
      }),
    ).toEqual({ action: 'IGNORE' });
  });

  it('depois de 24h cria episodio novo e encerra o anterior como QUIET_24H', () => {
    const stale = state({ lastSeenAtMs: T0, lastSampleAtMs: T0 });
    const timestampMs = T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 60_000;
    const plan = planOperationalOccurrence({
      current: null,
      latest: stale,
      supersede: supersedeFor(stale, timestampMs, null),
      timestampMs,
      delta: occurrenceDeltaFor('DISCARDS', sample({ inDiscardsDelta: 4n, outDiscardsDelta: 1n })),
      intervalBasisMs: T0,
    });
    expect(plan.action).toBe('CREATE');
    if (plan.action !== 'CREATE') return;
    expect(plan.close).toEqual({
      id: 'occ-1',
      reason: 'QUIET_24H',
      closedAtMs: T0 + OPERATIONAL_OCCURRENCE_QUIET_MS,
    });
    expect(plan.values).toMatchObject({
      firstSeenAtMs: timestampMs,
      occurrenceCount: 1,
      rxDiscardDeltaTotal: 4n,
      txDiscardDeltaTotal: 1n,
    });
  });

  it('reencontra episodio encerrado no passado: nao ha supersede pois ja esta fechado', () => {
    const stale = state({ lastSeenAtMs: T0, lastSampleAtMs: T0 });
    expect(supersedeFor(stale, T0 + 3600_000, null)).toBeNull();
    expect(supersedeFor(stale, T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 1, null)).not.toBeNull();
  });

  it('reconhecido pelo operador vira supersede de ACK quando ainda aberto', () => {
    const acked = state({ lastSeenAtMs: T0 + 60_000, lastSampleAtMs: T0 + 60_000 });
    expect(supersedeFor(acked, T0 + 120_000, T0 + 90_000)).toEqual({
      id: 'occ-1',
      reason: 'ACKNOWLEDGED',
      closedAtMs: T0 + 90_000,
    });
  });
});

describe('isOccurrenceStateCurrent', () => {
  it('23h59 vigente, 24h01 nao', () => {
    expect(isOccurrenceStateCurrent({ lastSeenAtMs: T0 }, T0 + OPERATIONAL_OCCURRENCE_QUIET_MS - 1)).toBe(
      true,
    );
    expect(
      isOccurrenceStateCurrent({ lastSeenAtMs: T0 }, T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 1),
    ).toBe(false);
  });
});
