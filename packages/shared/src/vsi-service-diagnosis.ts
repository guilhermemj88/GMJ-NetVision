/**
 * Contrato do Diagnostico VSI/VPLS por SERVICO (varios PEs), consumido pela aba unica de
 * diagnostico qualquer que seja o motor que gerou o resultado (VSI/MCP ou legado).
 *
 * Regras que o tipo carrega:
 *  - todo valor exibido diz de onde veio (`Observed.basis`); `value: null` nunca vira up/down;
 *  - papel do ACESSO (E-Trunk/LACP) e estado do SERVICO (VSI/AC/PW) sao campos distintos;
 *  - leituras de execucoes diferentes ficam em `readings` distintos (`inThisRun`);
 *  - todo participante descoberto aparece em `endpoints`, lido ou nao.
 */

export type VsiServiceEngine = 'VSI_MCP' | 'LEGACY';
export type VsiBasis = 'LIVE_SSH' | 'PERSISTED_SNMP' | 'NOT_READ' | 'COLLECTION_FAILED';
export type VsiFreshness = 'CURRENT' | 'AGED' | 'STALE';
export type VsiTimePrecision = 'INSTANT' | 'DAY';
export type VsiPathRole = 'ACTIVE' | 'STANDBY_EXPECTED' | 'DOWN_UNEXPECTED' | 'ROLE_UNKNOWN';
/**
 * ENGINE_APPROVED = o motor aprovou as verificacoes, mas NAO devolveu estado estruturado por
 * componente (caso do legado). E diferente de PROVEN_OK, que exige cada componente lido.
 */
export type VsiAxisState = 'PROVEN_OK' | 'ENGINE_APPROVED' | 'ISSUE' | 'NOT_CONFIRMED' | 'NOT_READ' | 'STALE' | 'NOT_APPLICABLE';
/** Estado do servico numa ponta; EXPECTED_DOWN = VSI down com Backup comprovado. */
export type VsiEndpointServiceState = VsiAxisState | 'EXPECTED_DOWN';
export type VsiFindingKind =
  | 'FAILURE'
  | 'RISK'
  | 'INCONCLUSIVE'
  | 'COLLECTION'
  | 'STALE_DATA'
  | 'STANDBY_EXPECTED'
  | 'INFO';
export type VsiVerdictStatus = 'OK' | 'WARNING' | 'FAILED' | 'INCONCLUSIVE' | 'NO_CURRENT_READING';
export type VsiUpDown = 'UP' | 'DOWN';

export interface VsiClause {
  code: string;
  params: Record<string, string | number>;
}

export interface VsiObserved<T> {
  value: T | null;
  basis: VsiBasis;
  readingId: string | null;
  evidenceId: string | null;
  /** ISO. Com `timePrecision: 'DAY'` so a data e conhecida. */
  observedAt: string | null;
  timePrecision?: VsiTimePrecision;
  /** Calculada na composicao; null quando nao ha instante (nao lido). */
  freshness: VsiFreshness | null;
  /** Valor do inventario exibido como apoio quando nao ha leitura direta. Nunca decide o estado. */
  inventoryHint?: { value: T; observedAt: string | null; stale: boolean; evidenceId: string | null };
}

export interface VsiReading {
  id: string;
  /** MANUAL_SSH_CAPTURE = saida colhida pelo operador fora do fluxo NetVision. */
  kind: 'SSH_SESSION' | 'MANUAL_SSH_CAPTURE' | 'SNMP_CYCLE';
  hostId: string | null;
  hostName: string;
  startedAt: string | null;
  timePrecision?: VsiTimePrecision;
  /** false = leitura anterior reaproveitada; a tela a lista separada. */
  inThisRun: boolean;
  outcome: 'OK' | 'PARTIAL' | 'FAILED';
  scope: string;
}

export interface VsiEvidenceRef {
  id: string;
  readingId: string | null;
  hostId: string | null;
  hostName: string;
  source: 'LIVE_SSH' | 'PERSISTED_SNMP' | 'RECENT_METRICS';
  command: string | null;
  collectedAt: string | null;
  observedAt: string | null;
  timePrecision?: VsiTimePrecision;
  complete: boolean;
  bytes: number | null;
  sha256: string | null;
  /** Linhas (base 1) consumidas pelo diagnostico; destaque no painel. */
  usedLines?: number[];
  /** Saida bruta embutida (legado e fixtures). No motor novo vira `outputUrl`. */
  output: string | null;
  /** true = `output` e so o inicio da saida (o motor novo devolve trecho); `bytes` traz o tamanho real. */
  outputTruncated?: boolean;
  outputUrl?: string | null;
  note?: string | null;
}

