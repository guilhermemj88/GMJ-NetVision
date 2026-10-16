import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isMapVisualLabEnabled } from '@/lib/map-visual-lab';
import { MapVisualLab } from './map-visual-lab';
import './map-visual-preview.css';

export const metadata: Metadata = {
  title: 'MAP-VISUAL-V2 · Laboratório · GMJ NetVision',
  robots: { index: false, follow: false },
};

/**
 * Gate do laboratório.
 *
 * Sem `force-dynamic`: a decisão acontece na renderização da rota (dev) ou no
 * BUILD (produção/preview, onde `NODE_ENV`/`NEXT_PUBLIC_PREVIEW_MODE` já estão
 * fixos). Assim o build de PRODUÇÃO gera de fato a página 404 com status 404 —
 * em página dinâmica o App Router responde 200 com o conteúdo 404 por causa do
 * streaming, o que confundiria qualquer verificação. O build de PREVIEW
 * (`NEXT_PUBLIC_PREVIEW_MODE=true`) gera a página do laboratório normalmente.
 */
export default function MapVisualPreviewPage() {
  if (!isMapVisualLabEnabled()) notFound();
  return <MapVisualLab />;
}
