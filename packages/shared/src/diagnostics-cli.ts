/** Real SSH diagnostics: selections are typed operations, never a raw CLI string. */
export const CLI_SESSION_PREPARATION = 'screen-length 0 temporary' as const;
export interface CliPreparationAudit {
  command: typeof CLI_SESSION_PREPARATION;
  state: 'SENT' | 'CONFIRMED' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  output: string;
  errorCode: string | null;
}
export type CliCommandId =
  | 'VERSION'
  | 'INTERFACE_DESCRIPTION'
  | 'IP_INTERFACE_BRIEF'
  | 'IPV6_INTERFACE_BRIEF'
  | 'VPN_INSTANCES'
  | 'INTERFACE'
  | 'VSI'
  | 'VSI_SERVICES';
export interface CliSelection {
  commandId: CliCommandId;
  argument?: string;
}
export interface CliCommandDefinition {
  id: CliCommandId;
  label: string;
  template: string;
  argument: 'NONE' | 'INTERFACE' | 'VSI';
}
export interface CliHost {
  id: string;
  name: string;
  vendor: string | null;
  model: string | null;
  managementIp: string;
  endpoint: string | null;
  port: number;
  username: string | null;
  context: string | null;
  credentialConfigured: boolean;
  interfaces: string[];
  vsis: string[];
  eligible: boolean;
  blockedReason: string | null;
  approval: {
    reference: string;
    expiresAt: string;
    fingerprint: string;
    deviceRole: string;
    commands: string[];
    sessionPreparation?: typeof CLI_SESSION_PREPARATION;
  } | null;
}
export const CLI_LIMITS = Object.freeze({
  concurrency: 1,
  perEndpoint: 1,
  queue: 10,
  perUser: 2,
  handshakeMs: 8000,
  commandMs: 15000,
  totalMs: 45000,
  outputBytes: 131072,
});
export interface CliCatalog {
  mode: 'REAL_READ_ONLY';
  source: 'NETVISION_INVENTORY';
  readAt: string;
  executionEnabled: boolean;
  hosts: CliHost[];
  commands: CliCommandDefinition[];
  limits: typeof CLI_LIMITS;
}
export type CliRunState =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'INTERRUPTED';
export interface CliRun {
  id: string;
  mode: 'REAL_READ_ONLY';
  state: CliRunState;
  operator: { id: string; username: string; role: 'ADMIN' | 'OPERATOR' | 'VIEWER' };
  host: {
    id: string;
    name: string;
    endpoint: string | null;
    port: number;
    username: string | null;
    context: string | null;
  };
  selection: CliSelection;
  command: string;
  approvalReference: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  output: string;
  outputBytes: number;
  truncated: boolean;
  fingerprint: string | null;
  verifiedPrompt: string | null;
  sentCommands: string[];
  /** Optional for compatibility with historical runs recorded before session preparation. */
  sessionPreparation?: CliPreparationAudit | null;
  error: { code: string; message: string } | null;
}
export const CLI_TERMINAL_STATES: readonly CliRunState[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'INTERRUPTED',
];
