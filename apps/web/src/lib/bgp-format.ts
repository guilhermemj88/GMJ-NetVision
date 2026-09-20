export function formatRouteCount(value: number | null): string {
  if (value === null || value === undefined) return '-';
  return value.toLocaleString('pt-BR');
}

/**
 * Formats an establishedSince timestamp as a compact operator-friendly uptime.
 * Returns '-' when the peer is not established or the timestamp is missing.
 */
export function formatBgpUptime(establishedSince: string | null): string {
  if (!establishedSince) return '-';
  const startedAt = Date.parse(establishedSince);
  if (!Number.isFinite(startedAt)) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

export function formatBgpTraffic(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '-';
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(1)}G`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(0)}M`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)}K`;
  return String(bps);
}
