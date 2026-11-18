import { request } from './api';

/**
 * Estado do recurso de execucao ao vivo (VSI_MCP_ENABLED) informado pela API em runtime.
 * SOMENTE LEITURA (GET): consultar o estado nunca executa diagnostico nem abre SSH.
 * Falha de consulta = tratado como INDISPONIVEL pelo chamador (fail-closed).
 */
export interface VsiMcpStatus {
  enabled: boolean;
}

export async function getVsiMcpStatus(): Promise<VsiMcpStatus> {
  const data = await request<{ enabled?: unknown }>('/api/vsi-mcp/status');
  return { enabled: data?.enabled === true };
}
