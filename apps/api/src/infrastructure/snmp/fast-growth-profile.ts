import type { FastTrafficTarget } from './fast-traffic-types';

/** The current AUTO contract uses integer percentages (BigInt), despite Prisma Float.
 * Reject unsupported values for presentation; never round or authorize a profile here.
 */
export function fastGrowthProfile(input: {
  profileId: string;
  direction: 'rx' | 'tx' | null;
  bandwidthBps: bigint | null | undefined;
  triggerPercent: number;
  recoveryPercent: number;
  recoverySamples: number;
}): FastTrafficTarget['profiles'][number] | undefined {
  if (
    typeof input.bandwidthBps !== 'bigint' ||
    input.bandwidthBps <= 0n ||
    !Number.isInteger(input.triggerPercent) ||
    input.triggerPercent <= 0 ||
    input.triggerPercent > 100 ||
    !Number.isInteger(input.recoveryPercent) ||
    input.recoveryPercent < 0 ||
    input.recoveryPercent >= input.triggerPercent ||
    !Number.isInteger(input.recoverySamples) ||
    input.recoverySamples <= 0
  )
    return undefined;
  return {
    profileId: input.profileId,
    direction: input.direction,
    bandwidthBps: input.bandwidthBps,
    thresholdBps: (input.bandwidthBps * BigInt(input.triggerPercent)) / 100n,
    triggerPercent: input.triggerPercent,
    recoveryThresholdBps: (input.bandwidthBps * BigInt(input.recoveryPercent)) / 100n,
    recoverySamples: input.recoverySamples,
  };
}

/** Runtime kill switch exclusively for the informational sidecar. Invalid = disabled. */
export function fastGrowthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.MITIGATION_FAST_GROWTH_ENABLED;
  return value === undefined || /^(1|true|yes|on)$/i.test(value.trim());
}
