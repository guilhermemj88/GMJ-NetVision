import { mkdir, copyFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/mitigation-worker-main.ts', 'src/mitigation-fast-observer-main.ts'],
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  clean: true,
  async onSuccess() {
    await mkdir('dist/catalog', { recursive: true });
    await copyFile('catalog/physical-catalog-v1.yaml', 'dist/catalog/physical-catalog-v1.yaml');
  },
  sourcemap: true,
  noExternal: ['@gmj/shared'],
});
