import { describe, expect, it } from 'vitest';
import {
  fastContinuityWindowMs,
  readFastNormalIntervalMs,
  FAST_MIN_CONTINUITY_MS,
} from './fast-cadence';
import { fastPollerConfig, FastTrafficPoller } from './fast-traffic-poller';
import { lifecycleConfig } from '../../worker/mitigation/auto-lifecycle';
import { pilotEvidenceValid, FAST_DEFAULT_WINDOW } from '../../worker/mitigation/single-pilot-trigger';

const BW = 1_000_000_000n;

describe('D4: cadencia e janela de continuidade (fonte unica)', () => {
  it('cadencia nominal: default 10 s e faixa 10..30 s (5 s exige homologacao propria)', () => {
    expect(readFastNormalIntervalMs({})).toBe(10_000);
    expect(readFastNormalIntervalMs({ MITIGATION_FAST_NORMAL_SECONDS: '15' })).toBe(15_000);
    expect(readFastNormalIntervalMs({ MITIGATION_FAST_NORMAL_SECONDS: '30' })).toBe(30_000);
    expect(() => readFastNormalIntervalMs({ MITIGATION_FAST_NORMAL_SECONDS: '5' })).toThrow(
      /MITIGATION_FAST_NORMAL_SECONDS/,
    );
    expect(() => readFastNormalIntervalMs({ MITIGATION_FAST_NORMAL_SECONDS: '31' })).toThrow(
      /MITIGATION_FAST_NORMAL_SECONDS/,
    );
  });

  it('janela = max(15 s; 1,5 x cadencia) — nunca afrouxa o contrato publicado', () => {
    expect(FAST_MIN_CONTINUITY_MS).toBe(15_000);
    expect(fastContinuityWindowMs(10_000)).toBe(15_000);
    expect(fastContinuityWindowMs(15_000)).toBe(22_500);
    expect(fastContinuityWindowMs(30_000)).toBe(45_000);
  });

  it('poller e decisao AUTO usam a MESMA janela para 10/15/30 s', () => {
    for (const seconds of [10, 15, 30]) {
      const env = { MITIGATION_FAST_NORMAL_SECONDS: String(seconds) };
      const poller = fastPollerConfig(env);
      const lifecycle = lifecycleConfig(env);
      expect(lifecycle.maxGapMs).toBe(poller.maxGapMs);
      expect(lifecycle.maxAgeMs).toBe(poller.maxGapMs);
      expect(poller.maxGapMs).toBe(fastContinuityWindowMs(seconds * 1000));
    }
  });

  it('pilotEvidenceValid acompanha a cadencia (30 s confirma; 15 s fixos nao)', () => {
    const now = 100_000;
    const evidence = {
      sampleAt: new Date(now).toISOString(),
      continuityKey: 'k',
    };
    const sample = {
      occurredAt: new Date(now),
      rateStartAt: new Date(now - 30_000),
      continuityKey: 'k',
      bps: BW,
    } as unknown as Parameters<typeof pilotEvidenceValid>[0];
    // Janela derivada de 30 s (45 s) aceita a amostra...
    expect(pilotEvidenceValid(sample, evidence, now, 1n, { maxAgeMs: 45_000, maxGapMs: 45_000 })).toBe(true);
    // ...a janela fixa de 15 s (contrato antigo) a rejeitava.
    expect(pilotEvidenceValid(sample, evidence, now, 1n, FAST_DEFAULT_WINDOW)).toBe(false);
  });
});

describe('D6: gaps medidos entre chegadas consecutivas', () => {
  function harness() {
    let clock = 1_000_000;
    let call = 0;
    const target = {
      deviceId: 'device-1',
      interfaceId: 'if-1',
      ifIndex: 1,
      interfaceName: 'Eth-Trunk1.3058',
      speedBps: BW,
      profiles: [{ profileId: 'p-1', direction: 'tx' as const, bandwidthBps: BW, thresholdBps: BW }],
    };
    const poller = new FastTrafficPoller({
      config: {
        mode: 'OBSERVE',
        profileIds: ['p-1'],
        telemetryProfileIds: [],
        normalIntervalMs: 10_000,
        suspectIntervalMs: 10_000,
        maxGapMs: 15_000,
        timeoutMs: 1500,
        retries: 0,
        concurrency: 1,
        maxInterfacesPerDevice: 32,
      },
      listTargets: async () => [target],
      reader: {
        read: async (batch) => {
          call += 1;
          if (call === 2) throw new Error('SNMP_TIMEOUT');
          return batch.map((entry) => ({
            deviceId: entry.deviceId,
            interfaceId: entry.interfaceId,
            ifIndex: entry.ifIndex,
            interfaceName: entry.interfaceName,
            requestStartedAt: new Date(clock),
            collectedAt: new Date(clock),
            inOctets: BigInt(call) * 1_250_000_000n,
            outOctets: 0n,
            uptimeTicks: 500_000n,
            discontinuityTicks: 0n,
            lastChangeTicks: 0n,
            adminStatus: 1,
            operStatus: 1,
            speedBps: BW,
          }));
        },
      },
      store: { append: async () => true, latest: async () => null },
      now: () => new Date(clock),
      logger: () => undefined,
    });
    return {
      poller,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('gap causado por falha de SNMP conta (a amostra seguinte e BASELINE)', async () => {
    const { poller, advance } = harness();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await poller.runDue();
    await settle();
    advance(10_000);
    await poller.runDue();
    await settle();
    advance(10_000);
    await poller.runDue();
    await settle();

    const status = poller.status();
    // 1 -> 3 = 20 s entre chegadas, apesar da amostra 3 ser BASELINE/STALE.
    expect(status.gapsOver15Seconds).toBe(1);
    expect(status.gapsOverContinuityLimit).toBe(1);
    expect(status.failures).toBeGreaterThanOrEqual(1);
  });

  it('cadencia normal nao gera gap falso', async () => {
    const { poller, advance } = harness();
    await poller.runDue();
    await new Promise((resolve) => setTimeout(resolve, 20));
    advance(10_000);
    await poller.runDue();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = poller.status();
    expect(status.gapsOver15Seconds).toBe(0);
    expect(status.gapsOverContinuityLimit).toBe(0);
  });
});
