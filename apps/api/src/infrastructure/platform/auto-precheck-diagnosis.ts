/**
 * P4-b (3a auditoria): diagnostico Rastreavel do pre-check do AUTO.
 *
 * O pre-check le CLI Huawei (config BGP + config fisica de mitigacao) antes de
 * liberar um alvo. Toda falha continua FAIL-CLOSED (o alvo nao e promovido),
 * mas as causas precisam ser distinguiveis — e, acima de tudo, uma falha de
 * TRANSPORTE nao pode ser lida como "fabricante incompativel".
 *
 * Regra: `ineligible: true` **somente** para veredito de plataforma. Qualquer
 * erro de sessao/autorizacao/transitorio e `ineligible: false` (o equipamento
 * nao foi julgado), e o log diz exatamente o que aconteceu.
 */
export type AutoPrecheckCode =
  | 'PLATFORM_NOT_SUPPORTED'
  | 'AUTHORIZATION'
  | 'SSH_AUTH'
  | 'SSH_REFUSED'
  | 'SSH_UNREACHABLE'
  | 'SSH_TIMEOUT'
  | 'SSH_NO_RESPONSE'
  | 'SSH_ERROR'
  | 'TRANSIENT';

export interface AutoPrecheckDiagnosis {
  code: AutoPrecheckCode;
  /**
   * `true` apenas quando o proprio equipamento foi julgado inelegivel.
   * `false` = nao houve julgamento (falha de coleta/transporte/autorizacao).
   */
  ineligible: boolean;
  detail: string;
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

/** Codigo de erro de driver/Prisma (ex.: `P1001`, `ECONNRESET`). */
function codeOf(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : '';
}

export function diagnoseAutoPrecheckFailure(error: unknown): AutoPrecheckDiagnosis {
  const message = textOf(error);
  const text = message.toLowerCase();
  const code = codeOf(error).toUpperCase();

  // Veredito do gate de plataforma (M1/P4): o equipamento foi avaliado.
  if (text.includes('platform_not_supported')) {
    return { code: 'PLATFORM_NOT_SUPPORTED', ineligible: true, detail: message };
  }
  // Politica/credencial de execucao: nao e julgamento do equipamento.
  if (
    text.includes('not allowed') ||
    text.includes('authoriz') ||
    text.includes('forbidden') ||
    text.includes('mitigation_allowed_device_ids')
  ) {
    return { code: 'AUTHORIZATION', ineligible: false, detail: message };
  }
  if (code.startsWith('P1') || code.startsWith('P2')) {
    // Banco indisponivel/erro de query: transitorio.
    return { code: 'TRANSIENT', ineligible: false, detail: message };
  }
  if (text.includes('authentication') || text.includes('permission denied')) {
    return { code: 'SSH_AUTH', ineligible: false, detail: message };
  }
  if (text.includes('timeout') || text.includes('timed out') || code === 'ETIMEDOUT') {
    return { code: 'SSH_TIMEOUT', ineligible: false, detail: message };
  }
  if (text.includes('refused') || code === 'ECONNREFUSED') {
    return { code: 'SSH_REFUSED', ineligible: false, detail: message };
  }
  if (text.includes('unreachable') || text.includes('no route') || code === 'EHOSTUNREACH') {
    return { code: 'SSH_UNREACHABLE', ineligible: false, detail: message };
  }
  if (
    text.includes('connection lost') ||
    text.includes('closed') ||
    text.includes('not connected') ||
    text.includes('socket') ||
    code === 'ECONNRESET'
  ) {
    return { code: 'SSH_NO_RESPONSE', ineligible: false, detail: message };
  }
  return { code: 'SSH_ERROR', ineligible: false, detail: message };
}

/**
 * Executa o pre-check e, em caso de falha, entrega o diagnostico ao chamador
 * (log estruturado) devolvendo `null`: o alvo nao e promovido.
 */
export async function runAutoPrecheck<T>(
  read: () => Promise<T>,
  onFailure: (diagnosis: AutoPrecheckDiagnosis) => void,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    onFailure(diagnoseAutoPrecheckFailure(error));
    return null;
  }
}
