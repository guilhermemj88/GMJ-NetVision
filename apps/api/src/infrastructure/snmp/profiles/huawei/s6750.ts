import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiGenericProfile } from './generic';

/**
 * Huawei CloudEngine S6750-H (YunShan OS, V600R024C00SPC500).
 *
 * Evidencia real (BHE-VTA-S6750-MPLS-01 / 100GE1/0/1):
 * - sysObjectID 1.3.6.1.4.1.2011.2.23.1247;
 * - .8/.9 em CENTI_DBM (18 => +0.18 dBm; -74 => -0.74 dBm);
 * - .13-.16 em centi-dBm, aplicaveis a todas as lanes do modulo;
 * - .31/.32/.33 continuam sendo a autoridade multi-lane (CSV em dBm).
 *
 * Matcher ESTRITO de proposito: `/YunShan/` ou `/CloudEngine\s*S6/` sozinhos
 * classificariam qualquer Huawei moderno (S67xx/S57xx nao validados) como S6750
 * e trocariam o encoding do scalar para CENTI_DBM — o S6730 comprovado e
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
  opticalScalarEncoding: 'CENTI_DBM',
  // YunShan ja entrega o CSV de lane em dBm (real: 0.19,0.69,1.02,0.11) — nao
  // dividir por 100.
  opticalLaneEncoding: 'DBM',
  metrics: huaweiGenericProfile.metrics,
};
