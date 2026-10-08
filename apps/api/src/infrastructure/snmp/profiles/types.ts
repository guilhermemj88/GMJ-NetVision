import type {
  HuaweiOpticalLaneEncoding,
  HuaweiOpticalScalarEncoding,
  HuaweiOpticalWarningEncoding,
} from '../../topology/huawei-optical';

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
   * Encoding do campo RAW da potencia scalarem .8/.9 da
   * HUAWEI-ENTITY-EXTENT-MIB (uW no VRP classico, centi-dBm no YunShan).
   * Ausente/UNKNOWN = nao decodifica scalar (nunca adivinha por sinal).
   */
  opticalScalarEncoding?: HuaweiOpticalScalarEncoding;
  /**
   * Encoding das colunas CSV de potencia POR LANE (.32/.33). Ausente/UNKNOWN =
   * nao decodifica potencia de lane (bias continua valido); nunca adivinha a
   * unidade pelo tamanho do numero.
   */
  opticalLaneEncoding?: HuaweiOpticalLaneEncoding;
  /**
   * Familia publica os thresholds de WARNING (.20-.23)? `ABSENT` = nem varre os
   * OIDs (YunShan/S6750 nao tem as colunas) â€” ausencia legitima, nunca copia do
   * ALARM.
   */
  opticalWarningEncoding?: HuaweiOpticalWarningEncoding;
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
