# Homologação em hardware — diagnóstico VSI por MCP (delta)

Branch `feature/vsi-mcp-diagnostics` · 2026-11-09 · fluxo exercitado: **MCP → API → SSH → coleta → interpretação → diagnóstico**, com aprovação ADMIN one-shot por execução, instância DEV em 127.0.0.1, somente `display`.

## 1. Execuções reais

| # | Equipamento | Ferramenta | Sessões SSH | Comandos | Resultado |
|---|---|---|---|---|---|
| 1 | BHE-VTA-F1A-BGP-01 (NetEngine 8000 F1A-8H20Q, VRP 8.220 `V800R022C00SPC600`) | `list_vsi` LIVE/LIST | 1 | `display version`, `display vsi` | autenticou, host key fixada conferida; `display vsi` aceito e **vazio** ⇒ roteador sem VSI (confirmado pelo operador: VSIs só nos switches) |
| 2 | BHE-VTA-S6750-MPLS-01 (S6750-H36C, YunShan 1.24.0.1 `V600R024C00SPC500`) | `diagnose_vsi` | 1 (sessão 2 barrada por bug) | `display version`, `display vsi name … verbose` | dados reais da VSI; **bug do intervalo mínimo** detectado e corrigido (`707ccae`) |
| 3 | idem | `diagnose_vsi` | 1 | `display version`, `display vsi name 3066-BGP-FLASHTELECOM verbose`, `display current-configuration interface Vlanif3064`, `…Vlanif3066`, `display mac-address vsi 3066-BGP-FLASHTELECOM` | todos aceitos, completos, sem erro de CLI |

Nenhuma configuração, banco produtivo, serviço ou AUTO-ALL foi alterado. Não houve SSH após o consumo de cada aprovação.

## 2. Circuito FAST Telecom — VSI `3066-BGP-FLASHTELECOM` (S6750)

**Comprovado por saída do equipamento** (evidências com `sha256`):
- VSI **up**, sinalização BGP, encapsulamento `vlan`, MTU 1500, RD `268568:3066`, criada há ~13 d.
- **AC único**: `Vlanif3066`, up, desbloqueado. Config: `description 3066-BGP-FLASHTELECOM` + `l2 binding vsi 3066-BGP-FLASHTELECOM` ⇒ **binding efetivo coerente**.
- **PW**: peer `10.100.101.6` (= RNS-FLOR-6730-MPLS-01, cadastro), up desde 2026/11/08 05:59:47, LDP, labels local 1016797 / remoto 36464; `Mac Flapping 0`.
- **Labels cruzados**: o registro SNMP de RNS-FLOR traz entrada 36464 / saída 1016797 ⇒ correspondência exata (dado do outro lado é *persistido*, não ao vivo).
- **MAC da VSI** (consulta restrita à VSI): 2 MACs dinâmicos, aprendidos em `Eth-Trunk1` e `Eth-Trunk6`; nenhum via PW.
- **Divergência banco × equipamento**: o NetVision tem `Vlanif3064` como AC da VSI 3066; o switch **não** a lista e `Vlanif3064` faz `l2 binding vsi 3064-PONTUALNET-IP-BHE-MQT`. O banco tem duas linhas para essa interface: a da VSI 3066 (última leitura 2026-09-15 07:43) e a da VSI 3064 (criada 07:56 do mesmo dia, atualizada hoje). **Classificação: registro obsoleto** — fato confirmado pelo equipamento; causa "interface movida de VSI e linha antiga não removida" é *provável* (linha do tempo do banco), não provada.

**Não comprovado / hipótese:**
- Encapsulamento/VLAN: o AC é VLANIF (VLAN 3066 pelo número). **Quais portas carregam a VLAN 3066 e com que tagging não foi consultado** (exigiria `display vlan 3066` e a config de `Eth-Trunk1/6`, fora do escopo aprovado).
- Ausência de MAC via PW: observação pontual; não indica falha. O significado exato da coluna `Age` (131 161 s) não foi validado.
- Tráfego real (contadores) e o estado ao vivo do lado RNS-FLOR não foram medidos.

**Veredito do motor (após correção): `INCONCLUSIVE`** — VSI_STATE, AC_STATE, PW_STATE, AC_BINDING e MAC_LEARNING = OK; ENCAPSULATION = NOT_EVALUATED. Sem WARNING/CRITICAL.

## 3. Esperado × real (auditoria do motor)

