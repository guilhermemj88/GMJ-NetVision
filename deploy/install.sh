#!/usr/bin/env bash
set -euo pipefail

readonly CANONICAL_PROJECT_DIR="/opt/GMJ-NetVision"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly NGINX_AVAILABLE_DIR="/etc/nginx/sites-available"
readonly NGINX_ENABLED_DIR="/etc/nginx/sites-enabled"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

is_project_dir() {
  local candidate="$1"

  [[ -f "$candidate/package.json" ]] &&
    [[ -f "$candidate/apps/api/package.json" ]] &&
    [[ -f "$candidate/apps/web/package.json" ]] &&
    [[ -f "$candidate/apps/api/prisma/schema.prisma" ]] &&
    [[ -f "$candidate/deploy/netvision-api.service" ]] &&
    [[ -f "$candidate/deploy/netvision-web.service" ]] &&
    [[ -f "$candidate/deploy/nginx.conf" ]]
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "comando obrigatório não encontrado: $1"
}

http_probe() {
  local url="$1"
  local include_body="$2"

  node --input-type=module - "$url" "$include_body" <<'NODE'
const [url, includeBody] = process.argv.slice(2);

try {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5_000),
  });
  const body = includeBody === 'true' ? (await response.text()).trim().slice(0, 500) : '';
  console.log(`HTTP ${response.status}${body ? ` - ${body}` : ''}`);
  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local include_body="$3"
  local attempt
  local result=""

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if result="$(http_probe "$url" "$include_body" 2>&1)"; then
      printf '%s' "$result"
      return 0
    fi
    sleep 2
  done

  printf 'Falha no healthcheck de %s (%s): %s\n' "$label" "$url" "$result" >&2
  return 1
}

[[ "$(id -u)" -eq 0 ]] || fail "execute este instalador como root (por exemplo: sudo bash deploy/install.sh)"
[[ "$(uname -s)" == "Linux" ]] || fail "este instalador só pode ser executado em Linux"

for required_command in git node npm psql nginx systemctl; do
  require_command "$required_command"
done

node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "não foi possível interpretar a versão do Node.js: $node_version"
((node_major >= 20)) || fail "Node.js 20 ou superior é obrigatório; encontrado: $node_version"

npm_version="$(npm --version)"
npm_major="${npm_version%%.*}"
[[ "$npm_major" =~ ^[0-9]+$ ]] || fail "não foi possível interpretar a versão do npm: $npm_version"
((npm_major >= 10)) || fail "npm 10 ou superior é obrigatório; encontrado: $npm_version"

script_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
current_dir="$(pwd -P)"
project_source=""

if is_project_dir "$CANONICAL_PROJECT_DIR"; then
  project_source="$CANONICAL_PROJECT_DIR"
elif is_project_dir "$current_dir"; then
  project_source="$current_dir"
elif is_project_dir "$script_project_dir"; then
  project_source="$script_project_dir"
else
  fail "o projeto não foi encontrado em $CANONICAL_PROJECT_DIR, no diretório atual ou ao lado deste script"
fi

[[ -f "$project_source/.env" ]] ||
  fail "arquivo $project_source/.env não encontrado; crie e configure-o antes da instalação"

if [[ "$project_source" != "$CANONICAL_PROJECT_DIR" ]]; then
  [[ ! -e "$CANONICAL_PROJECT_DIR" && ! -L "$CANONICAL_PROJECT_DIR" ]] ||
    fail "$CANONICAL_PROJECT_DIR já existe, mas não contém um projeto NetVision válido"
  install -d -m 0755 "$(dirname -- "$CANONICAL_PROJECT_DIR")"
  ln -s -- "$project_source" "$CANONICAL_PROJECT_DIR"
  log "Link criado: $CANONICAL_PROJECT_DIR -> $project_source"
fi

readonly PROJECT_DIR="$CANONICAL_PROJECT_DIR"
is_project_dir "$PROJECT_DIR" || fail "estrutura do projeto incompleta em $PROJECT_DIR"

cd -- "$PROJECT_DIR"

log "Instalando dependências"
npm install

log "Gerando o Prisma Client"
npm run db:generate

log "Aplicando migrations existentes"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

log "Gerando builds de produção"
npm run build

log "Instalando serviços systemd"
install -m 0644 deploy/netvision-api.service "$SYSTEMD_DIR/netvision-api.service"
install -m 0644 deploy/netvision-web.service "$SYSTEMD_DIR/netvision-web.service"

log "Instalando configuração do nginx"
[[ -d "$NGINX_AVAILABLE_DIR" && -d "$NGINX_ENABLED_DIR" ]] ||
  fail "estrutura sites-available/sites-enabled do nginx não encontrada"
install -m 0644 deploy/nginx.conf "$NGINX_AVAILABLE_DIR/netvision"
ln -sfn "$NGINX_AVAILABLE_DIR/netvision" "$NGINX_ENABLED_DIR/netvision"
if [[ -e "$NGINX_ENABLED_DIR/default" || -L "$NGINX_ENABLED_DIR/default" ]]; then
  rm -f -- "$NGINX_ENABLED_DIR/default"
  log "Site default do nginx desabilitado; o arquivo em sites-available foi preservado"
fi

log "Habilitando e reiniciando serviços"
systemctl daemon-reload
systemctl enable netvision-api
systemctl enable netvision-web
systemctl restart netvision-api
systemctl restart netvision-web
nginx -t
systemctl restart nginx

log "Validando endpoints locais"
api_health_result="$(wait_for_http "API" "http://127.0.0.1:3333/health" true)"
web_health_result="$(wait_for_http "frontend" "http://127.0.0.1:3000" false)"

log "Status final dos serviços"
systemctl --no-pager --full status netvision-api netvision-web

log "Portas do NetVision"
printf 'nginx:    80/tcp\nfrontend: 3000/tcp\nAPI:      3333/tcp\n'
if command -v ss >/dev/null 2>&1; then
  ss -ltnp '( sport = :80 or sport = :3000 or sport = :3333 )'
fi

log "Resultado dos healthchecks"
printf 'API      http://127.0.0.1:3333/health -> %s\n' "$api_health_result"
printf 'Frontend http://127.0.0.1:3000        -> %s\n' "$web_health_result"
