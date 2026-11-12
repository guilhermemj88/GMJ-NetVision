#!/usr/bin/env bash
# Teste do netvision-firewall.sh SEM tocar no firewall real: iptables/ip6tables sao SIMULADOS (stubs no PATH).
# Uso: bash test-netvision-firewall.sh [caminho-do-script]
set -u
SCRIPT=$(readlink -f "${1:-$(dirname "$0")/netvision-firewall.sh}")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/fw"
cat >"$T/bin/fakefw" <<'STUB'
#!/usr/bin/env bash
V=$1; shift; D="$FW/$V"; mkdir -p "$D"
op=$1; shift
case "$op" in
  -N) [ -e "$D/$1.chain" ] && exit 1; : >"$D/$1.chain" ;;
  -F) [ -e "$D/$1.chain" ] || exit 1; : >"$D/$1.chain" ;;
  -X) [ -e "$D/$1.chain" ] || exit 1; [ -s "$D/$1.chain" ] && exit 1; rm -f "$D/$1.chain" ;;
  -A) c=$1; shift; [ -e "$D/$c.chain" ] || exit 1; echo "$*" >>"$D/$c.chain" ;;
  -I) c=$1; shift; shift; [ -e "$D/$c.chain" ] || : >"$D/$c.chain"; { echo "$*"; cat "$D/$c.chain"; } >"$D/$c.n"; mv "$D/$c.n" "$D/$c.chain" ;;
  -C) c=$1; shift; [ -e "$D/$c.chain" ] && grep -Fxq -- "$*" "$D/$c.chain" ;;
  -D) c=$1; shift; [ -e "$D/$c.chain" ] || exit 1; grep -Fxq -- "$*" "$D/$c.chain" || exit 1
      n=$(grep -Fxn -- "$*" "$D/$c.chain" | head -1 | cut -d: -f1); sed -i "${n}d" "$D/$c.chain" ;;
  -S) [ $# -eq 0 ] && exit 0; c=${1:-INPUT}; [ -e "$D/$c.chain" ] || exit 1; while IFS= read -r l; do echo "-A $c $l"; done <"$D/$c.chain" ;;
esac
STUB
chmod +x "$T/bin/fakefw"
printf '#!/usr/bin/env bash\nexec "%s/bin/fakefw" v4 "$@"\n' "$T" >"$T/bin/iptables"
printf '#!/usr/bin/env bash\nexec "%s/bin/fakefw" v6 "$@"\n' "$T" >"$T/bin/ip6tables"
chmod +x "$T/bin/"*
export FW="$T/fw" PATH="$T/bin:$PATH"
pass=0; fail=0
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; fi; }
b() { [ "$1" = 0 ] && echo 1 || echo 0; }
run() { bash "$SCRIPT" "$@" >"$T/out" 2>&1; echo $?; }
rules() { cat "$FW/$1/NETVISION-IN.chain" 2>/dev/null; }
input() { cat "$FW/$1/INPUT.chain" 2>/dev/null; }

echo "1) apply valido"
rc=$(N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16,192.0.2.7/32 run apply)
ok "apply rc=0" $(b "$rc")
ok "uma unica ligacao no INPUT (v4)" $([ "$(input v4 | grep -c 'netvision-fw')" = 1 ] && echo 1 || echo 0)
ok "loopback livre primeiro" $([ "$(rules v4 | head -1)" = "-i lo -j RETURN" ] && echo 1 || echo 0)
ok "n8n so na porta 3333" $(rules v4 | grep -q -- '-s 179.189.80.25 --dport 3333 -j RETURN' && echo 1 || echo 0)
ok "painel: as duas redes na porta 80" $([ "$(rules v4 | grep -c -- 'dports 80 -j RETURN')" = 2 ] && echo 1 || echo 0)
ok "fechamento final cobre 3333,3000,80 (REJECT)" $(rules v4 | tail -1 | grep -q -- 'dports 3333,3000,80 -j REJECT' && echo 1 || echo 0)
ok "REJECT e a ultima regra (nada depois dele)" $(rules v4 | tail -1 | grep -q REJECT && echo 1 || echo 0)
ok "SSH (22/2222) nunca aparece nas regras" $(! rules v4 | grep -Eq -- '(^|[ ,])(22|2222)([ ,]|$)' && echo 1 || echo 0)
ok "v6 so com loopback + REJECT (sem origem permitida)" $([ "$(rules v6 | grep -c RETURN)" -le 2 ] && rules v6 | tail -1 | grep -q REJECT && echo 1 || echo 0)

