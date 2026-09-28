import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import '@xyflow/react/dist/style.css';
import './globals.css';
import './physical-preview.css';
import { Providers } from './providers';
import { PreviewBanner } from '@/components/preview-banner';
import { isPreviewMode } from '@/lib/preview-mode';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'GMJ NetVision',
  description: 'Topologia de rede, descoberta e observabilidade em um único mapa.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Com a flag desligada, o layout renderiza exatamente a mesma árvore de antes
  // (sem wrapper e sem banner), portanto a produção permanece idêntica.
  const previewMode = isPreviewMode();

  return (
    <html lang="pt-BR" className={`${inter.variable} ${mono.variable}`}>
      <body>
        {previewMode ? (
          <div className="nv-preview-root">
            <PreviewBanner enabled={previewMode} />
            <div className="nv-preview-root__body">
              <Providers>{children}</Providers>
            </div>
          </div>
        ) : (
          <Providers>{children}</Providers>
        )}
      </body>
    </html>
  );
}
