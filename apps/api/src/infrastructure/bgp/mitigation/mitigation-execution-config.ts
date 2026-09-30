/**
 * Configuracao de EXECUCAO da mitigacao (manual, fail-closed).
 *
 * O default continua exatamente o comportamento seguro da Fase 12: executor
 * MOCK, nenhuma escrita real. A escrita real so acontece quando as TRES
 * condicoes sao verdadeiras ao mesmo tempo:
 *
 *   1. MITIGATION_EXECUTOR=HUAWEI
 *   2. MITIGATION_LIVE_WRITE_ENABLED=true
 *   3. o device alvo esta em MITIGATION_ALLOWED_DEVICE_IDS
 *
 * A leitura real (preflight/read-back) exige apenas (1) + (3): assim o operador
 * pode rodar o preflight READ-ONLY antes de habilitar qualquer escrita.
 *
 * Sem AUTO nesta entrega: nada aqui liga o worker; so o comando manual
 * (UI/n8n inbound) usa esta configuracao.
 */

export type MitigationExecutorKind = 'MOCK' | 'HUAWEI';

export interface MitigationExecutionConfig {
  executor: MitigationExecutorKind;
  liveWriteEnabled: boolean;
  allowedDeviceIds: readonly string[];
}

export type EnvLike = Record<string, string | undefined>;

function parseExecutor(raw: string | undefined): MitigationExecutorKind {
  // Qualquer valor desconhecido cai no MOCK (fail-closed).
  return raw?.trim().toUpperCase() === 'HUAWEI' ? 'HUAWEI' : 'MOCK';
}

function parseFlag(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'true';
}

function parseAllowlist(raw: string | undefined): string[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(values)];
}

export function mitigationExecutionConfigFromEnv(env: EnvLike = process.env): MitigationExecutionConfig {
  return {
    executor: parseExecutor(env.MITIGATION_EXECUTOR),
    liveWriteEnabled: parseFlag(env.MITIGATION_LIVE_WRITE_ENABLED),
    allowedDeviceIds: parseAllowlist(env.MITIGATION_ALLOWED_DEVICE_IDS),
  };
}

/** O device esta explicitamente autorizado (usado por leitura E escrita). */
export function isDeviceAllowed(
  config: MitigationExecutionConfig,
  deviceId: string | null | undefined,
): boolean {
  if (!deviceId) return false;
  return config.allowedDeviceIds.includes(deviceId);
}

/** Leitura real (preflight/read-back): executor HUAWEI + device na allowlist. */
export function canReadLive(
  config: MitigationExecutionConfig,
  deviceId: string | null | undefined,
): boolean {
  return config.executor === 'HUAWEI' && isDeviceAllowed(config, deviceId);
}

/** Escrita real: leitura real habilitada + flag explicita de escrita. */
export function canWriteLive(
  config: MitigationExecutionConfig,
  deviceId: string | null | undefined,
): boolean {
  return canReadLive(config, deviceId) && config.liveWriteEnabled;
}
