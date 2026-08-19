import type { NextConfig } from 'next';

const internalApiUrl = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3333')
  .trim()
  .replace(/\/+$/, '');

const nextConfig: NextConfig = {
  transpilePackages: ['@gmj/shared', '@gmj/ui'],
  output: 'standalone',
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
