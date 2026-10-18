/** A raw GET and its derived rate are one immutable observation. Never a UI rate. */
export type FastTrafficQuality =
  | 'VALID'
  | 'BASELINE'
  | 'SNMP_ERROR'
  | 'LATE_RESPONSE'
  | 'IDENTITY_MISMATCH'
  | 'ADMIN_DOWN'
  | 'OPER_DOWN'
  | 'STATE_TRANSITION'
  | 'RESTART'
  | 'DISCONTINUITY'
  | 'ABOVE_CAPACITY'
  | 'STALE_INTERVAL'
  | 'OUT_OF_ORDER';

export interface FastTrafficTarget {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  interfaceName: string;
  /** Hardware/aggregate capacity; never the contract used by the engine. */
  speedBps: bigint | null;
  profiles: Array<{
    profileId: string;
    direction: 'rx' | 'tx';
    thresholdBps: bigint;
    bandwidthBps?: bigint;
  }>;
}

export interface FastCounterReading {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  interfaceName: string;
  requestStartedAt: Date;
  collectedAt: Date;
  inOctets: bigint;
  outOctets: bigint;
  uptimeTicks: bigint;
  discontinuityTicks: bigint;
  lastChangeTicks: bigint;
  adminStatus: number;
  operStatus: number;
  speedBps: bigint | null;
}

export interface FastTrafficObservation extends FastCounterReading {
  id: string;
  generation: string;
  previousCollectedAt: Date | null;
  intervalMs: number | null;
  rxBps: number | null;
  txBps: number | null;
  quality: FastTrafficQuality;
}

export interface FastTrafficStore {
  /** Must reject duplicate/out-of-order commits and mapping changes atomically. */
  append(observation: FastTrafficObservation): Promise<boolean>;
  latest(interfaceId: string): Promise<FastTrafficObservation | null>;
}

export interface FastTrafficReader {
  /** A single batch GET: sysUpTime + HC octets, identity, state and continuity. */
  read(targets: FastTrafficTarget[]): Promise<FastCounterReading[]>;
}
