export type SnmpProfileMetricName = 'cpu' | 'memory' | 'temperature';

export interface SnmpProfileIdentity {
  vendor?: string;
  model?: string;
  sysObjectId?: string;
  sysDescr?: string;
  sysName?: string;
}

export interface SnmpMetricCandidate {
  oid: string;
  type: 'gauge-table';
  scale: number;
  validRange: { min: number; max: number };
  selection: 'SINGLE_VALID_ROW' | 'PREFERRED_ENTITY';
  entityNameOid?: string;
  preferredEntityPatterns?: RegExp[];
  description: string;
  sourceUrl: string;
}

export interface SnmpMetricDefinition {
  unit: '%' | 'celsius';
  candidates: SnmpMetricCandidate[];
}

export interface SnmpProfile {
  id: string;
  vendor: string;
  family: string;
  priority: number;
  vendorPatterns?: RegExp[];
  modelPatterns?: RegExp[];
  sysDescrPatterns?: RegExp[];
  sysObjectIdPatterns?: RegExp[];
  metrics: Partial<Record<SnmpProfileMetricName, SnmpMetricDefinition>>;
  /**
   * Scalar OID for the PPP/PPPoE online counter (capability based). When the
   * selected profile does not declare it, the device is treated as not
   * supporting PPP polling — no value is ever invented.
   */
  pppOnlineOid?: string;
  /** Universal SNMPv2-MIB base OIDs (complemented by specific profiles). */
  systemOids?: Readonly<Record<string, string>>;
  /** Universal IF-MIB base OIDs (complemented by specific profiles). */
  interfaceOids?: Readonly<Record<string, string>>;
}

export interface SnmpCandidateAttempt {
  oid: string;
  status: 'SELECTED' | 'NO_DATA' | 'INVALID_VALUE' | 'AMBIGUOUS' | 'ERROR';
  value?: number;
  rows?: number;
}

export interface SnmpProfileDiagnostic {
  deviceId: string;
  profileId: string;
  identity: SnmpProfileIdentity;
  metrics: Partial<Record<SnmpProfileMetricName, {
    attempts: SnmpCandidateAttempt[];
    selectedOid: string | null;
    value: number | null;
    unit: string;
  }>>;
  checkedAt: string;
}
