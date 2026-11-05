import type { FastCounterReading, FastTrafficReader, FastTrafficTarget } from './fast-traffic-types';

/**
 * Leitor FAST SIMULADO — somente para homologacao local descartavel.
 *
 * O caminho de producao continua sendo `FastSnmpReader` (SNMP v2c real). Este
 * leitor existe para exercitar o `FastTrafficPoller` VERDADEIRO, o motor AUTO e
 * o lifecycle sem tocar em equipamento: ele devolve `FastCounterReading` como
 * qualquer outro leitor e nao participa de nenhuma decisao.
 *
 * Guardas (fail-closed, verificadas no boot):
 * - selecao por `MITIGATION_FAST_READER=SIMULATED`, nunca por padrao;
 * - proibido em `NODE_ENV=production`;
 * - exige `DEMO_MODE=false` (com demo o repositorio e em memoria e o teste nao
 *   provaria nada);
 * - nenhuma credencial, nenhum host: os contadores sao gerados localmente.
 */

export type FastReaderMode = 'SNMP' | 'SIMULATED';

export function fastReaderModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): FastReaderMode {
  const raw = (env.MITIGATION_FAST_READER ?? 'SNMP').trim().toUpperCase();
  if (raw !== 'SNMP' && raw !== 'SIMULATED') throw new Error('Invalid MITIGATION_FAST_READER');
  if (raw === 'SNMP') return 'SNMP';
  if (env.NODE_ENV === 'production') throw new Error('FAST_READER_SIMULATION_FORBIDDEN_IN_PRODUCTION');
  if (env.DEMO_MODE !== 'false' && env.DEMO_MODE !== '0')
    throw new Error('FAST_READER_SIMULATION_REQUIRES_DEMO_MODE_FALSE');
  return 'SIMULATED';
}

/** Fracao da banda contratada ao longo do ensaio (ms desde o inicio). */
export type FastSimulationScript = (elapsedMs: number, target: FastTrafficTarget) => number;

/** 50% por 10 s, 95% por 30 s, volta a 50% (recuperacao). */
export const DEFAULT_FAST_SIMULATION_SCRIPT: FastSimulationScript = (elapsedMs) => {
  if (elapsedMs < 10_000) return 0.5;
  if (elapsedMs < 40_000) return 0.95;
  return 0.5;
};

export interface SimulatedFastReaderOptions {
  now?: () => number;
  script?: FastSimulationScript;
  /** Deriva a banda de referencia quando o alvo nao expoe perfis. */
  bandwidthBps?: (target: FastTrafficTarget) => bigint;
}

/**
 * Contadores monotonos: cada leitura soma `rateBps * dt / 8` octetos ao total
 * anterior, exatamente como um Counter64 do equipamento. Assim o proprio
 * `deriveFastTraffic` calcula a taxa — o simulador nunca injeta Mbps.
 */
export function createSimulatedFastTrafficReader(
  options: SimulatedFastReaderOptions = {},
): FastTrafficReader {
  const now = options.now ?? Date.now;
  const script = options.script ?? DEFAULT_FAST_SIMULATION_SCRIPT;
  const startedAtMs = now();
  const state = new Map<string, { atMs: number; octets: bigint }>();

  return {
    async read(targets: FastTrafficTarget[]): Promise<FastCounterReading[]> {
      const atMs = now();
      const elapsedMs = Math.max(0, atMs - startedAtMs);
      return targets.map((target) => {
        const previous = state.get(target.interfaceId) ?? { atMs, octets: 0n };
        const dtSeconds = Math.max(0, atMs - previous.atMs) / 1000;
        const contracted =
          target.profiles.find((p) => (p.bandwidthBps ?? 0n) > 0n)?.bandwidthBps ??
          options.bandwidthBps?.(target) ??
          1_000_000_000n;
        const fraction = script(elapsedMs, target);
        const rateBps = Number(contracted) * fraction;
        const deltaOctets = BigInt(Math.max(0, Math.round((rateBps * dtSeconds) / 8)));
        const octets = previous.octets + deltaOctets;
        state.set(target.interfaceId, { atMs, octets });
        return {
          deviceId: target.deviceId,
          interfaceId: target.interfaceId,
          ifIndex: target.ifIndex,
          interfaceName: target.interfaceName,
          requestStartedAt: new Date(atMs),
          collectedAt: new Date(atMs),
          inOctets: octets,
          outOctets: octets,
          uptimeTicks: BigInt(Math.floor(atMs / 100)),
          discontinuityTicks: 0n,
          lastChangeTicks: 0n,
          adminStatus: 1,
          operStatus: 1,
          speedBps: target.speedBps ?? null,
        } satisfies FastCounterReading;
      });
    },
  };
}
