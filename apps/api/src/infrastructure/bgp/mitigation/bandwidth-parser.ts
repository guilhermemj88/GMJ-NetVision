import type { BandwidthSource } from './mitigation-types';

/**
 * Banda operacional tem UMA fonte canônica: bits por segundo (bps), em `bigint`.
 *
 * Gbps existe apenas como representação de UI/API — nunca é armazenado como
 * fonte de verdade. Nada de Float/Decimal para banda operacional.
 */

const BPS_PER_GBPS = 1_000_000_000n;

/** Conjunto operacionalmente aceito (1–100 Gbps). Valores fora são rejeitados. */
const MIN_GBPS = 1;
const MAX_GBPS = 100;

export interface BandwidthParse {
  /** Banda em bits por segundo (fonte canônica), ou `null` quando não identificada. */
  bps: bigint | null;
  source: BandwidthSource;
}

/** Banda detectada + override manual — shape mínimo para calcular a banda efetiva. */
export interface BandwidthOverridePair {
  detectedBandwidthBps: bigint | null;
  bandwidthOverrideBps: bigint | null;
}

/** Gbps (entrada/UI) → bps (canônico). */
export function gbpsToBps(gbps: number): bigint {
  return BigInt(Math.round(gbps * 1_000_000_000));
}

/** bps (canônico) → Gbps (apenas para exibição/UI). */
export function bpsToGbps(bps: bigint): number {
  return Number(bps) / 1_000_000_000;
}

/**
 * Banda efetiva do perfil: o override do operador vence a banda detectada.
 * É sempre calculada no domínio — nunca persistida, para não criar uma segunda
 * fonte de verdade.
 */
export function effectiveBandwidthBps(input: BandwidthOverridePair): bigint | null {
  return input.bandwidthOverrideBps ?? input.detectedBandwidthBps;
}

/**
 * Extrai a banda contratada da descrição da interface e devolve bps.
 *
 * Aceita os formatos vistos em campo e variações comuns:
 *   HORIZONTE_IP_40GB · PLAY_CONNECT_10GB · CLIENTE_X_20GB · CLIENTE_Y_5GB
 *   "40 Gbps" · "40GB" · "40 GB" · "40g" · "40G"
 */
export function parseBandwidthBpsFromDescription(
  description: string | null | undefined,
): BandwidthParse {
  const value = (description ?? '').trim();
  if (!value) return { bps: null, source: 'UNKNOWN' };

  const match = value.match(/(\d{1,3})\s*(?:GBPS|GB|G)\b/i);
  if (!match) return { bps: null, source: 'UNKNOWN' };

  const gbps = Number(match[1]);
  if (!Number.isInteger(gbps) || gbps < MIN_GBPS || gbps > MAX_GBPS) {
    return { bps: null, source: 'UNKNOWN' };
  }
  return { bps: gbpsToBps(gbps), source: 'DESCRIPTION' };
}

/** Formata bps de forma compacta para a UI (ex.: "38.7 Gbps"). */
export function formatTrafficGbps(bps: bigint | null): string {
  if (bps === null) return '—';
  const gbps = bpsToGbps(bps);
  if (!Number.isFinite(gbps)) return '—';
  if (gbps >= 100) return `${gbps.toFixed(0)} Gbps`;
  if (gbps >= 10) return `${gbps.toFixed(1)} Gbps`;
  return `${gbps.toFixed(2)} Gbps`;
}

export { BPS_PER_GBPS };
