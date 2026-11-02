#!/usr/bin/env bash
# Validacao READ-ONLY apos a ativacao da release B6. Nao escreve nada.
# 1) confirma a release ativa; 2) prova que persistencia/flags estao no esperado;
# 3) roda o preflight real via SIMULATE_ACTIVATE (nao escreve) e confere que o
#    baseline_record_store esta disponivel; 4) prova que nenhum registro de
#    baseline foi criado por engano.
#
# Uso: BASE=http://127.0.0.1:3333 TOKEN=<token de operador> bash validate-readonly.sh <profileId>
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:3333}
TOKEN=${TOKEN:?defina TOKEN de operador (nao versionar)}
PROFILE=${1:?profileId de um alvo AGLINK}
SHA=2ad62b8077250d99a25ef243d0b8ea632e85d757

echo "== release ativa =="
systemctl show netvision-api -p WorkingDirectory --value | sed 's/^/  WorkingDirectory=/'
grep -q "$SHA" <<<"$(systemctl show netvision-api -p ExecStart --value)" \
  && echo "  ExecStart aponta para $SHA" \
  || { echo "  ERRO: ExecStart NAO aponta para $SHA"; exit 1; }

echo "== flags efetivas =="
PID=$(systemctl show -p MainPID --value netvision-api)
tr '\0' '\n' < "/proc/$PID/environ" \
  | grep -E '^(MITIGATION_EXECUTOR|MITIGATION_LIVE_WRITE_ENABLED|MITIGATION_AUTO_EXECUTION_ENABLED|MITIGATION_AUTO_LIFECYCLE_ENABLED|MITIGATION_AUTO_PERSISTENCE_ENABLED)=' \
  | sort | sed 's/^/  /'

echo "== preflight sem escrita (SIMULATE_ACTIVATE) =="
REQ="sim-b6-$(date -u +%s)"
curl -fsS -X POST "$BASE/api/bgp/mitigation/profiles/$PROFILE/command" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{\"requestId\":\"$REQ\",\"action\":\"SIMULATE_ACTIVATE\"}" \
  | node -e '
let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{
  const r=JSON.parse(raw);
  const checks=(r.preflight&&r.preflight.checks)||[];
  const store=checks.find(c=>c.id==="baseline_record_store");
  console.log("  status          =",r.status);
  console.log("  preflight.ok    =",r.preflight?r.preflight.ok:null);
  console.log("  baseline_store  =",store?store.ok:null,store?store.detail:"");
  console.log("  comandos        =",(r.commandPreview||[]).length);
  console.log("  escrita         =",(r.commandPreview||[]).some(l=>l==="commit")?"PREVIEW COM COMMIT (somente texto)":"sem commit");
});'

echo "== nenhum baseline criado por engano =="
su - postgres -c "psql -X -q -t -A -d netvision -c \"select 'linhas em MitigationAutomationRecord = '||count(*) from \\\"MitigationAutomationRecord\\\"\"" 2>/dev/null | sed 's/^/  /'

echo "== servicos =="
for u in netvision-api netvision-web netvision-mcp; do echo "  $u=$(systemctl is-active $u)"; done
echo "  postgres=$(systemctl is-active postgresql@18-main)"
