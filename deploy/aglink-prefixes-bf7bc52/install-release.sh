#!/usr/bin/env bash
# ETAPA A (requer autorizacao de deploy). Instala a release bf7bc52 AO LADO da 4637696.
# NAO toca em systemd, EnvironmentFiles, banco, WEB, MCP ou Observer.
# Uso (no IMPLANTAR): sudo bash install-release.sh /home/guilherme/staging-bf7bc52
set -euo pipefail
STAGE=${1:?staging dir}
SHA=bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59
PKG=netvision-single-pilot-api-$SHA.tar.gz
PKG_SHA256=585ed6ef2db7451075fb26e072a5bc5e666bf600e7a24e899f0970031eca5e7d
MANIFEST_SHA256=e2c5057096c9cd18edcffccfc42f5e826d6054484e5d60a6e400a5dadcbbfacf
DEST=/opt/netvision-auto-activate/releases/$SHA
CURRENT=/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e

[ -e "$DEST" ] && { echo "ERRO: $DEST ja existe"; exit 1; }
echo "$PKG_SHA256  $STAGE/$PKG" | sha256sum -c -
echo "$MANIFEST_SHA256  $STAGE/artifact-manifest.json" | sha256sum -c -

TMP=$(mktemp -d /opt/netvision-auto-activate/releases/.incoming-XXXXXX)
tar -xzf "$STAGE/$PKG" -C "$TMP"
[ "$(cat "$TMP/SOURCE_SHA")" = "$SHA" ] || { echo "ERRO: SOURCE_SHA"; exit 1; }

# Todos os arquivos do manifesto, byte a byte.
SHA=$SHA node -e '
const fs=require("fs"),c=require("crypto");const [m,root]=process.argv.slice(1);
const man=JSON.parse(fs.readFileSync(m));let bad=0;
for(const f of man.files){const h=c.createHash("sha256").update(fs.readFileSync(root+"/"+f.path)).digest("hex");if(h!==f.sha256)bad++;}
if(bad||man.sourceSha!==process.env.SHA){console.error("ERRO: manifesto",bad);process.exit(1)}
console.log("manifesto OK: "+man.files.length+" arquivos");' "$STAGE/artifact-manifest.json" "$TMP"

# Schema: migrations identicas as da release em producao (nenhuma migration nova).
diff <(cd "$CURRENT/apps/api/prisma/migrations" && find . -type f -exec sha256sum {} + | sort -k2) \
     <(cd "$TMP/apps/api/prisma/migrations" && find . -type f -exec sha256sum {} + | sort -k2) \
  && echo "migrations identicas a 4637696"

chown -R root:root "$TMP"; chmod 755 "$TMP"
mv "$TMP" "$DEST"
echo "INSTALADA (inativa): $DEST"
