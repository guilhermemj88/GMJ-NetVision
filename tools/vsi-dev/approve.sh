#!/bin/bash
# ATO HUMANO (ADMIN): cria UMA aprovacao one-shot. Uso: approve.sh [NOME_DA_VSI]   (sem nome = escopo de descoberta do host)
set -eu
D="${VSI_DEV_DIR:-$HOME/vsi-dev}"; B=http://127.0.0.1:${VSI_DEV_PORT:-43901}
HOSTID=$(python3 -c "import json;print(json.load(open('$D/host.json'))['id'])")
U=$(python3 -c "import json;print(json.load(open('$D/secrets.json'))['admin']['usernameOrEmail'])")
P=$(python3 -c "import json;print(json.load(open('$D/secrets.json'))['admin']['password'])")
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
curl -fs -c "$JAR" -H 'content-type: application/json' -d "{\"usernameOrEmail\":\"$U\",\"password\":\"$P\"}" $B/api/auth/login >/dev/null
if [ $# -ge 1 ]; then BODY="{\"hostId\":\"$HOSTID\",\"vsiName\":\"$1\",\"ttlSeconds\":600}"; else BODY="{\"hostId\":\"$HOSTID\",\"ttlSeconds\":600}"; fi
curl -fs -b "$JAR" -H 'content-type: application/json' -d "$BODY" $B/api/vsi-mcp/approvals
echo
