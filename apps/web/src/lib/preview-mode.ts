/**
 * Leitura da flag de ambiente de PREVIEW.
 *
 * Módulo neutro (sem `'use client'`) de propósito: o layout raiz é um server
 * component e precisa decidir se monta o shell de preview, enquanto o banner é
 * um client component. `NEXT_PUBLIC_*` é substituído em tempo de build tanto no
 * grafo do servidor quanto no do cliente, então os dois lados concordam.
 *
 * Somente o valor exato `"true"` liga o preview; qualquer outra coisa
 * (ausente, `"false"`, `"1"`) mantém a produção exatamente como está.
 */
export function isPreviewMode(): boolean {
  return process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true';
}
