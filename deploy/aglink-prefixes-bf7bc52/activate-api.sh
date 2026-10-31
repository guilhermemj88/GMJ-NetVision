#!/usr/bin/env bash
# ETAPA B (requer autorizacao EXPLICITA de restart API/MCP). Aponta a API para bf7bc52.
# Um drop-in novo, posterior a todos; mesmas EnvironmentFiles (nenhuma flag muda).
# O MCP reinicia por Requires=netvision-api.service (mesmo grafo de 30/10).
set -euo pipefail
SHA=bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59
REL=/opt/netvision-auto-activate/releases/$SHA/apps/api
DIR=/etc/systemd/system/netvision-api.service.d
DROPIN=$DIR/zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf

[ -f "$REL/dist/server.cjs" ] || { echo "ERRO: release nao instalada"; exit 1; }
[ -e "$DROPIN" ] && { echo "ERRO: drop-in ja existe"; exit 1; }
LAST=$(ls "$DIR" | sort | tail -1)
[ "$LAST" = "zzzzzzzzzzzzzzzzzzzzzz-single-pilot-4637696-auto0.conf" ] || { echo "ERRO: ultimo drop-in inesperado: $LAST"; exit 1; }

cat > "$DROPIN.tmp" <<EOF
# AGLINK prefixos — API bf7bc52 (contrato prefixes). Rollback: remover este arquivo.
[Service]
WorkingDirectory=$REL
ExecStart=
ExecStart=/usr/bin/node $REL/dist/server.cjs
EOF
chmod 644 "$DROPIN.tmp"; mv "$DROPIN.tmp" "$DROPIN"
systemctl daemon-reload
[ "$(systemctl show netvision-api -p WorkingDirectory --value)" = "$REL" ] || { echo "ERRO: drop-in nao efetivo"; exit 1; }
systemctl restart netvision-api
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3333/health >/dev/null 2>&1 && break; sleep 1
done
curl -fsS http://127.0.0.1:3333/health; echo
systemctl is-active netvision-api netvision-mcp
