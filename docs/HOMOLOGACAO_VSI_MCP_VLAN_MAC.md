# Preparação da homologação VLAN/encapsulamento + aprendizado MAC (delta)

Branch `feature/vsi-mcp-diagnostics` · 2026-11-09 · **nenhum SSH executado nesta etapa**. A execução física depende de uma NOVA aprovação ADMIN one-shot.

## 1. Cobertura do aprendizado MAC (`display mac-address vsi <VSI>`)

O coletor e o parser já existiam e estão homologados no S6750 (YunShan V600R024C00SPC500). Antes desta etapa o motor consumia da tabela apenas **contagem por lado (AC/PW)** e ignorava tipo, idade, escopo da VSI e o contador de flapping do PW.

| Pedido | Antes | Agora |
|---|---|---|
| 1. Quantidade de MACs | só `viaAc`/`viaPw` | `macSummary.total`, `declaredTotal`, `viaAc`, `viaPw` |
| 2. MAC, tipo, interface | MAC/interface/`type` bruto | + `typeClass` (DYNAMIC/STATIC/BLACKHOLE/OTHER), `ageSeconds`, flag `*`/`#`, resumo por interface e por tipo, idade máx./mín. |
| 3. Local × remoto | `side` AC/PW | mantido **sem inventar**: `side` reflete só o campo Learned-From (interface vs. peer). Não existe campo "local/remoto" |
| 4. Inconsistência MAC × AC × PW | só `NO_MAC_FROM_AC/PW` | + `MAC_LEARNED_ON_NON_AC_INTERFACE` (só quando o AC não é Vlanif), `MAC_DUPLICATE_IN_TABLE`, `MAC_BLACKHOLE_PRESENT` (WARNING), `MAC_NON_DYNAMIC_PRESENT` |
| 5. MAC flapping | não lido | `Mac Flapping` do PW é parseado (`null` se ausente, nunca 0 inventado); `> 0` ⇒ `MAC_FLAPPING_REPORTED` (WARNING; fato confirmado, efeito provável) e dimensão `MAC_LEARNING = ISSUE` |
| 6. Comparação entre coletas | — | **Não implementada de propósito**: não há histórico confiável persistido. `macSummary.history = 'NOT_AVAILABLE'` e `notVerified` declara que cada diagnóstico é uma fotografia |

Regras preservadas: ausência de MAC (AC ou PW) continua INFO/HYPOTHESIS; MAC aprendido nunca prova fim a fim (`notVerified`); a consulta é sempre `display mac-address vsi <VSI>` — **linhas de outra VSI invalidam a tabela** (`OUT_OF_SCOPE`); total declarado ≠ linhas ⇒ `MAC_TABLE_INCOMPLETE` (truncamento sinalizado, nunca OK); limite de saída de 128 KiB inalterado.

Testes sobre a captura real do S6750: `vlan-mac.test.ts` (campos por entrada, resumo, flapping 0 real e 7 simulado, escopo, truncamento, tipos, duplicata, Vlanif × subinterface).

## 2. Próxima consulta: VLAN 3066 e Eth-Trunks (preparada, não executada)

**Alvo**: `BHE-VTA-S6750-MPLS-01` (hostId `host-f995bc3c-1ffa-4f1b-adf5-ffb0578528b4`), VSI `3066-BGP-FLASHTELECOM`, VLAN 3066, Eth-Trunk1 e Eth-Trunk6.

### Comandos exatos (1 sessão SSH)

| # | Comando | Situação na matriz S6750 YunShan V600R024C00SPC500 |
|---|---|---|
| 0 | `screen-length 0 temporary` (preparação existente) | já usado |
| 1 | `display version` | homologado (confirma a família; divergência aborta) |
| 2 | `display vsi name 3066-BGP-FLASHTELECOM verbose` | homologado |
| 3 | `display current-configuration interface Vlanif3064` | homologado (só Vlanif) |
| 4 | `display current-configuration interface Vlanif3066` | homologado (só Vlanif) |
| 5 | `display vlan 3066` | **CANDIDATO** (sintaxe VRP padrão; exige `homologation=true`) |
| 6 | `display current-configuration interface Eth-Trunk1` | **config de trunk ainda sem captura**; operação homologada só para Vlanif |
| 7 | `display current-configuration interface Eth-Trunk6` | idem |
| 8 | `display mac-address vsi 3066-BGP-FLASHTELECOM` | homologado (por último, como sempre) |

