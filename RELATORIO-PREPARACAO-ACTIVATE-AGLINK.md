# AGLINK / COMPUTIZE — preparação do ACTIVATE físico (nodes 1 e 2)

**Data:** 2026-11-01 · **Equipamento:** `BHE-VTA-F1A-BGP-01` (NE8000 F1A-8H20Q, VRP 8.220)
**Branch isolada:** `feature/aglink-activate-safety` · worktree `c:\projetos\GMJ-NetVision-aglink-activate-safety` · base `390c34f` · commit da correção **`a4f1d00`**
**Nada foi criado, commitado ou salvo no roteador. Nenhum ACTIVATE/REMOVE. Nenhum deploy.**

---

# A. Configuração BEFORE (lida do equipamento em 2026-11-01 10:03 −03:00)

```
Route-policy: PL-AGLINK_IPv4-IN
  permit : 10 (matched counts: 77)
    Match clauses:
      if-match ip-prefix AGLINK-BLOCO-TODO-23
    Apply clauses:
      apply local-preference 1100
      apply extcommunity rt 268568:140 additive
  deny : 1000 (matched counts: 0)
```

Contexto confirmado na mesma leitura:

| Item | Valor |
|---|---|
| Prefix-list `AGLINK-BLOCO-TODO-23` | `index 10 permit 167.250.126.0/23 ge 23 le 24` (Permitted 77) |
| Prefix-list `BOGONS` | existe, Permitted 362 |
| Nodes livres na policy | **1, 2 e 5** (só existem 10 e 1000) |
| Peer AGLINK | `10.200.201.2` AS273811, **Established** 5 d 19 h |
| Peer COMPUTIZE | `198.19.4.145` AS270735, **Established** 5 d 19 h |
| Peer SEMPRE-DDoS | `138.99.240.141`, **Active** (não estabelecida) |
| Prefixos recebidos | 3, todos best/select, LP 1100, RT **140** + **330** |

---

# B. AFTER proposto — comandos exatos do ACTIVATE

O motor gera exatamente esta lista (`buildMitigationActivateCommands`):

```
system-view
route-policy PL-AGLINK_IPv4-IN deny node 1
 if-match ip-prefix BOGONS
route-policy PL-AGLINK_IPv4-IN permit node 2
 if-match ip-prefix AGLINK-BLOCO-TODO-23
 apply local-preference 1100
 apply extcommunity rt 268568:660
commit
```

Estado resultante, na ordem de avaliação:

```
Route-policy: PL-AGLINK_IPv4-IN
  deny   : 1     if-match ip-prefix BOGONS
  permit : 2     if-match ip-prefix AGLINK-BLOCO-TODO-23
                 apply local-preference 1100
                 apply extcommunity rt 268568:660
  permit : 10    if-match ip-prefix AGLINK-BLOCO-TODO-23
                 apply local-preference 1100
                 apply extcommunity rt 268568:140 additive
  deny   : 1000
```

O VRP8 avalia em ordem crescente de sequência e **termina no primeiro node que casa**. Para os três prefixos da AGLINK o node 2 casa e o node 10 deixa de ser executado.

---

# C. Como LP1100, RT140 e RT330 se comportam

## C.1 Origem real de cada atributo (leitura, não suposição)

| Atributo | Origem determinada | Evidência |
|---|---|---|
| **LP 1100** | aplicado pelo **node 10** (`apply local-preference 1100`) | `display route-policy PL-AGLINK_IPv4-IN` |
| **RT 268568:140** | aplicado pelo **node 10** (`apply extcommunity rt 268568:140 additive`) | idem |
| **RT 268568:330** | **não existe em nenhuma route-policy do equipamento** → chega no UPDATE do peer AGLINK | `display current-configuration configuration route-policy \| include 330` → **0 ocorrências** (o mesmo comando com `268568:140` retorna 8 linhas) |

## C.2 Comportamento durante a mitigação

| Atributo | Durante o ACTIVATE | Por quê |
|---|---|---|
| LP 1100 | **PRESERVADO** | o node 2 reaplica explicitamente (`apply local-preference 1100`), porque o node 10 não roda mais |
| RT 268568:140 | **AUSENTE** | vem do node 10, que não é executado |
| RT 268568:330 | **AUSENTE** | `apply extcommunity rt 268568:660` **sem `additive`** substitui todo o conjunto de extended communities |
| RT 268568:660 | **presente e única** | é o que marca a rota para o mitigador |

## C.3 Por que remover RT140/RT330 é obrigatório (e não um defeito)

Esta é a parte em que a premissa da missão não se sustenta no equipamento real. **As policies de exportação dos provedores normais não negam uma rota só por ela carregar RT660:**

