#!/bin/bash
# Sobe harness (API DEV) e MCP DEV, ambos em 127.0.0.1. Nada em /opt, systemd ou producao.
# Uma instancia por equipamento: VSI_DEV_DIR (padrao ~/vsi-dev), VSI_DEV_PORT (43901) e VSI_MCP_PORT (43902).
set -eu
D="${VSI_DEV_DIR:-$HOME/vsi-dev}"; AP="${VSI_DEV_PORT:-43901}"; MP="${VSI_MCP_PORT:-43902}"; cd "$D"
export VSI_DEV_DIR="$D" VSI_DEV_PORT="$AP"
pkill -u "$USER" -f "$D/dist/harness.mjs" 2>/dev/null || true
pkill -u "$USER" -f "$D/dist/mcp.mjs" 2>/dev/null || true
sleep 1
nohup node "$D/dist/harness.mjs" > "$D/harness.out" 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs http://127.0.0.1:$AP/health >/dev/null 2>&1 && break; sleep 1; done
U=$(python3 -c "import json;print(json.load(open('$D/secrets.json'))['mcp']['usernameOrEmail'])")
P=$(python3 -c "import json;print(json.load(open('$D/secrets.json'))['mcp']['password'])")
MCP_HOST=127.0.0.1 MCP_PORT=$MP NETVISION_API_URL=http://127.0.0.1:$AP NETVISION_REPO_ROOT="$D" \
NETVISION_MCP_USERNAME="$U" NETVISION_MCP_PASSWORD="$P" \
nohup node "$D/dist/mcp.mjs" > "$D/mcp.out" 2>&1 &
sleep 2
curl -fs http://127.0.0.1:$AP/health; echo; curl -fs http://127.0.0.1:$MP/health; echo
