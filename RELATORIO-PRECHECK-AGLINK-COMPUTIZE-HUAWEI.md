# AGLINK / COMPUTIZE — pré-check físico READ-ONLY (Huawei NE8000)

**Observado em:** 2026-11-01, 12:40–12:52 UTC (09:40–09:52 −03:00)
**Equipamento:** `BHE-VTA-F1A-BGP-01` — Huawei NetEngine 8000 F1A-8H20Q, VRP 8.220 (`V800R022C00SPC600`), uptime 47 d 6 h
**Accesso:** SSH `45.163.144.1:2222` a partir do IMPLANTAR, perfil de operador (`<BHE-VTA-F1A-BGP-01>`) — apenas nível de consulta
**Escopo:** 100% leitura. Nenhum `system-view`, `commit`, refresh/reset, ACTIVATE/REMOVE. Nenhuma escrita em API, n8n, Telegram ou catálogo.

Comandos usados: `display version`, `display bgp peer`, `display bgp peer <ip> verbose`, `display bgp routing-table peer <ip> received-routes`, `display bgp routing-table peer <ip> advertised-routes`, `display bgp routing-table <prefixo>`, `display route-policy <nome>`, `display ip ip-prefix <nome>`, `display ip extcommunity-filter`. `screen-length 0 temporary` foi apenas ajuste de sessão.

---

# 1. FATOS VERIFICADOS NO HUAWEI

## 1.1 Sessões BGP

| Peer | Endereço | Remote AS | Estado | Uptime | Veredito |
|---|---|---|---|---|---|
| **AGLINK** | `10.200.201.2` | 273811 | **Established** | 5 d 19 h 32 m | pronto |
| **COMPUTIZE-DDoS** | `198.19.4.145` | 270735 | **Established** | 5 d 19 h 31 m | pronto |
| **SEMPRE-DDoS** | `138.99.240.141` | 28198 | **Connect** (último: Active) | `Up count: 0` | **NÃO estabelecida** |
| SEMPRE (normal) | `138.99.240.117` | 28198 | Established | 5 d 19 h 32 m | referência |

Instância: AS local **268568**, 60 peers, 42 em Established.

Detalhe COMPUTIZE: descrição `"COMPUTIZE-DDoS-MITIGACAO"`, router ID remoto `10.99.99.0`, hold negociado 90 s / keepalive 30 s, `Peer Up count: 22`.
Detalhe AGLINK: descrição `"AGLINK"`, `Peer Up count: 11`.

## 1.2 Políticas por peer

| Peer | Import | Export |
|---|---|---|
| AGLINK `10.200.201.2` | `PL-AGLINK_IPv4-IN` | `PL-AGLINK_IPv4-OUT` |
| COMPUTIZE `198.19.4.145` | `PL-COMPUTIZE-IPv4-IN` | **`PL-COMPUTIZE-IPv4-OUT`** |
| SEMPRE-DDoS `138.99.240.141` | `PL-SEMPRE-DDoS-IPv4-IN` | **`PL-SEMPRE-DDoS-IPv4-OUT`** |

Nenhuma `import/export distribute policy` configurada em nenhum dos três.

## 1.3 Exportação por RT 268568:660 — COMPUTIZE

O filtro nomeado que materializa a RT de mitigação está correto:

```
Named Extended Community basic filter: MITIGACAO
    index: 10            permit     rt : 268568:660
```

`PL-COMPUTIZE-IPv4-OUT` (99 linhas) tem os dois nodes de mitigação no lugar:

```
  permit : 200 (matched counts: 12)
      if-match ip-prefix 73S-MITIGACAO
      if-match extcommunity-filter MITIGACAO
  permit : 300 (matched counts: 37)
      if-match extcommunity-filter MITIGACAO
  deny : 1000 (matched counts: 48638256)
```

**Veredito: a exportação por RT 268568:660 está PREPARADA para a COMPUTIZE.** O node 300 permite qualquer rota que carregue a RT de mitigação; o node 200 é o caminho nominal (prefix-list `73S-MITIGACAO` **e** RT660). Ordem dos nodes garante que os `deny` 25–95 (blocos não mitigáveis) vêm antes.

