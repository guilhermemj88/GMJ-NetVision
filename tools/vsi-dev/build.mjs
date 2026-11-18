// Gera os bundles de homologacao: node tools/vsi-dev/build.mjs  -> tools/vsi-dev/dist/
import { build } from 'esbuild';
import { harnessOptions, mcpOptions } from './options.mjs';

await build(harnessOptions());
await build(mcpOptions());
console.log('ok');
