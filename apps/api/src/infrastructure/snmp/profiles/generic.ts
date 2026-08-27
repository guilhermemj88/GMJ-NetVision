import type { SnmpProfile } from './types';
import { GENERIC_INTERFACE_OIDS, GENERIC_SYSTEM_OIDS } from './generic-oids';

export const genericProfile: SnmpProfile = {
  id: 'generic',
  vendor: 'Generic',
  family: 'Generic',
  priority: 0,
  metrics: {},
  systemOids: GENERIC_SYSTEM_OIDS,
  interfaceOids: GENERIC_INTERFACE_OIDS,
};
