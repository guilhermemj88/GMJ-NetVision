# Diagnóstico VSI/MPLS por MCP — documentação técnica e operacional

Branch: `feature/vsi-mcp-diagnostics` (base `6ad9265`, produção atual). Status: **desenvolvimento, não publicado, desligado por padrão**.
Relatório de auditoria: [`AUDITORIA_VSI_MCP.md`](./AUDITORIA_VSI_MCP.md).

## 1. Ferramentas

Nomes seguem o padrão `verbo_substantivo` já usado no MCP (`list_bgp_peers`, `get_interface`).

| Ferramenta | Fonte | SSH | Exige |
|---|---|---|---|
| `list_vsi` | SNMP persistido | não | autenticado |
| `get_vsi_details` | `PERSISTED` (padrão) ou `LIVE` | só `LIVE` | `LIVE`: ADMIN/OPERATOR + `approvalId` |
| `get_vsi_ac_bindings` | idem (LIVE lê config de cada AC e detecta binding duplicado) | só `LIVE` | idem |
| `get_vsi_pseudowires` | idem | só `LIVE` | idem |
| `get_vsi_mac_table` | SSH | sim | ADMIN/OPERATOR + `approvalId`; `NOT_SUPPORTED` se não homologado |
| `get_vsi_vlan_encapsulation` | SSH (config das interfaces) | sim | idem |
| `diagnose_vsi` | SSH + correlator (uma ponta) | sim | idem |
| `compare_vsi_endpoints` | SSH nas duas pontas + correlator | sim (1×/ponta) | 1 `approvalId` por ponta |

**Não existe** ferramenta MCP para criar a aprovação (ato humano de ADMIN) nem parâmetro de comando/texto livre.

### Contrato comum de resposta (`ToolEnvelope`)

```jsonc
{
  "tool": "diagnose_vsi",
  "status": "OK | INCONCLUSIVE | NOT_SUPPORTED | ERROR",
  "generatedAt": "ISO-8601",
  "hostId": "…", "vsiName": "…",
  "data": { … },                      // específico da ferramenta
  "evidence": [{ "id", "source": "PERSISTED_SNMP|LIVE_SSH", "hostId", "hostName",
                 "collectedAt", "observedAt", "command", "sha256", "bytes", "complete", "excerpt" }],
  "skipped":  [{ "hostId", "command", "reason": "CANDIDATE_NOT_HOMOLOGATED|NOT_SUPPORTED", "note" }],
  "warnings": [], "errors": [{ "code", "message", "hostId" }]
}
```

- `status` **nunca** é `OK` com evidência ausente/incompleta (paginação, nome divergente, total de MAC divergente → `INCONCLUSIVE`).
- `excerpt` é truncado (1.200 caracteres); a saída inteira não é devolvida. Senha do equipamento e linhas com `password|secret|community|…` são removidas.

### Achados (`Finding`) — fato × efeito

Cada achado separa **`certainty`** (o que a saída do equipamento mostra) de **`impactCertainty`** (a consequência inferida): `CONFIRMED | PROBABLE | HYPOTHESIS | INCONCLUSIVE`, mais `caveat` (quando a regra **não** vale). O sistema nunca declara causa raiz confirmada.

| Código | Fato | Efeito |
|---|---|---|
| `DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE` | CONFIRMED | PROBABLE |
| `ENCAPSULATION_TYPE_MISMATCH` (vlan×ethernet) | CONFIRMED | PROBABLE |
| `MTU_MISMATCH`, `PW_STATE_ASYMMETRIC`, `PW_LABEL_MISMATCH` | CONFIRMED | PROBABLE |
| `VLAN_TRANSFORM_ASYMMETRIC` | CONFIRMED | **HYPOTHESIS** |
| `TAG_COUNT_MISMATCH_PROBABLE` | PROBABLE | HYPOTHESIS |
| `TRAFFIC_STOPS_AFTER_STAGE` (MAC A_AC→A_PW→B_PW→B_AC) | PROBABLE | HYPOTHESIS |
| `VSI_DOWN`, `AC_DOWN`, `PW_DOWN`, `ALL_PW_DOWN` | CONFIRMED | CONFIRMED |
| `*_MISSING`, `COMPARISON_INCONCLUSIVE`, `PW_PAIR_UNRESOLVED` | INCONCLUSIVE | INCONCLUSIVE |