**Compatibilidade — confirmada o quê e o quê não:** a sintaxe de 5–7 é a do VRP padrão e a família já aceitou os demais `display` equivalentes, mas **não foi confirmada por captura** no YunShan V600R024C00SPC500. O formato de saída de `display vlan` (colunas, marcadores `TG:`/`UT:`, linha de status) pode diferir. O parser foi escrito para falhar de forma conservadora: sem a linha da VLAN na tabela `VID Type Ports` devolve `complete=false` e o motor mantém `ENCAPSULATION=NOT_EVALUATED` (INCONCLUSIVE). Se o formato divergir, a captura bruta vira fixture real e o parser é corrigido sem nova sessão SSH.

Chamada prevista (todas as `interfaces` explícitas evitam uma 2ª sessão):
```
diagnose_vsi { hostId, vsiName:"3066-BGP-FLASHTELECOM", approvalId:<NOVO>, includeMac:true,
               interfaces:["Vlanif3064","Vlanif3066"], vlanId:3066,
               carrierInterfaces:["Eth-Trunk1","Eth-Trunk6"], homologation:true }
```
Limites: 1 sessão, ≤ 45 s/sessão, ≤ 12 s/comando, ≤ 128 KiB/saída, 8 comandos de consulta (teto 14). Se algum comando falhar, os seguintes ainda rodam (o MAC é o último) e **não há segunda tentativa sem nova aprovação**.

### Validação de segurança (testes em `vlan-mac.test.ts`)

- **Allowlist** `^display vlan <1..4094>$`: bloqueados `display vlan`, `… all`, `… verbose`, `… 3066 to 3070`, `… 0`, `… 4095`, zero à esquerda, `;`/`|`/quebra de linha, espaço duplo. VLAN fora de 1–4094 não vira comando.
- **Escopo fechado por host, no perfil** (`/etc/netvision/…` no produto; `~/vsi-dev/profiles.json` no DEV): novos campos `vlans` (lista de VLANs consultáveis) e `carrierInterfaces` (interfaces NÃO-AC legíveis). VLAN ou interface transportadora fora da lista ⇒ `OPERATION_NOT_AUTHORIZED` **antes** de abrir SSH (teste confirma 0 comandos enviados). Padrão `[]`: nada é permitido sem inclusão explícita.
- Interface arbitrária continua impossível: mesmo guard, só `display current-configuration interface <nome válido>`; `display current-configuration` sem interface e com `| include` são bloqueados.
- A aprovação one-shot continua `vsi-name:3066-BGP-FLASHTELECOM` + hostId; **o escopo de VLAN/trunks não vai na aprovação, vai no perfil do host** (a aprovação não é ampliada).
- `VLAN_INFO` entra como CANDIDATO em todas as famílias e NOT_SUPPORTED em UNKNOWN; sem `homologation=true` é negado.

### Perfil DEV a alterar (somente quando você confirmar; ainda NÃO aplicado)
```
"operations": [... , "VLAN_INFO"],
"vlans": [3066],
"carrierInterfaces": ["Eth-Trunk1", "Eth-Trunk6"]
```
e sincronizar o bundle DEV (`tools/vsi-dev`) com este commit.

### Escopo da nova aprovação ADMIN
`~/vsi-dev/approve.sh 3066-BGP-FLASHTELECOM` (hostId acima; one-shot; validade curta do script; não reutiliza as aprovações 8f4553e8…, 18e1e333… nem a do F1A).

### Dados sensíveis
Config de Eth-Trunk é compartilhada (descrições, membros, VLANs de outros clientes). As capturas brutas ficam só no diretório DEV (`~/vsi-dev/captures`, 0600). Antes de virar fixture no repositório: remover `description`, IPs, MACs reais e VLANs/portas que não pertençam ao serviço.

## 3. Regras do diagnóstico de encapsulamento (implementadas, testadas com texto sintético)

`ENCAPSULATION = OK` (sempre **LOCAL**) só quando: AC Vlanif único; VLAN existe e não está `disable`; a VLAN consultada é a do AC; há MAC aprendido na VSI e **todas** as portas onde foram aprendidos constam em `display vlan` com tagging conhecido, sem `ST`/`MP`; e, se a config da porta foi lida, ela não contradiz (trunk `allow-pass`, hybrid tagged/untagged, access `default vlan`).

