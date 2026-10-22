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

/**
 * Dialeto CLI READ-ONLY da familia (evidencia de campo 2026-10-09).
 * `{interface}` = nome da porta exatamente como publicado no SNMP.
 * O polling SNMP nao executa nenhum destes comandos: a declaracao existe para
 * o fallback SSH/diagnostico e para auditoria do que foi validado em campo.
 */
export interface SnmpCliDialect {
  /** Diagnostico optico (potencia por lane, thresholds, bias). */
  opticalDiagnosis?: string;
  /** Variante verbosa, quando a plataforma exige outro comando. */
  opticalVerbose?: string;
  /** Versao/software da plataforma. */
  version?: string;
}

/**
 * Capability declarativa de contagem PPPoE via subscriber table. Os valores de
 * enum sao os comprovados em campo (Junos 19.2R1.8 e 19.4R3-S10.3).
 */
export interface PppSubscriberTableCapability {
  source: 'SNMP_JUNIPER';
  clientTypeOid: string;
  stateOid: string;
  clientTypePppoe: number;
  stateActive: number;
  intervalSeconds: number;
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
   * Comandos CLI read-only validados em campo nesta familia. Apenas metadata:
   * a camada optica decide o que ler por SNMP/SSH, nunca executa isto sozinha.
   */
  cli?: SnmpCliDialect;
  /**
   * Scalar OID for the PPP/PPPoE online counter (capability based). When the
   * selected profile does not declare it, the device is treated as not
   * supporting PPP polling — no value is ever invented.
   */
  pppOnlineOid?: string;
  /**
   * Estrategia por subscriber table (JUNIPER-SUBSCRIBER-MIB). Usada quando o
   * vendor nao expoe um scalar de PPPoE online: a contagem vem do join das
   * colunas clientType/state pelo indice <HandleHiWord>.<HandleLoWord>.
   */
  pppSubscriberTable?: PppSubscriberTableCapability;
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
  /** Dialeto CLI declarado pelo profile selecionado (auditoria/QA). */
  cli?: SnmpCliDialect | null;
  identity: SnmpProfileIdentity;
  metrics: Partial<Record<SnmpProfileMetricName, {
    attempts: SnmpCandidateAttempt[];
    selectedOid: string | null;
    value: number | null;
    unit: string;
  }>>;
  checkedAt: string;
}
