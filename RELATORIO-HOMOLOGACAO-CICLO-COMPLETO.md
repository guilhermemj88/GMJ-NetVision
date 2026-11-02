# RELATORIO — HOMOLOGACAO DO CICLO COMPLETO (ACTIVATE -> RESTART -> REMOVE)

Ambiente: Windows (estacao de trabalho) — nada executado na IMPLANTAR
Worktree: `C:\projetos\GMJ-NetVision-aglink-activate-safety`
Branch: `feature/aglink-activate-safety` · HEAD de partida: `12306fb`
Codigo do motor: **inalterado** (nenhum arquivo de `src/` foi modificado)
PostgreSQL: container `netvision-baseline-pg` — **18.6**, `127.0.0.1:55077`,
banco `mitigation_baseline_test`

**Resultado: PASS em todas as etapas** (ACTIVATE, restart real de processo,
REMOVE, 6 cenarios negativos).

---

## LIMITACAO DO HARNESS EXISTENTE (reportada antes de criar infraestrutura)

`apps/api/src/testing/single-pilot-harness.ts` expõe `restart: async () => { create(); await lifecycle.reconcile(); }`
— isso **recria objetos no MESMO processo** (mesmo heap, mesmos modulos em cache).
Nao prova que o estado sobrevive a morte do processo, que e o ponto central do B6.

Nenhum harness do repo oferece fronteira real de processo. Por isso foi criado o
minimo descartavel em `apps/api/lab-homolog/` (5 arquivos, ~450 linhas), usando
`tsx` (dependencia ja existente), **sem tocar em codigo de produto**:

| Arquivo | Papel |
| --- | --- |
| `router-sim.ts` | equipamento Huawei simulado (VRP8), estado em arquivo JSON **fora do processo** |
| `shared.ts` | constantes, guarda de isolamento de URL, fabricas de Prisma/executor |
| `step-activate.ts` | **processo A** — ACTIVATE |
| `step-remove.ts` | **processo B** — leitura do baseline no PG + REMOVE |
| `negatives.ts` | 6 cenarios negativos |

O simulador aplica a lista canonica como o VRP: erro em qualquer comando
**descarta a candidata** e nenhum `commit` e efetivado.

---

## ETAPA 1 — Verificacoes (PASS)

| Item | Resultado |
| --- | --- |
| Branch / HEAD / status | `feature/aglink-activate-safety` · `12306fb` · **limpo** |
| PostgreSQL de laboratorio | `Up`, `127.0.0.1:55077 -> 5432`, `Mounts=[]` |
| Bancos na instancia | `mitigation_baseline_test`, `postgres`, `template0`, `template1` |
| Migrations aplicadas | **43** |
| Tabela | `MitigationAutomationRecord` presente |
| Credenciais | usuario `nv_baseline_lab` / senha de laboratorio; nenhum `.env` produtivo |
| Guarda de URL no harness | recusa qualquer host/porta/banco fora de `127.0.0.1:55077` (ou `55999` no teste de indisponibilidade) |
| Conexao com IMPLANTAR | **nenhuma** |

---

## ETAPA 2 — ACTIVATE simulado (PASS)

Executor Huawei **real**, transporte SSH **simulado** (sem rede para equipamento).

Preflight aprovado:
```
ok: true · blockedReasons: []
baseline_record_store : armazenamento do baseline disponivel para escrita real
preserved_attributes  : atributos derivados do node 10
                        [if-match ip-prefix PREFIX8to24 | apply local-preference 1100
                         | apply extcommunity rt 268568:140 rt 268568:660 additive]
node_occupancy        : nodes 1 e 2 livres (caso A)
```

Comandos enviados (lista canonica, 8 linhas):
```
system-view
route-policy PL-HOMOLOG_IPv4-IN deny node 1
 if-match ip-prefix BOGONS
route-policy PL-HOMOLOG_IPv4-IN permit node 2
 if-match ip-prefix PREFIX8to24
 apply local-preference 1100
 apply extcommunity rt 268568:140 rt 268568:660 additive
commit
```

Readback: `verified: true` — “par ativo: deny node 1 (BOGONS) + permit node 2
(PREFIX8to24 + atributos preservados + RT 268568:660)”.

### Registro persistido no PostgreSQL (antes da escrita ja gravado e confirmado)
```json
{
  "id": "mitigation-baseline:host-lab-homolog:PL-HOMOLOG_IPv4-IN",
  "kind": "mitigation-baseline", "status": "ACTIVE",
  "payload": {
    "version": 1, "deviceId": "host-lab-homolog",
    "policyName": "PL-HOMOLOG_IPv4-IN", "bogonNode": 1, "mitigationNode": 2,
    "nodes": [
      { "node": 10, "action": "permit",
        "clauses": ["if-match ip-prefix PREFIX8to24","apply local-preference 1100",
                    "apply extcommunity rt 268568:140 additive"] },
      { "node": 1000, "action": "deny", "clauses": [] }
    ],
    "readBackSha256": "276023f9b940cc9a51deaf094c5afffa67fbe06dd86f143d78c47cd773b97756",
    "capturedAt": "2026-11-02T12:51:45.387Z"
  }
}
```

---

## ETAPA 3 — RESTART real do processo (PASS)

| Prova | Evidencia |
| --- | --- |
| Processo A encerrado | `tsx step-activate` PID **34996**, `exit=0`, processo morto |
| Instancias descartadas | `PrismaClient`, `AutomationMitigationBaselineStore` e executor existiam apenas no processo A |
| Container mantido | `netvision-baseline-pg` segue `Up` |
| Processo B novo | `tsx step-remove` PID **33164** (distinto), conexoes novas |
| Baseline recuperado | **exclusivamente** do PostgreSQL |

