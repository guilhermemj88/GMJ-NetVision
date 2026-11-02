#!/usr/bin/env bash
# Validacao READ-ONLY apos a ativacao da release B6. Nao escreve nada.
# 1) confirma a release ativa; 2) prova que persistencia/flags estao no esperado;
# 3) roda o preflight real via SIMULATE_ACTIVATE (somente leitura no equipamento)
#    e confere que o baseline_record_store esta disponivel; 4) prova que nenhum
#    registro de baseline foi criado por engano.
#
# O comando entra pela rota inbound do n8n (token Bearer), que usa o MESMO
# MitigationCommandService da UI. A rota da UI exige sessao de usuario.
#
# Uso: sudo bash validate-readonly.sh [profileId]
#   TOKEN opcional; se ausente, le NETVISION_N8N_COMMAND_TOKEN do processo da API.
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:3333}
SHA=2ad62b8077250d99a25ef243d0b8ea632e85d757
PROFILE=${1:-${PROFILE_ID:-}}
[ -n "$PROFILE" ] || { echo "ERRO: informe o profileId (parametro 1)"; exit 1; }

API_PID=$(systemctl show netvision-api -p MainPID --value)
api_env() { tr '\0' '\n' < "/proc/$API_PID/environ" 2>/dev/null | grep "^$1=" | head -1 | cut -d= -f2- || true; }

if [ -z "${TOKEN:-}" ]; then
  # Token inbound de BGP_MITIGATION: lido do banco e decifrado com a mesma chave
  # do processo da API (AES-256-GCM, layout iv|tag|ciphertext). Nunca e exibido.
  CIPHER_B64=$(su - postgres -c "psql -X -q -t -A -d netvision -c \"select encode(\\\"inboundSecretEncrypted\\\",'base64') from \\\"MediaIntegration\\\" where purpose='BGP_MITIGATION' and \\\"inboundEnabled\\\"=true\"" | tr -d '[:space:]')
  [ -n "$CIPHER_B64" ] || { echo "ERRO: inboundSecretEncrypted ausente"; exit 1; }
  TOKEN=$(KEY=$(api_env CREDENTIAL_ENCRYPTION_KEY) CIPHER="$CIPHER_B64" node -e '
const { createDecipheriv } = require("node:crypto");
const key = Buffer.from(process.env.KEY || "", "base64");
if (key.length !== 32) { console.error("ERRO: CREDENTIAL_ENCRYPTION_KEY ausente ou invalida"); process.exit(1); }
const buf = Buffer.from(process.env.CIPHER, "base64");
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
d.setAuthTag(buf.subarray(12, 28));
const token = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")).token;
if (!token) process.exit(1);
process.stdout.write(token);')
  [ -n "$TOKEN" ] || { echo "ERRO: nao foi possivel obter o token inbound"; exit 1; }
  echo "  token de comando: obtido do registro persistido (nao exibido)"
fi

echo "== release ativa =="
echo "  WorkingDirectory=$(systemctl show netvision-api -p WorkingDirectory --value)"
EXEC=$(systemctl show netvision-api -p ExecStart --value)
if grep -q "$SHA" <<<"$EXEC"; then echo "  ExecStart aponta para $SHA"; else echo "  ERRO: ExecStart NAO aponta para $SHA"; exit 1; fi

echo "== flags efetivas no processo $API_PID =="
for k in MITIGATION_EXECUTOR MITIGATION_MODE MITIGATION_LIVE_WRITE_ENABLED \
         MITIGATION_AUTO_EXECUTION_ENABLED MITIGATION_AUTO_LIFECYCLE_ENABLED \
         MITIGATION_AUTO_REMOVE_ENABLED MITIGATION_AUTO_PERSISTENCE_ENABLED NETVISION_INSTALLATION_ID; do
  echo "  $k=$(api_env "$k")"
done

echo "== preflight sem escrita (SIMULATE_ACTIVATE) =="
REQ="sim-b6-$(date -u +%s)"
RESP=$(curl -fsS -X POST "$BASE/api/integrations/n8n/mitigation-command" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{\"requestId\":\"$REQ\",\"action\":\"SIMULATE_ACTIVATE\",\"profileId\":\"$PROFILE\"}" || true)
[ -n "$RESP" ] || { echo "  ERRO: sem resposta do comando"; exit 1; }
printf '%s' "$RESP" | node -e '
let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{
  const r=JSON.parse(raw);
  const checks=(r.preflight&&r.preflight.checks)||[];
  const pick=id=>checks.find(c=>c.id===id);
  console.log("  requestId       =", r.requestId);
  console.log("  status          =", r.status);
  console.log("  ok              =", r.ok);
  if (r.preflight) console.log("  preflight.ok    =", r.preflight.ok);
  for (const id of ["baseline_record_store","preserved_attributes","node_occupancy","policy_mitigation_scope"]) {
    const c=pick(id);
    console.log("  " + id.padEnd(23) + "=", c? c.ok : "AUSENTE", c&&c.detail? "- "+c.detail : "");
  }
  const prev=r.commandPreview||[];
  console.log("  comandos previstos =", prev.length);
  console.log("  contem commit      =", prev.some(l=>/^commit/.test(String(l))));
  if (r.safeError) console.log("  safeError       =", r.safeError);
});'

echo "== nenhum baseline criado por engano =="
su - postgres -c "psql -X -q -t -A -d netvision -c \"select 'linhas em MitigationAutomationRecord = '||count(*) from \\\"MitigationAutomationRecord\\\"\"" 2>/dev/null | sed 's/^/  /'

echo "== servicos =="
for u in netvision-api netvision-web netvision-mcp; do echo "  $u=$(systemctl is-active $u)"; done
echo "  postgres=$(systemctl is-active postgresql@18-main)"
