import { describe, expect, it } from 'vitest';
import {
  BASELINE_ONLY_RATE_BPS,
  COUNTER_RATE_TOLERANCE_RATIO,
  evaluateTrafficRate,
  filterUsableTrafficSamples,
  isUsableTrafficSample,
  pickLatestUsableTrafficSample,
} from './traffic-rate';

const GIGA = 1_000_000_000;
const HUNDRED_G = 100n * BigInt(GIGA);
const SECONDS = 60;

/** Octets para sustentar `bps` durante `seconds`. */
function octetsFor(bps: number, seconds = SECONDS): bigint {
  return BigInt(Math.round((bps * seconds) / 8));
}

describe('avaliação fail-safe da taxa de tráfego SNMP', () => {
  it('1) interface 100G: delta normal de 30 Gbps é aceito', () => {
    const rate = evaluateTrafficRate({
      currentInOctets: octetsFor(30 * GIGA),
      currentOutOctets: octetsFor(30 * GIGA),
      previousInOctets: 0n,
      previousOutOctets: 0n,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });

    expect(rate.usable).toBe(true);
    expect(rate.reason).toBeNull();
    expect(rate.rxBps).toBeCloseTo(30 * GIGA, 0);
    expect(rate.txBps).toBeCloseTo(30 * GIGA, 0);
    expect(rate.limitBps).toBeCloseTo(100 * GIGA * (1 + COUNTER_RATE_TOLERANCE_RATIO), 0);
  });

  it('2) contador atual menor que o anterior é descontinuidade (amostra não utilizável)', () => {
    const rate = evaluateTrafficRate({
      currentInOctets: 1_000n,
      currentOutOctets: 1_000n,
      previousInOctets: 5_000n,
      previousOutOctets: 5_000n,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });

    expect(rate.discontinuity).toBe(true);
    expect(rate.usable).toBe(false);
    expect(rate.reason).toBe('DISCONTINUITY');
    // o chamador usa este valor para gravar a linha de baseline (rebase)
    expect(BASELINE_ONLY_RATE_BPS).toBeLessThan(0);
  });

  it('3) depois da descontinuidade, contador volta ao normal e NÃO produz spike de 124 Gbps', () => {
    // baseline rebaseado no contador baixo (leitura anômala)
    const lowBaseline = 1_000n;
    const spike = evaluateTrafficRate({
      // delta que renderia 124,68 Gbps em 60s
      currentInOctets: lowBaseline + octetsFor(124.68 * GIGA),
      currentOutOctets: lowBaseline + octetsFor(124.68 * GIGA),
      previousInOctets: lowBaseline,
      previousOutOctets: lowBaseline,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });

    expect(spike.aboveCapacity).toBe(true);
    expect(spike.usable).toBe(false);
    expect(spike.reason).toBe('ABOVE_CAPACITY');
    expect(spike.rxBps).toBeGreaterThan(100 * GIGA);
  });

  it('4) taxa acima da capacidade + tolerância é rejeitada; dentro da tolerância é aceita', () => {
    const aboveTolerance = evaluateTrafficRate({
      currentInOctets: octetsFor(125 * GIGA),
      currentOutOctets: 0n,
      previousInOctets: 0n,
      previousOutOctets: 0n,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });
    expect(aboveTolerance.usable).toBe(false);
    expect(aboveTolerance.reason).toBe('ABOVE_CAPACITY');

    const withinTolerance = evaluateTrafficRate({
      currentInOctets: octetsFor(100 * GIGA),
      currentOutOctets: octetsFor(100 * GIGA * 1.05),
      previousInOctets: 0n,
      previousOutOctets: 0n,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });
    expect(withinTolerance.usable).toBe(true);
  });

  it('5) próximo sample normal depois do rebase volta a ~30 Gbps', () => {
    const rebasedBaseline = octetsFor(124.68 * GIGA) + 1_000n;
    const next = evaluateTrafficRate({
      currentInOctets: rebasedBaseline + octetsFor(30 * GIGA),
      currentOutOctets: rebasedBaseline + octetsFor(30 * GIGA),
      previousInOctets: rebasedBaseline,
      previousOutOctets: rebasedBaseline,
      seconds: SECONDS,
      speedBps: HUNDRED_G,
    });

    expect(next.usable).toBe(true);
    expect(next.rxBps).toBeCloseTo(30 * GIGA, 0);
    expect(next.txBps).toBeCloseTo(30 * GIGA, 0);
  });

  it('6) interface sem speed conhecida: mantém o cálculo (documentado) e ainda rejeita descontinuidade', () => {
    const unknownSpeed = evaluateTrafficRate({
      currentInOctets: octetsFor(124.68 * GIGA),
      currentOutOctets: octetsFor(124.68 * GIGA),
      previousInOctets: 0n,
      previousOutOctets: 0n,
      seconds: SECONDS,
      speedBps: null,
    });
    expect(unknownSpeed.limitBps).toBeNull();
    expect(unknownSpeed.usable).toBe(true);

    const stillRejectsDiscontinuity = evaluateTrafficRate({
      currentInOctets: 10n,
      currentOutOctets: 10n,
      previousInOctets: 20n,
      previousOutOctets: 20n,
      seconds: SECONDS,
      speedBps: null,
    });
    expect(stillRejectsDiscontinuity.usable).toBe(false);
    expect(stillRejectsDiscontinuity.reason).toBe('DISCONTINUITY');
  });

  it('primeiro sample sem baseline continua sendo 0 bps e utilizável', () => {
    const first = evaluateTrafficRate({
      currentInOctets: 999n,
      currentOutOctets: 999n,
      seconds: 0,
      speedBps: HUNDRED_G,
    });
    expect(first.rxBps).toBe(0);
    expect(first.txBps).toBe(0);
    expect(first.usable).toBe(true);
  });
});

