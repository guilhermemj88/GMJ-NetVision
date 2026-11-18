// Opcoes de empacotamento do harness DEV (usadas por build.mjs e pelos testes).
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;" };
export const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning', external: ['cpu-features', './crypto/build/Release/sshcrypto.node'] };
export const harnessOptions = (outfile = 'tools/vsi-dev/dist/harness.mjs') => ({ ...common, entryPoints: ['tools/vsi-dev/harness.ts'], outfile, format: 'esm', banner });
export const mcpOptions = (outfile = 'tools/vsi-dev/dist/mcp.mjs') => ({ ...common, entryPoints: ['tools/mcp-netvision/src/server.ts'], outfile, format: 'esm', banner });
