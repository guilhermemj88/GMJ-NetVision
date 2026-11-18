/**
 * A1-b (3a auditoria): falha de COLETA nao e evidencia.
 *
 * O `readVsi` do fallback CLI nunca lanca: ele devolve um reading com
 * `available: false` quando a sessao nao chegou a produzir resultado. Sem
 * distinguir isso de um veredito legitimo, o merge tratava "nao consegui falar
 * com o equipamento" como "nao ha VSI" e rebaixava `FOUND_L2VC` para
 * `INCOMPLETE`.
 *
 * Regra:
 *  - `available: true`  -> houve leitura (mesmo que vazia): EVIDENCIA;
 *  - `supported: false` -> o VRP respondeu que o comando nao existe: EVIDENCIA
 *    de que a plataforma nao tem VSI/MPLS;
 *  - qualquer outra combinacao com erro -> FALHA, e o ultimo estado comprovado
 *    e preservado (`touchPolling`), com o motivo classificado para diagnostico.
 */
export type MplsSshFailureKind =
  | 'AUTH'
  | 'REFUSED'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'NO_RESPONSE'
  | 'NOT_CONFIGURED'
  | 'OTHER';

/** Classifica o texto normalizado por `safeSshError`/`readVsi`. */
export function classifyMplsSshFailure(message: string | null | undefined): MplsSshFailureKind {
  const text = (message ?? '').toLowerCase();
  if (!text) return 'OTHER';
  if (text.includes('authentication') || text.includes('permission denied')) return 'AUTH';
  if (text.includes('not enabled') || text.includes('não está habilitado')) return 'NOT_CONFIGURED';
  if (text.includes('timeout') || text.includes('timed out')) return 'TIMEOUT';
  if (text.includes('refused')) return 'REFUSED';
  if (text.includes('unreachable') || text.includes('no route')) return 'UNREACHABLE';
  if (
    text.includes('connection lost') ||
    text.includes('closed') ||
    text.includes('not connected') ||
    text.includes('socket') ||
    text.includes('command failed')
  )
    return 'NO_RESPONSE';
  return 'OTHER';
}

/** Motivo pelo qual o reading NAO conta como evidencia (ou `null` se conta). */
export function mplsSshFailureOf(reading: {
  available: boolean;
  supported: boolean | null;
  errorSafe: string | null;
}): MplsSshFailureKind | null {
  if (reading.available) return null;
  // Veredito explicito do equipamento: nao suporta VSI/MPLS. Isso e evidencia.
  if (reading.supported === false) return null;
  return classifyMplsSshFailure(reading.errorSafe);
}
