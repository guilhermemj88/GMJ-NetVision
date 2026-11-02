#!/usr/bin/env bash
# ROLLBACK para a release bf7bc52 (REQUER AUTORIZACAO).
# Remove os drop-ins da release B6, recarrega o systemd e reinicia SOMENTE a API.
# Nao toca no banco (o deploy nao aplicou migration) nem em WEB/MCP/n8n.
#
# Uso (no IMPLANTAR): sudo bash rollback-to-bf7bc52.sh
set -euo pipefail
B6_DROPIN=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzzz-b6-2ad62b8.conf
B6_LIVE_OFF=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzzzzz-b6-flags.conf
BF7_DROPIN=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf

[ -f "$BF7_DROPIN" ] || { echo "ERRO: drop-in da bf7bc52 ausente — rollback nao e seguro"; exit 1; }

BACKUP_DIR=/root/netvision-backups/b6-rollback-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR/systemd"
cp -a /etc/systemd/system/netvision-api.service.d/. "$BACKUP_DIR/systemd/" 2>/dev/null || true
echo "drop-ins atuais salvos em $BACKUP_DIR"

rm -f "$B6_DROPIN" "$B6_LIVE_OFF"
systemctl daemon-reload
systemctl restart netvision-api

for i in $(seq 1 30); do
  sleep 1
  systemctl is-active --quiet netvision-api || { echo "ERRO: API nao ativa"; break; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3333/health || true)
  [ "$code" = "200" ] && { echo "health 200 apos ${i}s"; break; }
done

systemctl show netvision-api -p WorkingDirectory -p ExecStart --value | head -2
PID=$(systemctl show netvision-api -p MainPID --value)
for k in MITIGATION_LIVE_WRITE_ENABLED MITIGATION_AUTO_EXECUTION_ENABLED MITIGATION_AUTO_LIFECYCLE_ENABLED MITIGATION_AUTO_REMOVE_ENABLED MITIGATION_AUTO_PERSISTENCE_ENABLED; do
  echo "  $k = $(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep "^$k=" | head -1 | cut -d= -f2- || echo '?')"
done
echo "Rollback concluido: release esperada = bf7bc52 (flags restauradas do drop-in zz-auto.conf)"
echo "A release B6 permanece instalada (inativa) em /opt/netvision-auto-activate/releases"