## 2. Segurança — por que não executa nada além de consulta

Camadas independentes (qualquer uma sozinha já bloquearia escrita):

1. **Schema zod `.strict()`**: campo desconhecido é erro; `vsiName`/`interface` por regex estrita; `approvalId` UUID.
2. **Enum fechado de operações** (`VERSION, VSI_LIST, VSI_VERBOSE, VSI_MAC, INTERFACE_CONFIG, INTERFACE_STATE`). O chamador escolhe a operação, nunca o texto; `buildVsiMcpCommand` é o único ponto onde um comando nasce.
3. **`assertVsiMcpReadOnly`**: só `display `, allowlist por regex ancorada, bloqueio de metacaracteres (`; & | \` $ < > \\ \n`), de pipe/redirecionamento e de tokens de escrita (`undo system-view commit save reset reboot shutdown clear delete rollback ping tracert telnet ssh … peer apply`). Revalidado imediatamente antes do envio ao canal.
4. **Matriz de capacidades**: o comando só é enviado se `HOMOLOGATED` para a família detectada; `CANDIDATE` só em `homologation=true` (ADMIN) e nunca produz veredito.
5. **Perfil de acesso por host** (`VSI_MCP_ACCESS_FILE`, root 0600/≤64 KiB/sem symlink): endpoint, porta, usuário, contexto e **fingerprint do host key** têm de bater com o inventário; validade; operações autorizadas; família declarada é **confirmada contra `display version`** a cada sessão (`PLATFORM_MISMATCH` aborta).
6. **`SshClientImpl` em modo diagnóstico**: `allowedCommands` exatos, sequência verificada comando a comando, saída ≤128 KiB, prompt confirmado.
7. **Aprovação one-shot** por host + VSI (escopo `vsi-name:<VSI>`, distinto do escopo legado), criada só por ADMIN via `POST /api/vsi-mcp/approvals`.
8. **Limites**: ≤2 sessões SSH no processo, 1 por host (`BUSY`), 12 s/comando, 45 s/sessão, 90 s/chamada, ≤14 operações/sessão, ≤8 interfaces/leitura.

Testes de segurança: `vsi-mcp.test.ts` (injeção em nome de VSI/interface, mais de 20 comandos de escrita/proibidos recusados, todo comando gerado passa no guard e começa por `display`), `tools.test.ts` (nenhum campo de comando em nenhum schema, VIEWER bloqueado, aprovação 423 interrompe antes do SSH, descarte de candidatos antes de conectar, senha nunca na saída, contexto virtual-system, BUSY), `vsi-tools.test.ts` (MCP sem ferramenta de aprovação/comando livre).

## 3. Quantas conexões SSH

- Uma sessão por ponta quando as interfaces dos ACs são conhecidas (passadas em `interfaces` ou persistidas no banco): `display version` + VSI [+ MAC] + configs.
- **Duas sessões** quando os ACs só são descobertos pela saída da VSI (NE8000/NE40E sem SNMP): sessão 1 = version + VSI [+ MAC]; sessão 2 = configs dos ACs lidos (≤8). Motivo: o `SshClientImpl` só permite um comando condicional; **não foi alterado** (compartilhado com a mitigação). Melhoria futura: generalizar o hook (mudança em arquivo compartilhado, exige revisão própria).

## 4. Comandos por família (estado real)

