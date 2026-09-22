#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_DIR="/opt/GMJ-NetVision"
readonly WEB_DIR="$PROJECT_DIR/apps/web"
readonly STANDALONE_WEB="$WEB_DIR/.next/standalone/apps/web"
readonly WEB_SERVICE_UNIT="/etc/systemd/system/netvision-web.service"
readonly NODE_BIN="/usr/bin/node"
readonly WEB_HEALTH_URLS=(
  "http://127.0.0.1:3000/"
  "http://127.0.0.1:3000/physical/catalog-preview"
  "http://127.0.0.1:3000/physical-panels/huawei/s6730-h48x6c-front.png"
)

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

# http_probe <url> [include_body]
http_probe() {
  local url="$1"
  local include_body="${2:-false}"

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

wait_for_api() {
  local attempt
  local result=""

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if result="$(http_probe 'http://127.0.0.1:3333/health' true 2>&1)"; then
      printf '%s' "$result"
      return 0
    fi
    sleep 2
  done

  printf 'Falha no healthcheck da API: %s\n' "$result" >&2
  return 1
}

# Sonda todas as URLs do Web (as páginas e um asset de `public`).
probe_web_urls() {
  local url
  local output=""

  for url in "${WEB_HEALTH_URLS[@]}"; do
    if ! output+="$(http_probe "$url" 2>&1)"$'\n'; then
      printf '%s' "$output" >&2
      return 1
    fi
  done

  printf '%s' "$output"
  return 0
}

wait_for_web() {
  local attempt
  local result=""

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if result="$(probe_web_urls 2>&1)"; then
      printf '%s' "$result"
      return 0
    fi
    sleep 2
  done

  printf 'Falha no healthcheck do Web: %s\n' "$result" >&2
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

log "Preparando bundle standalone do Web"
[[ -x "$NODE_BIN" ]] || fail "node não encontrado em $NODE_BIN (a unit netvision-web.service usa esse caminho)"
[[ -f "$STANDALONE_WEB/server.js" ]] ||
  fail "bundle standalone não encontrado em $STANDALONE_WEB/server.js (confirme output: 'standalone' em apps/web/next.config.ts)"
[[ -d "$WEB_DIR/public" ]] || fail "diretório $WEB_DIR/public não encontrado"
[[ -d "$WEB_DIR/.next/static" ]] || fail "diretório $WEB_DIR/.next/static não encontrado"

# O build standalone não copia `public` nem `.next/static`: sem isso o Web
# sobe sem imagens, CSS e chunks (as rotas respondem, mas a página quebra).
mkdir -p "$STANDALONE_WEB/.next"
rm -rf "$STANDALONE_WEB/public"
cp -a "$WEB_DIR/public" "$STANDALONE_WEB/public"
rm -rf "$STANDALONE_WEB/.next/static"
cp -a "$WEB_DIR/.next/static" "$STANDALONE_WEB/.next/static"

[[ -d "$STANDALONE_WEB/public" ]] || fail "public não foi copiado para o bundle standalone"
[[ -d "$STANDALONE_WEB/.next/static" ]] || fail "assets estáticos (.next/static) não foram copiados para o bundle standalone"
[[ -f "$STANDALONE_WEB/public/physical-panels/huawei/s6730-h48x6c-front.png" ]] ||
  fail "imagens dos painéis físicos não foram copiadas para o bundle standalone"

log "Instalando a unit do serviço Web"
[[ -f "$PROJECT_DIR/deploy/netvision-web.service" ]] ||
  fail "unit $PROJECT_DIR/deploy/netvision-web.service não encontrada"
install -m 0644 "$PROJECT_DIR/deploy/netvision-web.service" "$WEB_SERVICE_UNIT"
systemctl daemon-reload

log "Reiniciando serviços"
systemctl restart netvision-api
systemctl restart netvision-web

log "Validando a API"
api_health_result="$(wait_for_api)"

log "Validando o Web (standalone)"
web_health_result="$(wait_for_web)"

log "Commit atual"
git log -1 --format='%H %s'

log "Status final dos serviços"
systemctl --no-pager --full status netvision-api netvision-web

log "Resultado do healthcheck"
printf 'API http://127.0.0.1:3333/health -> %s\n' "$api_health_result"
printf 'WEB (standalone) ->\n%s' "$web_health_result"
