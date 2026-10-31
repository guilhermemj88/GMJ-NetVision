# DIFF HUAWEI PROPOSTO — bloqueio permanente da SEMPRE-DDoS

**Status: PROPOSTA. NÃO APLICADA. Nenhuma escrita em equipamento foi executada nesta missão.**

Equipamento: `BHE-VTA-F1A-BGP-01` · Data do plano: 31/10/2026
Escopo autorizado nesta missão: **apenas preparar o diff**. Aplicar exige autorização específica separada.

---

## 1. Estado real lido (READ-ONLY, 30/10/2026 19:48 BRT)

```text
route-policy PL-SEMPRE-DDoS-IPv4-OUT permit node 50
 if-match extcommunity-filter MITIGACAO
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 100

ip extcommunity-filter basic MITIGACAO index 10 permit rt 268568:660
```

Interpretação: o RT660 **continua permitido** nessa saída. Se a sessão com
`138.99.240.141` voltar a Established, os prefixos com RT660 são anunciados.
A exclusão administrativa (`excluded=true`, `BACKBONE`) protege o peer como
**alvo** de mitigação; ela não controla anúncios enviados a ele.

---

## 2. Diff exato proposto

```diff
 # BHE-VTA-F1A-BGP-01 — PL-SEMPRE-DDoS-IPv4-OUT
+route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
+ if-match extcommunity-filter MITIGACAO
+
 route-policy PL-SEMPRE-DDoS-IPv4-OUT permit node 50
  if-match extcommunity-filter MITIGACAO
 route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 100
```

Comandos exatos (contexto de configuração, **não executados**):

```text
system-view
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
 if-match extcommunity-filter MITIGACAO
quit
quit
commit
```

### O que **não** muda

| Item                                                                                              | Ação                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| nodes 50 e 100 da própria policy                                                                  | **preservados integralmente**                                    |
| definição de `ip extcommunity-filter basic MITIGACAO`                                             | **não tocada** — é compartilhada com COMPUTIZE e outras policies |
| `PL-SEMPRE-IPv4-OUT` (saída normal do SEMPRE)                                                     | **não tocada**                                                   |
| peer `138.99.240.141` / sessão BGP                                                                | **não tocada** (sem refresh/reset/ignore)                        |
| exclusões administrativas (SEMPRE-DDoS `BACKBONE`, COMPUTIZE `BACKBONE`, SEMPRE normal `TRANSIT`) | **não tocadas**                                                  |
| nodes AGLINK 1/2/10/1000 e node 2 com RT660/LP1100                                                | **não tocados**                                                  |
| `LP-SEMPRE-DDoS-*`, outras policies                                                               | **não tocadas**                                                  |

---

## 3. Alcance — leia antes de autorizar

O `deny node 5` usa o filtro `MITIGACAO`, portanto rejeita **qualquer prefixo com
RT `268568:660`** nessa saída — não apenas os três prefixos da AGLINK.

Isso é intencional: `NEVER_MITIGATE` significa que **nenhuma** mitigação deve ser
anunciada a esse destino, para qualquer cliente. Efeito colateral aceito e
declarado: se algum dia outro cliente mitigado precisar ser anunciado à
SEMPRE-DDoS, ele também será bloqueado.

**Reavaliar a proposta se:**

- `node 5` estiver ocupado no momento da aplicação (conferir antes);
- o binding do peer mudar de policy de saída;
- o filtro `MITIGACAO` deixar de corresponder exatamente a RT660.

---

## 4. Pré-condições obrigatórias antes de aplicar

1. Autorização explícita do operador para **este** diff (alcance global RT660 aceito).
2. Confirmar que `node 5` está livre:
   `display current-configuration configuration route-policy | include PL-SEMPRE-DDoS-IPv4-OUT`
3. Confirmar o filtro: `display ip extcommunity-filter basic MITIGACAO`.
4. Janela com operador presente; nenhuma mitigação AGLINK em curso (ou impacto entendido).
5. Backup/registro do texto atual da policy (já existe em `docs/evidence/aglink-computize-only.json`).

## 5. Readback obrigatório depois de aplicar

```text
display current-configuration configuration route-policy | include PL-SEMPRE-DDoS-IPv4-OUT
```

Esperado, exatamente:

```text
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
 if-match extcommunity-filter MITIGACAO
route-policy PL-SEMPRE-DDoS-IPv4-OUT permit node 50
 if-match extcommunity-filter MITIGACAO
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 100
```

Validação de exportação (se a sessão estiver disponível no momento — **não é
requisito de prontidão**):

```text
display bgp routing-table peer 138.99.240.141 advertised-routes
```

Esperado: nenhuma rota com RT660. Separar sempre três camadas: Adj-RIB-Out local,
recepção do provedor e encaminhamento efetivo.

## 6. Reversão (se necessário)

```text
system-view
undo route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
quit
quit
commit
```

Reverter **reabre** o anúncio de RT660 a esse destino. Não faz parte do REMOVE
manual da AGLINK e nunca deve ser removido automaticamente por nenhum fluxo do
NetVision.

---

## 7. Relação com o código desta missão

Nada no código alterado nesta missão aplica, sugere ou automatiza esse diff:

- não há comando de escrita novo;
- `readReceivedRoutes` é READ-ONLY e serve apenas ao contrato de notificação;
- nenhum caminho do motor FAST foi modificado;
- `MITIGATION_AUTO_EXECUTION_ENABLED` permanece desligado;
- AUTO REMOVE continua proibido.
