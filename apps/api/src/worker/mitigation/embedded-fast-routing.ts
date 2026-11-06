import type { FastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';

/** AUTO-ALL is a dynamic telemetry scope, not a physical execution authorization. */
export function embeddedFastRoutingActive(profileId: string, config: FastPollerConfig): boolean {
  return (
    config.mode === 'ENFORCE' &&
    (config.autoAllEnforce === true || config.profileIds.includes(profileId))
  );
}
