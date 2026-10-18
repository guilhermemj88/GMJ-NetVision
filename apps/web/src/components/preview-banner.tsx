'use client';

import { isPreviewMode } from '@/lib/preview-mode';

/**
 * Identificacao visual do ambiente de PREVIEW.
 *
 * A Web de preview roda em outra porta, com outro worktree e outra branch, mas
 * consome dados REAIS. O aviso precisa ser impossivel de confundir com
 * producao — e precisa dizer a VERDADE sobre a instancia: qual porta serve a
 * interface e qual API esta por tras (a instancia de preview pode ser somente
 * leitura, e afirmar o contrario assustaria sem motivo).
 *
 * `NEXT_PUBLIC_PREVIEW_META` e resolvido no build do preview; sem ele o texto
 * cai num rótulo curto e igualmente honesto.
 *
 * Quando `NEXT_PUBLIC_PREVIEW_MODE` nao for exatamente `true`, este modulo nao
 * renderiza absolutamente nada e a producao permanece visualmente identica.
 */
export const PREVIEW_BANNER_TEXT = 'PREVIEW · INTERFACE EXPERIMENTAL · DADOS DE PRODUÇÃO';

export const PREVIEW_BANNER_DEFAULT_META = 'instância de preview · dados reais';

function previewMeta(): string {
  const value = process.env.NEXT_PUBLIC_PREVIEW_META?.trim();
  return value ? value : PREVIEW_BANNER_DEFAULT_META;
}

export interface PreviewBannerProps {
  enabled?: boolean;
}

/**
 * Barra fixa no topo quando o preview esta ligado.
 *
 * `enabled` e resolvido pelo layout raiz (server component) e passado como
 * prop: assim servidor e cliente concordam sempre, mesmo que o valor de build
 * do bundle cliente divirja do `process.env` de runtime do servidor. Sem a
 * prop o componente decide sozinho pela flag (usado nos testes).
 */
export function PreviewBanner({ enabled }: PreviewBannerProps) {
  if (!(enabled ?? isPreviewMode())) return null;
  const meta = previewMeta();

  return (
    <div
      className="nv-preview-banner"
      data-testid="preview-banner"
      role="note"
      aria-label={`${PREVIEW_BANNER_TEXT}. ${meta}.`}
    >
      <span className="nv-preview-banner__label">{PREVIEW_BANNER_TEXT}</span>
      <span className="nv-preview-banner__meta">{meta}</span>
    </div>
  );
}
