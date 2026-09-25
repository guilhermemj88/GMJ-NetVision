#!/usr/bin/env bash
#
# Atualiza SOMENTE o ambiente de preview (/opt/GMJ-NetVision-preview, porta 3001).
#
# Este script NUNCA:
#   - toca em /opt/GMJ-NetVision (producao) alem de healthchecks HTTP de leitura;
#   - executa deploy/update.sh;
#   - aplica migration ou roda prisma migrate;
#   - roda `prisma generate` (por isso os gates do workspace @gmj/api — que tem
#     `prebuild`/`pretest`/`pretypecheck` chamando prisma — nao sao executados);
#   - reinicia a API (:3333) ou o Web de producao (:3000);
#   - altera PostgreSQL, nginx, firewall, DNS ou TLS;
#   - usa `git reset --hard` ou `git clean`.
#
# Uso: sudo bash deploy/update-preview.sh
# (ou, sem root, desde que `sudo -n` esteja disponivel para os passos de systemd)

set -euo pipefail

readonly PROJECT_DIR="/opt/GMJ-NetVision-preview"
readonly PRODUCTION_DIR="/opt/GMJ-NetVision"
readonly PREVIEW_BRANCH="preview/deepseek-ui"
readonly WEB_DIR="$PROJECT_DIR/apps/web"
readonly STANDALONE_ROOT="$WEB_DIR/.next/standalone"
readonly STANDALONE_WEB="$STANDALONE_ROOT/apps/web"
readonly UNIT_SOURCE="$PROJECT_DIR/deploy/netvision-web-preview.service"
readonly UNIT_TARGET="/etc/systemd/system/netvision-web-preview.service"
readonly PREVIEW_SERVICE="netvision-web-preview.service"
readonly NODE_BIN="/usr/bin/node"
readonly PREVIEW_PORT=3001
readonly API_PORT=3333
readonly PRODUCTION_WEB_PORT=3000
readonly PREVIEW_HEALTH_URLS=(
  "http://127.0.0.1:${PREVIEW_PORT}/"
  "http://127.0.0.1:${PREVIEW_PORT}/physical/catalog-preview"
  "http://127.0.0.1:${PREVIEW_PORT}/physical/rack-lab"
  "http://127.0.0.1:${PREVIEW_PORT}/physical-panels/huawei/s6730-h48x6c-front.png"
)
readonly PRODUCTION_WEB_URL="http://127.0.0.1:${PRODUCTION_WEB_PORT}/"
readonly API_HEALTH_URL="http://127.0.0.1:${API_PORT}/health"
# Asset estatico de referencia que prova que `public/` foi copiado de verdade.
readonly KNOWN_ASSET="physical-panels/huawei/s6730-h48x6c-front.png"
#
# `origin` deste repositorio e SSH (git@github.com:...) e a chave de deploy do
# servidor e protegida por passphrase: um deploy nao interativo nao consegue
# autenticar. Como o repositorio e publico, o fetch cai para leitura HTTPS
# anonima quando `origin` falha, escrevendo no MESMO ref de rastreamento
# (`refs/remotes/origin/<branch>`), portanto o upstream nao muda.
# Nada de configuracao de remote é alterado, nem na producao nem no preview.
readonly PREVIEW_FETCH_FALLBACK_URL="${PREVIEW_FETCH_FALLBACK_URL:-https://github.com/guilhermemj88/GMJ-NetVision.git}"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Aviso: %s\n' "$*" >&2
}

# ---------------------------------------------------------------- privilegios
# Root so nos passos que realmente exigem (instalar unit e falar com o systemd).
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 ||
    fail "sem root e sem 'sudo' disponivel; execute como root: sudo bash deploy/update-preview.sh"
  sudo -n true >/dev/null 2>&1 ||
    fail "'sudo -n' indisponivel (senha exigida ou sudo negado); execute como root: sudo bash deploy/update-preview.sh"
  SUDO=(sudo -n)
fi

run_privileged() {
  "${SUDO[@]+"${SUDO[@]}"}" "$@"
}

