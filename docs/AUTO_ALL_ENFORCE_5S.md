# AUTO-ALL ENFORCE IPv4 com FAST SNMP de 5 s

**04/11/2026 — branch `feature/fast-auto-multiclient-5s` (base `feature/auto-all-ipv4-fast-fixes` @ `f768c15`).**
Nenhum deploy, nenhuma migration, nenhum comando no equipamento, nenhuma flag ligada em
produção. `AUTO_EXECUTION_ENABLED=0` continua obrigatório na homologação inicial.

---

## 1. Três estados que não podem ser confundidos

| Estado | Como se comprova | O que autoriza |
|---|---|---|
| **AUTO-ALL implementado** | branch contém o código, testes verdes e `phases.implemented=true` na API | nada — é código |
| **AUTO-ALL em observação** | `MITIGATION_FAST_POLL_MODE=OBSERVE` (ou `ENFORCE` com `AUTO_EXECUTION_ENABLED=0`) | medir, decidir e auditar; **zero escrita** |
| **AUTO-ALL autorizado para execução física** | `MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED=1` **e** `MITIGATION_AUTO_LIFECYCLE_ENABLED=1` **e** `MITIGATION_AUTO_EXECUTION_ENABLED=1` **e** `MITIGATION_LIVE_WRITE_ENABLED=true` **e** device allowlistado | escrita BGP real (fora do escopo desta entrega) |

O endpoint `/api/bgp/mitigation/auto-all` publica `phases.physicalExecutionAuthorized` a partir
das flags reais — nunca de um valor declarado.

---

## 2. Flags

| Variável | Padrão | Efeito |
|---|---|---|
| `MITIGATION_FAST_POLL_MODE` | `OFF` | `OFF` / `OBSERVE` / `ENFORCE` |
| `MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED` | `0` | **nova**: descobre o escopo no caminho ENFORCE. Exige `mode=ENFORCE`; exclui observação total |
| `MITIGATION_FAST_NORMAL_SECONDS` | `10` | cadência nominal; faixa **5..30** (5 s homologado no F1A) |
| `MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE` | `32` | teto por equipamento; exceder **falha** o refresh (fail-closed) |
| `MITIGATION_FAST_SINGLE_OWNER` | `0` | posse única; **forçada** quando AUTO-ALL está ligado |
| `MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS` | vazio | lista explícita; `*` = todos os descobertos (exige AUTO-ALL ligado, senão falha no boot) |
| `MITIGATION_AUTO_MAX_ACTIVE` | `1` | concorrência de mitigação física — **não** alterada nesta fase |
| `MITIGATION_AUTO_COOLDOWN_SECONDS` | `600` | cooldown por escopo — **não** alterado nesta fase |

Guardas de boot (falham alto, nunca degradam em silêncio):

- `AUTO_ALL_ENFORCE_REQUIRES_ENFORCE` — AUTO-ALL em modo diferente de `ENFORCE`;
- `AUTO_ALL_ENFORCE_EXCLUDES_OBSERVE_ALL` — as duas flags juntas;
- `AUTO_ALL_ENFORCE_REQUIRES_LEASE` — AUTO-ALL sem lease construída;
- `AUTO_ALLOW_ALL_REQUIRES_AUTO_ALL_ENFORCE` — `*` na allowlist sem AUTO-ALL.

---

## 3. Elegibilidade — matriz completa

A descoberta avalia **todos** os perfis com `mode = AUTO` e devolve, por cliente, o motivo
estável do bloqueio. Nenhum perfil é promovido: `MANUAL`, `HOLD` e `ALERT_ONLY` nunca entram.

| Código | Condição | Efeito |
|---|---|---|
| `PROFILE_DISABLED` | `enabled = false` | fora do escopo |
| `MODE_NOT_AUTO` | modo diferente de `AUTO` e sem telemetria explícita | fora do escopo |
| `NOT_IPV4` | `addressFamily <> IPV4` | fora (IPv6 segue ALERT_ONLY) |
| `MITIGATION_EXCLUDED` | `mitigationExcluded = true` | fora |
| `DEVICE_NOT_ALLOWED` | device fora de `MITIGATION_ALLOWED_DEVICE_IDS` | fora |
| `INTERFACE_UNKNOWN` | `interfaceId` não resolve no inventário | fora |
| `SNMP_DISABLED` | host sem SNMP habilitado | fora |
| `SNMP_NOT_V2C` | versão diferente de SNMP v2c | fora |
| `BANDWIDTH_UNKNOWN` | banda contratada ausente ou ≤ 0 | fora — nunca usa 300 Gbps por omissão |
| `DIRECTION_UNRESOLVED` | sem direção por perfil/ENV/interface | fora no ENFORCE (observação aceita) |

