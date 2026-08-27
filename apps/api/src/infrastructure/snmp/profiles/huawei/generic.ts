import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';

export const HUAWEI_ENTITY_NAME_OID = '1.3.6.1.2.1.47.1.1.1.1.7';
export const HUAWEI_ENTITY_CPU_USAGE_OID = '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5';

export const huaweiGenericProfile: SnmpProfile = {
  id: 'huawei-generic',
  vendor: 'Huawei',
  family: 'VRP',
  priority: 100,
  vendorPatterns: [/huawei/i],
  sysDescrPatterns: [/huawei|vrp/i],
  sysObjectIdPatterns: [/^1\.3\.6\.1\.4\.1\.2011(?:\.|$)/],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  metrics: {
    cpu: {
      unit: '%',
      candidates: [{
        oid: HUAWEI_ENTITY_CPU_USAGE_OID,
        type: 'gauge-table',
        scale: 1,
        validRange: { min: 0, max: 100 },
        selection: 'PREFERRED_ENTITY',
        entityNameOid: HUAWEI_ENTITY_NAME_OID,
        preferredEntityPatterns: [/\bMPU\b/i, /main processing unit/i, /\bSRU\b/i, /control board/i, /^system$/i],
        description: 'CPU da entidade principal correlacionada por entPhysicalIndex',
        sourceUrl: 'https://info.support.huawei.com/enterprise/en/doc/EDOC1100306132/e704d4b7/mib-example',
      }],
    },
  },
};