export interface VsiAcView {
  interfaceName: string;
  state: VsiObserved<VsiUpDown>;
  blocked: boolean | null;
  role: VsiPathRole | null;
  carrier: string | null;
  vlan: string | null;
  detail?: string | null;
}
export interface VsiPwView {
  peerAddress: string;
  peerHostId: string | null;
  state: VsiObserved<VsiUpDown>;
  localLabel: number | null;
  remoteLabel: number | null;
  tunnel: string | null;
  /** Registro do inventario mais antigo que a leitura da propria VSI: nao representa o estado atual. */
  stale: boolean;
  detail?: string | null;
}
export interface VsiEthTrunkView {
  name: string;
  operStatus: VsiObserved<VsiUpDown>;
  workingMode: 'LACP' | 'NORMAL' | null;
  selected: number | null;
  members: Array<{ port: string; status: string | null }>;
  eTrunkId: number | null;
  remoteEthTrunkId: number | null;
  role: VsiPathRole;
  memberCausation?: string | null;
  detail?: string | null;
}
export interface VsiETrunkView {
  id: number;
  state: VsiObserved<'MASTER' | 'BACKUP' | 'INITIALIZE'>;
  causation: string | null;
  priority: number | null;
  peerPriority: number | null;
  peerIp: string | null;
  members: Array<{ interfaceName: string; state: string | null; causation: string | null; remoteId: number | null }>;
  detail?: string | null;
}
export interface VsiMacView {
  total: number;
  viaAc: number;
  viaPw: number;
  viaUnresolved: number;
  byLearnedFrom: Record<string, number>;
}

export interface VsiEndpointInput {
  hostId: string | null;
  hostName: string;
  platform: string | null;
  loopback: string | null;
  discoveredBy: 'REQUESTED' | 'INVENTORY_SAME_VSI' | 'PW_PEER';
  collection: 'READ' | 'PARTIAL' | 'NOT_READ' | 'NOT_AUTHORIZED' | 'FAILED';
  /** Papel do ACESSO (redundancia). Nao fala da VSI. null = redundancia fora do escopo lido. */
  accessRole: VsiPathRole | null;
  vsi: VsiObserved<{ state: VsiUpDown; signaling: string | null; encapsulation: string | null; mtu: number | null; rd: string | null }>;
  acs: VsiAcView[];
  pws: VsiPwView[];
  ethTrunks: VsiEthTrunkView[];
  eTrunks: VsiETrunkView[];
  mac: VsiObserved<VsiMacView>;
  /** O que ainda PRECISA SER LIDO para classificar esta ponta. Vazio = nenhuma leitura pendente aqui. */
  missingEvidence: string[];
  /**
   * O que o motor nao avaliou nesta ponta SEM que falte leitura (ex.: ponta em standby comprovado, MAC nao
   * solicitado). Nao e pendencia de coleta e nao pede nova leitura.
   */
  notAssessed?: string[];
  /**
   * Verificacoes em TEXTO do motor para esta ponta, quando ele nao devolve o componente estruturado
   * (legado). A tela as mostra como "verificacao do motor", nunca como estado lido do componente.
   */
  engineChecks?: VsiEngineCheck[];
}
export interface VsiEngineCheck {
  id: string;
  layer: 'etrunk' | 'lag' | 'vsi' | 'ac' | 'pw' | 'underlay' | 'interface';
  label: string;
  status: 'OK' | 'WARNING' | 'FAILED' | 'INSUFFICIENT_DATA';
  message: string;
  certainty: 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE';
  evidenceIds: string[];
}
/** Ping/traceroute entre loopbacks, exatamente como o motor mediu (hoje so o legado executa). */
export interface VsiConnectivityProbe {
  sourceHostId: string;
  sourceHostName: string;
  destinationHostId: string;
  destinationHostName: string;
  source: string;
  destination: string;
  routingContext: string;
  status: 'OK' | 'WARNING' | 'FAILED' | 'INSUFFICIENT_DATA';
  transmitted: number | null;
  received: number | null;
  lossPercent: number | null;
  rttMs: { min: number; avg: number; max: number } | null;
  hops: Array<{ ttl: number; address: string | null; timesMs: number[] }>;
  tracerouteNotExecutedReason: string | null;
}
export interface VsiConnectivity {
  /** false = o motor desta execucao nao faz ping/traceroute (nao e "sem perda"). */
  evaluated: boolean;
  /** Classificacao do underlay dada pelo motor, sem reinterpretacao. */
  underlayClassification: string | null;
  probes: VsiConnectivityProbe[];
}
export type VsiResultOrigin = 'ENGINE_RUN' | 'LEGACY_JOB' | 'REPLAY' | 'FIXTURE';
export interface VsiEndpointView extends VsiEndpointInput {
  serviceState: VsiEndpointServiceState;
}
/** Linha da lista de resultados guardados: o suficiente para escolher qual abrir, sem carregar o resultado. */
export interface VsiServiceRunSummary {
  runId: string;
  vsiName: string;
  origin: VsiResultOrigin;
  /** Rotulo de demonstracao/homologacao, quando o resultado nao e uma execucao operacional comum. */
  label: string | null;
  engine: VsiServiceDiagnosis['engine'];
  startedAt: string;
  completedAt: string;
  verdict: VsiVerdictStatus;
  endpoints: Array<{ hostId: string | null; hostName: string; collection: VsiEndpointInput['collection']; accessRole: VsiPathRole | null }>;
  /** MEMORY = execucao desta instancia da API; ARCHIVE = arquivo guardado, somente leitura. */
  storedIn: 'MEMORY' | 'ARCHIVE';
}

