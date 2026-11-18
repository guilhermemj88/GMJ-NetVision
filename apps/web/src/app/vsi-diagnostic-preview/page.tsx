import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { VsiServicePreview } from '@/components/diagnostics/service/service-preview';
import { isVsiDiagnosticPreviewEnabled } from '@/lib/vsi-diagnostic-preview';

// Sem isto o build pre-renderiza a pagina "nao encontrada" e a serve com HTTP 200. Dinamica, a decisao e por
// requisicao e fora de `next dev` a resposta e um 404 de verdade.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'GMJ NetVision · Preview do Diagnóstico VSI/VPLS',
};

/**
 * Tela de desenvolvimento: renderiza os componentes reais do diagnostico por servico com
 * fixtures. Nenhuma chamada a API, nenhum SSH, nada e gravado. Fora de dev/preview: 404.
 */
export default async function VsiDiagnosticPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ cenario?: string; ev?: string }>;
}) {
  if (!isVsiDiagnosticPreviewEnabled()) notFound();
  const { cenario, ev } = await searchParams;
  return <VsiServicePreview scenario={cenario ?? '3072'} evidenceId={ev ?? null} />;
}
