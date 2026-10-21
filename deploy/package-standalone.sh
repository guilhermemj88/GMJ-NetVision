#!/usr/bin/env bash
#
# Empacota os assets que o `next build` (output: 'standalone') NÃO copia para o
# bundle standalone: `.next/static` e `public`.
#
# Por que isso existe: o servidor standalone sobe e responde HTTP 200 nas
# rotas, MAS todos os chunks JS/CSS saem 404, porque o `server.js` do Next
# procura os estáticos em `<standalone>/apps/web/.next/static` e as imagens de
# `public` em `<standalone>/apps/web/public`. Sem eles o JavaScript nunca
# carrega e a UI fica presa em "Verificando sessão".
#
# Uso (padrão = layout do monorepo deste repositório):
#   bash deploy/package-standalone.sh
#   bash deploy/package-standalone.sh --web-dir DIR --standalone-dir DIR
#
# Idempotente: remove o destino antes de copiar, então pode rodar depois de
# cada build, em instalação nova ou em atualização. Não reinicia serviços.

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

WEB_DIR=""
STANDALONE_WEB=""

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Uso: bash deploy/package-standalone.sh [opções]

  --web-dir DIR         diretório do app Web (default: <repo>/apps/web)
  --standalone-dir DIR  diretório do bundle standalone do app
                        (default: <web-dir>/.next/standalone/apps/web)
  -h, --help            mostra esta ajuda
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-dir)
      [[ $# -ge 2 ]] || fail "--web-dir exige um valor"
      WEB_DIR="$2"
      shift 2
      ;;
    --standalone-dir)
      [[ $# -ge 2 ]] || fail "--standalone-dir exige um valor"
      STANDALONE_WEB="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "argumento desconhecido: $1 (use --help)"
      ;;
  esac
done

[[ -n "$WEB_DIR" ]] || WEB_DIR="$PROJECT_DIR/apps/web"
[[ -d "$WEB_DIR" ]] || fail "diretório do Web não encontrado: $WEB_DIR"
WEB_DIR="$(cd -- "$WEB_DIR" && pwd -P)"

readonly NEXT_DIR="$WEB_DIR/.next"
[[ -d "$NEXT_DIR" ]] ||
  fail "$NEXT_DIR não encontrado; rode 'npm run build' antes de empacotar o standalone"

# O bundle do Next é sempre <distDir>/standalone/<caminho-do-app>/server.js.
[[ -n "$STANDALONE_WEB" ]] || STANDALONE_WEB="$NEXT_DIR/standalone/apps/web"
[[ -f "$STANDALONE_WEB/server.js" ]] ||
  fail "bundle standalone não encontrado em $STANDALONE_WEB/server.js; confirme output: 'standalone' em next.config.ts e que o build terminou"
STANDALONE_WEB="$(cd -- "$STANDALONE_WEB" && pwd -P)"

[[ -d "$NEXT_DIR/static" ]] ||
  fail "$NEXT_DIR/static não encontrado; o build do Next não gerou os assets estáticos"

log "Empacotando assets do standalone do Web"
printf 'origem:  %s\n' "$WEB_DIR"
printf 'destino: %s\n' "$STANDALONE_WEB"

mkdir -p "$STANDALONE_WEB/.next"

# `.next/static` é obrigatório: é onde ficam chunks JS, CSS e fontes. O
# `rm -rf` antes do `cp -a` garante idempotência — um segundo `cp -a` sobre o
# destino existente criaria `<destino>/static/static`.
rm -rf -- "$STANDALONE_WEB/.next/static"
cp -a -- "$NEXT_DIR/static" "$STANDALONE_WEB/.next/static"

[[ -d "$STANDALONE_WEB/.next/static" ]] ||
  fail "falha ao copiar .next/static para $STANDALONE_WEB/.next/static"

static_source_count="$(find "$NEXT_DIR/static" -type f | wc -l)"
static_target_count="$(find "$STANDALONE_WEB/.next/static" -type f | wc -l)"
[[ "$static_source_count" -eq "$static_target_count" ]] ||
  fail "cópia incompleta de .next/static: $static_target_count de $static_source_count arquivo(s)"

# `public` é opcional no contrato do Next, mas se existir precisa ir junto:
# são as imagens dos painéis físicos, favicons etc.
if [[ -d "$WEB_DIR/public" ]]; then
  rm -rf -- "$STANDALONE_WEB/public"
  cp -a -- "$WEB_DIR/public" "$STANDALONE_WEB/public"

  [[ -d "$STANDALONE_WEB/public" ]] ||
    fail "falha ao copiar public para $STANDALONE_WEB/public"

  public_source_count="$(find "$WEB_DIR/public" -type f | wc -l)"
  public_target_count="$(find "$STANDALONE_WEB/public" -type f | wc -l)"
  [[ "$public_source_count" -eq "$public_target_count" ]] ||
    fail "cópia incompleta de public: $public_target_count de $public_source_count arquivo(s)"
  printf 'public: %s arquivo(s)\n' "$public_target_count"
else
  # Remove um public remanescente de um build anterior para não servir asset velho.
  rm -rf -- "$STANDALONE_WEB/public"
  printf 'public: ausente em %s (nada a copiar)\n' "$WEB_DIR"
fi

printf 'static: %s arquivo(s)\n' "$static_target_count"

log "Bundle standalone empacotado"
printf 'static: %s\n' "$STANDALONE_WEB/.next/static"
printf 'public: %s\n' "$STANDALONE_WEB/public"
