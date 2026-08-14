import type { LinkThresholds, UtilizationLevel } from './types';

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

export const DEFAULT_LINK_THRESHOLDS: LinkThresholds = {
  attention: 40,
  high: 70,
  critical: 90,
  maximum: 100,
};

export function calculateUtilization(bps: number, capacityBps: number): number {
  if (capacityBps <= 0) return 0;
  return Math.max(0, (bps / capacityBps) * 100);
}

export function utilizationLevel(
  value: number,
  thresholds: LinkThresholds = DEFAULT_LINK_THRESHOLDS,
): UtilizationLevel {
  if (value > thresholds.maximum) return 'INCONSISTENT';
  if (value >= thresholds.critical) return 'CRITICAL';
  if (value >= thresholds.high) return 'HIGH';
  if (value >= thresholds.attention) return 'ATTENTION';
  return 'NORMAL';
}
