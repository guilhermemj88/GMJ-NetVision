import type { NextConfig } from 'next';

const internalApiUrl = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3333')
  .trim()
  .replace(/\/+$/, '');

const nextConfig: NextConfig = {
  transpilePackages: ['@gmj/shared', '@gmj/ui'],
  output: 'standalone',
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
