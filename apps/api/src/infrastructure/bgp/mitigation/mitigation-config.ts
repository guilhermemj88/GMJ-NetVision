import type { MitigationMode } from './mitigation-types';

export interface MitigationEngineConfig {
  mode: MitigationMode;
  trunkCapacityGbps: number;
  triggerPercent: number;
  recoveryPercent: number;
  checkIntervalSeconds: number;
  triggerSamples: number;
  recoverySamples: number;
  prefixLimit: number;
  mitigationRt: string;
  webhookUrl: string | null;
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
    trunkCapacityGbps: intEnv(env, 'MITIGATION_TRUNK_CAPACITY_GB', 300),
    triggerPercent: intEnv(env, 'MITIGATION_TRIGGER_PERCENT', 90),
    recoveryPercent: intEnv(env, 'MITIGATION_RECOVERY_PERCENT', 70),
    checkIntervalSeconds: intEnv(env, 'MITIGATION_CHECK_INTERVAL_SECONDS', 5),
    triggerSamples: intEnv(env, 'MITIGATION_TRIGGER_SAMPLES', 3),
    recoverySamples: intEnv(env, 'MITIGATION_RECOVERY_SAMPLES', 12),
    prefixLimit: intEnv(env, 'MITIGATION_PREFIX_LIMIT', 100),
    mitigationRt: env.MITIGATION_RT ?? '268568:660',
    webhookUrl: env.MITIGATION_WEBHOOK_URL?.trim() || null,
  };
}

/** Limite de mitigação em bps: banda contratada × trigger%. */
export function mitigationThresholdBps(config: MitigationEngineConfig, bandwidthGbps: number): number {
  return bandwidthGbps * (config.triggerPercent / 100) * 1_000_000_000;
}

/** Limite de recovery em bps: banda contratada × recovery%. */
export function recoveryThresholdBps(config: MitigationEngineConfig, bandwidthGbps: number): number {
  return bandwidthGbps * (config.recoveryPercent / 100) * 1_000_000_000;
}

/**
 * Percentual equivalente no `display interface brief`.
 *
 * Ex.: 40 Gbps × 90% = 36 Gbps; 36 / 300 (trunk) × 100 = 12%.
 */
export function displayBriefTriggerPercent(
  config: MitigationEngineConfig,
  bandwidthGbps: number,
): number {
  if (config.trunkCapacityGbps <= 0) return 0;
  const value = (bandwidthGbps * config.triggerPercent) / config.trunkCapacityGbps;
  return Math.round(value * 100) / 100;
}
