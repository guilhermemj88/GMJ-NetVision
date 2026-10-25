/** Contracts shared by the isolated diagnostics API and NOC workspace. */
export type DiagnosticFamily = 'IPv4' | 'IPv6';
/** REAL: engine talks to the enrolled device through the approved SSH executor. */
export type DiagnosticMode = 'SIMULATED' | 'REAL';
export type DiagnosticOperation = 'PING' | 'TRACEROUTE';
export type DiagnosticRunState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'INTERRUPTED';
export type DiagnosticStageId =
  'MANUAL' | 'DISCOVERY' | 'VSI_MPLS' | 'LOOPBACKS' | 'ACCESS' | 'F1A' | 'REPORT';
export type DiagnosticObservation =
  'PREVIOUSLY_DISCOVERED' | 'CONFIRMED_NOW' | 'UNREACHABLE' | 'INFERRED' | 'UNPROVEN';

/**
 * Motivo operacional verificável de uma consulta não executada ou inconclusiva.
 * Nunca substitui a evidência: explica por que ela não existe.
 */
export const DIAGNOSTIC_BLOCK_REASONS = [
  'AUTHORIZATION_MISSING',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_CONFLICT',
  'FINGERPRINT_UNKNOWN',
  'FINGERPRINT_MISMATCH',
  'PLATFORM_NOT_HOMOLOGATED',
  'COMMAND_NOT_AUTHORIZED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_INVALID',
  'SSH_DISABLED',
  'ENDPOINT_INVALID',
  'HOST_UNREACHABLE',
  'IDENTIFICATION_FAILED',
  'OUTPUT_UNRECOGNIZED',
  'NOT_EXECUTED',
  'INSUFFICIENT_DATA',
  'INVENTORY_STALE',
] as const;
export type DiagnosticBlockReason = (typeof DIAGNOSTIC_BLOCK_REASONS)[number];

export function isDiagnosticBlockReason(value: unknown): value is DiagnosticBlockReason {
  return (
    typeof value === 'string' &&
    (DIAGNOSTIC_BLOCK_REASONS as readonly string[]).includes(value)
  );
}

export interface DiagnosticAddress {
  id: string;
  interfaceName: string;
  ip: string;
  family: DiagnosticFamily;
  vrf: string | null;
  role: 'LOOPBACK' | 'MANAGEMENT' | 'ACCESS';
  observedAt: string;
}

export interface DiagnosticHost {
  id: string;
  name: string;
  vendor: 'Huawei';
  model: string;
  role: 'PE' | 'F1A';
  addresses: DiagnosticAddress[];
  /** Platform/VRP detected from `display version`; null until a real read happens. */
  platform?: DiagnosticPlatform | null;
  /** Per-command capability for this exact model/version. Never inferred from another model. */
  capabilities?: DiagnosticCommandCapability[];
}

/**
 * VALIDATED  - output captured from a real device of this family/version (homologated).
 * CANDIDATE  - syntax audited but never executed here; blocked unless the engine runs a
 *              homologation window. Production never executes CANDIDATE automatically.
 * UNSUPPORTED- family/version does not offer the command.
 * UNKNOWN    - platform not yet identified; nothing may be executed.
 */
export type DiagnosticCapabilityState = 'VALIDATED' | 'CANDIDATE' | 'UNSUPPORTED' | 'UNKNOWN';

export interface DiagnosticPlatform {
  family: 'S67XX' | 'NE40' | 'NE8000' | 'OLT' | 'UNKNOWN';
  product: string | null;
  version: string | null;
  /** null quando a família veio do cadastro e ainda não houve leitura real. */
  observedAt: string | null;
  /** Fingerprint SSH da sessão que produziu a evidência; null quando não houve leitura. */
  fingerprint?: string | null;
  /** Origem da evidência: leitura real (`display version`) ou apenas cadastro. */
  evidence?: 'DISPLAY_VERSION' | 'INVENTORY' | null;
  /** Fim da validade da observação; depois disso a plataforma volta a ser não confirmada. */
  expiresAt?: string | null;
}

export interface DiagnosticCommandCapability {
  id: string;
  label: string;
  state: DiagnosticCapabilityState;
  /** Active operations generate traffic on the device; passive are read-only queries. */
  kind: 'PASSIVE' | 'ACTIVE';
  reason: string;
}

export interface DiagnosticService {
  id: string;
  name: string;
  customer: string | null;
  candidateHostIds: string[];
  indexedAt: string;
  description: string;
}

export interface ManualDiagnosticInput {
  operation: DiagnosticOperation;
  family: DiagnosticFamily;
  sourceHostId: string;
  sourceAddressId: string;
  destination: { ip: string } | { hostId: string; addressId: string };
  /** VPN instance confirmed on the source device; null means global routing table. */
  vrf?: string | null;
}

export interface VsiDiagnosticInput {
  serviceId?: string;
  name?: string;
}

export interface DiagnosticLocation {
  hostId?: string;
  vsi?: string;
  pwId?: string;
  vlan?: number;
  interfaceName?: string;
  linkId?: string;
}

export interface DiagnosticEvidence {
  id: string;
  stage: DiagnosticStageId;
  observation: DiagnosticObservation;
  source: 'INDEX' | 'SIMULATED_SSH' | 'SIMULATED_SNMP' | 'REAL_SSH' | 'REAL_SNMP' | 'TOPOLOGY';
  observedAt: string;
  collectedAt: string;
  location: DiagnosticLocation;
  summary: string;
  raw: string | null;
}