| Operação | Comando | S6730 V200 | S6750 YunShan V600 | NE8000 V800 | NE40E V800 |
|---|---|---|---|---|---|
| VERSION | `display version` | HOMOLOGATED | HOMOLOGATED | HOMOLOGATED¹ | HOMOLOGATED¹ |
| VSI_VERBOSE | `display vsi name <v> verbose` | HOMOLOGATED | HOMOLOGATED | **CANDIDATE** | **CANDIDATE** |
| INTERFACE_STATE | `display interface <if>` | HOMOLOGATED | HOMOLOGATED | CANDIDATE | CANDIDATE |
| INTERFACE_CONFIG | `display current-configuration interface <if>` | CANDIDATE | CANDIDATE | CANDIDATE | CANDIDATE |
| VSI_MAC | `display mac-address vsi <v>` | CANDIDATE | CANDIDATE | CANDIDATE | CANDIDATE |
| VSI_LIST | `display vsi` | CANDIDATE | CANDIDATE | CANDIDATE | CANDIDATE |

¹ comando universal já usado em produção; necessário para identificar a plataforma.
`HOMOLOGATED` = existe captura real versionada no repositório (S6730/S6750: `__fixtures__/bhe-vta-*`). **Não existe captura real de NE8000/NE40E.** As sintaxes `CANDIDATE` são plausíveis, **não comprovadas** — podem diferir por versão (`display mac-address` por VSI, p.ex., varia entre linhas VRP).

## 5. Configuração (somente na publicação futura)

Variáveis (hoje **ausentes** em produção ⇒ rotas respondem 503, nenhum coletor é criado):

```
VSI_MCP_ENABLED=true
VSI_MCP_ACCESS_FILE=/etc/netvision/vsi-mcp-profiles.json   # root, 0600
```

Perfil (um por host; sem credenciais; fingerprint real obtida do equipamento):

```json
{ "profiles": [ {
  "hostId": "host-…", "endpoint": "10.x.x.x", "port": 2222, "username": "svc-netvision",
  "context": null,
  "fingerprint": "SHA256:…43 caracteres…",
  "initialPrompt": "<NE8-IXBR>", "expectedPrompt": "<NE8-IXBR>",
  "vendor": "HUAWEI", "family": "NE8000_V800", "disablePagingTemporary": true,
  "validFrom": "2026-11-10T00:00:00.000Z", "expiresAt": "2026-12-10T00:00:00.000Z",
  "operations": ["VERSION","VSI_VERBOSE","INTERFACE_CONFIG","INTERFACE_STATE","VSI_MAC"],
  "maxInterfaces": 8 } ] }
```

Fingerprint (somente leitura): `ssh-keyscan -p <porta> <ip> | ssh-keygen -lf - -E sha256`.
`context` deve ser **idêntico** ao `sshContextCommand` do inventário (ex.: `switch virtual-system IMPLANTAR-IXBR` no NE8-IXBR); o `expectedPrompt` é o prompt **após** o contexto.

## 6. Homologação (obrigatória antes de qualquer veredito em NE8000/NE40E)

Pré-requisitos: janela combinada, perfil criado com as operações candidatas, ADMIN disponível. **Somente consultas.**

1. ADMIN cria aprovação: `POST /api/vsi-mcp/approvals {"hostId","vsiName"}`.
2. Executar `get_vsi_vlan_encapsulation`/`diagnose_vsi` com `"homologation": true` (ADMIN). Isso envia **apenas** `display …` do §4 e devolve `evidence[].excerpt` + `sha256`.
3. Para cada operação: se a saída for `Error: Unrecognized command`/`Incomplete command`, registrar o erro e **buscar a sintaxe correta no equipamento** (ex.: ajuda interativa feita por um humano) — não improvisar comando.
4. Salvar a captura **sanitizada** (sem IP/ASN/cliente sensível) em `apps/api/src/infrastructure/mpls/__fixtures__/<modelo>-<data>/`, com `metadata.json` (modelo, versão, data, comando).
5. Ajustar/validar parser com a fixture real; só então promover a célula em `platform.ts` (`CANDIDATE → HOMOLOGATED`) com a nota da fixture.
6. Re-executar sem `homologation` e confirmar o veredito; rodar a suíte.

