/**
 * Guarda estrutural de comandos do worker de mitigação.
 *
 * Fase 3 é READ-ONLY: o worker conversa com o Huawei apenas para LER. A proteção
 * não é convenção — é allowlist positiva + deny explícito, avaliados ANTES de
 * qualquer interação com o SSH. Comando fora da allowlist é rejeitado localmente.
 */

export interface CommandRejection {
  allowed: false;
  reason: CommandRejectionReason;
  detail?: string;
}

export interface CommandAcceptance {
  allowed: true;
  /** Comando normalizado (espaços colapsados, sem espaços nas pontas). */
  normalized: string;
}

export type CommandValidation = CommandAcceptance | CommandRejection;

export type CommandRejectionReason =
  | 'EMPTY_COMMAND'
  | 'MULTILINE_NOT_ALLOWED'
  | 'SHELL_METACHARACTER_NOT_ALLOWED'
  | 'REDIRECTION_NOT_ALLOWED'
  | 'COMMAND_TOO_LONG'
  | 'FORBIDDEN_WRITE_COMMAND'
  | 'COMMAND_NOT_IN_ALLOWLIST';

/** Tamanho máximo defensivo (comandos de leitura reais são curtos). */
const MAX_COMMAND_LENGTH = 512;

/**
 * Allowlist positiva. Um comando é aceito apenas se for exatamente um destes ou
 * se começar por um deles seguido de espaço (parâmetros/filtros de leitura).
 */
const ALLOWED_COMMAND_PREFIXES: readonly string[] = [
  'screen-length 0 temporary',
  'display interface brief',
  'display interface',
  'display ip interface brief',
  'display ip routing-table',
  'display bgp peer',
  'display bgp routing-table',
  'display current-configuration configuration bgp',
  'display current-configuration configuration route-policy',
  'display current-configuration |',
  'display route-policy',
  'display version',
  'display device',
  'display cpu-usage',
  'display memory-usage',
  'display health',
  'display alarm',
  'display logbuffer',
  'display transceiver',
  'display vlan',
  'display ospf peer',
  'display isis peer',
];

/**
 * Deny explícito, defesa em profundidade. Mesmo que um padrão de escrita caísse
 * na allowlist por engano, ele continua bloqueado aqui.
 */
const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; detail: string }[] = [
  { pattern: /\bsystem-view\b/i, detail: 'entrada em modo de configuração' },
  { pattern: /^\s*commit\b/i, detail: 'commit de configuração' },
  { pattern: /\bundo\s+route-policy\b/i, detail: 'remoção de route-policy' },
  { pattern: /\broute-policy\s+\S+\s+(permit|deny)\s+node\b/i, detail: 'criação/alteração de node de route-policy' },
  { pattern: /\bapply\s+extcommunity\b/i, detail: 'aplicação de extcommunity' },
  { pattern: /\bpeer\s+\S+\s+ignore\b/i, detail: 'supressão de peer' },
  { pattern: /\b(quit|return)\s*$/i, detail: 'navegação de contexto de configuração' },
  { pattern: /^\s*(save|reset|reboot|shutdown|startup)\b/i, detail: 'comando destrutivo' },
  { pattern: /^\s*undo\b/i, detail: 'comando de remoção' },
  { pattern: /^\s*(interface|acl|route-policy|bgp|vlan|ip\s+route-static)\b/i, detail: 'entrada em contexto de configuração' },
];

/**
 * Valida um comando contra a política READ-ONLY.
 *
 * Nunca lança: devolve a decisão para quem chama decidir (o worker rejeita).
 */
export function validateReadOnlyCommand(command: string): CommandValidation {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { allowed: false, reason: 'EMPTY_COMMAND' };
  }
  if (/[\r\n]/.test(command)) {
    return { allowed: false, reason: 'MULTILINE_NOT_ALLOWED' };
  }
  if (/[;&`$]/.test(command) || /&&|\|\|/.test(command)) {
    return { allowed: false, reason: 'SHELL_METACHARACTER_NOT_ALLOWED' };
  }
  if (/[<>]/.test(command)) {
    return { allowed: false, reason: 'REDIRECTION_NOT_ALLOWED' };
  }

  const normalized = command.trim().replace(/\s+/g, ' ');
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return { allowed: false, reason: 'COMMAND_TOO_LONG' };
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return { allowed: false, reason: 'FORBIDDEN_WRITE_COMMAND', detail: rule.detail };
    }
  }

  const lower = normalized.toLowerCase();
  const inAllowlist = ALLOWED_COMMAND_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix} `),
  );
  if (!inAllowlist) {
    return { allowed: false, reason: 'COMMAND_NOT_IN_ALLOWLIST' };
  }

  return { allowed: true, normalized };
}

/** Lança quando o comando não é estritamente de leitura (uso interno da sessão). */
export function assertReadOnlyCommand(command: string): string {
  const verdict = validateReadOnlyCommand(command);
  if (!verdict.allowed) {
    throw new Error(`READ_ONLY_VIOLATION: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`);
  }
  return verdict.normalized;
}

export const READ_ONLY_ALLOWLIST: readonly string[] = ALLOWED_COMMAND_PREFIXES;
