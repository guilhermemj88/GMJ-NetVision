import type { Metadata } from 'next';
import { PhysicalCatalogPreview } from '@/components/physical/physical-catalog-preview';

export const metadata: Metadata = {
  title: 'GMJ NetVision · Preview dos painéis físicos',
};

/**
 * Tela de desenvolvimento: mostra todo o catálogo físico com o MESMO renderer
 * do módulo Físico (painel por imagem quando existir, grade geométrica como
 * fallback). Nada é gravado — nenhum POP, rack ou equipamento é criado.
 */
export default function PhysicalCatalogPreviewPage() {
  return <PhysicalCatalogPreview />;
}