## 1.4 PL-AGLINK_IPv4-IN — baseline preservado

```
Route-policy: PL-AGLINK_IPv4-IN
  permit : 10 (matched counts: 77)
      if-match ip-prefix AGLINK-BLOCO-TODO-23
      apply local-preference 1100
      apply extcommunity rt 268568:140 additive
  deny : 1000 (matched counts: 0)
```

Exatamente o baseline exigido por `aglinkBaselineIntact` (2 nodes `>= 10`: node 10 permit com prefix-list + LP1100 + RT140 additive; node 1000 deny vazio).

**Nodes livres:** `1`, `2` e `5` não existem na policy. O motor planeja `bogonNode = 1` e `mitigationNode = 2` — ambos **disponíveis**, sem colisão com 10/1000.

## 1.5 Listas de prefixos

| Lista | Conteúdo verificado |
|---|---|
| `AGLINK-BLOCO-TODO-23` | `index: 10 permit 167.250.126.0/23 ge 23 le 24` — Permitted 77, Denied 0 |
| `BOGONS` | Permitted 362 (ex.: `10.0.0.0/8 ge 8 le 32`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`) |
| `73S-MITIGACAO` | Permitted 330 (usada no node 200 da COMPUTIZE-OUT) |

A `AGLINK-BLOCO-TODO-23` cobre os três prefixos nos dois comprimentos (/23 e /24) — coerente com o node de mitigação previsto.

## 1.6 Os três prefixos recebidos da AGLINK

`display bgp routing-table peer 10.200.201.2 received-routes` → **Total Number of Routes: 3**

| Prefixo | Next-hop | MED | LocalPref | AS-path | Best/select |
|---|---|---|---|---|---|
| 167.250.126.0/23 | 10.200.201.2 | 0 | 1100 | 273811 273811i | `*>` |
| 167.250.126.0/24 | 10.200.201.2 | 0 | 1100 | 273811 273811i | `*>` |
| 167.250.127.0/24 | 10.200.201.2 | 0 | 1100 | 273811 273811i | `*>` |

Atributos do /23 (detalhe): `From: 10.200.201.2 (167.250.126.0)`, `Original nexthop 10.200.201.2`, `Ext-Community: RT <268568:140>, RT <268568:330>`, `origin igp`, `valid, external, best, select`, `Paths: 1 available, 1 best, 1 select`, duração 5 d 19 h 32 m.

**Nenhuma das três carrega RT 268568:660** — confirmação independente de que **não há mitigação ativa**.

## 1.7 Anúncios atuais para a COMPUTIZE

`display bgp routing-table peer 198.19.4.145 advertised-routes` → **Total Number of Routes: 11**, e **zero** ocorrências de `167.250.126.0/23`, `167.250.126.0/24` ou `167.250.127.0/24`.

Comportamento esperado no estado pré-mitigação: sem RT660 nas rotas, o node 300 não as libera. A tabela de 11 rotas é a operação normal do peer.

Para a SEMPRE-DDoS não há leitura possível de `advertised-routes` (sessão em `Connect`).

## 1.8 PL-SEMPRE-DDoS-IPv4-OUT — RT660 ainda exportável

```
Route-policy: PL-SEMPRE-DDoS-IPv4-OUT
  permit : 50 (matched counts: 0)
      if-match extcommunity-filter MITIGACAO
  deny : 100 (matched counts: 0)
```

**Sim: a SEMPRE-DDoS ainda pode receber rotas com RT 268568:660** (node 50 casa `MITIGACAO`). Hoje o contador é 0 apenas porque a sessão está caída e não há mitigação ativa.

### Avaliação do `deny node 5` (não aplicado)

- **Node 5 está livre.** Um `deny node 5` com `if-match extcommunity-filter MITIGACAO` seria avaliado antes do `permit 50` e bloquearia definitivamente o anúncio de rotas mitigadas à SEMPRE-DDoS, mantendo o resto da policy intacto (`deny 100` continua como catch-all).
- **Alinhamento:** coerente com a decisão de que a COMPUTIZE é a única mitigadora e a SEMPRE-DDoS é `NEVER_MITIGATE`.
- **Necessidade prática:** o risco concreto é um *flap* da sessão SEMPRE-DDoS durante a janela — hoje ela está em `Connect`, mas se subir, receberia as rotas com RT660 imediatamente. A janela de exposição existe, ainda que pequena.
- **Blast radius:** o node 5 afeta **apenas** a exportação para essa sessão; não toca 1x8, backbone, IX ou a COMPUTIZE.
- **Recomendação:** aplicar **antes** da janela física, com autorização separada e readback; não é pré-requisito técnico bloqueante, mas elimina uma fonte de ambiguidade durante a homologação.

---

# 2. BLOQUEIOS AUTO E INTEGRIDADE DO PERFIL (API `bf7bc52`)

Flags **efetivas no processo** (PID 3460475, `/proc/<pid>/environ`):

| Flag | Valor | Efeito |
|---|---|---|
| `MITIGATION_AUTO_EXECUTION_ENABLED` | **0** | kill switch global de escrita automática |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED` | **0** | sem ciclo de vida automático |
| `MITIGATION_AUTO_REMOVE_ENABLED` | **0** | REMOVE automático permanentemente proibido |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED` | **1** | registro durável ativo |
| `MITIGATION_AUTO_MAX_ACTIVE` | **1** | concorrência 1 |
| `MITIGATION_EXECUTOR` | `HUAWEI` | executor real |
| `MITIGATION_LIVE_WRITE_ENABLED` | `true` | escrita habilitada no executor — contida pelo kill switch + allowlist |

Allowlist de execução: `cmuoavm6600cdsslhhw427w4r, cmuoavmed00dmsslhi3dzev57, cmuoavmfz00e2sslhbmo9ple7` — **o perfil AGLINK (`cmuoavm4e00bysslhqd0h3q7u`) NÃO está incluído**. Duas barreiras independentes para AUTO sobre a AGLINK.

Perfil AGLINK `cmuoavm4e00bysslhqd0h3q7u`:

| Campo | Valor |
|---|---|
| Policy | `PL-AGLINK_IPv4-IN` |
| Família | IPV4 |
| Modo | `AUTO` |
| Enabled | `true` |
| RT | `268568:660` |
| Trigger | 90 % · 3 amostras |
| `mitigationExcluded` | `false` |
| `autoModeExempt` | `false` |
| Escopo | peer `10.200.201.2` (primary) |
| Runtime | **NORMAL** · trigger 0 · recovery 46 · `plannedBogonNode 1` · `plannedMitigationNode 2` |

Estado global: 39 perfis → **38 NORMAL + 1 DISABLED, zero MITIGATED**. Eventos: ACTIVATE 4 (último 2026-10-18), REMOVE 4 (último 2026-10-19), SIMULATION 3; **0 eventos nas últimas 72 h**. Log administrativo BGP: apenas ENABLE/DISABLE de peer, últimos em 2026-10-20.

API saudável: `active`, PID 3460475, `NRestarts=0`, `/health` → 200, release `bf7bc527…`.

---

# 3. DIVERGÊNCIAS

| # | Divergência | Impacto | Bloqueia? |
|---|---|---|---|
| D1 | **SEMPRE-DDoS `138.99.240.141` não está Established** (`Connect`, `Up count 0`) — mesma condição de 30/10 | Não afeta a COMPUTIZE. Torna o caminho SEMPRE inutilizável e mantém aberto o risco de flap com export de RT660 | **Não** para COMPUTIZE-only; **sim** se a janela exigir as duas mitigadoras |
| D2 | `PL-SEMPRE-DDoS-IPv4-OUT` ainda permite RT660 (node 50) | Anúncio de rotas mitigadas à SEMPRE-DDoS se a sessão subir | **Não bloqueia**; elimina-se com o `deny node 5` |
| D3 | `MITIGATION_LIVE_WRITE_ENABLED=true` | Escrita física possível por ação manual autenticada | **Não** — é o mecanismo necessário para o REMOVE manual; contido por `AUTO_EXECUTION_ENABLED=0` + allowlist |
| D4 | `MITIGATION_AUTO_DESCRIPTION_ENABLED=1` | Descriptions automáticas em 8 perfis allowlistados | **Não** — AGLINK não está na lista de descriptions |

Nenhuma divergência de configuração encontrada: nodes 10/1000 intactos, listas corretas, RT660 definida corretamente, nodes 1/2 livres.

---

# 4. DEPENDE DE CONFIRMAÇÃO DA COMPUTIZE (não verificável do nosso lado)

O `advertised-routes` prova apenas o que **enviamos** (Adj-RIB-Out). Não há acesso à RIB do provedor nem recibo operacional. Ficam **NOT_VERIFIED**:

1. **Aceitação dos prefixos:** que a COMPUTIZE importe `167.250.126.0/23`, `167.250.126.0/24` e `167.250.127.0/24` com RT 268568:660 em sua política de import, e confirme a recepção.
2. **Capacidade de limpeza (divert):** que a mitigadora efetivamente desvie/limpe o tráfego dos três prefixos após a ativação — e o tempo até a limpeza plena.
3. **Retorno do tráfego:** que após o REMOVE o tráfego volte ao caminho normal AGLINK sem blackhole residual, e em quanto tempo.
4. **Prontidão e exclusividade da janela:** presença de contato técnico da COMPUTIZE durante a homologação.
5. **Perfil de limpeza contratado:** se há template/policy do lado deles pronto para esses prefixos (não apenas a sessão BGP up).

---

# 5. GO / NO-GO

## Infraestrutura Huawei — **GO**

Estrutura pronta e sem divergência de configuração: `PL-COMPUTIZE-IPv4-OUT` exporta RT660 (nodes 200/300), filtro `MITIGACAO` = `268568:660`, baseline da `PL-AGLINK_IPv4-IN` intacto (nodes 10/1000), nodes 1/2 livres, `AGLINK-BLOCO-TODO-23` cobrindo /23 e /24, três prefixos recebidos, best/select, LP1100. Nada precisa ser alterado no equipamento para ativar a mitigação.

## Homologação física geral — **NO-GO até as confirmações da COMPUTIZE**

Motivos objetivos:

1. **Item 4 permanece NOT_VERIFIED** nos quatro pontos que só a mitigadora pode confirmar (aceitação, limpeza, retorno, plantão).
2. **D1** mantém uma sessão DDoS da mesma família em `Connect`; a janela deve ser explicitamente **COMPUTIZE-only**, e isso precisa estar escrito na autorização.
3. **D2** deixa a porta aberta para anúncio duplicado à SEMPRE-DDoS em caso de flap; recomendado fechar com o `deny node 5` **antes** da janela, mediante autorização separada.

## Condições para converter em GO

1. Confirmação escrita da COMPUTIZE: sessão + política de import prontas, template de limpeza para os três prefixos, compromisso de acompanhamento na janela.
2. Autorização explícita, one-shot, com escopo: par `10.200.201.2` ⇄ `198.19.4.145`, VSI/prefixos `167.250.126.0/23`, `.126.0/24`, `.127.0/24`, RT `268568:660`, janela e duração.
3. Decisão sobre o `deny node 5` na SEMPRE-DDoS (aplicar antes, com readback e rollback; ou aceitar formalmente o risco de flap).
4. Aceitar que `AUTO_EXECUTION_ENABLED=0` permanece — a ativação será **manual**, com REMOVE manual disponível e autorizado separadamente.

---

# 6. CONFIRMAÇÃO DE NENHUMA ESCRITA

Zero `system-view`, zero `commit`, zero criação/remoção de node, zero alteração de policy, prefix-list, filtro RT ou sessão BGP. Nenhum `ping`, ataque ou tráfego artificial. Nenhum ACTIVATE/REMOVE no motor. Nenhuma alteração em API, n8n, Telegram, flags AUTO ou catálogo físico. Nenhum restart de serviço.

Estado final da API: `active`, PID 3460475, `NRestarts=0`, `/health` 200 — inalterado do início ao fim. Helpers de acesso efêmeros removidos do servidor.
