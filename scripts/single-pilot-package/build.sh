set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends openssl ca-certificates
mkdir /work
cp /audit/source.tar /tmp/source.tar
tar -xf /tmp/source.tar -C /work
cd /work
npm ci --workspace @gmj/api --include-workspace-root --ignore-scripts --no-audit --no-fund
npm run build -w @gmj/api
sha256sum apps/api/dist/server.cjs apps/api/dist/server.cjs.map apps/api/dist/catalog/physical-catalog-v1.yaml > /tmp/first-build.sha256
npm run build -w @gmj/api
sha256sum -c /tmp/first-build.sha256
cp /tmp/first-build.sha256 /output/reproducible-build.sha256
npm prune --omit=dev --workspace @gmj/api --include-workspace-root --ignore-scripts --no-audit --no-fund
node /audit/package.mjs
epoch=$(node -p 'JSON.parse(require("fs").readFileSync("/audit/build-input.json")).epoch')
sha=$(node -p 'JSON.parse(require("fs").readFileSync("/audit/build-input.json")).sha')
name="netvision-single-pilot-api-${sha}.tar.gz"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -cf /tmp/package.tar -C /release .
gzip -n -c /tmp/package.tar > "/output/$name"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -cf /tmp/package-again.tar -C /release .
gzip -n -c /tmp/package-again.tar > /tmp/package-again.tar.gz
cmp "/output/$name" /tmp/package-again.tar.gz
cd /output
sha256sum "$name" > package.sha256
