# Alteração autorizada — `deny node 5` na PL-SEMPRE-DDoS-IPv4-OUT

**Equipamento:** `BHE-VTA-F1A-BGP-01` — Huawei NetEngine 8000 F1A-8H20Q, VRP 8.220
**Janela:** 2026-11-01, 13:03:12–13:05 UTC (10:03:12–10:05 −03:00)
**Escopo executado:** criação de **um único node** — `deny node 5` com `if-match extcommunity-filter MITIGACAO` em `PL-SEMPRE-DDoS-IPv4-OUT`
**Resultado final:** **PASS** — alteração aplicada exatamente como autorizada, sem nenhum outro efeito

---

## 1. BEFORE (capturado antes da alteração)

`display route-policy PL-SEMPRE-DDoS-IPv4-OUT` — 10:01:34 −03:00

```
Route-policy: PL-SEMPRE-DDoS-IPv4-OUT
  permit : 50 (matched counts: 0)
    Match clauses:
      if-match extcommunity-filter MITIGACAO
  deny : 100 (matched counts: 0)
```

| Precondição | Exigido | Observado | Status |
|---|---|---|---|
| `permit node 50` com `if-match extcommunity-filter MITIGACAO` | presente | presente | ✅ |
| `deny node 100` | presente | presente | ✅ |
| `node 5` | inexistente | inexistente (0 ocorrências) | ✅ |
| Filtro `MITIGACAO` | `rt 268568:660` | `index 10 permit rt : 268568:660` | ✅ |
| Configurações pendentes de commit | nenhuma | `Info: The current configuration is the same as the next startup configuration file.` | ✅ |
| Concorrência | sem lock alheio | somente sessão `VTY 0 guilherme3`, coluna `Lock` = `-` | ✅ |

Baseline de rollback: `undo route-policy PL-SEMPRE-DDoS-IPv4-OUT node 5` + `commit` (reverte ao estado acima).

---

## 2. Execução

### 2.1 Comandos enviados (idênticos ao autorizado)

```
system-view
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
if-match extcommunity-filter MITIGACAO
quit
```

Resposta do equipamento (transcrição literal):

```
[~BHE-VTA-F1A-BGP-01]route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
Info: New Sequence of this List
[*BHE-VTA-F1A-BGP-01-route-policy]if-match extcommunity-filter MITIGACAO
[*BHE-VTA-F1A-BGP-01-route-policy]quit
[*BHE-VTA-F1A-BGP-01]
```

O prefixo `*` no prompt indica alteração pendente de commit — o node foi criado na configuração candidata, ainda não aplicada.

### 2.2 Desvio no mecanismo de controle (registrado com transparência)

| Etapa planejada | O que aconteceu |
|---|---|
| Conferir o diff candidato antes do commit | ❌ **Comando errado.** Usei `display configuration changes`, que no VRP8 compara **running × startup**, não candidata × running. Ele respondeu “current configuration is the same as the next startup configuration”, então o guard não viu as linhas esperadas e recusou emitir `commit`. |
| Descartar a candidata em caso de divergência | ❌ **Resposta invertida.** Ao sair do modo de configuração, o equipamento perguntou `Uncommitted configurations found, commit them before exiting? [Y(yes)/N(no)/C(cancel)]` e o script respondeu `y` — que **commita**, não descarta. |
| Efeito líquido | ✅ O commit ocorreu por esse caminho, em `2026-11-01 10:03:20-03:00`, e a configuração em execução contém **exatamente e somente** a alteração autorizada (prova na seção 3.3). Nenhum efeito colateral. |

**Conclusão:** o guard falhou por erro de verificação e a diretiva de descarte estava invertida; ambos os defeitos são do meu script, não do equipamento. O resultado físico coincide integralmente com o autorizado, e a prova de ausência de mudanças extras é o diff running × startup, que contém apenas as duas linhas esperadas.

---

## 3. AFTER (readback)

### 3.1 Configuração em execução

`display route-policy PL-SEMPRE-DDoS-IPv4-OUT` — 10:04−03:00

```
Route-policy: PL-SEMPRE-DDoS-IPv4-OUT
  deny : 5 (matched counts: 0)
    Match clauses:
      if-match extcommunity-filter MITIGACAO
  permit : 50 (matched counts: 0)
    Match clauses:
      if-match extcommunity-filter MITIGACAO
  deny : 100 (matched counts: 0)
```

| Item verificado | Resultado | Status |
|---|---|---|
| `deny node 5` com filtro `MITIGACAO` | presente, ordem correta (5 → 50 → 100) | ✅ PASS |
| `permit node 50` preservado | presente, inalterado | ✅ PASS |
| `deny node 100` preservado | presente, inalterado | ✅ PASS |

### 3.2 Sessões BGP

