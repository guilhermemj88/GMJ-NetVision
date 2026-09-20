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

/** Formats an incident duration in seconds as a compact "4m12s" / "1h05m" / "18d04h". */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/** Compact HH:mm:ss clock for a timestamp. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Short relative freshness, e.g. "há 42s", "há 3m". */
export function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours}h`;
}
