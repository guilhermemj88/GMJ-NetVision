import type { Alarm } from '@gmj/shared';

export interface AlarmOpenInput {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  startedAt: Date;
}

export interface AlarmHistoryOptions {
  /**
   * When true, return only resolved alarms (endedAt is not null), ordered by
   * resolution time, most recent first. Otherwise return every alarm ordered by
   * start time, most recent first.
   */
  resolvedOnly?: boolean;
}

export interface AlarmRepository {
  /** Alarms that are still open (endedAt is null). */
  listActive(): Promise<Alarm[]>;
  /** Alarms ordered by start time, most recent first (see options for resolved). */
  listHistory(limit: number, options?: AlarmHistoryOptions): Promise<Alarm[]>;
  /** Which of the given interfaces belong to at least one map link. */
  findLinkedInterfaceIds(interfaceIds: string[]): Promise<Set<string>>;
  /**
   * Persists one INTERFACE_DOWN/CRITICAL alarm per interface, ignoring any
   * interface that already has an open alarm (no duplicates).
   */
  openInterfaceDownAlarms(inputs: AlarmOpenInput[]): Promise<Alarm[]>;
  /** Closes every open INTERFACE_DOWN alarm for the given interfaces. */
  resolveInterfaceDownAlarms(interfaceIds: string[], resolvedAt: Date): Promise<void>;
}