echo "2) idempotencia"
rc=$(N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16,192.0.2.7/32 run apply)
ok "apply 2x rc=0" $(b "$rc")
ok "continua UMA ligacao" $([ "$(input v4 | grep -c 'netvision-fw')" = 1 ] && echo 1 || echo 0)
ok "regras nao duplicaram" $([ "$(rules v4 | grep -c REJECT)" = 1 ] && echo 1 || echo 0)

echo "3) trocar o IP do n8n"
N8N_EGRESS=5.6.7.8 PANEL_CIDRS=10.1.0.0/16 run apply >/dev/null
ok "so o IP novo permitido" $(rules v4 | grep -q -- '-s 5.6.7.8 ' && ! rules v4 | grep -q 179.189.80.25 && echo 1 || echo 0)

echo "4) status"
rc=$(run status); ok "status ativo rc=0" $(b "$rc")

echo "5) validacoes (nada instalado quando a entrada e invalida)"
bash "$SCRIPT" remove >/dev/null 2>&1
for case in "N8N_EGRESS=" "N8N_EGRESS=abc PANEL_CIDRS=10.0.0.0/8" "N8N_EGRESS=1.2.3.0/24 PANEL_CIDRS=10.0.0.0/8" "N8N_EGRESS=1.2.3.4" "N8N_EGRESS=1.2.3.4 PANEL_CIDRS=nao-e-cidr"; do
  rc=$(env $case bash "$SCRIPT" apply >/dev/null 2>&1; echo $?)
  ok "recusa: ${case}" $([ "$rc" != 0 ] && [ -z "$(input v4)" ] && [ ! -e "$FW/v4/NETVISION-IN.chain" ] && echo 1 || echo 0)
done

echo "6) remove"
N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16 run apply >/dev/null
rc=$(run remove); ok "remove rc=0" $(b "$rc")
ok "INPUT limpo e cadeia apagada (v4 e v6)" $([ -z "$(input v4)" ] && [ -z "$(input v6)" ] && [ ! -e "$FW/v4/NETVISION-IN.chain" ] && [ ! -e "$FW/v6/NETVISION-IN.chain" ] && echo 1 || echo 0)
rc=$(run remove); ok "remove 2x (idempotente) rc=0" $(b "$rc")
rc=$(run status); ok "status apos remove: rc!=0 (ausente)" $([ "$rc" != 0 ] && echo 1 || echo 0)

echo "7) regra alheia no INPUT e preservada"
echo "-p tcp --dport 2222 -j ACCEPT" >>"$FW/v4/INPUT.chain" 2>/dev/null || { mkdir -p "$FW/v4"; echo "-p tcp --dport 2222 -j ACCEPT" >"$FW/v4/INPUT.chain"; }
N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16 run apply >/dev/null; run remove >/dev/null
ok "regra alheia (SSH) intacta apos apply+remove" $([ "$(input v4)" = "-p tcp --dport 2222 -j ACCEPT" ] && echo 1 || echo 0)

echo "8) ip6tables indisponivel (kernel sem a tabela filter v6)"
printf '#!/usr/bin/env bash
exit 3
' >"$T/bin/ip6tables"
printf '00000000000000000000000000000001 01 80 10 80       lo
' >"$T/if_inet6_none"
printf '20010db8000000000000000000000001 02 40 00 80     eth0
' >"$T/if_inet6_global"
rc=$(IF_INET6_FILE="$T/if_inet6_none" N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16 run apply)
ok "sem IPv6 global: aplica so o IPv4 com aviso (rc=0)" $(b "$rc")
ok "IPv4 filtrado mesmo assim" $([ "$(input v4 | grep -c 'netvision-fw')" = 1 ] && echo 1 || echo 0)
run remove >/dev/null
rc=$(IF_INET6_FILE="$T/if_inet6_global" N8N_EGRESS=179.189.80.25 PANEL_CIDRS=10.1.0.0/16 run apply)
ok "COM IPv6 global e sem ip6tables: RECUSA e nao deixa regra parcial" $([ "$rc" != 0 ] && [ "$(input v4 | grep -c netvision-fw)" = 0 ] && echo 1 || echo 0)

echo; echo "RESULTADO: $pass ok, $fail falha(s)"; [ $fail = 0 ]
