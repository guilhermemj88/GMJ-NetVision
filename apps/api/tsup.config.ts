import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/mitigation-worker-main.ts', 'src/mitigation-fast-observer-main.ts'],
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  clean: true,
  sourcemap: true,
  noExternal: ['@gmj/shared'],
});
