import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiOpticalCapability } from '../../../topology/huawei-optical';
import { huaweiGenericProfile } from './generic';

export const huaweiS6730Profile: SnmpProfile = {
  id: 'huawei-s6730',
  vendor: 'Huawei',
  family: 'S6730',
  priority: 220,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/S6730/i],
  sysDescrPatterns: [/S6730/i],
  sysObjectIdPatterns: [/^\.?1\.3\.6\.1\.4\.1\.2011\.2\.23\.667$/],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  /**
   * S6730-H24X6C / VRP5 V200R022C00SPC500 (evidencia de campo 2026-10-09,
   * SPO-EQUINIX-6730-MPLS-01):
   * - .8/.9 em MICRO_WATTS e iguais a LANE 0 (`665 uW` = -1.77 dBm = lane0);
   * - .32/.33 em CSV DECIMAL de centi-dBm (`-176.79` = -1.7679 dBm);
   * - .31 bias em CSV decimal de mA (`42.76,42.76,42.76,42.76`);
   * - .13-.16 ALARM e .20-.23 WARNING, ambos centi-dBm (confirmado no CLI);
   * - .38-.41 (max/min) nao existem.
   */
  optical: huaweiOpticalCapability({
    scalarEncoding: 'MICRO_WATTS',
    scalarSemantics: 'LANE_0',
    laneEncoding: 'DECIMAL_CENTI_DBM',
    laneBiasEncoding: 'DECIMAL_MA',
    alarmThresholdEncoding: 'CENTI_DBM',
    warningThresholdEncoding: 'CENTI_DBM',
    minMaxEncoding: 'UNSUPPORTED',
  }),
  cli: {
    opticalDiagnosis: 'display transceiver diagnosis interface {interface}',
    opticalVerbose: 'display transceiver verbose interface {interface}',
    version: 'display version',
  },
  metrics: huaweiGenericProfile.metrics,
};