| Policy de exportação | Como trata RT660 |
|---|---|
| `PL-SEMPRE-IPv4-OUT` | `deny : 5` = `if-match extcommunity-filter MITIGACAO` **E** `if-match extcommunity-filter NO-EXPORT-SEMPRE` → dois `if-match` no mesmo node significam **AND**. RT660 sozinha **não** nega |
| `PL-SEABORN-IPv4-OUT` | mesma estrutura (`MITIGACAO` **AND** `NO-EXPORT-SEABORN`) |
| `PL-SEABORN-BH-IPv4-OUT` | mesma estrutura |
| `PL-CIRION-IPv4-OUT` | **não possui** nenhum node com `MITIGACAO` |
| `PL-TUDDO-IPv4-OUT` | **não possui** nenhum node com `MITIGACAO` |
| `PL-BGP_VS-IX_V4_OUT` | **não possui** nenhum node com `MITIGACAO` |

Consequência direta: se o node 2 mantivesse RT140/RT330 (`additive`), os três prefixos continuariam sendo anunciados a **todos** os provedores normais, o tráfego continuaria entrando por lá e a mitigação **não desviaria nada**. Substituir o conjunto de RTs é o mecanismo de desvio, não um efeito colateral.

E o mais importante: **nada é perdido de forma permanente**. Ao remover os nodes 1 e 2, o node 10 volta a casar (reaplicando LP1100 + RT140) e a RT330 volta com o UPDATE do peer. O estado BEFORE é restaurado integralmente — coberto pelo teste `8) REMOVE manual restaura o estado original`.

> Se a intenção fosse realmente preservar RT140/RT330 durante a mitigação, seria necessário **antes** adicionar nodes `deny` com `if-match extcommunity-filter MITIGACAO` (RT660 sozinha) nas seis policies de exportação normais. Isso é uma mudança de escopo muito maior, **não autorizada** e não executada. Fica registrada como decisão do operador.

## C.4 Valores fixos × valores da policy

A preocupação de "não usar LP/RT140 globais" já está atendida e agora está travada por teste:

- `apply local-preference` só é emitido **para a policy da AGLINK**; qualquer outro cliente recebe `apply extcommunity rt <sua RT> additive` e **nenhum** `local-preference` (`buildMitigationActivateCommands` ramifica por `policyName`).
- O LP 1100 só é aceito porque o baseline físico é validado antes de qualquer escrita: `aglinkBaselineIntact` exige que o node 10 tenha exatamente `if-match AGLINK-BLOCO-TODO-23` + `apply local-preference 1100` + `apply extcommunity rt 268568:140 additive`, e que existam exatamente dois nodes `>= 10` (o 10 permit e o 1000 deny). Se o cliente mudar o LP, a ativação é **bloqueada**, não silenciosamente sobrescrita.
- O preflight também exige que a definição da prefix-list seja exatamente `ip ip-prefix AGLINK-BLOCO-TODO-23 index 10 permit 167.250.126.0 23 greater-equal 23 less-equal 24`.
- Rejeição de RT divergente: `AGLINK_MITIGATION_RT_MISMATCH`.

---

# D. Diferenças de código e testes

## D.1 Defeito encontrado e corrigido

**Não havia defeito na geração de comandos** (ver C.3). O defeito real está no **transporte de escrita**, exatamente no item 10 da missão — e é a mesma classe de falha que produziu o commit involuntário:

Na sessão de ESCRITA, o cliente SSH **não detectava** confirmação/paginação do VRP no meio dos comandos. Ele esperava o *idle* (2,5 s), considerava a saída terminada e seguia adiante — de modo que o **próximo texto enviado virava a resposta ao prompt**. Uma sessão que recebesse `Uncommitted configurations found, commit them before exiting? [Y/N/C]` podia responder qualquer coisa, inclusive algo interpretado como `Y`, commitando configuração não revisada. A detecção de `[Y/N]`/`--More--`/`Error:` só existia no modo *diagnostic* (VSI), nunca no caminho de mitigação.

### `apps/api/src/infrastructure/ssh/ssh-client-impl.ts` (+34)

```ts
/** [Y/N] / [Y/N/C] / (y/n) / --More-- / press any key */
const INTERACTIVE_PROMPT = /\[Y\/N(?:\/[A-Z])?\]|\(y\/n\)|----\s*More\s*----|--More--|press\s+any\s+key/i;

// opção nova, opt-in, só para escrita:
abortOnInteractivePrompt?: boolean;
```

No `handleStdout`, depois de acumular a saída e **antes** de qualquer novo `write`:

