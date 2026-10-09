import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiOpticalCapability } from '../../../topology/huawei-optical';
import { huaweiGenericProfile } from './generic';

/**
 * Huawei CloudEngine S6750-H (YunShan OS, V600R024C00SPC500).
 *
 * Evidencia de campo 2026-10-09 (BHE-VTA-S6750-MPLS-01 e SPO-EQUINIX-6750-MPLS-01,
 * 100GE1/0/1):
 * - sysObjectID 1.3.6.1.4.1.2011.2.23.1247;
 * - .8/.9 em CENTI_DBM e iguais a LANE 0 (`1` = +0.01 dBm = lane0 do CSV);
 * - .32/.33 em CSV DECIMAL de dBm (`0.01,0.72,1.05,0.15`), sem /100;
 * - .31 bias em CSV decimal de mA;
 * - .13-.16 em centi-dBm, aplicaveis a todas as lanes do modulo;
 * - .20-.23 (WARNING) e .38-.41 (max/min) NAO existem no YunShan.
 *
 * Matcher ESTRITO de proposito: `/YunShan/` ou `/CloudEngine\s*S6/` sozinhos
 * classificariam qualquer Huawei moderno (S67xx/S57xx nao validados) como S6750
 * e trocariam o encoding do scalar para CENTI_DBM - o S6730 comprovado e
 * MICRO_WATTS. So entra com evidencia de S6750: modelo, sysDescr ou o
 * sysObjectID real acima (nunca por familia/serie generica).
 */
export const huaweiS6750Profile: SnmpProfile = {
  id: 'huawei-s6750',
  vendor: 'Huawei',
  family: 'S6750',
  priority: 240,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/S6750/i],
  sysObjectIdPatterns: [/^\.?1\.3\.6\.1\.4\.1\.2011\.2\.23\.1247$/],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  optical: huaweiOpticalCapability({
    scalarEncoding: 'CENTI_DBM',
    scalarSemantics: 'LANE_0',
    laneEncoding: 'DECIMAL_DBM',
    laneBiasEncoding: 'DECIMAL_MA',
    alarmThresholdEncoding: 'CENTI_DBM',
    warningThresholdEncoding: 'UNSUPPORTED',
    minMaxEncoding: 'UNSUPPORTED',
  }),
  cli: {
    // YunShan OS: diagnostico (potencia/bias/limites) em um unico comando.
    opticalDiagnosis: 'display interface {interface} transceiver verbose',
    version: 'display version',
  },
  metrics: huaweiGenericProfile.metrics,
};