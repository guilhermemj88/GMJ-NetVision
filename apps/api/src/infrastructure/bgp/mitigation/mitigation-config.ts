import { gbpsToBps } from './bandwidth-parser';
import type { MitigationMode } from './mitigation-types';

/**
 * Configuração do motor de mitigação.
 *
 * Banda operacional é sempre bps (`bigint`). O env `MITIGATION_TRUNK_CAPACITY_GB`
 * é apenas a forma humana de informar a capacidade do trunk; ele é convertido
 * para bps imediatamente, e o objeto de config carrega só a forma canônica.
 *
 * Nada de webhook/Telegram aqui: transporte de notificação é responsabilidade
 * da camada de mídias, atrás da porta `NotificationPublisher`.
 */
export interface MitigationEngineConfig {
  mode: MitigationMode;
  /** Capacidade do trunk em bits por segundo (fonte canônica). */
  trunkCapacityBps: bigint;
  triggerPercent: number;
  recoveryPercent: number;
  checkIntervalSeconds: number;
  triggerSamples: number;
  recoverySamples: number;
  prefixLimit: number;
  mitigationRt: string;
}

type EnvLike = Record<string, string | undefined>;

function intEnv(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Configuração do motor, lida do ambiente. Nenhum valor operacional fica
 * hardcoded na lógica principal — os defaults são exatamente os do desenho
 * aprovado (trunk 300 Gbps, trigger 90%, recovery 70%, 5s, 3/12 amostras).
 */
export function mitigationConfigFromEnv(env: EnvLike = process.env): MitigationEngineConfig {
  return {
    mode: 'SIMULATION_ONLY',
    trunkCapacityBps: gbpsToBps(intEnv(env, 'MITIGATION_TRUNK_CAPACITY_GB', 300)),
    triggerPercent: intEnv(env, 'MITIGATION_TRIGGER_PERCENT', 90),
    recoveryPercent: intEnv(env, 'MITIGATION_RECOVERY_PERCENT', 70),
    checkIntervalSeconds: intEnv(env, 'MITIGATION_CHECK_INTERVAL_SECONDS', 5),
    triggerSamples: intEnv(env, 'MITIGATION_TRIGGER_SAMPLES', 3),
    recoverySamples: intEnv(env, 'MITIGATION_RECOVERY_SAMPLES', 12),
    prefixLimit: intEnv(env, 'MITIGATION_PREFIX_LIMIT', 100),
    mitigationRt: env.MITIGATION_RT ?? '268568:660',
  };
}

/** Limite de mitigação em bps: banda (bps) × trigger% (percentual inteiro). */
export function mitigationThresholdBps(
  config: MitigationEngineConfig,
  bandwidthBps: bigint,
): bigint {
  return (bandwidthBps * BigInt(config.triggerPercent)) / 100n;
}

/** Limite de recovery em bps: banda (bps) × recovery% (percentual inteiro). */
export function recoveryThresholdBps(
  config: MitigationEngineConfig,
  bandwidthBps: bigint,
): bigint {
  return (bandwidthBps * BigInt(config.recoveryPercent)) / 100n;
}

/**
 * Percentual equivalente no `display interface brief`.
 *
 * Ex.: 40 Gbps × 90% = 36 Gbps; 36 / 300 (trunk) × 100 = 12%.
 */
export function displayBriefTriggerPercent(
  config: MitigationEngineConfig,
  bandwidthBps: bigint,
): number {
  if (config.trunkCapacityBps <= 0n) return 0;
  const threshold = mitigationThresholdBps(config, bandwidthBps);
  const value = (Number(threshold) / Number(config.trunkCapacityBps)) * 100;
  return Math.round(value * 100) / 100;
}
