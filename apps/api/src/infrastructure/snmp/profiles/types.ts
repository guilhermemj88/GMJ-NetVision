import type { HuaweiOpticalCapability } from '../../topology/huawei-optical';

export type SnmpProfileMetricName = 'cpu' | 'memory' | 'temperature';

export interface SnmpProfileIdentity {
  vendor?: string;
  model?: string;
  sysObjectId?: string;
  sysDescr?: string;
  sysName?: string;
  /**
   * Versao/plataforma coletadas quando disponiveis (HUAWEI-DEVICE-EXT-MIB).
   * Servem para diagnostico/auditoria e para um futuro override por versao —
   * NUNCA como unico criterio de selecao do decoder.
   */
  softwareVersion?: string;
  platformVersion?: string;
  productVersion?: string;
  productModel?: string;
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
   * Capability optica declarativa da plataforma (HUAWEI-ENTITY-EXTENT-MIB).
   * Ausente = o profile NAO declara leitura optica por essa MIB (nenhum walk e
   * feito e nada e decodificado) — nunca se assume o encoding de outra familia.
   * O runtime confirma/refina com o capability probe por equipamento.
   */
  optical?: HuaweiOpticalCapability;
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