/**
 * A evidencia desta ponta basta para classifica-la? Independe de a COLETA ter terminado (`collection`) e de o
 * SERVICO estar up (`serviceState`): um Backup lido por inteiro e SUFFICIENT com a VSI down.
 */
export type VsiEndpointEvidenceState = 'SUFFICIENT' | 'INSUFFICIENT' | 'NONE';

export interface VsiPwLinkView {
  aHostId: string | null;
  bHostId: string | null;
  bAddress: string;
  state: 'UP_BOTH' | 'UP_ONE_SIDE' | 'DOWN' | 'NOT_CONFIRMED' | 'STALE';
  labelsMatch: boolean | null;
  findingIds: string[];
}

export type VsiFindingComponent =
  | 'VSI'
  | 'AC'
  | 'PW'
  | 'MAC'
  | 'ETH_TRUNK'
  | 'E_TRUNK'
  | 'ENCAPSULATION'
  | 'INVENTORY'
  | 'COLLECTION'
  | 'UNDERLAY'
  | 'INTERFACE';

export interface VsiFindingView {
  id: string;
  code: string;
  kind: VsiFindingKind;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  certainty: 'CONFIRMED' | 'PROBABLE' | 'HYPOTHESIS' | 'INCONCLUSIVE';
  impactCertainty: 'CONFIRMED' | 'PROBABLE' | 'HYPOTHESIS' | 'INCONCLUSIVE';
  /** ENGINE = emitido pelo motor nesta execucao; AGGREGATOR = regra de composicao; MANUAL_ANALYSIS = fixture/analise fora do fluxo. */
  origin: 'ENGINE' | 'AGGREGATOR' | 'MANUAL_ANALYSIS';
  hostId: string | null;
  hostName: string | null;
  component: VsiFindingComponent;
  title: string;
  explanation: string;
  caveat: string | null;
  evidenceIds: string[];
  nextStepIds: string[];
}

export interface VsiNextStep {
  id: string;
  hostId: string | null;
  hostName: string | null;
  title: string;
  command: string | null;
  /** null = nao se aplica (passo que nao e comando de equipamento). */
  homologated: boolean | null;
  reason: string;
  reasonFindingIds: string[];
  evidenceIds: string[];
}

export interface VsiAxis {
  state: VsiAxisState;
  clause: VsiClause;
}
export interface VsiAxes {
  redundancy: VsiAxis;
  service: VsiAxis;
  mac: VsiAxis;
  evidence: VsiAxis;
}

