#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_DIR="/opt/GMJ-NetVision"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

http_probe() {
  node --input-type=module - <<'NODE'
try {
  const response = await fetch('http://127.0.0.1:3333/health', {
    redirect: 'follow',
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.text()).trim().slice(0, 500);
  console.log(`HTTP ${response.status}${body ? ` - ${body}` : ''}`);
  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

wait_for_api() {
  local attempt
  local result=""

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if result="$(http_probe 2>&1)"; then
      printf '%s' "$result"
      return 0
    fi
    sleep 2
  done

  printf 'Falha no healthcheck da API: %s\n' "$result" >&2
  return 1
}

[[ "$(id -u)" -eq 0 ]] || fail "execute esta atualização como root (por exemplo: sudo bash deploy/update.sh)"
[[ "$(uname -s)" == "Linux" ]] || fail "este atualizador só pode ser executado em Linux"
[[ -d "$PROJECT_DIR/.git" ]] || fail "repositório Git não encontrado em $PROJECT_DIR"
[[ -f "$PROJECT_DIR/.env" ]] || fail "arquivo $PROJECT_DIR/.env não encontrado"

cd -- "$PROJECT_DIR"

log "Estado do repositório antes da atualização"
git status

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  fail "existem alterações locais não commitadas; a atualização foi cancelada sem modificar arquivos"
fi

log "Atualizando o repositório por fast-forward"
git pull --ff-only

log "Instalando dependências"
npm install

log "Gerando o Prisma Client"
npm run db:generate

log "Aplicando migrations existentes"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

log "Gerando builds de produção"
npm run build

log "Reiniciando serviços"
systemctl restart netvision-api
systemctl restart netvision-web

log "Validando a API"
api_health_result="$(wait_for_api)"

log "Commit atual"
git log -1 --format='%H %s'

log "Status final dos serviços"
systemctl --no-pager --full status netvision-api netvision-web

log "Resultado do healthcheck"
printf 'API http://127.0.0.1:3333/health -> %s\n' "$api_health_result"
