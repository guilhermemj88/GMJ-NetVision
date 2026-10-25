import type { HostRecord, MplsCapabilities, MplsHostOverview, MplsVsi } from '@gmj/shared';

/** A diagnostic snapshot expires independently of the SSH/profile authorization window. */
export const VSI_INVENTORY_MAX_AGE_MS = 5 * 60_000;
export type VsiInventoryOverview = Omit<MplsHostOverview, 'capabilities'> & {
  capabilities: Omit<MplsCapabilities, 'pw'> & { pw: boolean | null | undefined };
};
export class VsiInventoryError extends Error {}
export interface PwSnmpLimitation {
  code: 'PW_EVIDENCE_UNAVAILABLE_VIA_SNMP';
  hostId: string;
  observedAt: string;
  pwSupported: false;
}

/** Pure pre-execution gate: no network, mutation, label inference or persistence. */
export function precheckVsiInventory(input: {
  host: HostRecord;
  peer: HostRecord;
  vsi: MplsVsi | undefined;
  overview: VsiInventoryOverview | null | undefined;
  expectedName: string;
  now: number;
}): PwSnmpLimitation | null {
  const { host, peer, vsi, overview, expectedName, now } = input;
  const fail = (code: string): never => {
    throw new VsiInventoryError(code);
  };
  if (!vsi || vsi.hostId !== host.id || vsi.name !== expectedName)
    return fail('PERSISTED_VSI_IDENTITY_MISMATCH');
  if (
    !overview ||
    overview.supported !== true ||
    overview.capabilities.vsi !== true ||
    overview.lastErrorSafe !== null ||
    overview.source !== 'SNMP' ||
    vsi.source !== 'SNMP'
  )
    return fail('INVENTORY_EVIDENCE_INSUFFICIENT');
  const fresh = (stamp: string | null) => {
    const at = Date.parse(stamp ?? '');
    return (
      Number.isFinite(now) &&
      Number.isFinite(at) &&
      at <= now &&
      now - at <= VSI_INVENTORY_MAX_AGE_MS
    );
  };
  if (
    !fresh(overview.lastPollingAt) ||
    !fresh(overview.lastSuccessAt) ||
    !fresh(vsi.lastSeenAt) ||
    Date.parse(overview.lastPollingAt!) > Date.parse(overview.lastSuccessAt!)
  )
    return fail('INVENTORY_STALE_OR_INCOMPLETE');
  const capability = overview.capabilities.pw;
  if (capability !== true && capability !== false) return fail('PW_SNMP_CAPABILITY_UNKNOWN');
  if (capability === false) {
    if (vsi.pws.length !== 0) return fail('PERSISTED_PW_CAPABILITY_CONFLICT');
    return {
      code: 'PW_EVIDENCE_UNAVAILABLE_VIA_SNMP',
      hostId: host.id,
      observedAt: overview.lastSuccessAt!,
      pwSupported: false,
    };
  }
  if (vsi.pws.length !== 1) return fail('PERSISTED_PW_CARDINALITY_MISMATCH');
  const pw = vsi.pws[0]!;
  if (
    pw.hostId !== host.id ||
    pw.mplsVsiId !== vsi.id ||
    pw.vsiName !== vsi.name ||
    !fresh(pw.lastSeenAt)
  )
    return fail('PERSISTED_PW_INVENTORY_MISMATCH');
  if (
    (pw.remoteHostId !== null && pw.remoteHostId !== peer.id) ||
    ![peer.ip, peer.managementIp].includes(pw.remoteIp)
  )
    return fail('PERSISTED_PEER_IP_MISMATCH');
  return null;
}
