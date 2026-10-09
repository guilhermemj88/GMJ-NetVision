import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiOpticalCapability } from '../../../topology/huawei-optical';

export const HUAWEI_ENTITY_NAME_OID = '1.3.6.1.2.1.47.1.1.1.1.7';
export const HUAWEI_ENTITY_CPU_USAGE_OID = '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5';

/**
 * Familia generica Huawei (VRP classico nao classificado): mantem o
 * comportamento historico - .8/.9 em MICRO_WATTS, lanes em dBm cru e WARNING
 * publicado. NUNCA assume scalar agregado: `scalarSemantics: 'UNKNOWN'` deixa o
 * motor optico no caminho legado (scalar comparavel) e o capability probe
 * confirma o que o equipamento realmente publica.
 */
export const huaweiGenericProfile: SnmpProfile = {
  id: 'huawei-generic',
  vendor: 'Huawei',
  family: 'VRP',
  priority: 100,
  vendorPatterns: [/huawei/i],
  sysDescrPatterns: [/huawei|vrp/i],
  sysObjectIdPatterns: [/^1\.3\.6\.1\.4\.1\.2011(?:\.|$)/],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  optical: huaweiOpticalCapability({
    scalarEncoding: 'MICRO_WATTS',
    scalarSemantics: 'UNKNOWN',
    laneEncoding: 'DECIMAL_DBM',
    laneBiasEncoding: 'DECIMAL_MA',
    alarmThresholdEncoding: 'CENTI_DBM',
    warningThresholdEncoding: 'CENTI_DBM',
    minMaxEncoding: 'UNSUPPORTED',
  }),
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