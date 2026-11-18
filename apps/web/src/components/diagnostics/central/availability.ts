/**
 * Disponibilidade das DUAS formas de coleta, decididas de forma INDEPENDENTE:
 *
 *  - Diagnostico LEGADO (janela one-shot + "Diagnosticar"): estado real de `/api/diagnostics/status`
 *    (`diagnosticEnabled` e `diagnosticTrust`) mais o papel do usuario. NAO depende de VSI_MCP_ENABLED.
 *  - Diagnostico VSI por SERVICO (nova coleta via MCP): estado de `/api/vsi-mcp/status`. Falha de consulta = indisponivel.
 *
 * Uma falha ao consultar o estado do MCP nunca desativa o legado, e vice-versa.
 */
export type LegacyAvailability =
  | 'checking' // consultando o estado
  | 'unknown' // a consulta de estado falhou: nao da para confirmar -> sem acao (fail-closed)
  | 'disabled' // VSI_DIAGNOSTIC_ENABLED=false
  | 'no-trust' // ativo, mas sem perfil de acesso confiavel (diagnostico nao conseguiria operar)
  | 'available';

export interface LegacyStatusInput {
  pending: boolean;
  error: boolean;
  data?: { diagnosticEnabled?: boolean; diagnosticTrust?: string } | null | undefined;
}

export function legacyAvailability(status: LegacyStatusInput): LegacyAvailability {
  if (status.pending) return 'checking';
  if (status.error || !status.data) return 'unknown';
  if (status.data.diagnosticEnabled !== true) return 'disabled';
  if (status.data.diagnosticTrust !== 'AVAILABLE') return 'no-trust';
  return 'available';
}

export type ServiceCollectionAvailability = 'checking' | 'unavailable' | 'status-failed' | 'available';

export interface McpStatusInput {
  pending: boolean;
  error: boolean;
  data?: { enabled?: boolean } | null | undefined;
}

export function serviceCollectionAvailability(status: McpStatusInput): ServiceCollectionAvailability {
  if (status.pending) return 'checking';
  if (status.error) return 'status-failed';
  return status.data?.enabled === true ? 'available' : 'unavailable';
}

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER' | (string & {});

/** Mesmas regras que a API ja aplica ao legado: armar a janela = ADMIN; diagnosticar = ADMIN ou OPERATOR. */
export const canArmLegacy = (role: Role | undefined): boolean => role === 'ADMIN';
export const canExecuteLegacy = (role: Role | undefined): boolean => role === 'ADMIN' || role === 'OPERATOR';