export interface VsiServiceDiagnosis {
  schemaVersion: 1;
  engine: VsiServiceEngine;
  engineVersion: string;
  runId: string;
  /** ENGINE_RUN = execucao real; LEGACY_JOB = job do legado; REPLAY = motor real sobre capturas gravadas; FIXTURE = montado a mao. */
  origin: VsiResultOrigin;
  vsiName: string;
  operator: { username: string; role: string } | null;
  startedAt: string;
  completedAt: string;
  connectivity: VsiConnectivity;
  /** Preenchido quando o resultado NAO veio de uma execucao real (fixture/demonstracao). */
  demonstration?: { label: string; provenance: string } | null;
  verdict: { status: VsiVerdictStatus; clauses: VsiClause[] };
  axes: VsiAxes;
  endpoints: VsiEndpointView[];
  links: VsiPwLinkView[];
  findings: VsiFindingView[];
  nextSteps: VsiNextStep[];
  readings: VsiReading[];
  evidence: VsiEvidenceRef[];
}

/* ------------------------------------------------------------------ */
/* Idade da evidencia SSH                                              */
/* ------------------------------------------------------------------ */

export interface VsiEvidenceAgeLimits {
  /** Ate este limite (inclusive): ATUAL. */
  currentMs: number;
  /** Acima de `currentMs` ate este limite (inclusive): ENVELHECIDA. Acima: ANTIGA. */
  agedMs: number;
}
export const VSI_EVIDENCE_AGE_LIMITS: Readonly<VsiEvidenceAgeLimits> = Object.freeze({
  currentMs: 15 * 60_000,
  agedMs: 24 * 60 * 60_000,
});

/**
 * Idade de uma leitura direta. Com precisao de DIA usa o INICIO do dia (pior caso):
 * uma captura sem horario nunca e classificada como mais nova do que pode ser provado.
 */
export function vsiFreshness(
  observedAt: string | null,
  now: string,
  limits: VsiEvidenceAgeLimits = VSI_EVIDENCE_AGE_LIMITS,
  precision: VsiTimePrecision = 'INSTANT',
): VsiFreshness | null {
  if (!observedAt) return null;
  const at = Date.parse(precision === 'DAY' ? `${observedAt.slice(0, 10)}T00:00:00.000Z` : observedAt);
  const ref = Date.parse(now);
  if (Number.isNaN(at) || Number.isNaN(ref)) return null;
  const age = Math.max(0, ref - at);
  if (age <= limits.currentMs) return 'CURRENT';
  if (age <= limits.agedMs) return 'AGED';
  return 'STALE';
}

/* ------------------------------------------------------------------ */
/* Categoria do achado                                                 */
/* ------------------------------------------------------------------ */

/**
 * Classe de cada codigo de achado. OPERATIONAL = a categoria segue a SEVERIDADE que o motor
 * atribuiu (CRITICAL -> FAILURE, WARNING -> RISK, INFO -> INFO): a tela nunca rebaixa uma falha.
 * Codigo ausente desta tabela e erro (ver `vsiFindingKind`).
 */
export type VsiFindingClass = 'OPERATIONAL' | Exclude<VsiFindingKind, 'FAILURE' | 'RISK'>;

