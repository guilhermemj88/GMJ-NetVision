#!/usr/bin/env bash
# Firewall PERMANENTE das superficies de comando do NetVision (substitui o isolamento temporario por janela).
# NAO e aplicado por nenhum deploy automatico: instalar e ativar exige autorizacao explicita.
#
# Politica (camada 3/4, sem inspecao de URL/payload):
#   - loopback: livre (API :3333, web :3000 e nginx se falam por 127.0.0.1; executor local e CLI de emergencia).
#   - :3333 (API)  -> somente N8N_EGRESS (canal n8n -> NetVision). Ninguem mais de fora.
#   - :80  (painel via nginx) -> somente PANEL_CIDRS (redes dos operadores).
#   - :3000 (web Next)        -> nunca de fora (o nginx o alcanca por loopback).
#   - SSH e todas as demais portas: NAO tocadas (nenhuma regra de descarte geral; sem risco de perder o acesso).
# Tudo numa cadeia propria (NETVISION-IN) ligada ao INPUT por UMA regra com comentario: idempotente, reversivel.
#
#   sudo N8N_EGRESS=<ip> PANEL_CIDRS=<cidr[,cidr]> bash netvision-firewall.sh apply
#   sudo bash netvision-firewall.sh status | remove
# Variaveis: N8N_PORT (3333), PANEL_PORTS (80), API_PORT (3333), WEB_PORT (3000), PANEL_CIDRS6 (opcional, IPv6).
set -uo pipefail
MODE=${1:?apply|remove|status}
CHAIN=NETVISION-IN
TAG=netvision-fw
API_PORT=${API_PORT:-3333}
WEB_PORT=${WEB_PORT:-3000}
N8N_PORT=${N8N_PORT:-$API_PORT}
PANEL_PORTS=${PANEL_PORTS:-80}
N8N_EGRESS=${N8N_EGRESS:-}
PANEL_CIDRS=${PANEL_CIDRS:-}
PANEL_CIDRS6=${PANEL_CIDRS6:-}

v4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; }
v6() { [[ "$1" =~ ^[0-9a-fA-F:]+(/[0-9]{1,3})?$ ]] && [[ "$1" == *:* ]]; }
csv() { local IFS=,; read -ra _o <<<"$1"; printf '%s\n' "${_o[@]}" | sed '/^$/d'; }

jump() { "$1" -C INPUT -m comment --comment "$TAG" -j "$CHAIN" 2>/dev/null; }

purge() { # $1 = iptables|ip6tables : remove TODAS as ligacoes e a cadeia (idempotente)
  local fw=$1 guard=0
  while jump "$fw" && [ $guard -lt 20 ]; do "$fw" -D INPUT -m comment --comment "$TAG" -j "$CHAIN"; guard=$((guard + 1)); done
  "$fw" -F "$CHAIN" 2>/dev/null
  "$fw" -X "$CHAIN" 2>/dev/null
  return 0
}

build() { # $1 fw, $2 familia (4|6)
  local fw=$1 fam=$2 c ports
  purge "$fw"
  "$fw" -N "$CHAIN" || return 1
  "$fw" -A "$CHAIN" -i lo -j RETURN || return 1
  "$fw" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN || return 1
  if [ "$fam" = 4 ]; then
    "$fw" -A "$CHAIN" -p tcp -s "$N8N_EGRESS" --dport "$N8N_PORT" -j RETURN || return 1
    while read -r c; do
      [ -n "$c" ] && "$fw" -A "$CHAIN" -p tcp -s "$c" -m multiport --dports "$PANEL_PORTS" -j RETURN
    done < <(csv "$PANEL_CIDRS")
  else
    while read -r c; do
      [ -n "$c" ] && "$fw" -A "$CHAIN" -p tcp -s "$c" -m multiport --dports "$PANEL_PORTS" -j RETURN
    done < <(csv "$PANEL_CIDRS6")
  fi
  ports="$API_PORT,$WEB_PORT,$PANEL_PORTS"; [ "$N8N_PORT" != "$API_PORT" ] && ports="$ports,$N8N_PORT"
  "$fw" -A "$CHAIN" -p tcp -m multiport --dports "$ports" -j REJECT --reject-with tcp-reset || return 1
  "$fw" -I INPUT 1 -m comment --comment "$TAG" -j "$CHAIN" || return 1
}

case "$MODE" in
  apply)
    v4 "$N8N_EGRESS" && [[ "$N8N_EGRESS" != */* ]] || { echo "ERRO: defina N8N_EGRESS=<ip unico do n8n>"; exit 2; }
    [ -n "$PANEL_CIDRS" ] || { echo "ERRO: defina PANEL_CIDRS=<redes dos operadores> (vazio = painel fechado para todos; use 127.0.0.1/32 se for esse o desejo)"; exit 2; }
    while read -r c; do v4 "$c" || { echo "ERRO: PANEL_CIDRS invalido: $c"; exit 2; }; done < <(csv "$PANEL_CIDRS")
    while read -r c; do [ -n "$c" ] && { v6 "$c" || { echo "ERRO: PANEL_CIDRS6 invalido: $c"; exit 2; }; }; done < <(csv "$PANEL_CIDRS6")
    build iptables 4 || { purge iptables; echo "ERRO: IPv4 nao aplicado; regras REMOVIDAS (estado anterior)"; exit 1; }
    if command -v ip6tables >/dev/null 2>&1; then
      build ip6tables 6 || { purge ip6tables; purge iptables; echo "ERRO: IPv6 nao aplicado; tudo REMOVIDO"; exit 1; }
    fi
    echo "FIREWALL NETVISION ATIVO (n8n=$N8N_EGRESS:$N8N_PORT, painel=$PANEL_CIDRS:$PANEL_PORTS)."
    echo "PROVA (de fora): :$API_PORT e :$WEB_PORT = 000 para quem nao e o n8n; do n8n: curl http://<servidor>:$API_PORT/health = 200."
    ;;
  remove)
    purge iptables; command -v ip6tables >/dev/null 2>&1 && purge ip6tables
    echo "FIREWALL NETVISION REMOVIDO."
    ;;
  status)
    rc=0
    for fw in iptables ip6tables; do
      command -v "$fw" >/dev/null 2>&1 || continue
      if jump "$fw"; then echo "$fw: ATIVO"; "$fw" -S "$CHAIN"; else echo "$fw: ausente"; rc=1; fi
    done
    exit $rc
    ;;
  *) echo "uso: netvision-firewall.sh apply|remove|status"; exit 2 ;;
esac
