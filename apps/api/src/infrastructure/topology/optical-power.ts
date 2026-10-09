export const MIN_OPTICAL_DBM = -60;
export const MAX_OPTICAL_DBM = 20;

/** Casas decimais do caminho SSH/legado (texto do equipamento). */
export const OPTICAL_DBM_DECIMALS = 2;

/**
 * Casas decimais do caminho SNMP Huawei: preserva a resolucao crua do vendor.
 * Um CSV em centi-dBm com 2 casas (`-176.79`) tem 4 casas em dBm (`-1.7679`);
 * arredondar para 2 aqui perderia resolucao do proprio equipamento.
 */
export const SNMP_OPTICAL_DBM_DECIMALS = 4;

export function normalizeOpticalDbm(
  value: unknown,
  decimals: number = OPTICAL_DBM_DECIMALS,
): number | null {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric) || numeric < MIN_OPTICAL_DBM || numeric > MAX_OPTICAL_DBM) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(numeric * factor) / factor;
}

export function microWattsToDbm(
  value: unknown,
  decimals: number = OPTICAL_DBM_DECIMALS,
): number | null {
  const microWatts = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(microWatts) || microWatts <= 0) return null;
  return normalizeOpticalDbm(10 * Math.log10(microWatts / 1000), decimals);
}
