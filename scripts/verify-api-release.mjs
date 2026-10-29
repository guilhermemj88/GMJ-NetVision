import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Read-only packaging gate; execute from apps/api, or pass its release directory.
const root = resolve(process.argv[2] ?? 'apps/api');
const files = ['dist/server.cjs', 'dist/server.cjs.map', 'dist/catalog/physical-catalog-v1.yaml'];
const hashes = {};
for (const file of files) {
  const data = await readFile(resolve(root, file));
  if (!data.length) throw Error(`Empty release artifact: ${file}`);
  hashes[file] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
console.log(JSON.stringify({ root, files: hashes }, null, 2));
