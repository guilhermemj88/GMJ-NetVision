import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';

const { sha, archiveHash } = JSON.parse(fs.readFileSync('/audit/build-input.json', 'utf8'));
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (hash('/tmp/source.tar') !== archiveHash) throw Error('Source archive mismatch');
const output = '/release';
fs.mkdirSync(output);
fs.mkdirSync(output + '/apps/api/dist/catalog', { recursive: true });
const artifacts = ['server.cjs', 'server.cjs.map', 'catalog/physical-catalog-v1.yaml'];
for (const f of artifacts)
  fs.copyFileSync('/work/apps/api/dist/' + f, output + '/apps/api/dist/' + f);
fs.cpSync('/work/apps/api/src/generated/prisma', output + '/apps/api/src/generated/prisma', {
  recursive: true,
});
fs.cpSync('/work/node_modules', output + '/node_modules', {
  recursive: true,
  verbatimSymlinks: true,
});
// Shared code is bundled. Workspace links would point to absent WEB/MCP/source trees.
for (const name of fs.readdirSync(output + '/node_modules/@gmj'))
  fs.rmSync(output + '/node_modules/@gmj/' + name, { recursive: true, force: true });
for (const f of ['package.json', 'package-lock.json', 'apps/api/package.json'])
  fs.copyFileSync('/work/' + f, output + '/' + f);
fs.cpSync('/work/apps/api/prisma', output + '/apps/api/prisma', { recursive: true });
fs.writeFileSync(output + '/SOURCE_SHA', sha + '\n');
const files = [],
  links = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name),
      stat = fs.lstatSync(p),
      relative = path.relative(output, p);
    if (stat.isSymbolicLink()) {
      if (!fs.realpathSync(p).startsWith(output + '/')) throw Error('External symlink ' + relative);
      links.push({ path: relative, target: fs.readlinkSync(p) });
    } else if (stat.isDirectory()) walk(p);
    else {
      if (name === '.env' || name.startsWith('.env.')) throw Error('Environment file in package');
      files.push({ path: relative, bytes: stat.size, sha256: hash(p) });
    }
  }
}
walk(output);
const manifest = {
  sourceSha: sha,
  preparedApiBase: '0badeba52a5699e08287b7b17e19428f60d1d7b8',
  sourceArchiveSha256: archiveHash,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  npm: cp.execFileSync('npm', ['--version']).toString().trim(),
  builderImage: 'sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24',
  systemDependencies: cp.execFileSync('dpkg-query', ['-W', 'openssl', 'libssl3']).toString().trim(),
  compiledArtifacts: Object.fromEntries(
    artifacts.map((f) => [f, hash(output + '/apps/api/dist/' + f)]),
  ),
  compiledHashesReproduced: true,
  packageTarReproduced: true,
  scope:
    'API server, catalog, production dependencies, Linux Prisma, existing migrations; no WEB/MCP/observer/worker bundles or configuration',
  fileCount: files.length,
  totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  symlinks: links,
  files,
};
fs.writeFileSync('/output/artifact-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, files: undefined, symlinks: undefined }));
