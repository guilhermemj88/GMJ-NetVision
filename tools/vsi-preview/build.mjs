// Gera o bundle do preview: node tools/vsi-preview/build.mjs  ->  tools/vsi-preview/dist/
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { previewBuildOptions } from './options.mjs';

mkdirSync('tools/vsi-preview/dist', { recursive: true });
const out = 'tools/vsi-preview/dist/vsi-preview-main.cjs';
const result = await build(previewBuildOptions(out));
const inputs = Object.keys(result.metafile.inputs).sort();
writeFileSync('tools/vsi-preview/dist/inputs.txt', inputs.join('\n') + '\n');
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync('tools/vsi-preview/dist/vsi-preview-main.cjs.sha256', `${sha}  vsi-preview-main.cjs\n`);
console.log(`ok ${inputs.length} modulos, sha256 ${sha.slice(0, 16)}`);
