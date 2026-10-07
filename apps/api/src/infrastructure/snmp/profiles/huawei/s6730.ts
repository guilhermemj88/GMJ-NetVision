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
  // Evidencia real (BHE-VTA-6730-MPLS-01): .8/.9 em MICRO_WATTS e .13-.16 em
  // centi-dBm (raw / 100).
  opticalScalarEncoding: 'MICRO_WATTS',
  metrics: huaweiGenericProfile.metrics,
};
