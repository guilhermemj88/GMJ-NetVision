import type { BandwidthSource } from './mitigation-types';

export interface BandwidthParse {
  /** Banda em Gbps, ou `null` quando não identificada. */
  gbps: number | null;
  source: BandwidthSource;
}

/** Conjunto operacionalmente aceito (1–100 Gbps). Valores fora são rejeitados. */
const MIN_GBPS = 1;
const MAX_GBPS = 100;

/**
 * Extrai a banda contratada da descrição da interface.
 *
 * Aceita os formatos vistos em campo e variações comuns:
 *   HORIZONTE_IP_40GB · PLAY_CONNECT_10GB · CLIENTE_X_20GB · CLIENTE_Y_5GB
 *   "40 Gbps" · "40GB" · "40 GB" · "40g" · "40G"
 */
export function parseBandwidthGbpsFromDescription(description: string | null | undefined): BandwidthParse {
  const value = (description ?? '').trim();
  if (!value) return { gbps: null, source: 'UNKNOWN' };

  const match = value.match(/(\d{1,3})\s*(?:GBPS|GB|G)\b/i);
  if (!match) return { gbps: null, source: 'UNKNOWN' };

  const gbps = Number(match[1]);
  if (!Number.isInteger(gbps) || gbps < MIN_GBPS || gbps > MAX_GBPS) {
    return { gbps: null, source: 'UNKNOWN' };
  }
  return { gbps, source: 'DESCRIPTION' };
}

/** Banda em Gbps → bps. */
export function gbpsToBps(gbps: number): number {
  return gbps * 1_000_000_000;
}

/** Formata bps de forma compacta para a UI (ex.: "38.7 Gbps"). */
export function formatTrafficGbps(bps: number): string {
  if (!Number.isFinite(bps)) return '—';
  const gbps = bps / 1_000_000_000;
  if (gbps >= 100) return `${gbps.toFixed(0)} Gbps`;
  if (gbps >= 10) return `${gbps.toFixed(1)} Gbps`;
  return `${gbps.toFixed(2)} Gbps`;
}
