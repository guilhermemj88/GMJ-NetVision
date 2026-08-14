import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@gmj/shared', '@gmj/ui'],
  output: 'standalone',
};

export default nextConfig;