export const VSI_FINDING_CLASS: Readonly<Record<string, VsiFindingClass>> = Object.freeze({
  // motor VSI/MCP (correlator.ts)
  AC_BINDING_MISMATCH: 'OPERATIONAL',
  AC_CONFIG_MISSING: 'INCONCLUSIVE',
  AC_DOWN: 'OPERATIONAL',
  ALL_PW_DOWN: 'OPERATIONAL',
  CARRIER_CONFIG_CONTRADICTS_VLAN: 'OPERATIONAL',
  CARRIER_PORT_VLAN_PROVEN: 'INFO',
  COMPARISON_INCONCLUSIVE: 'INCONCLUSIVE',
  DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE: 'OPERATIONAL',
  ENCAPSULATION_LOCAL_PROVEN: 'INFO',
  ENCAPSULATION_NOT_EVALUATED: 'INCONCLUSIVE',
  ENCAPSULATION_TYPE_MISMATCH: 'OPERATIONAL',
  ETRUNK_FORCED_STATE: 'OPERATIONAL',
  ETRUNK_PEER_UNREACHABLE: 'OPERATIONAL',
  MAC_BLACKHOLE_PRESENT: 'OPERATIONAL',
  MAC_DUPLICATE_IN_TABLE: 'OPERATIONAL',
  MAC_FLAPPING_REPORTED: 'OPERATIONAL',
  MAC_LEARNED_AT_PW_UP: 'INFO',
  MAC_LEARNED_ON_NON_AC_INTERFACE: 'OPERATIONAL',
  MAC_NON_DYNAMIC_PRESENT: 'OPERATIONAL',
  MAC_ON_PORT_OUTSIDE_VLAN: 'INCONCLUSIVE',
  MAC_ORIGIN_UNRESOLVED: 'INCONCLUSIVE',
  MTU_MISMATCH: 'OPERATIONAL',
  NO_AC: 'OPERATIONAL',
  NO_MAC_FROM_AC: 'OPERATIONAL',
  NO_MAC_FROM_PW: 'OPERATIONAL',
  PATH_ROLE_UNKNOWN: 'INCONCLUSIVE',
  PERSISTED_AC_NOT_IN_LIVE_VSI: 'STALE_DATA',
  PERSISTED_AC_OBSOLETE: 'STALE_DATA',
  PERSISTED_PW_STALE: 'STALE_DATA',
  PW_DOWN: 'OPERATIONAL',
  PW_DOWN_ON_INACTIVE_PATH: 'STANDBY_EXPECTED',
  PW_LABEL_MISMATCH: 'OPERATIONAL',
  PW_PAIR_UNRESOLVED: 'INCONCLUSIVE',
  PW_STATE_ASYMMETRIC: 'OPERATIONAL',
  PW_STATE_ASYMMETRIC_INACTIVE_PATH: 'STANDBY_EXPECTED',
  PW_UP_WITHOUT_LABELS: 'OPERATIONAL',
  RD_SAME_VALUE_DIFFERENT_NOTATION: 'INFO',
  REDUNDANCY_PEER_MEMBER_DOWN: 'OPERATIONAL',
  STANDBY_PATH_IDLE: 'STANDBY_EXPECTED',
  TAG_COUNT_MISMATCH_PROBABLE: 'OPERATIONAL',
  TRAFFIC_STOPS_AFTER_STAGE: 'OPERATIONAL',
  TRUNK_MEMBER_NOT_SELECTED: 'OPERATIONAL',
  VLAN_AC_NUMBER_MISMATCH: 'OPERATIONAL',
  VLAN_DISABLED: 'OPERATIONAL',
  VLAN_FORWARDING_DISCARD: 'OPERATIONAL',
  VLAN_MAC_LEARNING_DISABLED: 'OPERATIONAL',
  VLAN_NOT_FOUND: 'OPERATIONAL',
  VLAN_OUTPUT_INCOMPLETE: 'COLLECTION',
  VLAN_TRANSFORM_ASYMMETRIC: 'OPERATIONAL',
  VLAN_TRANSFORM_ON_CARRIER: 'OPERATIONAL',
  VSI_DOWN: 'OPERATIONAL',
  VSI_DOWN_ROLE_UNKNOWN: 'OPERATIONAL',
  VSI_DOWN_STANDBY_EXPECTED: 'STANDBY_EXPECTED',
  VSI_EVIDENCE_MISSING: 'INCONCLUSIVE',
  // camada de composicao (nao sao codigos do motor)
  ENDPOINT_SERVICE_NOT_READ: 'INCONCLUSIVE',
  REMOTE_ENDPOINT_NOT_READ: 'INCONCLUSIVE',
  COLLECTION_OUTPUT_INCOMPLETE: 'COLLECTION',
  COLLECTION_COMMAND_FAILED: 'COLLECTION',
  COLLECTION_NOT_AUTHORIZED: 'COLLECTION',
  COLLECTION_OPERATION_SKIPPED: 'COLLECTION',
  INVENTORY_STATE_DIVERGES_FROM_DEVICE: 'STALE_DATA',
  PATH_DOWN_UNEXPECTED: 'OPERATIONAL',
  // adaptador do legado
  LEGACY_CHECK: 'OPERATIONAL',
  LEGACY_CHECK_INSUFFICIENT_DATA: 'INCONCLUSIVE',
  LEGACY_LIMITATION: 'INFO',
});

export function vsiFindingKind(code: string, severity: 'INFO' | 'WARNING' | 'CRITICAL'): VsiFindingKind {
  const cls = VSI_FINDING_CLASS[code];
  if (!cls) throw new Error(`Codigo de achado sem categoria: ${code}`);
  if (cls !== 'OPERATIONAL') return cls;
  return severity === 'CRITICAL' ? 'FAILURE' : severity === 'WARNING' ? 'RISK' : 'INFO';
}