`bandwidthBps` é sempre a **banda contratada** (`bandwidthOverrideBps ?? detectedBandwidthBps`);
`thresholdBps = bandwidthBps × triggerPercent / 100` (padrão 90 %).

Os gates de **atuação** (política BGP, prefixos, limites, ownership, confirmação de estado,
kill switch, idempotência, cooldown) permanecem onde sempre estiveram — no motor e no
lifecycle. A descoberta não os reimplementa e não os contorna.

---

## 4. Contrato da API

`GET /api/bgp/mitigation/auto-all`

```json
{
  "phases": {
    "implemented": true,
    "observation": "AUTO_ALL | EXPLICIT_LIST_ONLY | OFF",
    "enforcementScope": "AUTO_ALL | EXPLICIT_LIST",
    "physicalExecutionAuthorized": false,
    "fastMode": "ENFORCE",
    "cadenceMs": 5000,
    "maxActive": 1,
    "cooldownMs": 600000
  },
  "lease": { "enabled": true, "acquired": true, "lost": false },
  "clients": [
    {
      "profileId": "...",
      "mode": "AUTO",
      "eligible": true,
      "reasons": [],
      "bandwidthBps": "10000000000",
      "ifIndex": 236,
      "direction": "tx",
      "triggerPercent": 90,
      "score": { "samplesOver": 2, "requiredSamples": 3, "progress": "2/3", "outcome": "PENDING", "reason": null, "firstAbnormalAt": "...", "decisionMs": 4120, "runtimeState": "NORMAL" }
    }
  ]
}
```

`score: null` = perfil elegível ainda sem decisão nesta janela.

`GET /api/bgp/mitigation/fast-poller` passa a listar o **escopo descoberto** (união entre o que
o coletor avaliou e as decisões emitidas), nunca a lista estática.

---

## 5. Isolamento e limites

- contadores de confirmação, cooldown e recuperação são **por perfil** (`samplesOver`,
  `samplesBelow`, `firstAbnormalAt` no registro de decisão) — um cliente não altera a
  sequência de outro;
- `maxActive = 1` e cooldown de 600 s preservados; a concorrência física não foi ampliada;
- posse única obrigatória em AUTO-ALL: dois processos nunca medem o mesmo `ifIndex`
  (advisory lock de sessão, `connection_limit=1`, perda de sessão para a coleta em 15 s).

---

## 6. Evidência de teste

| Suíte | Casos |
|---|---|
| `fast-auto-all-enforce.test.ts` | 11 — descoberta de 23 perfis, exclusão de MANUAL/HOLD/ALERT_ONLY, compatibilidade com allowlist explícita, motivos de bloqueio, limiar por banda contratada, isolamento por perfil, guardas de config |
| `fast-poller-lease.test.ts` | 8 — primeiro adquire, segundo não, perda de sessão, release, erro de banco, URL de conexão única |
| `fast-cadence.test.ts` | 6 — 5 s aceito, 4 s barrado, janela derivada igual no poller e na decisão |
| `fast-lifecycle-simulation.test.ts` | 7 — inclui confirmação em 3 amostras com 5 s e coortes 40 ataques × 40 controles |
| `auto-lifecycle.test.ts` | 72 — allowlist explícita, `*` só com AUTO-ALL, gates de device |
| Regressão FAST/AUTO/rotas | **715 testes verdes**, 0 falha |

`tsc --noEmit` limpo. Simulações usam transporte Huawei falso: **nada comprova homologação
física**.

---

## 7. GO / NO-GO

**GO (código)** — AUTO-ALL ENFORCE implementado, descoberta dinâmica sem limite de 3 clientes,
5 s, posse única obrigatória, isolamento por cliente e API de elegibilidade/motivo/progresso.

**GO (observação)** — ligar `MITIGATION_FAST_POLL_MODE=ENFORCE` +
`MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED=1` + `MITIGATION_FAST_NORMAL_SECONDS=5` com
`MITIGATION_AUTO_EXECUTION_ENABLED=0`: coleta e decide, não escreve.

**NO-GO (execução física)** enquanto não houver:

1. auditoria **independente** das correções F1–F4 (as evidências atuais são do implementador);
2. backup recuperável do PostgreSQL (achado A4: nenhum backup válido no host);
3. painel WEB por cliente (próxima fase) para o operador ver 1/3–3/3 e o motivo do bloqueio;
4. janela aprovada com `maxActive=1`, um único cliente e rollback ensaiado.