| Peer | Endereço | Estado antes | Estado depois | Status |
|---|---|---|---|---|
| AGLINK | `10.200.201.2` | Established | **Established** (139 h 56 m) | ✅ PASS |
| COMPUTIZE-DDoS | `198.19.4.145` | Established | **Established** (139 h 56 m) | ✅ PASS |
| SEMPRE (normal) | `138.99.240.117` | Established | **Established** (139 h 56 m) | ✅ PASS |
| SEMPRE-DDoS | `138.99.240.141` | Connect | Active (continua **não** estabelecida) | ⚪ inalterado |

Nenhum reset, refresh ou alteração de sessão foi executado.

### 3.3 Prova de mudança única

`display configuration changes` (running × startup), 10:04−03:00:

```
Warning: The current configuration is not the same as the next startup configuration file. There are several differences as follow:
  #
+ route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
+  if-match extcommunity-filter MITIGACAO
  #
```

Exatamente **duas linhas**, ambas do escopo autorizado. Nenhuma outra diferença em nenhuma parte da configuração.

### 3.4 Demais policies preservadas

| Policy | Verificação | Status |
|---|---|---|
| `PL-AGLINK_IPv4-IN` | `permit : 10` (AGLINK-BLOCO-TODO-23, LP 1100, RT 268568:140 additive) + `deny : 1000`; **nós 1 e 2 continuam inexistentes** | ✅ intacta |
| `PL-COMPUTIZE-IPv4-OUT` | `permit : 200`, `permit : 300`, `deny : 1000` presentes e inalterados | ✅ intacta |
| Demais route-policies | nenhuma diferença no diff running × startup | ✅ intactas |

### 3.5 Controle de concorrência e histórico de commit

`display configuration commit list`:

| CommitId | Usuário | Timestamp |
|---|---|---|
| **1000001962** | **guilherme3** | **2026-11-01 10:03:20 −03:00** ← esta alteração |
| 1000001961 | julioimp | 2026-10-28 21:49:45 |
| 1000001960 | julioimp | 2026-10-27 11:05:10 |

Nenhum commit de terceiros entre o baseline e a alteração — não houve concorrência.

### 3.6 AUTO permanece desligado

| Flag (env real do processo) | Valor |
|---|---|
| `MITIGATION_AUTO_EXECUTION_ENABLED` | **0** |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED` | **0** |
| `MITIGATION_AUTO_REMOVE_ENABLED` | **0** |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED` | 1 |
| `MITIGATION_AUTO_MAX_ACTIVE` | 1 |

Runtime de mitigação inalterado: 38 `NORMAL` + 1 `DISABLED`, **zero `MITIGATED`**. Eventos inalterados (ACTIVATE 4 / REMOVE 4 / SIMULATION 3, nenhum novo). API `active`, PID 3460475, `NRestarts=0`, `/health` 200 — mesma PID do início.

---

## 4. Configuração de inicialização — PENDENTE DE DECISÃO

O `commit` aplica a alteração na **configuração em execução**. O arquivo de inicialização (`next startup`) **não** foi atualizado: o diff da seção 3.3 mostra justamente running × startup.

Consequências:

- A alteração está **ativa agora** e sobrevive a failover de placa/processo enquanto a running config for mantida.
- Um **reboot** do equipamento faria a configuração voltar ao estado anterior (sem o node 5).
- `save` **não foi executado** — não estava no escopo autorizado.

**Recomendação:** autorizar `save` em janela separada, junto com o rollback pronto, para tornar a proteção permanente. Enquanto isso, o `deny node 5` protege normalmente a operação corrente.

---

## 5. Verificação final de escopo

| Proibição | Cumprida |
|---|---|
| Alterar `PL-AGLINK_IPv4-IN` | ✅ não alterada |
| Criar nodes 1 ou 2 na AGLINK | ✅ não criados |
| Alterar `PL-COMPUTIZE-IPv4-OUT` | ✅ não alterada |
| Reset/refresh de sessões BGP | ✅ nenhum |
| ACTIVATE / REMOVE | ✅ nenhum |
| Habilitar AUTO | ✅ permanece 0 |
| Alterar API / n8n / Telegram | ✅ nada alterado |
| Modificar qualquer outro elemento | ✅ diff running × startup com apenas 2 linhas |
| Homologação física / anúncio de prefixos à COMPUTIZE | ✅ não executados |

Helpers de acesso efêmeros removidos do servidor após o uso; nenhum segredo foi exibido ou persistido em arquivo.

---

## PASS/FAIL

| Critério | Status |
|---|---|
| Alteração aplicada exatamente como autorizada | **PASS** |
| Ausência de mudanças colaterais (diff de 2 linhas) | **PASS** |
| `deny node 5` + MITIGACAO no readback | **PASS** |
| Nodes 50 e 100 preservados | **PASS** |
| AGLINK e COMPUTIZE Established | **PASS** |
| AUTO desligado | **PASS** |
| Procedimento de commit guardado funcionar como projetado | **FAIL** (erro de verificação e de resposta ao prompt — documentado na seção 2.2; sem impacto no resultado) |
| Persistência em startup | ⚪ **PENDENTE** de autorização para `save` |
