#!/usr/bin/env bash
# ETAPA A do deploy do motor B6 (REQUER AUTORIZACAO ESPECIFICA).
# Instala a release 2ad62b8 AO LADO da bf7bc52, SEM alterar systemd, flags,
# banco, WEB, MCP, Observer ou n8n. Nenhuma migration, nenhum DDL.
#
# Uso (no IMPLANTAR): sudo bash install-release.sh /home/guilherme/staging-b6-2ad62b8
set -euo pipefail
STAGE=${1:?staging dir}
SHA=2ad62b8077250d99a25ef243d0b8ea632e85d757
PKG=netvision-single-pilot-api-$SHA.tar.gz
PKG_SHA256=a17b503ca2c6ce9389223a76af6f8af3a4bfd981189160643bc58c1987086a22
MANIFEST_SHA256=5ff8fedb473161f638f3ed301ecaa1b7851b6bf23911cc24d1aaa82c87428c24
DEST=/opt/netvision-auto-activate/releases/$SHA
# Release ativa no momento desta preparacao (origem da comparacao de migrations).
CURRENT=${CURRENT_RELEASE:-/opt/netvision-auto-activate/releases/bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59}

[ -e "$DEST" ] && { echo "ERRO: $DEST ja existe"; exit 1; }
[ -d "$CURRENT" ] || { echo "ERRO: release atual ausente em $CURRENT"; exit 1; }

echo "$PKG_SHA256  $STAGE/$PKG" | sha256sum -c -
echo "$MANIFEST_SHA256  $STAGE/artifact-manifest.json" | sha256sum -c -

# Espaco: a release ocupa ~300 MB; exigir folga de seguranca.
AVAIL_KB=$(df --output=avail /opt | tail -1 | tr -dc '0-9')
[ "$AVAIL_KB" -gt 3145728 ] || { echo "ERRO: menos de 3 GB livres em /opt"; exit 1; }

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

# Prova de que nenhum arquivo proibido entrou no pacote.
[ -z "$(find "$TMP" -name '.env' -o -name '.env.*' | head -1)" ] ||
  { echo "ERRO: arquivo .env no pacote"; exit 1; }

# Schema: migrations IDENTICAS as da release ativa (nenhuma migration nova).
diff <(cd "$CURRENT/apps/api/prisma/migrations" && find . -type f -exec sha256sum {} + | sort -k2) \
     <(cd "$TMP/apps/api/prisma/migrations" && find . -type f -exec sha256sum {} + | sort -k2) \
  && echo "migrations identicas a $(basename "$CURRENT")"

chown -R root:root "$TMP"; chmod 755 "$TMP"
mv "$TMP" "$DEST"
echo "INSTALADA (inativa): $DEST"
echo "A API continua servindo a release anterior ate a ativacao explicita."
