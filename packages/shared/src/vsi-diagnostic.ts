export type VsiDiagnosticStatus = 'OK' | 'WARNING' | 'FAILED' | 'INSUFFICIENT_DATA';
export type VsiDiagnosticCategory =
  | 'VSI'
  | 'PW'
  | 'UNDERLAY'
  | 'LOOPBACK_REACHABILITY'
  | 'ROUTE'
  | 'AC'
  | 'ETH_TRUNK'
  | 'INTERFACE'
  | 'ERRORS'
  | 'L3';
export interface VsiDiagnosticEvidence {
  id: string;
  hostId: string;
  source: 'PERSISTED_SNMP' | 'LIVE_SSH' | 'RECENT_METRICS';
  observedAt: string | null;
  collectedAt: string;
  command: string | null;
  output: string;
  durationMs?: number;
  errorCode?: string;
  complete?: boolean;
  sha256?: string;
  diagnosticId?: string;
}
export interface VsiDiagnosticCheck {
  id: string;
  category: VsiDiagnosticCategory;
  label: string;
  status: VsiDiagnosticStatus;
  hostId: string;
  message: string;
  evidence: string[];
  durationMs: number;
  certainty: 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE';
  required: boolean;
}
export interface VsiDiagnosticVsiFacts {
  vsiId: number | null;
  status: 'UP' | 'DOWN' | null;
  peers: Array<{
    address: string;
    vcId: number | null;
    state: 'UP' | 'DOWN' | null;
    inboundLabel: number | null;
    outboundLabel: number | null;
    tunnel: string | null;
  }>;
}
export interface VsiDiagnosticEndpoint {
  hostId: string;
  name: string;
  vsiId: string | null;
  vsiName: string | null;
  loopback: {
    address: string;
    interfaceName: string;
    routingContext: 'GLOBAL';
    evidence: string[];
  } | null;
  association: 'LOCAL' | 'PERSISTED_REMOTE_ID' | 'EXACT_INVENTORY_IP';
  observedVsi?: VsiDiagnosticVsiFacts;
}
export interface VsiDiagnosticProbe {
  sourceHostId: string;
  destinationHostId: string;
  source: string;
  destination: string;
  routingContext: 'GLOBAL';
  lossPercent: number | null;
  rttMs: { min: number; avg: number; max: number } | null;
  hops: Array<{ ttl: number; address: string | null; timesMs: number[] }>;
  status: VsiDiagnosticStatus;
  transmitted?: number;
  received?: number;
  tracerouteNotExecutedReason?: 'NOT_HOMOLOGATED';
}
/**
 * Autorização observada dos comandos de UMA execução num PE. Nunca afirma
 * privilégio da conta nem autorização de comandos não executados.
 */
export type VsiCommandAuthorization =
  'CONFIRMED_FOR_EXECUTED_COMMANDS' | 'NOT_CONFIRMED' | 'NOT_EXECUTED';
export interface VsiDiagnosticEndpointAccess {
  hostId: string;
  name: string;
  /** Conta de serviço SSH usada no PE; somente o username, nunca segredo. */
  sshUsername: string | null;
  commandAuthorization: VsiCommandAuthorization;
  executedCommands: number;
  acceptedCommands: number;
  /** O nível AAA da sessão não é consultado de forma independente. */
  devicePrivilegeLevel: 'NOT_VERIFIED';
}
/** Informativo; não participa do veredito. RBAC do NetVision está em `operator`. */
export interface VsiDiagnosticExecutionContext {
  endpoints: VsiDiagnosticEndpointAccess[];
}
export interface VsiDiagnosticResult {
  diagnosticId: string;
  hostId: string;
  vsiId: string;
  vsiName: string;
  operator: { id: string; username: string; role: string };
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT';
  stage: string;
  progress?: Array<{ stage: string; at: string }>;
  startedAt: string;
  completedAt: string | null;
  underlayClassification?:
    | 'UNDERLAY_REACHABLE'
    | 'ASYMMETRIC_REACHABILITY'
    | 'UNDERLAY_UNREACHABLE'
    | 'DEGRADED_REACHABILITY'
    | 'INCONCLUSIVE';
  overallStatus: VsiDiagnosticStatus;
  summary: string;
  local: VsiDiagnosticEndpoint;
  remotes: VsiDiagnosticEndpoint[];
  checks: VsiDiagnosticCheck[];
  evidence: VsiDiagnosticEvidence[];
  probes: VsiDiagnosticProbe[];
  warnings: string[];
  nextTests: string[];
  executionContext?: VsiDiagnosticExecutionContext;
}
export const VSI_DIAGNOSTIC_LIMITS = Object.freeze({
  concurrency: 1,
  queue: 5,
  totalMs: 90000,
  commandMs: 12000,
  outputBytes: 131072,
  totalOutputBytes: 524288,
  remotes: 4,
  attachments: 8,
  commands: 40,
  retainedJobs: 100,
});