```
ETAPA3 baseline lido do PostgreSQL pela instancia B
{ encontrado: true, deviceId: "host-lab-homolog", policyName: "PL-HOMOLOG_IPv4-IN",
  par: { bogon: 1, mitigation: 2 }, nodesPermanentes: [10, 1000],
  readBackSha256: "276023f9…b97756", capturedAt: "2026-11-02T12:51:45.387Z" }
```

O equipamento simulado (estado em arquivo, como um roteador real) sobreviveu ao
restart da API com os nodes `[1, 2, 10, 1000]` e `commits: 1`.

---

## ETAPA 4 — REMOVE (PASS)

```
preflight REMOVE: ok=true
  policy_baseline_record: nodes permanentes identicos ao registro …[10, 1000]
  policy_mitigation_scope: estrutura de mitigacao reconhecida
  readBackNodes: [1, 2, 10, 1000]

comandos: system-view / undo route-policy PL-HOMOLOG_IPv4-IN node 1
          / undo route-policy PL-HOMOLOG_IPv4-IN node 2 / commit

readback pos-remove: verified=true — "par removido: nodes 1 e 2 ausentes", nodes [10, 1000]
config igual ao original: true   diffConfig: []
policies tocadas: ["PL-HOMOLOG_IPv4-IN"]  (nenhuma outra)
```

### Diff da route-policy
| Momento | Configuracao |
| --- | --- |
| **ANTES** | `node 10 permit PREFIX8to24 (LP 1100 + RT 140 additive)` · `node 1000 deny` |
| **DURANTE** | ANTES + `node 1 deny BOGONS` · `node 2 permit PREFIX8to24 (LP 1100 + RT 140 **+ RT 660** additive)` |
| **DEPOIS** | identico ao ANTES (comparacao byte a byte da configuracao) |

---

## ETAPA 5 — Cenarios negativos (PASS 6/6)

| # | Cenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Baseline **ausente** bloqueia REMOVE | PASS | `MITIGATION_BASELINE_RECORD_MISSING` · 0 escritas |
| 2 | Baseline **corrompido** bloqueia REMOVE | PASS | `MITIGATION_BASELINE_RECORD_MISSING` · 0 escritas |
| 3 | Node permanente **modificado** bloqueia REMOVE | PASS | `MITIGATION_BASELINE_DRIFT: node 10 … LP 1100 -> LP 500` · 0 escritas |
| 4 | **PostgreSQL indisponivel** bloqueia | PASS | REMOVE bloqueado; ACTIVATE → `MITIGATION_BASELINE_RECORD_UNAVAILABLE: Can't reach database server at 127.0.0.1:55999` · 0 escritas |
| 5 | **Erro SSH impede commit** | PASS | `MITIGATION_WRITE_FAILED: Unrecognized command` · `commits=0` · nodes `[10,1000]` |
| 6 | **Ambiguidade** permanece bloqueada | PASS | `estrutura de mitigacao multipla: 2 node(s) BOGONS [1, 5], 1 node(s) de mitigacao [2]` · 0 escritas |

---

## ETAPA 6 — Regressao e estado do laboratorio

| Verificacao | Resultado |
| --- | --- |
| Suite completa da API | **2792 verdes / 39 skip (2831)**, exit 0 |
| `tsc --noEmit` | 0 |
| `eslint --max-warnings=0` (lab + mitigation + worker) | 0 |
| Codigo do motor alterado | **nenhum** |

Laboratorio preservado (conforme autorizado): `netvision-baseline-pg` `Up`,
`127.0.0.1:55077`, `Mounts=[]`, 4 bancos, registro
`mitigation-baseline:host-lab-homolog:PL-HOMOLOG_IPv4-IN | ACTIVE` mantido como
trilha de auditoria. Remocao futura: `docker rm -f netvision-baseline-pg`.

---

## PASS/FAIL por cenario

| Cenario | Veredito |
| --- | --- |
| ETAPA 1 verificacoes e isolamento | **PASS** |
| ETAPA 2 ACTIVATE (preflight, baseline no PG antes da escrita, nodes 1/2, permanentes intactos, readback) | **PASS** |
| ETAPA 3 restart real de processo + recuperacao do PG | **PASS** |
| ETAPA 4 REMOVE e equivalencia com o original | **PASS** |
| ETAPA 5 negativos 1–6 | **PASS** (6/6) |
| Regressao completa, typecheck, lint | **PASS** |

---

## GO / NO-GO

**GO** para deploy controlado na IMPLANTAR, observadas as condicoes:

1. a IMPLANTAR precisa de **persistencia habilitada** (`MITIGATION_AUTO_PERSISTENCE_ENABLED=1`),
   sem a qual o ACTIVATE real e bloqueado por desenho com
   `MITIGATION_BASELINE_RECORD_UNAVAILABLE`;
2. janela com o responsavel, mantendo **AUTO desligado** e REMOVE manual;
3. a primeira ativacao real deve ser acompanhada de readback e conferencia do
   registro `mitigation-baseline:<device>:<policy>` no PostgreSQL.

**NO-GO** permanece para qualquer ACTIVATE fisico sem autorizacao explicita.
Nada foi publicado, nenhuma conexao com Huawei real, nenhuma alteracao na
IMPLANTAR, n8n intocado, AUTO desligado.