| Situação | Resultado |
|---|---|
| sem `display vlan` | NOT_EVALUATED (como hoje) |
| formato não reconhecido / outra VLAN | `VLAN_OUTPUT_INCOMPLETE` / `VLAN_AC_NUMBER_MISMATCH` (INCONCLUSIVE) |
| VLAN inexistente / desabilitada | ISSUE, WARNING confirmado |
| porta com MAC fora da tabela da VLAN, config nao lida | NOT_EVALUATED |
| porta com MAC fora da VLAN e config que nao a permite, **com PW up** | `MAC_ORIGIN_UNRESOLVED` (INFO, INCONCLUSIVE): Learned-From nao distingue porta de acesso de interface de saida do tunel do PW |
| idem, **sem PW up** | `MAC_ON_PORT_OUTSIDE_VLAN` (WARNING, fato confirmado), ISSUE |
| `vlan-stacking` / `vlan-mapping` na porta | `VLAN_TRANSFORM_ON_CARRIER`, NOT_EVALUATED |
| config do trunk não permite a VLAN | `CARRIER_CONFIG_CONTRADICTS_VLAN`, ISSUE |
| nenhum MAC aprendido | NOT_EVALUATED (relação porta–serviço não comprovável) |

Relação Eth-Trunk × serviço: a evidência é **MAC aprendido na VSI naquela porta + porta listada na VLAN**. Isso comprova o caminho local; não comprova encapsulamento remoto nem conectividade fim a fim (`notVerified` sempre lista isso, e `compare_vsi_endpoints` é o instrumento da outra ponta).

## 4. Matriz (acréscimo)

| Operação | S6750 YunShan V600R024C00SPC500 | S6730 | NE8000 | NE40E |
|---|---|---|---|---|
| `display vlan <id>` | C (preparado) | C | C | C |
| `display current-configuration interface Eth-Trunk<N>` | C (hoje só Vlanif é H) | C | C | C |

## 5. Resultado da execução (2026-11-09 21:16Z, aprovação 5bcdf092…, 1 sessão, 8 comandos)

Todos os 8 `display` aceitos e completos. `display vlan` e a config de Eth-Trunk passam a **HOMOLOGADOS no S6750 YunShan V600R024C00SPC500** (modo trunk; dot1q/qinq/mapping/stacking nunca observados).

- **Formato real de `display vlan` diverge do VRP clássico**: tabela `VID Ports` (sem coluna Type) + tabela `VID Type Status Property MAC-LRN STAT BC MC UC Description`. O parser inicial (formato clássico) devolveu `VLAN_OUTPUT_INCOMPLETE` — o motor ficou INCONCLUSIVE em vez de adivinhar. Parser corrigido sobre a captura real (sem nova sessão), mantendo o formato clássico.
- **VLAN 3066**: common, enable, MAC-LRN enable, BC/MC/UC = FWD; única porta listada: `TG:Eth-Trunk1(U)`.
- **Eth-Trunk1** (trunk LACP estático): `allow-pass` inclui 3066 (faixa `3061 to 3067`).
- **Eth-Trunk6** (trunk LACP dinâmico): `allow-pass` **somente a VLAN 1602**; não consta em `display vlan 3066`.
- **MAC**: 2 dinâmicos, um em Eth-Trunk1 e um em **Eth-Trunk6** (mesmos MACs/portas da captura das 18:24Z; `Age` avançou 10 309 s = tempo decorrido ⇒ `Age` = segundos desde o aprendizado, validado por duas capturas reais).
- **Veredito do motor em 14734e5**: `ENCAPSULATION = ISSUE`, status `WARNING`: `CARRIER_PORT_VLAN_PROVEN` (Eth-Trunk1, tagged, up, config permite) + `MAC_ON_PORT_OUTSIDE_VLAN` (Eth-Trunk6). **Revisto na seção 6: esse WARNING era um falso positivo de premissa**; o veredito atual é INCONCLUSIVE (`MAC_ORIGIN_UNRESOLVED`).
- Nunca OK sem evidência: sem a config do Eth-Trunk6 a divergência não é afirmada (NOT_EVALUATED/INCONCLUSIVE).

## 6. Investigação final do Eth-Trunk6 (2026-11-10, só capturas existentes, sem SSH)

**Comando que produziu a entrada**: `display mac-address vsi 3066-BGP-FLASHTELECOM` (8º comando da execução 3, 21:16:28Z; também o 6º da execução 2, 18:24:39Z). O parser leu a linha corretamente (`f0a9-511e-… -/3066-BGP-FLASHTELECOM/- Eth-Trunk6 dynamic <Age>`): não há erro de interpretação de texto. O erro estava na **premissa do motor**: tratar todo `Learned-From` com nome de interface como porta de acesso local.

