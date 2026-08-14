export function formatBitsPerSecond(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} Gbps`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} Kbps`;
  return `${value.toFixed(0)} bps`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return `${days}d ${hours}h`;
}

export function utilizationTone(value: number): 'quiet' | 'normal' | 'busy' | 'strong' | 'alert' {
  if (value < 20) return 'quiet';
  if (value < 50) return 'normal';
  if (value < 80) return 'busy';
  if (value < 95) return 'strong';
  return 'alert';
}

export function clampUtilization(value: number): number {
  return Math.max(0, Math.min(100, value));
}
