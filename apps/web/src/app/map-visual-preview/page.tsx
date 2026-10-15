import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isMapVisualLabEnabled } from '@/lib/map-visual-lab';
import { MapVisualLab } from './map-visual-lab';
import './map-visual-preview.css';

export const metadata: Metadata = {
  title: 'MAP-VISUAL-V2 · Laboratório · GMJ NetVision',
  robots: { index: false, follow: false },
};

// A página decide em tempo de requisição: fora de ambiente local/preview ela
// nem é servida — responde 404, como qualquer rota inexistente.
export const dynamic = 'force-dynamic';

export default function MapVisualPreviewPage() {
  if (!isMapVisualLabEnabled()) notFound();
  return <MapVisualLab />;
}
