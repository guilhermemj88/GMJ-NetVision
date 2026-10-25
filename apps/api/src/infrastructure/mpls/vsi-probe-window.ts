/** Private, explicitly authorized homologation window. Never accepts CLI text or arbitrary IPs. */
export const PROBE_WINDOW_TARGETS = Object.freeze({
  LOCAL: Object.freeze({
    hostId: 'host-fd85f870-8f1c-4ff8-9b3c-e8077b10cf3c',
    name: 'BHE-VTA-6730-MPLS-01',
    source: '10.100.101.0',
    destination: '10.100.101.255',
    fingerprint: 'SHA256:ttovy+0oG3kpC+dO0KhcN+RGUOHemebeIWZenOE7tzg',
    platform: 'VRP_V200',
  }),
  REMOTE: Object.freeze({
    hostId: 'host-f995bc3c-1ffa-4f1b-adf5-ffb0578528b4',
    name: 'BHE-VTA-S6750-MPLS-01',
    source: '10.100.101.255',
    destination: '10.100.101.0',
    fingerprint: 'SHA256:OXJzyxUT3sO8G7u8D/gSy7kG9AAR3iV3G/wMsGNsMm8',
    platform: 'YUNSHAN_V600',
  }),
});
export type ProbeDirection = keyof typeof PROBE_WINDOW_TARGETS;
export function probeWindowCommand(direction: ProbeDirection, operation: 'PING' | 'TRACE'): string {
  if (!Object.hasOwn(PROBE_WINDOW_TARGETS, direction) || !['PING', 'TRACE'].includes(operation))
    throw new Error('PROBE_WINDOW_POLICY_BLOCKED');
  const t = PROBE_WINDOW_TARGETS[direction];
  return operation === 'PING'
    ? `ping -a ${t.source} -c 3 ${t.destination}`
    : `tracert -a ${t.source} -m 8 -q 1 ${t.destination}`;
}