```ts
if (interactivePromptGuard && !diagnostic && commandIndex > 0 && !exiting &&
    INTERACTIVE_PROMPT.test(stdout.slice(-400))) {
  settled = true; clearTimeout(timeout); clearIdle(); stream.close();
  reject(new Error('SSH_INTERACTIVE_PROMPT_BLOCKED'));
  return;
}
```

Efeito: **nenhum byte novo vai para o canal** — nem `Y`, nem o `return`/`quit` de saída. A candidata fica pendente e o VRP a descarta ao fechar a sessão.

### `apps/api/src/infrastructure/bgp/huawei-bgp-ssh.ts` (+16)

- `applyMitigationCommands` liga `abortOnInteractivePrompt: true` (só o caminho de escrita).
- `safeSshError` passou a preservar o motivo: `SSH interactive prompt blocked` em vez de mascarar como `SSH command failed`.
- `BgpSshClientOptions` ganhou os campos `exitMode`, `shellTimeoutMs` e `abortOnInteractivePrompt` (antes trafegavam sem tipo).

## D.2 Testes — mapa dos 10 itens obrigatórios

| # | Item exigido | Teste |
|---|---|---|
| 1 | Criação dos nodes 1 e 2 | `aglink-activate-contract.test.ts` › *gera exatamente a lista canonica do ACTIVATE* |
| 2 | Preservação dos nodes 10 e 1000 | idem › *nenhum comando referencia node 10 ou node 1000* |
| 3 | Manutenção do LP1100 | idem › *durante: node 2 casa, LP1100 preservado* |
| 4 | Communities legítimas | idem › *somente RT660 permanece* + *a RT660 e aplicada sem `additive`* (documenta o C.3) |
| 5 | Adição da RT660 | item 3/4 acima + readback |
| 6 | Bloqueio de configurações incompletas/divergentes | idem › *readback rejeita LP divergente*, *…prefix-list alvo trocada*, *…baseline alterado*, *…par incompleto* |
| 7 | Readback da configuração física | idem › *readback do estado ativado e verificado* (fixture no formato real de `display route-policy`) |
| 8 | REMOVE manual restaurando o original | idem › *readback de retirada exige os dois nodes ausentes e baseline intacto* + *depois do REMOVE o prefixo volta ao node 10* + *o REMOVE retira somente 1 e 2* |
| 9 | Não alteração de clientes com políticas diferentes | idem › *sem `apply local-preference` e com `additive`* |
| 10 | Falha segura no commit (nunca responder `Y`) | `ssh-client-impl.test.ts` › **J)** prompt `[Y/N]` no meio da escrita aborta sem responder (verifica que **nada** foi escrito depois), **K)** `--More--` aborta, **L)** leitura não é afetada; `huawei-bgp-ssh-mitigation.test.ts` › *prompt interativo vira falha explícita* |

## D.3 Resultados

| Verificação | Resultado |
|---|---|
| Suíte completa da API | **2720 testes, 0 falhas** (187 arquivos ok, 7 skipped) |
| `tsc --noEmit` | exit 0 |
| `eslint --max-warnings=0` nos arquivos alterados | exit 0 |
| Arquivos alterados | 2 fontes + 2 testes ajustados + 1 teste novo (17 casos) |

---

# E. Plano de readback e rollback

## E.1 Antes de escrever (pré-checks obrigatórios)

1. `display configuration commit list` — registrar o último `CommitId`; abortar se aparecer commit de terceiro durante a janela.
2. `display configuration sessions` — abortar se houver lock (`Lock` diferente de `-`).
3. `display route-policy PL-AGLINK_IPv4-IN` — confirmar nodes 10/1000 intactos e **nodes 1/2 inexistentes**.
4. `display ip ip-prefix AGLINK-BLOCO-TODO-23` e `display ip ip-prefix BOGONS`.
5. `display bgp peer 10.200.201.2` e `... 198.19.4.145` — ambos Established.
6. `display bgp routing-table peer 198.19.4.145 advertised-routes` — os três prefixos **ausentes** (estado pré-mitigação).
7. Confirmar flags AUTO por leitura da API (`EXECUTION/LIFECYCLE/REMOVE = 0`).

> **Correção de procedimento herdada do incidente:** `display configuration changes` compara **running × startup**, **não** candidata × running. Ele nunca serve para conferir a candidata. A conferência correta da candidata, quando feita por CLI, é feita pela própria aplicação (o motor só envia a lista canônica e depois faz readback) — não por esse comando.

## E.2 Readback depois do ACTIVATE

