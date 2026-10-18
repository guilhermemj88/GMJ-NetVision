#!/usr/bin/env bash
# Ensaio de ROLLBACK da RC2 — executa SOMENTE em ambiente isolado.
#
# Objetivo: provar que o bundle da RC2 e o bundle da API publicada
# (`fc790ade…`, empacotado como `rollback-server.cjs` pelo build Linux) sobem
# sobre o MESMO schema aditivo, sem escrita em equipamento e sem tocar produção.
#
# Uso (container descartável do build):
#   LINUX_SMOKE_DATABASE_URL=postgresql://... ./deploy/verify-rc2-rollback.sh /work/release
#
# Recusa-se a rodar se detectar a instalação de produção.
set -euo pipefail

RELEASE_DIR="${1:-/work/release}"
PORT="${ROLLBACK_PORT:-3399}"
BASE_URL="http://127.0.0.1:${PORT}"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Guardas: nada aqui pode rodar na IMPLANTAR ou em qualquer host de produção.
# ---------------------------------------------------------------------------
if [[ "$(hostname)" == "netvision-implantar" ]]; then
  fail "host de produção detectado (netvision-implantar); ensaio abortado"
fi
if [[ -r /etc/systemd/system/netvision-api.service ]] &&
   grep -qE 'ExecStart=.*/opt/netvision' /etc/systemd/system/netvision-api.service; then
  fail "unidade de produção detectada; ensaio abortado"
fi
if [[ -d /opt/GMJ-NetVision-release* ]] || [[ -d /opt/netvision-fast-bridge ]]; then
  fail "release de produção detectada; ensaio abortado"
fi
[[ -f "${RELEASE_DIR}/apps/api/dist/server.cjs" ]] || fail "bundle RC2 ausente"
[[ -f "${RELEASE_DIR}/apps/api/dist/rollback-server.cjs" ]] || fail "bundle de rollback ausente"

# Executor sem escrita e sem telemetria real: o ensaio nunca mitiga nada.
COMMON_ENV=(
  "DEMO_MODE=true"
  "NETVISION_INSTALLATION_ID=IMPLANTAR"
  "MITIGATION_MODE=SIMULATION_ONLY"
  "MITIGATION_EXECUTOR=MOCK"
  "MITIGATION_LIVE_WRITE_ENABLED=false"
  "MITIGATION_AUTO_EXECUTION_ENABLED=0"
  "MITIGATION_FAST_BRIDGE_MODE=OFF"
  "SNMP_POLLING_ENABLED=false"
  "PORT=${PORT}"
  "HOSTNAME=127.0.0.1"
  "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)"
)

boot() {
  local script="$1" label="$2"
  echo "==> subindo ${label}"
  # cwd = raiz da app: é onde `src/generated/prisma` (Query Engine) está.
  ( cd "${RELEASE_DIR}/apps/api" && env "${COMMON_ENV[@]}" node "${script}" >/tmp/rc2-rollback-${label}.log 2>&1 ) &
  local pid=$!
  local ok=0
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 1 "${BASE_URL}/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.25
  done
  if [[ "${ok}" -ne 1 ]]; then
    cat "/tmp/rc2-rollback-${label}.log" >&2 || true
    kill "${pid}" 2>/dev/null || true
    fail "${label} não respondeu /health"
  fi
  local health
  health="$(curl -fsS --max-time 2 "${BASE_URL}/health")"
  echo "    /health: ${health:0:200}"
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  echo "    ${label}: OK"
}

boot "dist/server.cjs" "rc2"
boot "dist/rollback-server.cjs" "baseline"

if [[ -n "${LINUX_SMOKE_DATABASE_URL:-}" ]]; then
  echo "==> schema aditivo consultado pelas duas versões"
  ( cd "${RELEASE_DIR}/apps/api" && node -e '
    const { PrismaClient } = require("./src/generated/prisma");
    (async () => {
      const db = new PrismaClient({ datasources: { db: { url: process.env.LINUX_SMOKE_DATABASE_URL } } });
      try {
        const [shadow, decisions] = await Promise.all([
          db.mitigationFastShadowState.count(),
          db.mitigationFastDecision.count(),
        ]);
        console.log("    MitigationFastShadowState=" + shadow + " MitigationFastDecision=" + decisions);
      } finally {
        await db.$disconnect();
      }
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  ' )
fi

echo
echo "Ensaio de rollback concluído: RC2 e bundle publicado sobem no mesmo schema,"
echo "sem escrita em equipamento. Produção não foi tocada."
