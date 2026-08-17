import type { SnmpProfile } from '../types';
import { HUAWEI_ENTITY_CPU_USAGE_OID, HUAWEI_ENTITY_NAME_OID } from './generic';

export const HUAWEI_AVG_CPU_1MIN_OID = '1.3.6.1.4.1.2011.6.3.4.1.3';

export const huaweiNe8000Profile: SnmpProfile = {
  id: 'huawei-ne8000',
  vendor: 'Huawei',
  family: 'NE8000',
  priority: 300,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/NE\s*8000/i, /F1A(?:-C)?/i],
  sysDescrPatterns: [/NetEngine\s*8000/i, /NE\s*8000/i],
  metrics: {
    cpu: {
      unit: '%',
      candidates: [
        {
          oid: HUAWEI_ENTITY_CPU_USAGE_OID,
          type: 'gauge-table',
          scale: 1,
          validRange: { min: 0, max: 100 },
          selection: 'PREFERRED_ENTITY',
          entityNameOid: HUAWEI_ENTITY_NAME_OID,
          preferredEntityPatterns: [/\bMPU\b/i, /main processing unit/i, /\bSRU\b/i, /control board/i, /^system$/i],
          description: 'CPU da MPU/entidade principal via HUAWEI-ENTITY-EXTENT-MIB',
          sourceUrl: 'https://info.support.huawei.com/enterprise/en/doc/EDOC1100306132/e704d4b7/mib-example',
        },
        {
          oid: HUAWEI_AVG_CPU_1MIN_OID,
          type: 'gauge-table',
          scale: 1,
          validRange: { min: 0, max: 100 },
          selection: 'SINGLE_VALID_ROW',
          description: 'Média de CPU de 1 minuto; aceita somente uma instância inequívoca',
          sourceUrl: 'https://info.support.huawei.com/hedex/api/pages/EDOC1100363264/AEN0403J/06/resources/mib/yunshan/dc_8090_HUAWEI-DEVICE-MIB_mibtable_1.3.6.1.4.1.2011.6.3.4.html',
        },
      ],
    },
  },
};
