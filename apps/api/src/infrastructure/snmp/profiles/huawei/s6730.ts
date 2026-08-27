import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiGenericProfile } from './generic';

export const huaweiS6730Profile: SnmpProfile = {
  id: 'huawei-s6730',
  vendor: 'Huawei',
  family: 'S6730',
  priority: 220,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/S6730/i],
  sysDescrPatterns: [/S6730/i],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  metrics: huaweiGenericProfile.metrics,
};
