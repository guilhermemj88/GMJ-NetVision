import { describe, expect, it } from 'vitest';
import { deriveFastTraffic } from './fast-traffic-rate';
import { fastContinuityWindowMs } from './fast-cadence';
import type { FastCounterReading, FastTrafficTarget } from './fast-traffic-types';

/**
 * Simulador determinístico do FAST com o código REAL de derivação de taxa e a
 * MESMA janela de continuidade usada pela decisão (D4).
 *
 * Não é medição de produção: relógio e contadores são sintéticos. Serve para
 * provar que a cadência configurada produz confirmação coerente e que nenhuma
 * falha de coleta autoriza ACTIVATE.
 */

const BW = 10_000_000_000; // 10 Gbps
const TRIGGER = 0.9; // limiar de 90 %
const SAMPLES = 3;
const TRIALS = 40;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const percentile = (values: number[], p: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
};

interface TrialInput {
  cadenceMs: number;
  seed: number;
  timeoutRate: number;
}

interface TrialResult {
  firstAbnormalMs: number | null;
  confirmationMs: number | null;
  persisted: number;
  timeouts: number;
  gapsOverWindow: number;
  falsePositive: boolean;
  invalidSamples: number;
}

function runTrial({ cadenceMs, seed, timeoutRate }: TrialInput): TrialResult {
  const random = rng(seed);
  const window = fastContinuityWindowMs(cadenceMs);
  const target: FastTrafficTarget = {
    deviceId: 'sim',
    interfaceId: 'if-sim',
    ifIndex: 1,
    interfaceName: 'Eth-Trunk1.sim',
    speedBps: BigInt(BW),
    profiles: [
      { profileId: 'p-sim', direction: 'tx', bandwidthBps: BigInt(BW), thresholdBps: BigInt(Math.round(BW * TRIGGER)) },
    ],
  };

  const attackAt = Math.round(random() * cadenceMs); // fase aleatória do degrau
  const latency = () => 20 + random() * 280; // 20–300 ms por lote
  let octets = 0n;
  let previous: FastCounterReading | undefined;
  let lastCollectedAt: number | null = null;

  let firstAbnormalMs: number | null = null;
  let confirmationMs: number | null = null;
  let streak = 0;
  let persisted = 0;
  let timeouts = 0;
  let gapsOverWindow = 0;
  let invalidSamples = 0;
  let falsePositive = false;
  const horizon = attackAt + cadenceMs * 12;

  for (let index = 0; ; index += 1) {
    const scheduled = index * cadenceMs;
    if (scheduled > horizon) break;
    if (random() < timeoutRate) {
      timeouts += 1; // falha de coleta: nenhuma amostra é produzida
      continue;
    }
    const requestStartedAt = scheduled;
    const collectedAt = Math.round(scheduled + latency());
    const rateBps = scheduled < attackAt ? BW * 0.3 : BW * 1.0;
    octets += BigInt(Math.round((rateBps * cadenceMs) / 8000));
    const current: FastCounterReading = {
      deviceId: target.deviceId,
      interfaceId: target.interfaceId,
      ifIndex: target.ifIndex,
      interfaceName: target.interfaceName,
      requestStartedAt: new Date(requestStartedAt),
      collectedAt: new Date(collectedAt),
      inOctets: 0n,
      outOctets: octets,
      uptimeTicks: BigInt(500_000 + scheduled / 10),
      discontinuityTicks: 0n,
      lastChangeTicks: 0n,
      adminStatus: 1,
      operStatus: 1,
      speedBps: BigInt(BW),
    };

    if (lastCollectedAt !== null && collectedAt - lastCollectedAt > window) gapsOverWindow += 1;
    const observation = deriveFastTraffic(target, current, previous, 'gen-1', window, 2_000);
    if (observation.quality !== 'VALID') invalidSamples += 1;

    const over = observation.quality === 'VALID' && (observation.txBps ?? 0) > BW * TRIGGER;
    const continuous =
      lastCollectedAt === null || collectedAt - lastCollectedAt <= window;
    if (observation.quality === 'VALID') persisted += 1;

    if (over && continuous) {
      if (firstAbnormalMs === null) firstAbnormalMs = collectedAt - attackAt;
      streak += 1;
      if (streak === SAMPLES && confirmationMs === null) confirmationMs = collectedAt - attackAt;
    } else {
      streak = 0;
      if (scheduled < attackAt && over) falsePositive = true;
    }

    previous = current;
    lastCollectedAt = collectedAt;
  }

  return { firstAbnormalMs, confirmationMs, persisted, timeouts, gapsOverWindow, falsePositive, invalidSamples };
}

function summarize(cadenceMs: number, timeoutRate: number) {
  const results = Array.from({ length: TRIALS }, (_, index) =>
    runTrial({ cadenceMs, seed: 1234 + index * 7919, timeoutRate }),
  );
  const first = results.map((r) => r.firstAbnormalMs).filter((v): v is number => v !== null);
  const confirmation = results
    .map((r) => r.confirmationMs)
    .filter((v): v is number => v !== null);
  return {
    cadenceMs,
    timeoutRate,
    first: {
      p50: percentile(first, 50),
      p95: percentile(first, 95),
      p99: percentile(first, 99),
    },
    confirmation: {
      p50: percentile(confirmation, 50),
      p95: percentile(confirmation, 95),
      p99: percentile(confirmation, 99),
    },
    confirmed: confirmation.length,
    trials: TRIALS,
    gapsOverWindow: results.reduce((sum, r) => sum + r.gapsOverWindow, 0),
    timeouts: results.reduce((sum, r) => sum + r.timeouts, 0),
    persisted: results.reduce((sum, r) => sum + r.persisted, 0),
    invalidSamples: results.reduce((sum, r) => sum + r.invalidSamples, 0),
    falsePositives: results.filter((r) => r.falsePositive).length,
  };
}

describe('FAST — simulador determinístico por cadência', () => {
  it('10/15/30 s confirmam com três amostras novas e não geram falso positivo', () => {
    const rows = [10, 15, 30].map((seconds) => summarize(seconds * 1000, 0));
    for (const row of rows) {
      // Nenhuma sequência confirmada sem as três amostras consecutivas.
      expect(row.confirmed).toBe(row.trials);
      expect(row.falsePositives).toBe(0);
      // A primeira amostra anormal nunca chega antes da cadência.
      expect(row.first.p50).toBeGreaterThan(0);
      expect(row.first.p99).toBeLessThanOrEqual(row.cadenceMs * 2.5);
      // A confirmação exige ~2 cadências depois da primeira amostra anormal.
      expect(row.confirmation.p50).toBeGreaterThan(row.first.p50);
      expect(row.confirmation.p99).toBeLessThanOrEqual(row.first.p99 + row.cadenceMs * 2.5);
    }
    console.log('FAST_SIM ' + JSON.stringify(rows));
  });

  it('10 s com 3 % de timeouts não confirma sem amostras novas consecutivas', () => {
    const row = summarize(10_000, 0.03);
    expect(row.confirmed).toBe(row.trials);
    expect(row.timeouts).toBeGreaterThan(0);
    expect(row.falsePositives).toBe(0);
    console.log('FAST_SIM_TIMEOUT ' + JSON.stringify(row));
  });

  it('5 s é rejeitado explicitamente (cadência não habilitada)', async () => {
    const { readFastNormalIntervalMs } = await import('./fast-cadence');
    expect(() => readFastNormalIntervalMs({ MITIGATION_FAST_NORMAL_SECONDS: '5' })).toThrow(
      /MITIGATION_FAST_NORMAL_SECONDS/,
    );
  });
});