/**
 * Guard READ-SIDE: a MESMA regra aplicada a amostras já persistidas pelos
 * leitores (histórico, current, BGP, mapa e mitigação).
 */
describe('guard read-side de amostras persistidas', () => {
  const SPEED_100G = 100n * BigInt(GIGA);
  const sample = (rxG: number, txG: number) => ({ rxBps: rxG * GIGA, txBps: txG * GIGA });

  it('histórico 30G / 124G / 28G devolve 30G e 28G — nunca o 124G', () => {
    const rows = [sample(30, 30), sample(124, 124), sample(28, 28)];
    const usable = filterUsableTrafficSamples(rows, SPEED_100G);
    expect(usable.map((row) => row.rxBps / GIGA)).toEqual([30, 28]);
  });

  it('current traffic escolhe 28G (último sample válido)', () => {
    // ordem real das consultas: mais novo primeiro
    const rows = [sample(28, 28), sample(124, 124), sample(30, 30)];
    expect(pickLatestUsableTrafficSample(rows, SPEED_100G)?.rxBps).toBe(28 * GIGA);
  });

  it('current traffic volta ao anterior válido se o mais novo for um spike', () => {
    const rows = [sample(124, 124), sample(30, 30)];
    expect(pickLatestUsableTrafficSample(rows, SPEED_100G)?.rxBps).toBe(30 * GIGA);
  });

  it('BGP, mapa e mitigação usam a mesma regra (28G válido, 124G não)', () => {
    expect(isUsableTrafficSample(sample(28, 28), SPEED_100G)).toBe(true);
    expect(isUsableTrafficSample(sample(124, 124), SPEED_100G)).toBe(false);
  });

  it('speed desconhecida mantém o sample positivo e ainda exclui a sentinela', () => {
    expect(isUsableTrafficSample(sample(124, 124), null)).toBe(true);
    expect(isUsableTrafficSample({ rxBps: BASELINE_ONLY_RATE_BPS, txBps: BASELINE_ONLY_RATE_BPS }, null)).toBe(false);
  });

  it('baseline-only (-1) continua excluída mesmo com speed conhecida', () => {
    expect(
      isUsableTrafficSample(
        { rxBps: BASELINE_ONLY_RATE_BPS, txBps: BASELINE_ONLY_RATE_BPS },
        SPEED_100G,
      ),
    ).toBe(false);
  });

  it('105G em 100G é aceito pela tolerância de 10%; 111G é rejeitado', () => {
    expect(isUsableTrafficSample(sample(105, 105), SPEED_100G)).toBe(true);
    expect(isUsableTrafficSample(sample(111, 111), SPEED_100G)).toBe(false);
  });
});