| # | Comando | Esperado |
|---|---|---|
| 1 | `display route-policy PL-AGLINK_IPv4-IN` | 4 nodes: `deny 1` (BOGONS), `permit 2` (BLOCO-TODO-23 + LP1100 + RT660 **sem** additive), `permit 10` (inalterado), `deny 1000` |
| 2 | `display bgp routing-table 167.250.126.0 23` (+ `/24` e `.127.0/24`) | `Ext-Community: RT <268568:660>` **somente**; LP 1100; best/select |
| 3 | `display bgp routing-table peer 198.19.4.145 advertised-routes` | os **três prefixos agora presentes** |
| 4 | `advertised-routes` de SEMPRE / SEABORN / SEABORN-BH / CIRION / TUDDO / VS-IX | os **três prefixos ausentes** |
| 5 | `display bgp peer` | AGLINK e COMPUTIZE seguem Established |
| 6 | Aplicação | `verifyActivation` = `verified: true` (valida LP, prefix-list, RT660 e baseline com igualdade exata de cláusulas) |

## E.3 Rollback

```
system-view
undo route-policy PL-AGLINK_IPv4-IN node 1
undo route-policy PL-AGLINK_IPv4-IN node 2
commit
```

Verificação: `verifyRemoval` exige **os dois nodes ausentes** e baseline intacto (se apenas um sumiu, o estado é `RECONCILIATION_REQUIRED`, não “retirado”). Depois: os três prefixos voltam a LP1100 + RT140 + RT330 e reaparecem em todos os provedores normais.

Executar o rollback **somente** se não houver commit concorrente posterior ao do ACTIVATE.

## E.4 Persistência

Se o ACTIVATE for feito, o `commit` altera a running config; o arquivo de inicialização **não** muda sem `save`. Recomenda-se decidir explicitamente sobre `save` após validar o estado — e, em caso de dúvida, manter sem `save` para que um reboot reverta.

---

# F. GO / NO-GO

## Código — **GO**

Defeito real (transporte de escrita respondendo a prompt interativo) corrigido, com 5 testes novos dedicados e 17 casos de contrato físico do ACTIVATE. Suíte completa verde, typecheck e lint limpos. Pronto em `feature/aglink-activate-safety` (`a4f1d00`), **sem deploy e sem publicação**.

## ACTIVATE físico — **NO-GO neste momento**

1. **Sem autorização.** A missão autorizou apenas leitura e correção de código.
2. **Dependências da COMPUTIZE ainda NOT_VERIFIED** (do pré-check anterior): aceitação dos três prefixos com RT660, capacidade/tempo de limpeza, retorno do tráfego após REMOVE, plantão na janela.
3. **SEMPRE-DDoS `138.99.240.141` não está Established** — a janela precisa ser declarada **COMPUTIZE-only**.
4. **Decisão pendente sobre RT140/RT330** (C.3): manter o comportamento atual (desvio efetivo, RTs restauradas no REMOVE) ou, alternativamente, preservá-las — o que exigiria antes acrescentar `deny` de RT660 nas seis policies normais, mudança não autorizada.
5. **A correção do transporte não está publicada.** A API em produção (`bf7bc52`) ainda roda o cliente antigo, sem o fail-safe. Qualquer ACTIVATE pelo motor hoje usaria o código publicado — vale o mesmo cuidado de sempre: conferir a candidata e nunca responder `Y`.

## Para converter em GO

1. Publicar (ou executar em ambiente controlado) a correção `a4f1d00` — deploy exige autorização própria.
2. Confirmação escrita da COMPUTIZE (4 itens + plantão).
3. Autorização one-shot explícita: policy `PL-AGLINK_IPv4-IN`, nodes 1 e 2, RT `268568:660`, peer `10.200.201.2` ⇄ `198.19.4.145`, três prefixos, janela e duração, com rollback pronto.
4. Aceite formal de que `AUTO_EXECUTION_ENABLED` permanece **0** e de que o LP/RT do cliente não serão alterados no baseline.

---

## Confirmação de não-alteração nesta missão

Nenhum `system-view`, nenhum `commit`, nenhum `save`, nenhuma criação de node, nenhuma alteração de policy/prefix-list/filtro/sessão BGP, nenhum ACTIVATE/REMOVE, nenhum ping ou tráfego artificial. Nenhuma alteração em produção, API, n8n, Telegram, flags AUTO ou catálogo físico. O helper de commit defeituoso **não foi reutilizado** — todas as leituras foram feitas por `display` em sessão read-only, e os helpers efêmeros foram removidos do servidor. API segue `active`, PID 3460475, `NRestarts=0`, `/health` 200.
