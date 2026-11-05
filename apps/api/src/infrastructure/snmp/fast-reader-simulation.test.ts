import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAST_SIMULATION_SCRIPT,
  createSimulatedFastTrafficReader,
  fastReaderModeFromEnv,
} from './fast-reader-simulation';
import { deriveFastTraffic } from './fast-traffic-rate';
import type { FastCounterReading, FastTrafficTarget } from './fast-traffic-types';

const BW = 1_000_000_000n; // 1 Gbps contratado

function target(): FastTrafficTarget {
  return {
    deviceId: 'sim-dev-1',
    interfaceId: 'sim-if-1',
    ifIndex: 231,
    interfaceName: 'Eth-Trunk1.3001',
    speedBps: 300_000_000_000n,
    profiles: [{ profileId: 'sim-prof-1', direction: 'tx', bandwidthBps: BW, thresholdBps: (BW * 90n) / 100n }],
  } as unknown as FastTrafficTarget;
}

describe('leitor FAST simulado — guardas de ambiente (fail-closed)', () => {
  it('SNMP e o padrao: sem a flag nada e simulado', () => {
    expect(fastReaderModeFromEnv({})).toBe('SNMP');
    expect(fastReaderModeFromEnv({ MITIGATION_FAST_READER: 'snmp' })).toBe('SNMP');
  });

  it('valor invalido falha no boot', () => {
    expect(() => fastReaderModeFromEnv({ MITIGATION_FAST_READER: 'FAKE' })).toThrow(
      'Invalid MITIGATION_FAST_READER',
    );
  });

  it('proibido em producao', () => {
    expect(() =>
      fastReaderModeFromEnv({
        MITIGATION_FAST_READER: 'SIMULATED',
        NODE_ENV: 'production',
        DEMO_MODE: 'false',
      }),
    ).toThrow('FAST_READER_SIMULATION_FORBIDDEN_IN_PRODUCTION');
  });

  it('exige DEMO_MODE=false explicito', () => {
    expect(() =>
      fastReaderModeFromEnv({ MITIGATION_FAST_READER: 'SIMULATED', NODE_ENV: 'development' }),
    ).toThrow('FAST_READER_SIMULATION_REQUIRES_DEMO_MODE_FALSE');
    expect(() =>
      fastReaderModeFromEnv({
        MITIGATION_FAST_READER: 'SIMULATED',
        NODE_ENV: 'development',
        DEMO_MODE: '1',
      }),
    ).toThrow('FAST_READER_SIMULATION_REQUIRES_DEMO_MODE_FALSE');
  });

  it('aceito em homologacao local', () => {
    expect(
      fastReaderModeFromEnv({
        MITIGATION_FAST_READER: 'SIMULATED',
        NODE_ENV: 'development',
        DEMO_MODE: 'false',
      }),
    ).toBe('SIMULATED');
  });
});

describe('leitor FAST simulado — contadores e taxas', () => {
  it('contadores sao monotonos e o delta vira taxa no motor real', async () => {
    let clock = 1_000_000;
    const reader = createSimulatedFastTrafficReader({
      now: () => clock,
      script: () => 0.5,
    });
    const t = target();
    const first = (await reader.read([t]))[0]!;
    clock += 5_000;
    const second = (await reader.read([t]))[0]!;
    expect(second.inOctets > first.inOctets).toBe(true);

    // A taxa e derivada pelo codigo de producao, nao pelo simulador.
    const observation = deriveFastTraffic(t, second, first, 'gen', 15_000, 2_000);
    expect(observation.quality).toBe('VALID');
    // 50% de 1 Gbps = 500 Mbps (tolerancia do intervalo real).
    expect(Number(observation.txBps)).toBeGreaterThan(450_000_000);
    expect(Number(observation.txBps)).toBeLessThan(550_000_000);
  });

  it('script padrao cruza o limiar de 90% e depois recupera', async () => {
    let clock = 0;
    const reader = createSimulatedFastTrafficReader({ now: () => clock });
    const t = target();
    const samples: number[] = [];
    let previous: FastCounterReading | undefined = undefined;
    for (let i = 0; i < 10; i += 1) {
      const current = (await reader.read([t]))[0]!;
      if (previous) {
        const observation = deriveFastTraffic(t, current, previous, 'gen', 15_000, 2_000);
        if (observation.quality === 'VALID' && observation.txBps !== null)
          samples.push(Math.round(Number(observation.txBps) / 1_000_000));
      }
      previous = current;
      clock += 5_000;
    }
    // t=5 s: 50% | t=10..35 s: 95% | t=40+ s: 50%
    expect(samples[0]).toBeLessThan(900);
    expect(samples.slice(1, 7).every((mbps) => mbps >= 900)).toBe(true);
    expect(samples.at(-1)!).toBeLessThan(900);
    expect(DEFAULT_FAST_SIMULATION_SCRIPT(0, t)).toBe(0.5);
    expect(DEFAULT_FAST_SIMULATION_SCRIPT(20_000, t)).toBe(0.95);
  });

  it('cada interface tem contador proprio (sem contaminacao entre clientes)', async () => {
    let clock = 0;
    const reader = createSimulatedFastTrafficReader({ now: () => clock });
    const a = target();
    const b = { ...target(), interfaceId: 'sim-if-2', ifIndex: 232 } as FastTrafficTarget;
    await reader.read([a, b]);
    clock += 5_000;
    const [ra, rb] = await reader.read([a, b]);
    expect(ra!.inOctets).toBe(rb!.inOctets);
    clock += 5_000;
    const solo = (await reader.read([a]))[0]!;
    expect(solo.inOctets > ra!.inOctets).toBe(true);
  });
});
