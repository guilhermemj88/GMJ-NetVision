import type { VsiServiceDiagnosis, VsiServiceRunSummary } from '@gmj/shared';
import { request } from './api';

/**
 * Cliente do Diagnostico VSI/VPLS por servico. SOMENTE LEITURA: estas tres chamadas sao GET e so
 * consultam resultados ja guardados. Nenhuma delas executa diagnostico nem abre SSH — a execucao
 * (POST, com aprovacao one-shot por PE) nao e chamada por esta tela.
 */
export interface VsiServiceStatus {
  enabled: boolean;
  engineAvailable: boolean;
  legacyAvailable: boolean;
  archiveAvailable?: boolean;
  /** A API informa se o papel da sessao pode listar/abrir resultados detalhados (OPERATOR/ADMIN). */
  resultsAccess?: boolean;
}
export interface VsiServiceClient {
  status(): Promise<VsiServiceStatus>;
  list(vsiName?: string): Promise<VsiServiceRunSummary[]>;
  get(runId: string): Promise<VsiServiceDiagnosis>;
}

const BASE = '/api/vsi-service-diagnostics';
export const vsiServiceClient: VsiServiceClient = {
  status: () => request<VsiServiceStatus>(`${BASE}/status`),
  list: async (vsiName) =>
    (await request<{ runs: VsiServiceRunSummary[] }>(vsiName ? `${BASE}?vsiName=${encodeURIComponent(vsiName)}` : BASE)).runs,
  get: (runId) => request<VsiServiceDiagnosis>(`${BASE}/${encodeURIComponent(runId)}`),
};
