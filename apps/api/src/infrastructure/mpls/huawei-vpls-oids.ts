export const HUAWEI_VPLS_VSI_ENTRY_OID = '1.3.6.1.4.1.2011.5.25.119.1.1.1.1';
export const HUAWEI_VPLS_PW_ENTRY_OID = '1.3.6.1.4.1.2011.5.25.119.1.1.5.1';

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
