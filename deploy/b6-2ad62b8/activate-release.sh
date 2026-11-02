#!/usr/bin/env bash
# ETAPA B do deploy do motor B6 (REQUER AUTORIZACAO ESPECIFICA).
# Ativa a release 2ad62b8 criando o drop-in e reiniciando SOMENTE netvision-api.
#
# Primeira publicacao: cria tambem o drop-in de flags com escrita real DESLIGADA
# (MITIGATION_LIVE_WRITE_ENABLED=false) e AUTO/REMOVE explicitamente em 0,
# preservando leitura/preflight e a persistencia durável do baseline.
# A habilitacao da escrita exige uma autorizacao separada.
#
# Uso (no IMPLANTAR): sudo bash activate-release.sh [--keep-live-write | --prepare-only]
#   --prepare-only cria os drop-ins e faz daemon-reload SEM reiniciar a API,
#   permitindo conferir a precedencia antes da janela de ativacao.
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
  # Ordem do nome garante precedencia sobre zz-auto.conf (unico que define
  # MITIGATION_LIVE_WRITE_ENABLED=true). As demais chaves repetem o que os
  # EnvironmentFile ja trazem, fixando o valor desejado no proprio drop-in.
  cat > /etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzzzzzz-b6-flags.conf <<'CONF'
# Primeira publicacao B6: escrita real desligada; AUTO e REMOVE em 0.
# Persistencia durável do baseline habilitada (nao habilita execucao).
[Service]
Environment=MITIGATION_LIVE_WRITE_ENABLED=false
Environment=MITIGATION_AUTO_EXECUTION_ENABLED=0
Environment=MITIGATION_AUTO_LIFECYCLE_ENABLED=0
Environment=MITIGATION_AUTO_REMOVE_ENABLED=0
Environment=MITIGATION_AUTO_PERSISTENCE_ENABLED=1
CONF
  echo "flags B6 aplicadas por drop-in (LIVE_WRITE=false, AUTO_*=0, PERSISTENCE=1)"
fi

systemctl daemon-reload

echo "--- precedencia efetiva (antes do restart):"
systemctl show netvision-api -p WorkingDirectory --value | sed 's/^/  WorkingDirectory=/'
systemctl show netvision-api -p ExecStart --value | head -1 | sed 's/^/  ExecStart=/'
systemctl show netvision-api -p Environment --value | tr ' ' '\n' \
  | grep -E '^MITIGATION_(LIVE_WRITE|AUTO_EXECUTION|AUTO_LIFECYCLE|AUTO_REMOVE|AUTO_PERSISTENCE)' \
  | sort | sed 's/^/  Environment= /'

if [ "${1:-}" = "--prepare-only" ]; then
  echo "PREPARADO sem restart. Rode novamente (sem --prepare-only) para ativar."
  exit 0
fi

systemctl restart netvision-api

for i in $(seq 1 30); do
  sleep 1
  systemctl is-active --quiet netvision-api || { echo "ERRO: API nao ativa"; break; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3333/health || true)
  [ "$code" = "200" ] && { echo "health 200 apos ${i}s"; break; }
done

PID=$(systemctl show netvision-api -p MainPID --value)
echo "--- release efetiva:"
systemctl show netvision-api -p WorkingDirectory -p ExecStart --value | head -2
echo "--- flags efetivas no processo $PID:"
for k in MITIGATION_LIVE_WRITE_ENABLED MITIGATION_AUTO_EXECUTION_ENABLED MITIGATION_AUTO_LIFECYCLE_ENABLED \
         MITIGATION_AUTO_REMOVE_ENABLED MITIGATION_AUTO_PERSISTENCE_ENABLED NETVISION_INSTALLATION_ID; do
  echo "  $k = $(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep "^$k=" | head -1 | cut -d= -f2- || echo '?')"
done
echo "--- health:"
curl -s -o /dev/null -w 'api health=%{http_code}\n' http://127.0.0.1:3333/health
curl -s -o /dev/null -w 'web %{http_code}\n' http://127.0.0.1/
curl -s -o /dev/null -w 'mcp %{http_code}\n' http://127.0.0.1:3335/health
echo "Ativacao concluida. Rollback: sudo bash rollback-to-bf7bc52.sh"
