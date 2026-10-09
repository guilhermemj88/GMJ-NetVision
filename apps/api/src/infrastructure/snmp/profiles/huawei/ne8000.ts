import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiOpticalCapability } from '../../../topology/huawei-optical';
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
  sysObjectIdPatterns: [/^\.?1\.3\.6\.1\.4\.1\.2011\.2\.360(?:\.|$)/],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  /**
   * NE8000 F1A / VRP8 V800R022C00SPC600 (evidencia de campo 2026-10-09,
   * BHE-VTA-F1A-BGP-01):
   * - .8/.9 em CENTI-dBm e AGREGADOS: `601` = +6.01 dBm, que e a soma em mW das
   *   4 lanes do QSFP (o proprio equipamento nao publica scalar por lane);
   * - .32/.33 em CSV de INTEIROS centi-dBm (`29,-33,-14,14`), inclusive com um
   *   unico valor em porta de uma lane (`-326`);
   * - .31 nao implementado; .20-.23 (WARNING) e .38-.41 (max/min) existem.
   */
  optical: huaweiOpticalCapability({
    scalarEncoding: 'CENTI_DBM',
    scalarSemantics: 'AGGREGATED_LANES',
    laneEncoding: 'INT_CENTI_DBM',
    laneBiasEncoding: 'UNSUPPORTED',
    alarmThresholdEncoding: 'CENTI_DBM',
    warningThresholdEncoding: 'CENTI_DBM',
    minMaxEncoding: 'CENTI_DBM',
  }),
  cli: {
    // No NE8000-8H20Q o diagnostico por lane sai do proprio `display interface`
    // (potencias por lane e "Rx Warning range"); nao existe
    // `display transceiver diagnosis` valido nessa plataforma.
    opticalDiagnosis: 'display interface {interface}',
    version: 'display version',
  },
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
