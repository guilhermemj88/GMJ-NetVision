'use client';

import { isPreviewMode } from '@/lib/preview-mode';

/**
 * Identificacao visual do ambiente de PREVIEW.
 *
 * A Web de preview roda em outra porta, com outro worktree e outra branch, mas
 * consome a MESMA API real e o MESMO PostgreSQL da producao. Por isso o aviso
 * precisa ser impossivel de confundir com producao: os dados exibidos aqui sao
 * reais e acoes de escrita afetam o ambiente de verdade.
 *
 * Quando `NEXT_PUBLIC_PREVIEW_MODE` nao for exatamente `true`, este modulo nao
 * renderiza absolutamente nada e a producao permanece visualmente identica.
 */
export const PREVIEW_BANNER_TEXT = 'PREVIEW · INTERFACE EXPERIMENTAL · DADOS DE PRODUÇÃO';

/** Barra fixa no topo do ambiente autenticado quando o preview esta ligado. */
export function PreviewBanner() {
  if (!isPreviewMode()) return null;

  return (
    <div
      className="nv-preview-banner"
      data-testid="preview-banner"
      role="note"
      aria-label={`${PREVIEW_BANNER_TEXT}. Web de preview na porta 3001 usando a API real.`}
    >
      <span className="nv-preview-banner__label">{PREVIEW_BANNER_TEXT}</span>
      <span className="nv-preview-banner__meta">Web :3001 · dados reais · API compartilhada :3333</span>
    </div>
  );
}
