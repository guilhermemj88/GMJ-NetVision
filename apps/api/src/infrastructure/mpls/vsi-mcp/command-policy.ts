import { interfaceName } from '../vsi-diagnostic-policy';

/**
 * Politica de comandos do diagnostico VSI/MPLS por MCP.
 *
 * Principios:
 *  - NENHUM texto livre do usuario vira comando. O chamador escolhe uma OPERACAO
 *    (enum fechado) e, no maximo, um argumento tipado (nome de VSI ou de
 *    interface) que e validado por regex estrita antes de ser interpolado.
 *  - Allowlist positiva (regex ancorada por operacao) + deny explicito de
 *    qualquer verbo de configuracao/escrita, avaliados antes de qualquer SSH.
 *  - Guard INDEPENDENTE do guard da mitigacao BGP (read-only-command-guard.ts):
 *    este modulo nao importa nem altera aquele.
 */

export const VSI_MCP_OPERATIONS = [
  'VERSION',
  'VSI_LIST',
  'VSI_VERBOSE',
  'VSI_MAC',
  'INTERFACE_CONFIG',
  'INTERFACE_STATE',
  'VLAN_INFO',
  'ETRUNK_BRIEF',
  'ETRUNK_INFO',
  'ETH_TRUNK_INFO',
] as const;
export type VsiMcpOperationKind = (typeof VSI_MCP_OPERATIONS)[number];

export type VsiMcpOperation =
  | { kind: 'VERSION' | 'VSI_LIST' | 'ETRUNK_BRIEF' }
  | { kind: 'ETRUNK_INFO'; eTrunkId: number }
  | { kind: 'ETH_TRUNK_INFO'; trunkId: number }
  | { kind: 'VSI_VERBOSE' | 'VSI_MAC'; vsiName: string }
  | { kind: 'INTERFACE_CONFIG'; interfaceName: string; role?: 'AC' | 'CARRIER' }
  | { kind: 'INTERFACE_STATE'; interfaceName: string }
  | { kind: 'VLAN_INFO'; vlanId: number };

const VSI_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

export class VsiMcpPolicyError extends Error {
  constructor(
    readonly code:
      | 'UNSAFE_VSI_NAME'
      | 'UNSAFE_INTERFACE'
      | 'UNSAFE_VLAN'
      | 'UNSAFE_TRUNK_ID'
      | 'COMMAND_NOT_ALLOWED'
      | 'WRITE_VERB_BLOCKED'
      | 'METACHARACTER_BLOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'VsiMcpPolicyError';
  }
}

/** Constroi o comando exato de uma operacao. Unico ponto onde um comando nasce. */
export function buildVsiMcpCommand(operation: VsiMcpOperation): string {
  switch (operation.kind) {
    case 'VERSION':
      return 'display version';
    case 'VSI_LIST':
      return 'display vsi';
    case 'VSI_VERBOSE':
      return `display vsi name ${vsiNameOrThrow(operation.vsiName)} verbose`;
    case 'VSI_MAC':
      return `display mac-address vsi ${vsiNameOrThrow(operation.vsiName)}`;
    case 'INTERFACE_CONFIG':
      return `display current-configuration interface ${interfaceOrThrow(operation.interfaceName)}`;
    case 'INTERFACE_STATE':
      return `display interface ${interfaceOrThrow(operation.interfaceName)}`;
    case 'VLAN_INFO':
      return `display vlan ${vlanOrThrow(operation.vlanId)}`;
    case 'ETRUNK_BRIEF':
      return 'display e-trunk brief';
    case 'ETRUNK_INFO':
      return `display e-trunk ${idOrThrow(operation.eTrunkId, 1, 16)}`;
    case 'ETH_TRUNK_INFO':
      return `display eth-trunk ${idOrThrow(operation.trunkId, 0, 255)}`;
  }
}

function vsiNameOrThrow(value: string): string {
  if (!VSI_NAME.test(value)) throw new VsiMcpPolicyError('UNSAFE_VSI_NAME', 'Nome de VSI invalido');
  return value;
}

function vlanOrThrow(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4094) throw new VsiMcpPolicyError('UNSAFE_VLAN', 'VLAN invalida');
  return value;
}

/** Id numerico em faixa fechada (E-Trunk 1..16, faixa exibida pelo S6730 V200 em `display e-trunk ?`; Eth-Trunk 0..255): nunca texto livre. */
function idOrThrow(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new VsiMcpPolicyError('UNSAFE_TRUNK_ID', 'Id de trunk invalido');
  return value;
}

function interfaceOrThrow(value: string): string {
  if (!interfaceName(value)) throw new VsiMcpPolicyError('UNSAFE_INTERFACE', 'Nome de interface invalido');
  return value;
}

/** Tokens (palavras inteiras) que alteram configuracao, plano de controle ou encaminhamento. */
const WRITE_TOKENS: ReadonlySet<string> = new Set([
  'undo', 'system-view', 'sys', 'commit', 'save', 'reset', 'reboot', 'shutdown', 'startup',
  'clear', 'delete', 'format', 'rollback', 'schedule', 'configure', 'return', 'quit',
  'ping', 'tracert', 'telnet', 'ssh', 'ftp', 'tftp', 'sftp', 'copy', 'move', 'rename',
  'set', 'apply', 'peer', 'refresh', 'debugging', 'terminal', 'screen-length',
]);
const METACHARACTERS = /[;&|`$<>\r\n\\]/;

const ALLOWED: ReadonlyArray<RegExp> = [
  /^display version$/,
  /^display vsi$/,
  /^display vsi name [A-Za-z0-9_.:-]{1,64} verbose$/,
  /^display mac-address vsi [A-Za-z0-9_.:-]{1,64}$/,
  /^display current-configuration interface [A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/,
  /^display vlan (?:[1-9]\d{0,2}|[1-3]\d{3}|40[0-8]\d|409[0-4])$/,
  /^display interface [A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/,
  /^display e-trunk brief$/,
  /^display e-trunk (?:[1-9]|1[0-6])$/,
  /^display eth-trunk (?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/,
];

/**
 * Defesa em profundidade: mesmo comandos gerados por `buildVsiMcpCommand` sao
 * revalidados aqui imediatamente antes de irem para o canal SSH.
 */
export function assertVsiMcpReadOnly(command: string): string {
  if (typeof command !== 'string' || command.length === 0 || command.length > 160)
    throw new VsiMcpPolicyError('COMMAND_NOT_ALLOWED', 'Comando fora do limite');
  if (METACHARACTERS.test(command))
    throw new VsiMcpPolicyError('METACHARACTER_BLOCKED', 'Metacaractere nao permitido');
  if (command !== command.trim() || /\s{2,}/.test(command))
    throw new VsiMcpPolicyError('COMMAND_NOT_ALLOWED', 'Comando nao normalizado');
  if (!command.startsWith('display '))
    throw new VsiMcpPolicyError('WRITE_VERB_BLOCKED', 'Somente comandos display sao permitidos');
  if (command.toLowerCase().split(' ').some((token) => WRITE_TOKENS.has(token)))
    throw new VsiMcpPolicyError('WRITE_VERB_BLOCKED', 'Verbo de escrita bloqueado');
  if (!ALLOWED.some((pattern) => pattern.test(command)))
    throw new VsiMcpPolicyError('COMMAND_NOT_ALLOWED', 'Comando fora da allowlist');
  return command;
}

/** Atalho: gera e valida. */
export function safeVsiMcpCommand(operation: VsiMcpOperation): string {
  return assertVsiMcpReadOnly(buildVsiMcpCommand(operation));
}
