import { randomUUID } from 'node:crypto';
import { evaluateTrafficRate } from './traffic-rate';
import type {
  FastCounterReading,
  FastTrafficObservation,
  FastTrafficQuality,
  FastTrafficTarget,
} from './fast-traffic-types';

/** Counter64 decreasing is rebased, including wrap: it must never confirm an attack. */
export function deriveFastTraffic(
  target: FastTrafficTarget,
  current: FastCounterReading,
  previous: FastCounterReading | undefined,
  generation: string,
  maxIntervalMs = 15_000,
  maxRequestMs = 2_500,
): FastTrafficObservation {
  const intervalMs = previous
    ? current.collectedAt.getTime() - previous.collectedAt.getTime()
    : null;
  let quality: FastTrafficQuality = 'VALID';
  let rxBps: number | null = null;
  let txBps: number | null = null;
  if (
    current.deviceId !== target.deviceId ||
    current.interfaceId !== target.interfaceId ||
    current.ifIndex !== target.ifIndex ||
    current.interfaceName !== target.interfaceName
  )
    quality = 'IDENTITY_MISMATCH';
  else if (
    current.collectedAt.getTime() - current.requestStartedAt.getTime() > maxRequestMs ||
    current.collectedAt < current.requestStartedAt
  )
    quality = 'LATE_RESPONSE';
  else if (current.adminStatus !== 1) quality = 'ADMIN_DOWN';
  else if (current.operStatus !== 1) quality = 'OPER_DOWN';
  else if (!previous) quality = 'BASELINE';
  else if (intervalMs === null || intervalMs <= 0) quality = 'OUT_OF_ORDER';
  else if (previous.ifIndex !== current.ifIndex || previous.interfaceName !== current.interfaceName)
    quality = 'IDENTITY_MISMATCH';
  else if (current.uptimeTicks <= previous.uptimeTicks) quality = 'RESTART';
  else if (current.discontinuityTicks !== previous.discontinuityTicks) quality = 'DISCONTINUITY';
  else if (
    previous.adminStatus !== 1 ||
    previous.operStatus !== 1 ||
    current.lastChangeTicks !== previous.lastChangeTicks
  )
    quality = 'STATE_TRANSITION';
  else if (intervalMs > maxIntervalMs) quality = 'STALE_INTERVAL';
  else {
    const rate = evaluateTrafficRate({
      currentInOctets: current.inOctets,
      currentOutOctets: current.outOctets,
      previousInOctets: previous.inOctets,
      previousOutOctets: previous.outOctets,
      seconds: intervalMs / 1000,
      speedBps: current.speedBps,
    });
    if (!rate.usable) quality = rate.reason ?? 'DISCONTINUITY';
    else {
      rxBps = rate.rxBps;
      txBps = rate.txBps;
    }
  }
  return {
    ...current,
    id: randomUUID(),
    generation,
    previousCollectedAt: previous?.collectedAt ?? null,
    intervalMs,
    rxBps,
    txBps,
    quality,
  };
}
