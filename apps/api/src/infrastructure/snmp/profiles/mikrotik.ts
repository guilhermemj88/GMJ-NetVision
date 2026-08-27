import type { SnmpProfile } from './types';
import { MIKROTIK_PPP_ONLINE_OID } from './ppp-oids';

/**
 * MikroTik RouterOS profile. MikroTik exposes PPP/PPPoE active sessions via the
 * standard AAA session MIB scalar (validated against real equipment).
 */
export const mikrotikProfile: SnmpProfile = {
  id: 'mikrotik',
  vendor: 'MikroTik',
  family: 'RouterOS',
  priority: 200,
  vendorPatterns: [/mikrotik|routeros/i],
  sysDescrPatterns: [/routeros|mikrotik/i],
  sysObjectIdPatterns: [/^1\.3\.6\.1\.4\.1\.14988(?:\.|$)/],
  metrics: {},
  pppOnlineOid: MIKROTIK_PPP_ONLINE_OID,
};
