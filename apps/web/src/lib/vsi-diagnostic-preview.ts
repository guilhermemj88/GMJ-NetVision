/**
 * Pre-visualizacao da nova tela de Diagnostico VSI/VPLS (rota `/vsi-diagnostic-preview`).
 *
 * Existe SOMENTE em `next dev` (NODE_ENV=development). Em QUALQUER build — producao ou preview
 * isolado, com qualquer flag — a pagina responde 404 e a rota exige sessao como o resto do app.
 *
 * Motivo de nao aceitar flag de build: a pagina e sem sessao e mostra fixtures com nomes de
 * equipamentos, loopbacks e VSIs reais. Um build publicado com a flag exporia esses dados sem
 * login. As fixtures sao importadas apenas por componentes de servidor, portanto nao entram nos
 * arquivos estaticos (`/_next/static`), que sao servidos sem autenticacao.
 *
 * Nao e uma segunda aba: nao ha link para ela no app.
 */
export function isVsiDiagnosticPreviewEnabled(): boolean {
  return process.env.NODE_ENV === 'development';
}