export interface DiagnosticFinding {
  id: string;
  certainty: 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE';
  title: string;
  location: DiagnosticLocation;
  evidenceIds: string[];
  nextTest: string;
}

export interface DiagnosticTest {
  id: string;
  stage: DiagnosticStageId;
  operation: DiagnosticOperation | 'VSI' | 'PW' | 'TUNNEL' | 'INTERFACE' | 'F1A';
  state: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_EXECUTED' | 'NOT_APPLICABLE';
  location: DiagnosticLocation;
  sourceIp: string | null;
  destinationIp: string | null;
  vrf: string | null;
  lossPercent: number | null;
  latencyMs: { min: number; avg: number; max: number } | null;
  hops: { ttl: number; ip: string | null; latencyMs: number | null }[];
  evidenceIds: string[];
  reason: string;
  /** Motivo operacional verificável; null quando o teste foi realmente executado. */
  reasonCode?: DiagnosticBlockReason | null;
}

export interface DiagnosticStage {
  id: DiagnosticStageId;
  label: string;
  /**
   * NOT_EXECUTED: etapa processada sem nenhuma consulta ao equipamento — nunca
   * deve ser lida como conclusão operacional.
   */
  state: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'NOT_EXECUTED' | 'CANCELLED';
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DiagnosticRun {
  conclusion?: DiagnosticConclusion;
  id: string;
  kind: 'MANUAL' | 'VSI';
  state: DiagnosticRunState;
  mode: DiagnosticMode;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
  target: string;
  input: ManualDiagnosticInput | VsiDiagnosticInput;
  stages: DiagnosticStage[];
  participants: {
    hostId: string;
    observation: DiagnosticObservation;
    observedAt: string;
    /** Por que a consulta não foi executada; null quando houve consulta. */
    reasonCode?: DiagnosticBlockReason | null;
    detail?: string | null;
  }[];
  tests: DiagnosticTest[];
  evidence: DiagnosticEvidence[];
  findings: DiagnosticFinding[];
  limitations: string[];
}

export type DiagnosticConclusion =
  'CONFIRMED_FAULT' | 'PROBABLE_FAULT' | 'INCONCLUSIVE' | 'NO_ANOMALIES';
export function concludeDiagnosticRun(
  run: Pick<DiagnosticRun, 'state' | 'tests' | 'findings'>,
): DiagnosticConclusion {
  if (!DIAGNOSTIC_TERMINAL_STATES.includes(run.state)) return 'INCONCLUSIVE';
  if (
    run.findings.some((finding) => finding.certainty === 'CONFIRMED') ||
    run.tests.some((test) => test.state === 'FAILED')
  )
    return 'CONFIRMED_FAULT';
  if (run.findings.some((finding) => finding.certainty === 'PROBABLE')) return 'PROBABLE_FAULT';
  if (
    run.state !== 'COMPLETED' ||
    !run.tests.some((test) => test.state === 'PASSED') ||
    run.findings.some((finding) => finding.certainty === 'INCONCLUSIVE') ||
    run.tests.some((test) => ['INCONCLUSIVE', 'NOT_EXECUTED'].includes(test.state))
  )
    return 'INCONCLUSIVE';
  return 'NO_ANOMALIES';
}

export const DIAGNOSTIC_TERMINAL_STATES: readonly DiagnosticRunState[] = [
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'INTERRUPTED',
];

export interface DiagnosticCatalog {
  mode: DiagnosticMode;
  hosts: DiagnosticHost[];
  services: DiagnosticService[];
  /** Active IPv6 probes stay disabled until the syntax is homologated on a real device. */
  ipv6Active: boolean;
  limits: {
    concurrency: number;
    perHost: number;
    packets: number;
    maxHops: number;
    commandTimeoutMs: number;
    runTimeoutMs: number;
  };
}

/** Passo (comando exato) que o operador autoriza para descobrir/homologar um equipamento. */
export interface DiagnosticHomologationStep {
  command: string;
  purpose: string;
  /** Candidato: sintaxe auditada, sem captura real nesta família/versão. */
  state: DiagnosticCapabilityState;
}

export interface DiagnosticHomologationBlocker {
  code: DiagnosticBlockReason | 'MODEL_UNKNOWN';
  message: string;
}

/**
 * Plano de homologação de UM equipamento. Gerado a partir do inventário e das
 * observações persistidas; nada é executado nem gravado ao gerar o plano.
 */
export interface DiagnosticHomologationPlan {
  hostId: string;
  hostName: string;
  vendor: string | null;
  model: string | null;
  endpoint: string | null;
  port: number | null;
  username: string | null;
  context: string | null;
  credentialsConfigured: boolean;
  sshEnabled: boolean;
  platform: DiagnosticPlatform | null;
  /** READY: já há evidência válida. IDENTIFICATION_REQUIRED: falta `display version`. */
  state: 'READY' | 'IDENTIFICATION_REQUIRED' | 'BLOCKED';
  blockers: DiagnosticHomologationBlocker[];
  steps: DiagnosticHomologationStep[];
  /** Janela pronta para `approvals.json`; null quando o host está bloqueado. */
  approval: {
    reference: string;
    approvedBy: string;
    hostId: string;
    endpoint: string;
    port: number;
    username: string;
    context: string | null;
    fingerprint: string;
    initialPrompt: string;
    expectedPrompt: string;
    deviceRole: 'READ_ONLY_CONFIRMED';
    validFrom: string;
    expiresAt: string;
    commands: string[];
    sessionPreparation?: string;
  } | null;
  notes: string[];
}
