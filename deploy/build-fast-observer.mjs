// Run on Linux in the dedicated release directory. Existing build tools are read only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const [toolRoot, releaseRoot, commit] = process.argv.slice(2);
if (
  !toolRoot ||
  !releaseRoot?.startsWith('/opt/netvision-fast-observer/releases/rc-') ||
  !/^[a-f0-9]{40}$/.test(commit ?? '')
) {
  throw new Error(
    'Explicit build tools, dedicated observer release directory and full commit required',
  );
}
const source = path.join(releaseRoot, 'build');
const runtime = path.join(releaseRoot, 'runtime');
if (fs.existsSync(runtime)) throw new Error('Refusing to overwrite an existing runtime');
fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
const require = createRequire(path.join(toolRoot, 'package.json'));
require('esbuild').buildSync({
  entryPoints: [path.join(source, 'apps/api/src/mitigation-fast-observer-main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  external: ['./generated/prisma/index.js'],
  outfile: path.join(runtime, 'dist/mitigation-fast-observer-main.cjs'),
  sourcemap: true,
});
fs.cpSync(
  path.join(source, 'apps/api/src/generated/prisma'),
  path.join(runtime, 'dist/generated/prisma'),
  { recursive: true, dereference: true },
);
const dependencies = {};
function copy(name) {
  if (dependencies[name]) return;
  const packageFile = require.resolve(name + '/package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  dependencies[name] = pkg.version;
  fs.cpSync(path.dirname(packageFile), path.join(runtime, 'node_modules', name), {
    recursive: true,
    dereference: true,
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) copy(dep);
}
copy('@prisma/client');
copy('net-snmp');
const bundle = fs.readFileSync(path.join(runtime, 'dist/mitigation-fast-observer-main.cjs'));
for (const forbidden of [
  'MitigationAutoEngine',
  'MitigationCommandService',
  'HuaweiMitigationExecutor',
  'require("ssh2")',
]) {
  if (bundle.includes(forbidden)) throw new Error('Actuation dependency in observer bundle');
}
fs.writeFileSync(
  path.join(runtime, 'package.json'),
  JSON.stringify(
    { name: 'netvision-fast-observer', private: true, type: 'commonjs', dependencies },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(runtime, 'release.json'),
  JSON.stringify(
    {
      commit,
      builtAt: new Date().toISOString(),
      mode: 'OBSERVE',
      executionAvailable: false,
      dependencies,
      sha256: createHash('sha256').update(bundle).digest('hex'),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ runtime, commit, dependencies, bytes: bundle.length }));
