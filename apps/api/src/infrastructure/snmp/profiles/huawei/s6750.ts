import type { SnmpProfile } from '../types';
import { HUAWEI_PPP_ONLINE_OID } from '../ppp-oids';
import { huaweiGenericProfile } from './generic';

/**
 * Huawei CloudEngine S6750-H (YunShan OS, V600R024...).
 *
 * Evidencia real (BHE-VTA-S6750-MPLS-01 / 100GE1/0/1):
 * - .8/.9 em CENTI_DBM (18 => +0.18 dBm; -74 => -0.74 dBm);
 * - .13-.16 em centi-dBm, aplicaveis a todas as lanes do modulo;
 * - .31/.32/.33 continuam sendo a autoridade multi-lane (CSV em dBm).
 */
export const huaweiS6750Profile: SnmpProfile = {
  id: 'huawei-s6750',
  vendor: 'Huawei',
  family: 'S6750',
  priority: 240,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/S6750/i],
  sysDescrPatterns: [/S6750/i, /YunShan/i, /CloudEngine\s*S6/i],
  pppOnlineOid: HUAWEI_PPP_ONLINE_OID,
  opticalScalarEncoding: 'CENTI_DBM',
  metrics: huaweiGenericProfile.metrics,
};