Os ajustes prováveis: cabeçalhos de AC/PW da `display vsi … verbose` do NE (rótulos diferentes de "Interface Name/State/Peer Ip Address"), formato de `display mac-address`, e diretivas L2 de subinterface (`encapsulation dot1q vid`, `rewrite …`).

## 7. Cenários de regressão

| Cenário | O que o teste prova | O que **não** prova |
|---|---|---|
| **A — VSI `L2-PPPOE-3901`**: interface física + subinterface QinQ na mesma VSI, VSI/PW "up" | Detecta `DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE` (fato CONFIRMED, efeito PROBABLE), explica o impacto em PPPoE e registra o `caveat` ("não é inválido em todo cenário"); controle sem duplicidade não alerta; interfaces irmãs (`1/0/1` × `1/0/10.3901`) não se confundem | Que a duplicidade tenha sido a causa da falha original (hipótese) |
| **B — VLAN 50→502 NE8000×NE40E**: mapping/stacking vs. termination | Compara VLAN original×transportada, nº de tags, modo, AC, PW, labels, MAC e o último estágio com MAC; assimetria sai como **HYPOTHESIS** | Qual sintaxe real cada modelo usa; causa do problema |

Exemplos reais de request/response (gerados pelo código, teste golden): [`docs/vsi-mcp-examples/`](./vsi-mcp-examples/).

## 8. Testes

```
cd apps/api && npx vitest run src/infrastructure/mpls/vsi-mcp src/vsi-mcp-routes.test.ts   # 111 testes
cd tools/mcp-netvision && node --import tsx --test src/vsi-tools.test.ts src/server.test.ts   # 21 testes
npx eslint apps/api/src/infrastructure/mpls/vsi-mcp apps/api/src/vsi-mcp-routes*.ts tools/mcp-netvision/src --max-warnings=0
```

Não rodam neste worktree (pré-existente, não relacionado): `prisma-mpls-repository.test.ts` (exige `src/generated/prisma`, gerado por `npm run db:generate`).

## 9. Publicação futura (nada disto foi executado)

1. Revisão de código do branch; gerar Prisma client e rodar a suíte completa + `typecheck`/`lint`.
2. Liberar espaço em disco antes de criar release (88% usado).
3. Build do release a partir de `6ad9265` + este branch (mesmo padrão `cp -al`/drop-in das releases atuais), **sem** alterar drop-ins de AUTO-ALL/FAST/lease/flags/allowlist/n8n.
4. Criar `vsi-mcp-profiles.json` com os hosts **após** a homologação do §6; manter `VSI_MCP_ENABLED` ausente no primeiro deploy (ferramentas respondem 503).
5. Janela: reiniciar `netvision-api` (reinicia `netvision-mcp`, que `Requires=` a API); verificar `GET /api/vsi-mcp/status` → `enabled:false`; depois ligar a flag por drop-in próprio e verificar `enabled:true`.
6. **Rollback**: remover o drop-in da flag (volta a 503) e/ou o drop-in do release novo + `daemon-reload` + restart. Sem migrations ⇒ nenhum rollback de banco.
7. Acompanhar `app.log` (`vsi-mcp: comando somente leitura`) — um evento por comando enviado, com `operatorId` e `hostId`.

## 10. Limitações conhecidas

- Sem captura real de NE8000/NE40E (ver §4); parsers desses modelos estão validados só contra o formato esperado.
- `list_vsi` ao vivo (`display vsi`) devolve `NOT_SUPPORTED`; use `PERSISTED` ou informe o nome da VSI.
- Aprovação é consumida antes da validação de perfil/SSH (comportamento herdado do legado).
- Sem polling: o diagnóstico é sempre sob demanda.
