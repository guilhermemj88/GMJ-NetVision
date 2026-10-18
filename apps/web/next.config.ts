import { hostname as osHostname } from 'node:os';
import type { NextConfig } from 'next';
import { resolveInstallationModuleAvailability } from '@gmj/shared';

const internalApiUrl = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3333')
  .trim()
  .replace(/\/+$/, '');

/**
 * IDENTIDADE DA INSTALAÇÃO no build.
 *
 * `NEXT_PUBLIC_*` só chega ao cliente se for inlinado aqui. A disponibilidade da
 * mitigação DDoS passa a depender da identidade (IMPLANTAR = permanentemente
 * habilitada), não de uma flag que se perde quando o build roda numa worktree
 * sem `.env` — foi assim que a aba desapareceu da produção.
 *
 * O valor explícito de `NEXT_PUBLIC_DDOS_MITIGATION_UI` continua valendo como
 * opt-in para outras instalações (laboratórios).
 */
const installation = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
  hostname: process.env.NETVISION_INSTALLATION_HOSTNAME ?? osHostname(),
  installationId: process.env.NETVISION_INSTALLATION_ID ?? null,
  flag: process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI ?? null,
});

const nextConfig: NextConfig = {
  transpilePackages: ['@gmj/shared', '@gmj/ui'],
  output: 'standalone',
  env: {
    NEXT_PUBLIC_INSTALLATION_HOSTNAME: process.env.NETVISION_INSTALLATION_HOSTNAME ?? osHostname(),
    NEXT_PUBLIC_INSTALLATION_ID: process.env.NETVISION_INSTALLATION_ID ?? '',
    NEXT_PUBLIC_DDOS_MITIGATION_UI: installation.enabled ? 'true' : 'false',
  },
  experimental: {
    // O discovery (BGP/mitigacao) e sincrono e faz SSH por peer; o proxy
    // padrao de 30s derrubava a conexao e a UI mostrava "API 500".
    proxyTimeout: 15 * 60 * 1000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
