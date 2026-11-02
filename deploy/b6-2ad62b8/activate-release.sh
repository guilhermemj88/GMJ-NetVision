#!/usr/bin/env bash
# ETAPA B do deploy do motor B6 (REQUER AUTORIZACAO ESPECIFICA).
# Ativa a release 2ad62b8 criando o drop-in e reiniciando SOMENTE netvision-api.
#
# Primeira publicacao: cria tambem o drop-in que mantem a ESCRITA REAL desligada
# (MITIGATION_LIVE_WRITE_ENABLED=false), preservando leitura/preflight. A
# habilitacao da escrita exige uma autorizacao separada.
#
# Uso (no IMPLANTAR): sudo bash activate-release.sh [--keep-live-write]
set -euo pipefail
SHA=2ad62b8077250d99a25ef243d0b8ea632e85d757
DEST=/opt/netvision-auto-activate/releases/$SHA
DROPIN=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzzz-b6-2ad62b8.conf
CURRENT_DROPIN=/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf

[ -d "$DEST" ] || { echo "ERRO: release nao instalada em $DEST"; exit 1; }
[ -f "$DEST/apps/api/dist/server.cjs" ] || { echo "ERRO: server.cjs ausente"; exit 1; }

BACKUP_DIR=/root/netvision-backups/b6-activate-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR/systemd"
cp -a /etc/systemd/system/netvision-api.service.d/. "$BACKUP_DIR/systemd/"
systemctl show netvision-api > "$BACKUP_DIR/api-unit-before.txt"
echo "baseline do systemd em $BACKUP_DIR"

cat > "$DROPIN" <<CONF
# Motor B6 (2ad62b8). Rollback: remover este arquivo + daemon-reload + restart.
[Service]
WorkingDirectory=$DEST/apps/api
ExecStart=
ExecStart=/usr/bin/node $DEST/apps/api/dist/server.cjs
CONF

if [ "${1:-}" != "--keep-live-write" ]; then
  # Escrita real DESLIGADA na primeira publicacao (leitura/preflight continuam).
  printf '# Primeira publicacao B6: escrita real desligada (autorizacao separada).\n[Service]\nEnvironment=MITIGATION_LIVE_WRITE_ENABLED=false\n' \
    > /etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzzzz-b6-live-write-off.conf
  echo "MITIGATION_LIVE_WRITE_ENABLED=false aplicado por drop-in"
fi

systemctl daemon-reload
systemctl restart netvision-api

for i in $(seq 1 30); do
  sleep 1
  systemctl is-active --quiet netvision-api || { echo "ERRO: API nao ativa"; break; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3333/health || true)
  [ "$code" = "200" ] && { echo "health 200 apos ${i}s"; break; }
done

systemctl show netvision-api -p ExecStart --value | head -1
curl -s -o /dev/null -w 'api health=%{http_code}\n' http://127.0.0.1:3333/health
curl -s -o /dev/null -w 'web %{http_code}\n' http://127.0.0.1/
curl -s -o /dev/null -w 'mcp %{http_code}\n' http://127.0.0.1:3335/health
echo "Ativacao concluida. Rollback: sudo bash rollback-to-bf7bc52.sh"
