#!/usr/bin/env bash
# ROLLBACK API (requer autorizacao de restart). Volta para 4637696 removendo SOMENTE o drop-in novo.
# A release bf7bc52 fica no disco (inativa). Nenhuma flag, banco ou outro servico e tocado.
set -euo pipefail
DROPIN=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf
PREV=/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e/apps/api
[ -f "$DROPIN" ] || { echo "drop-in ausente: nada a reverter"; exit 1; }
rm -f "$DROPIN"
systemctl daemon-reload
[ "$(systemctl show netvision-api -p WorkingDirectory --value)" = "$PREV" ] || { echo "ERRO: WorkingDirectory"; exit 1; }
echo "5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d  $PREV/dist/server.cjs" | sha256sum -c -
systemctl restart netvision-api
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3333/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3333/health; echo
systemctl is-active netvision-api netvision-mcp