# -------------------------------------------------------------------- helpers
# http_probe <url> [include_body]
http_probe() {
  local url="$1"
  local include_body="${2:-false}"

  "$NODE_BIN" --input-type=module - "$url" "$include_body" <<'NODE'
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

# wait_for_http <url> [include_body]
wait_for_http() {
  local url="$1"
  local include_body="${2:-false}"
  local attempt
  local result=""

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if result="$(http_probe "$url" "$include_body" 2>&1)"; then
      printf '%s' "$result"
      return 0
    fi
    sleep 2
  done

  printf 'Falha no healthcheck (%s): %s\n' "$url" "$result" >&2
  return 1
}

probe_preview_urls() {
  local url
  local output=""

  for url in "${PREVIEW_HEALTH_URLS[@]}"; do
    if ! output+="$(http_probe "$url" 2>&1)"$'\n'; then
      printf '%s' "$output" >&2
      return 1
    fi
  done

  printf '%s' "$output"
  return 0
}

# O banner e a prova de que esta Web e o preview (e nao a producao). As duas
# strings usadas aqui sao ASCII, portanto imunes a qualquer normalizacao de
# encoding do HTML.
# assert_banner <url>
assert_banner() {
  local url="$1"

  "$NODE_BIN" --input-type=module - "$url" <<'NODE'
const [url] = process.argv.slice(2);

try {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  const ok = body.includes('nv-preview-banner') && body.includes('INTERFACE EXPERIMENTAL');
  if (!response.ok || !ok) {
    console.error(`banner PREVIEW ausente em ${url} (HTTP ${response.status})`);
    process.exit(1);
  }
  console.log(`HTTP ${response.status} - banner PREVIEW presente`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

# assert_no_banner <url> — producao jamais pode servir o banner de preview.
assert_no_banner() {
  local url="$1"

  "$NODE_BIN" --input-type=module - "$url" <<'NODE'
const [url] = process.argv.slice(2);

try {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  if (body.includes('nv-preview-banner') || body.includes('nv-preview-root')) {
    console.error(`a Web de producao (${url}) serviu o banner/wrapper de preview`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`HTTP ${response.status} em ${url}`);
    process.exit(1);
  }
  console.log(`HTTP ${response.status} - producao sem banner de preview`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

port_listening() {
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 2
  ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q ":${port}\b"
}

# --------------------------------------------------------- validacoes basicas
[[ "$(uname -s)" == "Linux" ]] || fail "este atualizador só pode ser executado em Linux"

for required_command in git node npm systemctl ss; do
  command -v "$required_command" >/dev/null 2>&1 ||
    fail "comando obrigatório não encontrado: $required_command"
done

[[ -x "$NODE_BIN" ]] || fail "node não encontrado em $NODE_BIN (a unit do preview usa esse caminho)"
[[ -d "$PROJECT_DIR" ]] || fail "worktree de preview não encontrado em $PROJECT_DIR"

resolved_project_dir="$(cd -- "$PROJECT_DIR" && pwd -P)"
if [[ -d "$PRODUCTION_DIR" ]]; then
  resolved_production_dir="$(cd -- "$PRODUCTION_DIR" && pwd -P)"
  [[ "$resolved_project_dir" != "$resolved_production_dir" ]] ||
    fail "PROJECT_DIR aponta para a producao; atualizacao do preview abortada"
fi

git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "$PROJECT_DIR não é um repositório/worktree Git"

current_branch="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)"
[[ "$current_branch" == "$PREVIEW_BRANCH" ]] ||
  fail "branch atual é '$current_branch'; o preview exige '$PREVIEW_BRANCH'"

[[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]] ||
  fail "existem alterações locais não commitadas no preview; a atualização foi cancelada sem modificar arquivos"

[[ -f "$UNIT_SOURCE" ]] || fail "unit não encontrada em $UNIT_SOURCE"

# -------------------------------------------------- pre-checks de producao/API
log "Pré-check: produção (:${PRODUCTION_WEB_PORT}), API (:${API_PORT}) e porta ${PREVIEW_PORT}"

production_before="$(wait_for_http "$PRODUCTION_WEB_URL" false)" ||
  fail "a Web de produção (:$PRODUCTION_WEB_PORT) não respondeu antes da atualização"
printf 'Produção  :%s -> %s\n' "$PRODUCTION_WEB_PORT" "$production_before"

api_before="$(wait_for_http "$API_HEALTH_URL" true)" ||
  fail "a API (:$API_PORT) não respondeu antes da atualização"
printf 'API       :%s -> %s\n' "$API_PORT" "$api_before"

# A porta 3001 pode estar livre (primeiro deploy) ou ocupada pelo proprio
# preview (atualizacao). Qualquer outro ocupante e motivo para abortar.
if port_listening "$PREVIEW_PORT"; then
  if systemctl is-active --quiet "$PREVIEW_SERVICE"; then
    printf 'Preview   :%s -> ocupada pelo %s (atualização)\n' "$PREVIEW_PORT" "$PREVIEW_SERVICE"
  else
    fail "a porta $PREVIEW_PORT está em uso por outro processo que não é o $PREVIEW_SERVICE"
  fi
else
  printf 'Preview   :%s -> livre (primeiro deploy)\n' "$PREVIEW_PORT"
fi

# ------------------------------------------------------------ atualizar codigo
log "Buscando somente a branch $PREVIEW_BRANCH"
if git -C "$PROJECT_DIR" fetch origin "$PREVIEW_BRANCH"; then
  fetch_note="origin (SSH)"
else
  warn "fetch de 'origin' falhou (credencial SSH do servidor exige passphrase); usando leitura HTTPS publica read-only"
  warn "nenhuma configuracao de remote foi alterada; o ref de rastreamento continua sendo origin/$PREVIEW_BRANCH"
  git -C "$PROJECT_DIR" fetch "$PREVIEW_FETCH_FALLBACK_URL" \
    "refs/heads/$PREVIEW_BRANCH:refs/remotes/origin/$PREVIEW_BRANCH"
  fetch_note="HTTPS publico (fallback)"
fi
git -C "$PROJECT_DIR" merge --ff-only "origin/$PREVIEW_BRANCH"

log "Commit de preview a ser implantado"
git -C "$PROJECT_DIR" log -1 --format='%H %s'
printf 'origem do fetch: %s\n' "$fetch_note"

# ------------------------------------------------------------------ dependencias
log "Instalando dependências pelo lockfile (npm ci)"
cd -- "$PROJECT_DIR"
npm ci --no-audit --no-fund

# ----------------------------------------------------------------- validacoes
# Somente @gmj/web e @gmj/shared: o workspace @gmj/api tem hooks de Prisma
# (`pretest`/`pretypecheck`/`prebuild`) e NÃO deve ser executado pelo preview.
log "Lint (eslint, sem tocar na API)"
npx eslint apps/web packages/shared packages/ui --max-warnings=0

log "Typecheck da Web"
npm run typecheck -w @gmj/web

log "Testes da Web"
npm run test -w @gmj/web

log "Testes do domínio compartilhado"
npm run test -w @gmj/shared

# ---------------------------------------------------------------------- build
log "Build da Web preview (NEXT_PUBLIC_PREVIEW_MODE=true)"
NEXT_PUBLIC_PREVIEW_MODE=true \
NEXT_PUBLIC_API_URL= \
API_INTERNAL_URL="http://127.0.0.1:${API_PORT}" \
  npm run build -w @gmj/web

log "Preparando bundle standalone do preview"
[[ -f "$STANDALONE_WEB/server.js" ]] ||
  fail "bundle standalone não encontrado em $STANDALONE_WEB/server.js (confirme output: 'standalone')"
[[ -d "$WEB_DIR/public" ]] || fail "diretório $WEB_DIR/public não encontrado"
[[ -d "$WEB_DIR/.next/static" ]] || fail "diretório $WEB_DIR/.next/static não encontrado"

# O build standalone não copia `public` nem `.next/static`: sem isso o Web sobe
# sem imagens, CSS e chunks (as rotas respondem, mas a pagina quebra).
mkdir -p "$STANDALONE_WEB/.next"
rm -rf "$STANDALONE_WEB/public"
cp -a "$WEB_DIR/public" "$STANDALONE_WEB/public"
rm -rf "$STANDALONE_WEB/.next/static"
cp -a "$WEB_DIR/.next/static" "$STANDALONE_WEB/.next/static"

[[ -d "$STANDALONE_WEB/public" ]] || fail "public não foi copiado para o bundle standalone"
[[ -d "$STANDALONE_WEB/.next/static" ]] || fail "assets estáticos (.next/static) não foram copiados"
[[ -f "$STANDALONE_WEB/public/$KNOWN_ASSET" ]] ||
  fail "asset estático de referência ($KNOWN_ASSET) não foi copiado para o bundle standalone"

# Prova que este bundle e o de preview: o HTML prerenderizado carrega o banner.
grep -q 'nv-preview-banner' "$STANDALONE_WEB/.next/server/app/index.html" ||
  fail "o build gerado não contém o banner de preview (NEXT_PUBLIC_PREVIEW_MODE não chegou ao build)"
grep -q 'nv-preview-root' "$STANDALONE_WEB/.next/server/app/index.html" ||
  fail "o build gerado não contém o wrapper de preview"

# --------------------------------------------------------------- unit do systemd
log "Instalando/atualizando somente a unit $PREVIEW_SERVICE"
run_privileged install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
run_privileged systemctl daemon-reload
run_privileged systemctl enable "$PREVIEW_SERVICE" >/dev/null

# ------------------------------------------------------------------ restart
log "Reiniciando SOMENTE $PREVIEW_SERVICE (API e Web :${PRODUCTION_WEB_PORT} não são tocados)"
run_privileged systemctl restart "$PREVIEW_SERVICE"

# ---------------------------------------------------------------- healthchecks
log "Validando o preview (:$PREVIEW_PORT)"
preview_health_result="$(wait_for_http "http://127.0.0.1:${PREVIEW_PORT}/" false)" ||
  fail "o preview não respondeu em http://127.0.0.1:${PREVIEW_PORT}/"
preview_assets_result="$(probe_preview_urls)" ||
  fail "o preview não respondeu a todas as URLs de verificação (páginas e asset estático)"

log "Confirmando que o preview realmente está em modo PREVIEW"
banner_result="$(assert_banner "http://127.0.0.1:${PREVIEW_PORT}/")" ||
  fail "a Web de preview não serviu o banner PREVIEW"

log "Confirmando que a produção continua íntegra"
production_after="$(wait_for_http "$PRODUCTION_WEB_URL" false)" ||
  fail "a Web de produção (:$PRODUCTION_WEB_PORT) parou de responder durante a atualização do preview"
production_no_banner="$(assert_no_banner "$PRODUCTION_WEB_URL")" ||
  fail "a Web de produção passou a servir conteúdo de preview"

api_after="$(wait_for_http "$API_HEALTH_URL" true)" ||
  fail "a API (:$API_PORT) parou de responder durante a atualização do preview"

log "Estado dos serviços"
run_privileged systemctl --no-pager --full status "$PREVIEW_SERVICE" || true
systemctl is-active netvision-api netvision-web "$PREVIEW_SERVICE" || true

log "Portas do NetVision"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp "( sport = :${PRODUCTION_WEB_PORT} or sport = :${PREVIEW_PORT} or sport = :${API_PORT} )" || true
fi

log "Resultado"
printf 'Produção :%s -> %s (antes) / %s (depois)\n' "$PRODUCTION_WEB_PORT" "$production_before" "$production_after"
printf 'API      :%s -> %s (antes) / %s (depois)\n' "$API_PORT" "$api_before" "$api_after"
printf 'Preview  :%s -> %s\n' "$PREVIEW_PORT" "$preview_health_result"
printf 'Preview  banner: %s\n' "$banner_result"
printf 'Produção banner: %s\n' "$production_no_banner"
printf 'Preview  assets:\n%s' "$preview_assets_result"