| Item | Esperado | Real (1ª leitura do motor) | Ação |
|---|---|---|---|
| Veredito geral | não declarar saúde sem avaliar encapsulamento | `OK` | **Defeito.** Agora `INCONCLUSIVE` + `dimensions` por eixo |
| Vlanif3064 | usar a config coletada para classificar o registro | só "diverge" (hipótese) | **Defeito.** Novo `PERSISTED_AC_OBSOLETE` (fato CONFIRMED, efeito PROBABLE) quando a config prova binding em outra VSI; sem a config permanece hipótese |
| Total do MAC | reconhecer `Total items: 2` | regex só aceitava `Total items displayed =` | **Defeito.** Corrigido; divergência de total ⇒ incompleto |
| 2ª sessão da mesma chamada | executar | `BUSY` (intervalo mínimo) | **Defeito.** `pace` espera o intervalo |
| Banner do NE8000 | reconhecer `NetEngine 8000` | `UNKNOWN` (só procurava `NE8000`) | **Defeito.** Corrigido |
| Timeout MCP→API | ≥ prazo da API | 30 s < 90 s | **Defeito.** 120 s nas ferramentas VSI |
| Falta de MAC | não é falha de tráfego | era WARNING | Agora INFO/HYPOTHESIS |

## 4. Matriz por modelo/versão

`H` = homologado com captura real · `C` = candidato (sintaxe plausível, **sem** captura; só `homologation=true`) · `—` = não suportado.

| Operação (comando) | S6750-H36C YunShan `V600R024C00SPC500` | S6730 `V200R021/R022` | NE8000 F1A-8H20Q `V800R022C00SPC600` | NE40E |
|---|---|---|---|---|
| `display version` | H | H¹ | H | C |
| `display vsi` (lista) | C | C | **H (só caso vazio)**² | C |
| `display vsi name X verbose` | H | H¹ | C (nenhuma VSI no roteador) | C |
| `display mac-address vsi X` | **H** (colunas MAC / VLAN-VSI-BD / Learned-From / Type / Age; `Total items: N`) | C | C | C |
| `display current-configuration interface X` | **H só Vlanif** (sem dot1q/qinq/trunk) | C | C | C |
| `display interface X` | H¹ | H¹ | C | C |

¹ captura anterior (fixtures `bhe-vta-*`, 2026-10-22) · ² formato com VSIs nunca observado: o parser devolve `INCONCLUSIVE`.

### Ferramentas suportadas (hoje)

| Ferramenta | S6750 YunShan | S6730 | NE8000 | NE40E |
|---|---|---|---|---|
| `list_vsi` PERSISTED | sim (SNMP) | sim | sem dados (sem SNMP VPLS) | idem |
| `list_vsi` LIVE | só version; lista = candidato | idem | **sim, retorna lista vazia** | NOT_SUPPORTED |
| `get_vsi_details` / `get_vsi_pseudowires` LIVE | **sim** | sim | candidato | NOT_SUPPORTED |
| `get_vsi_ac_bindings` | **sim para ACs Vlanif** (binding + obsolescência) | parcial (config candidata) | candidato | — |
| `get_vsi_mac_table` | **sim** | candidato | candidato | — |
| `get_vsi_vlan_encapsulation` | **parcial**: Vlanif sem diretivas ⇒ `NOT_EVALUATED`; dot1q/qinq/trunk nunca observados | candidato | candidato | — |
| `diagnose_vsi` | **sim, com `INCONCLUSIVE` enquanto encapsulamento não for avaliado** | parcial | não | não |
| `compare_vsi_endpoints` | **não homologado** (nunca rodou nas duas pontas ao vivo) | idem | idem | idem |

## 5. Limitações e riscos

- O motor **não prova encapsulamento/VLAN** para ACs VLANIF; para ACs de subinterface (dot1q/qinq/rewrite) o parser existe, mas **nunca foi exercitado com saída real**. Os cenários A (binding duplicado) e B (VLAN 50→502) continuam validados só com fixtures sintéticas.
- Uma única VSI e um único switch por família: não há ainda amostra para generalizar.
- `compare_vsi_endpoints` exige duas aprovações e duas sessões; não executado em hardware.
- **Persistência do NetVision retém ACs obsoletos**: só neste switch são **159 linhas de AC com última leitura anterior a 2026-11-01, em 157 VSIs**. Achado fora do escopo deste branch (coleta SNMP em produção); recomendável tratar à parte.
- Aprovação é consumida antes de validar perfil/SSH (herdado): falha de infraestrutura exige nova aprovação.
- A credencial SSH foi lida de arquivo local do DEV (não do cofre) para não carregar chave/DB de produção no processo.

## 6. Para confiar no diagnóstico (próximos passos mínimos)

1. Homologar `display vlan <id>` e `display current-configuration interface Eth-Trunk<N>` (S-series) para avaliar VLAN/tagging de ACs VLANIF.
2. Capturar um AC de **subinterface** real (dot1q/qinq) para validar `parseInterfaceConfig` e as regras A/B com saída real.
3. Executar `compare_vsi_endpoints` S6750 × RNS-FLOR (duas aprovações) para validar o cruzamento ao vivo.
4. Homologar NE40E/NE8000 em uma VSI real quando existir (nenhum dos roteadores atuais tem VSI).
5. Revisão de segurança final (§ parecer de escopo/isolamento) antes de qualquer merge.
