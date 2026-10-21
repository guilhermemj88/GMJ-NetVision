/**
 * Habilitação do laboratório MAP-VISUAL-V2 (rota `/map-visual-preview`).
 *
 * O laboratório existe SOMENTE em ambiente local/isolado:
 *  - `NODE_ENV=development` (next dev local); ou
 *  - build de PREVIEW isolado (`NEXT_PUBLIC_PREVIEW_MODE=true`), o mesmo
 *    flag já usado pelo banner de preview.
 *
 * Em produção (build normal da main) a flag fica desligada: a página responde
 * 404 (`notFound()`) e a rota não entra na lista de rotas públicas do app.
 *
 * Este módulo não altera classificação AUTO, tipos persistidos nem
 * equipamentos — apenas controla a visibilidade da rota do laboratório.
 */
export function isMapVisualLabEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true'
  );
}