Evidências reunidas (todas das capturas já existentes):

| Evidência | Observado | Certeza |
|---|---|---|
| Eth-Trunk6 na VLAN 3066 | não consta em `display vlan 3066`; `allow-pass` só 1602; sem stacking/mapping | confirmado |
| Função do Eth-Trunk6 | `description` (removida do fixture) nomeia um LACP para outro nó MPLS (S6730); trunk `lacp-dynamic` com uma única VLAN — padrão de enlace P2P de núcleo | confirmado (descrição) / provável (função) |
| Relação temporal com o PW | relógio do equipamento ≈ UTC+69 s (derivado de `Last Up Time` + `Total Up Time` do AC vs. horário da captura). `PW Last Up Time` 2026/11/08 05:59:47 (equip.) = 05:58:38Z. MAC do Eth-Trunk1 aprendido em 05:58:38Z (Age 141470 às 21:16:28Z) e MAC do Eth-Trunk6 em 05:58:43Z (Age 141465): **0 s e +5 s após o último up do PW** | confirmado (aritmética) |
| Persistência | mesmas 2 entradas nas execuções 2 e 3 (Δ Age = Δ relógio = 10 309 s): MACs com 36–39 h de idade só persistem com tráfego contínuo (aging padrão 300 s) ou aging desabilitado (não lido) | confirmado / causa não lida |
| MACs "via PW" | nenhuma linha com peer IP em nenhuma execução, apesar de PW up há 39 h e MAC local sendo refrescado | confirmado |
| Formato YunShan para MAC aprendido por PW | não documentado nas fontes acessíveis (páginas Huawei renderizadas em JS, não legíveis por fetch); nunca observado com peer no Learned-From nesta família | **não verificado** |

Conclusão: a hipótese mais consistente com o conjunto é que a entrada do Eth-Trunk6 é o **MAC remoto recebido pelo PW**, exibido pelo YunShan com a **interface física de saída do túnel LDP** (Eth-Trunk6 → nó MPLS vizinho → peer 10.100.101.6) em vez do peer. Ela explica, de uma vez, a ausência de MAC "via PW", o aprendizado 5 s após o PW subir e o refresco contínuo. **Não está provada**: faltam a documentação do formato e a interface de saída do LSP até o peer. A hipótese de entrada residual é improvável (exigiria aging desabilitado ou tráfego da VLAN 3066 entrando por um trunk que não a permite), mas não foi excluída.

Correção aplicada ao motor (branch DEV, testes de regressão em `vlan-mac.test.ts`):
- `MAC_ORIGIN_UNRESOLVED` (INFO, INCONCLUSIVE) quando a porta está fora da VLAN, a config não a permite **e há PW up**; a entrada não conta como AC nem como PW (`macSummary.viaUnresolved`, `unresolvedOrigin`), `NO_MAC_FROM_PW` deixa de ser afirmado e `notVerified` declara a limitação. `ENCAPSULATION = NOT_EVALUATED`, status INCONCLUSIVE.
- `MAC_ON_PORT_OUTSIDE_VLAN` (WARNING) permanece quando **não há PW up** (nenhum túnel explica a entrada).
- `PW Total Up Time` passa a ser lido (`totalUpSeconds`, VRP clássico e YunShan) e `MAC_LEARNED_AT_PW_UP` (INFO) registra, na mesma sessão e sem depender de relógio, quando todos os MACs foram aprendidos até 60 s após o último up do PW. Com os fixtures locais (verbose da execução 1 e MAC da execução 2) o achado **não** é emitido; o teste usa os valores da execução 3.
- Formatos VRP clássico e YunShan preservados (testes sintéticos + fixtures reais; fixture clássico `bhe-vta-local-full-20261022` usado para `totalUpSeconds`).

Evidências que faltam (cada uma exige nova aprovação ADMIN one-shot; nenhuma foi executada):
1. `display mpls lsp include 10.100.101.6 32 verbose` (ou `display mpls ldp lsp 10.100.101.6 32`): interface de saída do LSP até o peer — se for Vlanif1602/Eth-Trunk6, a hipótese de transporte fica PROVÁVEL.
2. `display vlan 1602` e `display current-configuration interface Vlanif1602`: confirma o enlace de núcleo (IP, `mpls`/`mpls ldp`).
3. `display mac-address aging-time`: exclui ou confirma a hipótese de entrada residual.
4. Opcional: `display eth-trunk 6` (membros físicos; não altera a conclusão).
