export const HUAWEI_VPLS_VSI_ENTRY_OID = '1.3.6.1.4.1.2011.5.25.119.1.1.1.1';
export const HUAWEI_VPLS_PW_ENTRY_OID = '1.3.6.1.4.1.2011.5.25.119.1.1.5.1';
export const HUAWEI_VPLS_AC_ENTRY_OID = '1.3.6.1.4.1.2011.5.25.119.1.1.3.1';

export const HUAWEI_VPLS_VSI_COLUMNS = {
  signalingType: 2,
  rd: 3,
  vsiId: 4,
  vcType: 5,
  operationalStatus: 6,
  mtu: 7,
  tunnelPolicy: 8,
  description: 9,
  adminStatus: 33,
} as const;

export const HUAWEI_VPLS_PW_COLUMNS = {
  tunnelPolicy: 3,
  pwType: 4,
  inboundLabel: 6,
  outboundLabel: 7,
  status: 8,
  upStartTime: 11,
  upSumTime: 12,
  state: 13,
  workingState: 14,
} as const;

export const HUAWEI_VPLS_AC_COLUMNS = {
  status: 2,
  upStartTime: 3,
  upSumTime: 4,
} as const;

// Keep these lists explicit: every entry becomes an independent SNMP walk.
// Besides the required operational fields, only values currently consumed by
// the API/UI are collected.
export const HUAWEI_VPLS_VSI_WALK_COLUMNS = [
  HUAWEI_VPLS_VSI_COLUMNS.signalingType,
  HUAWEI_VPLS_VSI_COLUMNS.rd,
  HUAWEI_VPLS_VSI_COLUMNS.vsiId,
  HUAWEI_VPLS_VSI_COLUMNS.vcType,
  HUAWEI_VPLS_VSI_COLUMNS.operationalStatus,
  HUAWEI_VPLS_VSI_COLUMNS.mtu,
  HUAWEI_VPLS_VSI_COLUMNS.tunnelPolicy,
  HUAWEI_VPLS_VSI_COLUMNS.adminStatus,
] as const;

export const HUAWEI_VPLS_PW_WALK_COLUMNS = [
  HUAWEI_VPLS_PW_COLUMNS.tunnelPolicy,
  HUAWEI_VPLS_PW_COLUMNS.pwType,
  HUAWEI_VPLS_PW_COLUMNS.inboundLabel,
  HUAWEI_VPLS_PW_COLUMNS.outboundLabel,
  HUAWEI_VPLS_PW_COLUMNS.status,
  HUAWEI_VPLS_PW_COLUMNS.upStartTime,
  HUAWEI_VPLS_PW_COLUMNS.upSumTime,
  HUAWEI_VPLS_PW_COLUMNS.state,
  HUAWEI_VPLS_PW_COLUMNS.workingState,
] as const;

export const HUAWEI_VPLS_AC_WALK_COLUMNS = [
  HUAWEI_VPLS_AC_COLUMNS.status,
  HUAWEI_VPLS_AC_COLUMNS.upStartTime,
  HUAWEI_VPLS_AC_COLUMNS.upSumTime,
] as const;
