# Visão Física de POP / Rack

## Estado

Implementação iniciada em 2026-09-21. O ZIP `0c924f57-d8af-49b8-ac19-9c78c1541c01.zip` é referência visual fornecida pelo usuário, permanece intacto e não deve entrar no Git.

| Milestone | Estado | Escopo |
| --- | --- | --- |
| 1 | COMPLETO | Schema, migration, inventário POP/rack/asset, API e testes |
| 2 | COMPLETO | Rack view e equipamento genérico |
| 3 | COMPLETO | Portas, templates e vínculo com Interface |
| 4 | COMPLETO | Conexão porta-a-porta e drawer |
| 5 | COMPLETO | DIO/patch panel e path tracing |
| 6 | COMPLETO | Cable lanes, selected-only e highlights |
| 7 | EM ANDAMENTO | Responsividade, acessibilidade e validação final |
| 8 | COMPLETO | Catálogo de equipamentos predefinido e templates do sistema |
| 9 | COMPLETO | Portas com nome real, estado visual e vínculo com Interface |
| 10 | COMPLETO | Equipamento modular com slots e placas |
| 11 | COMPLETO | Reuso do LLDP para ocupação e sugestão de conexão (sem auto-connect) |

## Estado verificado (revisão de 2026-09-21)

- Backend, shared e web já implementam os milestones 1 a 6; o que resta é acabamento e validação contínua (milestone 7).
- Migration `20260921150000_physical_pop_rack` **já foi aplicada em produção** e por isso não é editada. A migration nova (`20260921180000_physical_catalog_slots_lldp`) foi validada em PostgreSQL descartável: `migrate deploy` aplica todas as migrations e `migrate diff --from-migrations` responde `No difference detected`.
- Invariantes no banco (triggers da migration): limites/overlap de U por rack com advisory lock, proteção contra encolher rack abaixo do ocupado e liberação dos dois endpoints ao excluir um cabo.
- Correção aplicada: `PhysicalPort.connectionId` é `ON DELETE SET NULL`, mas o check `PhysicalPort_connection_pair_check` exige `connectionId` e `connectionEnd` nulos em conjunto. O FK sozinho não conseguia desocupar a porta e a exclusão (de cabo ou de porta) falhava com violação do check. Foi adicionado o trigger `PhysicalConnection_detach_endpoints` (BEFORE DELETE) que libera as duas colunas antes da remoção da linha do cabo.
- Cobertura de testes do módulo: `physical-routes.test.ts` (POP/rack/asset/portas, U inválido, limites, overlap, ocupação, self-link, FRONT/REAR, path tracing, loop, guards de exclusão, sync de interfaces, RBAC VIEWER), `physical-schema.test.ts` (schema/migration/triggers) e `physical-rack-canvas.test.tsx` (posição proporcional e modo selecionado).
- As asserções de schema são insensíveis a espaçamento (regex), porque `prisma format` realinha colunas.

## Arquitetura escolhida

- `PhysicalSite` é uma entidade estruturada nova porque `Device.site` é texto livre. O campo legado não é alterado nem usado como chave.
- `PhysicalAsset` pode referenciar um `Device` real (no máximo um asset por Device) ou existir como item genérico/passivo.
- `PhysicalPort` tem identidade própria e pode referenciar uma `Interface` real por ID; a telemetria continua pertencendo a `Interface`.
- DIO e patch panel usam portas `FRONT` e `REAR` pareadas por `pairedPortId`. Cada terminação continua aceitando no máximo um cabo externo.
- `PhysicalConnection` guarda dois endpoints canônicos e exclusivos. Restrições de banco e validações de domínio impedem self-link, duplicação e ocupação múltipla.
- RBAC: leitura segue a autenticação global; escrita é permitida a `ADMIN` e `OPERATOR`, e negada a `VIEWER`.
- Produção usa Prisma/PostgreSQL; testes e `DEMO_MODE` usam repositório em memória, sem inserir fixtures físicas no runtime.

## Referência Magic Patterns

### A. Conceitos aproveitados diretamente

- rack proporcional por U, numeração bilateral e equipamento como faceplate;
- seleção separada de equipamento, porta e cabo;
- drawer contextual e modo de conexões `Ocultas / Selecionado / Todas`;
- cabos ortogonais saindo para uma calha lateral, com baixa opacidade por padrão;
- realce violeta do caminho selecionado e redução visual dos demais itens.

### B. Conceitos adaptados

- os dispositivos, interfaces, permissões e telemetria vêm das entidades reais do NetVision;
- status de porta é contexto da `Interface` vinculada, não estado físico inventado;
- passagem de DIO/patch panel é persistida como duas portas pareadas, em vez de uma cadeia mock;
- altura e portas genéricas são dados persistidos, não templates locais do browser.

### C. Elementos que não serão copiados

- POPs, racks, equipamentos, circuitos e conexões fictícios;
- templates/numerações Huawei ou Datacom sem fonte confirmada;
- arquitetura React/Vite, stores locais e arquivos de dados mock do protótipo;
- status `connected/degraded/down` armazenado no cabo sem uma fonte real.

### D. Limitações resolvidas no produto

- persistência, concorrência e validação transacional;
- racks com quantidade de U configurável e validação de overlap;
- identidade estável para Device/Interface;
- ocupação exclusiva de cada terminação e passagem passiva explícita;
- rastreamento com detecção de loops;
- permissões e estados de carregamento/erro/vazio.

## Entidades planejadas

- `PhysicalSite`
- `PhysicalRack`
- `PhysicalEquipmentTemplate`
- `PhysicalTemplatePort`
- `PhysicalAsset`
- `PhysicalPort`
- `PhysicalConnection`

## Evolução DCIM (catálogo, modular e LLDP)

O módulo físico deixou de ser um desenho de rack e passou a ser um DCIM, **sem arquitetura paralela**: as
entidades acima continuam sendo as mesmas, com campos e tabelas novas ligadas a elas.

### Catálogo predefinido

- `PhysicalEquipmentTemplate` ganhou `catalogKey` (único), `category`, `family`, `structureConfirmed`, `referenceUrl` e `origin` (`SYSTEM` | `CUSTOM`).
- **A fonte de verdade é o arquivo `apps/api/catalog/physical-catalog-v1.yaml`** (schemaVersion 1.0, conteúdo V1.1): 121 templates de equipamento, 5 templates de placa, 1.480 conectores e 153 slots. O catálogo embutido em `physical-catalog.ts` é apenas o fallback para quando o arquivo **não existe**. Regras aplicadas:
  - `vendorVerified: true` **apenas** quando estrutura e modelo vieram da fonte oficial listada em `sources[]` (90 templates + as 5 placas verificadas; 31 seguem pendentes);
  - `structureConfirmed: false` mantém portas e slots vazios: o formulário pede os dados reais em vez de inventar;
  - templates genéricos (`generic-*`) são definicionais (patch panel tem canais, servidor 1U tem 1U) e nunca alegam ser um modelo de fabricante.
- `POST /api/physical/catalog/bootstrap` sincroniza os templates `SYSTEM` por `catalogKey`: idempotente, nunca duplica e nunca sobrescreve `CUSTOM`. Em produção o bootstrap roda no `onReady` da API.
- `GET /api/physical/catalog` devolve o catálogo atual com a estrutura conhecida.

### Nome real das portas

- O template fornece a estrutura (prefixo, contagem, tipo, lado); o **nome exato** vem do inventário `Device`/`Interface` (sync) ou de ajuste manual — nenhum nome RouterOS/VRP é inventado.
- `PhysicalPort.role` registra a origem da porta: `TEMPLATE` (template), `DISCOVERED` (sync de interface) e `MANUAL`.
- `PhysicalPort.state` é derivado: `FREE`, `MAPPED` (interface vinculada), `LLDP_DETECTED` (vizinho visto pelo LLDP) e `CONNECTED` (cabo persistido). `operStatus` continua sendo dado da `Interface`, exibido em separado.

### Equipamento modular

- Modelos novos: `PhysicalSlot`, `PhysicalModule` e `PhysicalTemplateSlotModule`; o template declara slots (`PhysicalTemplateSlot`), placas (`PhysicalModuleTemplate`, com `catalogKey` e `slotsRequired`) e as portas de cada placa (`PhysicalModuleTemplatePort`).
- A instalação de placa valida o que o slot aceita (`moduleKeys`); sem correspondência a API responde 409 em vez de adivinhar fabricante. Placa genérica só entra quando informada manualmente.
- A remoção de placa é bloqueada quando alguma porta possui cabo ou vínculo com `Interface`.

### Reuso do LLDP

- Nenhum motor de descoberta novo: o pipeline LLDP existente (`TopologyPreviewService`) grava um **snapshot** em `PhysicalLldpAdjacency` através de `PhysicalService.recordLldpPreview`, chamado nos endpoints `/api/topology/lldp/discover` e `/api/hosts/:hostId/lldp/discover`.
- `GET /api/physical/lldp` converte o snapshot em sugestões: `READY` (os dois lados mapeados), `PARTIAL` (um lado) e `UNRESOLVED` (correlação ambígua ou frágil).
- `POST /api/physical/lldp/:id/confirm` só aceita sugestão `READY` e **somente** por ação humana; o serviço recusa explicitamente `origin: 'AUTO'` (`isAutoConfirmEnabled()` permanece `false`).

### API adicionada

- `GET/POST /api/physical/catalog`, `GET /api/physical/lldp`, `POST /api/physical/lldp/:id/confirm`
- `PATCH /api/physical/ports/:id`, `POST /api/physical/assets/:id/modules`, `DELETE /api/physical/modules/:id`
- `POST /api/physical/racks/:id/assets` aceita `catalogKey` e `applyTemplate`; template confirmado é a fonte de verdade da altura.
- `POST /api/physical/assets/:id/reconcile-ports` remove conectores criados para interfaces lógicas (nunca toca porta com cabo, porta de template nem porta manual com nome físico).

### Catálogo versionado em arquivo (`physical-catalog-v1.yaml`)

- Caminhos procurados: `PHYSICAL_CATALOG_YAML_PATH` → `apps/api/catalog/physical-catalog-v1.yaml` → `catalog/physical-catalog-v1.yaml` (relativos ao diretório de trabalho; em produção o `WorkingDirectory` é a raiz do projeto).
- **Sem merge**: arquivo presente e válido ⇒ `source: "yaml"` e o catálogo do YAML é o único carregado (nada da lista embutida é mantido).
- Arquivo presente e **inválido** ⇒ `source: "invalid"` com a lista de `errors`; o bootstrap responde com `PhysicalCatalogError` e o `onReady` registra o motivo em nível de erro. Não existe fallback silencioso: o operador precisa corrigir o arquivo.
- Arquivo **ausente** ⇒ `source: "builtin"` com warning; apenas nesse caso o catálogo embutido entra.
- Erros de schema/migration pendente continuam tratados como aviso (a API sobe e tenta de novo), mas erro de YAML, `catalogKey` duplicado, falha de Zod ou erro de programação aparecem claramente no log.
- O esquema (portas explícitas e em grupo, slots, placas), a política de falha, as regras de tradução (expansão de `{n}`/`{n+K}`, `heightU` fracionário, `unsupportedFields`) e as regras de conteúdo estão documentados em `apps/api/catalog/README.md`.

### Breakout (QSFP/QSFP28/QSFP56/QSFP-DD)

- O cage é **um** conector físico: as lanes `qsfp28-1-1..4` e `et-0/0/0:0..3` colapsam em `qsfp28-1` / `et-0/0/0` — nunca quatro portas.
- A primeira lane vincula o cage; as demais encontram o cage ocupado e são ignoradas (SKIP), em qualquer ordem de `ifIndex`, e o segundo sync não cria nem rouba vínculo.
- Em modo 1x100G uma lane isolada ainda mapeia para o cage existente do template.
- `.` continua sendo sub-interface lógica (`.100`), nunca lane: apenas `:` e o sufixo `-N` de canal são tratados como breakout.

### Classificação PHYSICAL x LOGICAL

- `packages/shared/src/physical-interface.ts` classifica o nome da interface: sub-interface (`.100`) e canal de breakout (`et-0/0/0:0`) são **logical**; `ether1`, `sfp-sfpplus1`, `sfp28-1`, `qsfp28-*`, `ge-/xe-/et-0/0/0`, `Gi/GE/TenGigabitEthernet/XGigabitEthernet` são candidatos **physical**; VLAN, bridge, bonding, eoip, pppoe, wireguard, vrrp, irb, lo, ae, trunk, tunnel e afins são **logical**; o resto é **unknown**.
- O sync nunca cria conector para `logical` (fora do cage de breakout) nem para `unknown`; `physical` mapeia a porta existente ou cria uma (`DISCOVERED`) **somente quando o template não é de fabricante**. Template de fabricante é autoritativo: o sync apenas mapeia o painel declarado, nunca cria conexões extras nem `UNKNOWN`.
- A reconciliação (`POST /api/physical/assets/:id/reconcile-ports`) remove somente portas `DISCOVERED`, sem cabo, sem pareamento FRONT/REAR e sem `templatePortId`, cujo nome/interface é lógico **e** que não representam o cage de um breakout. `MANUAL`, `TEMPLATE` e `UNKNOWN` nunca são removidos automaticamente.
- Interfaces que já possuem porta continuam vinculadas (o sync é idempotente) e portas de template/manual são preservadas.

### UI

- Modal de equipamento reescrito: `Categoria → Fabricante → Modelo/template → Device → Nome → Start U`, com resumo do template, selo `VERIFICADO NO FABRICANTE` / `TEMPLATE GENÉRICO` / `ESTRUTURA NÃO CONFIRMADA` e campos manuais quando o dado não foi confirmado.
- Canvas desenha slots, placa instalada e portas da placa; portas ganham estado visual (`LIVRE`, `MAPEADA`, `LLDP`, `CONECTADA`) e marcador de vizinho LLDP.
- **Faceplate realista (geometria visual separada da ocupação física)**: a régua continua marcando cada U e `startU`/`heightU` persistidos não mudam — uma U pode ser desenhada mais alta para caber o painel. A geometria vem do catálogo (`panelLayout`/`visual`, unidades de grade normalizadas, nunca pixels) e, sem ela, de um fallback determinístico. Todas as portas são desenhadas (nenhum `+N`), com tamanho por família de conector (SFP < QSFP < QSFP-DD; RJ45, PON e console próprios), e o cabo é ancorado no centro do conector realmente desenhado.
- Inspetor: lista de slots com instalar/remover placa, vínculo com `Interface`, observações da porta, vizinho LLDP, painel de sugestões com o botão “Confirmar conexão física” (apenas `READY`), aviso de conectores lógicos com ação **Reconciliar portas lógicas** e exclusão de equipamento em dois passos.
- Avisos da barra superior têm três níveis (`error`, `warning`, `info`): uma falha de sync depois de criar o equipamento aparece como aviso, com o equipamento já selecionado — a criação nunca é repetida.
- Legenda de estados na barra superior e contador de adjacências LLDP do snapshot.

## Arquivos principais

- `apps/api/prisma/schema.prisma` e migration física
- `apps/api/src/physical-routes.ts`
- `apps/api/src/infrastructure/physical/*`
- `packages/shared/src/physical.ts`
- `apps/web/src/components/physical/*`
- `apps/web/src/lib/api.ts`

## Handoff

- `20260921150000_physical_pop_rack` **já aplicada em produção**: não editar nem reaplicar.
- `20260921180000_physical_catalog_slots_lldp` criada e **não aplicada**; validada em PostgreSQL descartável (apply + zero drift). Nenhum banco de produção foi tocado nesta etapa.
- Commit `93baa7c` (autor: Guilherme, 2026-09-21 10:43 -0300) incluiu, além do trabalho BGP, a fatia inicial deste módulo físico, o ZIP de referência `0c924f57-d8af-49b8-ac19-9c78c1541c01.zip` e os arquivos `flash-*.diff/txt` que estavam no diretório de trabalho. Nada foi removido nem reescrito.
- Continuação do módulo (UI física, catálogo, slots/placas, LLDP, testes e ajustes) permanece **somente no working tree**, sem commit.
- Próximo passo recomendado: aplicar a migration nova em ambiente de desenvolvimento, rodar `POST /api/physical/catalog/bootstrap` e validar a view Físico com um POP real.

## Visão técnica — linguagem visual e Slot Lab (2026-09-23)

Porte **apenas visual** do protótipo de referência para a visão `Técnica` que já existia. Nenhum
dado do protótipo entra no NetVision: sem catálogo paralelo, sem migration, sem tabela nova. A
cadeia continua `CATALOG → PhysicalAsset → PhysicalSlot → PhysicalModule → PhysicalPort → Cable
Anchor`.

**Referência visual correta (2ª passada):** `af7c2169-d46a-4acd-9994-df36b5570c01.zip`
(protótipo Vite com `EquipmentChassis`, `Slot`, `ModuleShell`, `BlankPanel`, `LineCard`,
`OLTServiceBoard`, `ControlModule`, `PowerModule`, `FanModule`, `Port`, `StatusLeds`, `FanGlyph`,
`useSlotConfigurator`, `ModulePalette`, `SlotInspector`, `SlotPrototype`; paleta `nv-*` +
`CATEGORY_COLORS`/`PORT_COLORS`). O ZIP anterior (`0c924f57-…`, protótipo de rack) foi **descartado
como referência desta etapa** — continua valendo apenas como referência histórica das fases
milestone 5/6.

Aparência aproveitada/adaptada na 2ª passada (tudo em `TECHNICAL`; `REAL` intacto):

- **Paleta `nv`/categorias**: tokens CSS `--tech-nv-*`, `--tech-cat-*` e `--tech-port-*`; chassi com
  interior rebaixado + moldura de bezel, cabeçalho com marca HUAWEI, LEDs rotulados PWR/ALM/ACT,
  chip de `heightU` e resumo de papéis do chassi (`4 serviço/uplink · 1 controle`).
- **`ModuleShell`**: cada placa ganha moldura na cor da categoria, bloco de código (part number) +
  nome da placa, LEDs por tipo (RUN/ACT/ALM, PWR, FAN) e ejetores desenhados **só onde a placa tem
  folga** no slot (`slack` calculado da própria colocação). É camada `inset: 0` sem interação —
  as portas continuam filhas diretas do contêiner e a geometria/âncora seguem iguais.
- **`BlankPanel`**: fundo `#141d29`, parafusos nas pontas e fendas de ventilação (padrão repetido,
  girado no slot vertical); código do papel no centro.
- **`Port`/`PortGroup`**: cor por família (`--tech-port-sfp|sfp28|qsfp|qsfpdd|pon|rj45`) com caixa
  interna, trava do RJ45, divisória do QSFP e núcleo óptico no PON/XGS-PON. `PhysicalPortShape`
  continua dono de posição, clique, seleção, LLDP, estado e âncora.
- **`Slot`/`useSlotConfigurator`/`ModulePalette`/`SlotInspector` (só no LAB)**: paleta de módulos
  agrupada por categoria (com selo de slots compatíveis), fluxo **armar → clicar no slot**, realce
  `is-fit-ok` ("✓ Encaixa") e `is-fit-bad` ("Incompatível" + motivo), botão **×** para remover a
  placa, inspector do slot (papel, moduleKeys declarados, ocupante) e bloco "não suportados neste
  chassi". Tudo em `useState` local, sem API/persistência.

Mantidos sem alteração: `slotInnerBox()`, `modulePanelPlacementInSlot()`, `modulePortAnchorPx()`,
`PhysicalSlot`/`PhysicalModule`/`PhysicalPort`, orientação pelo mapa (X2/X7/M4 horizontal;
X15/X17/M8 vertical) e a pendência **NE40E-M2K-B**.

- **Portas**: o desenho continua vindo de `CONNECTOR_SHAPES`/`PhysicalPortShape` (mesma geometria
  para clique, seleção, LLDP, estado e âncora do cabo). O que mudou é só a aparência na visão
  técnica (jaula RJ45 com trava, bore central em SFP/SFP+/SFP28, jaula dupla em QSFP, console/MGMT
  discretos, PON como receptáculo óptico — nunca RJ45).
- **Orientação do slot**: derivada do **bbox do mapa** (`slotOrientation` em
  `modular-chassis-map.ts`), nunca da imagem. MA5800-X2/X7 e NE8000 M4 = placas horizontais;
  MA5800-X15/X17 e NE8000 M8/NE40E = placas verticais, desenhadas com rotação de 90°
  (`modulePanelPlacementInSlot`), com alongamento limitado do eixo curto
  (`VERTICAL_BOARD_MAX_STRETCH = 2.5`) para a porta continuar legível/clicável.
- **Uma única matemática**: desenho e âncora usam a mesma colocação — `slotInnerBox` →
  `modulePanelPlacementInSlot` → `modulePortAnchorPx`. Com a placa girada, a âncora é
  `(origemX − v, origemY + u)`, exatamente a mesma transformação do CSS `rotate(90deg)` com
  `transform-origin: 0 0`; o teste de bancada confere a igualdade (≤ 2px) entre o centro do
  conector desenhado e o início do cabo.
- **Módulos**: `TechnicalBlankPanel` é só representação visual (slot vazio com papel e
  `compatível: …` quando o catálogo declara `moduleKeys`). Placa instalada usa as portas do
  `moduleTemplate`; placa sem mapa frontal mostra a nota "Mapa frontal não disponível" e **nunca**
  inventa conector. `slotRoleAccent()` continua sendo a taxonomia de cor (serviço/uplink azul,
  controle roxo, fabric âmbar, energia verde, ventilação neutro).
- **Slot Lab** (`/physical/rack-lab`, seção `MODULAR SLOT LAB`): bancada **dev** com estado local
  (`useState`, nada persiste) para escolher chassi (NE8000 M4/M8-DC/M8-AC e MA5800 X2/X7/X15/X17),
  inserir/remover placa compatível, ver a recusa de incompatível com motivo, e os toggles
  `Mostrar slots`, `Mostrar bbox`, `Mostrar port anchors` e `Mostrar moduleKeys`. Os módulos da
  bancada usam os `partNumber` reais (`H802GPFD`, `H803XGS`, `H901MPSC`, `H902MPLA`,
  `PAC600S12-CB`) e as portas vêm dos mapas de painel já existentes.
- **Modo real intacto**: fotografia, hitboxes por imagem e alturas continuam iguais; a rotação e o
  desenho seco valem só em `TECHNICAL`.

### Pendência — NE40E-M2K-B

- O catálogo atual **não possui** `catalogKey` exato para `NE40E-M2K-B` (existem as variantes
  X3-DC/X3-AC/X3A/X8/X8A/X16/X16A). Nada foi criado a partir do protótipo: **sem catalog entry
  inventado, sem slots inventados, sem `heightU` estimado**.
- O renderer já está preparado para recebê-lo (basta um template `MODULAR` no YAML com
  `slotGroups` + mapa correspondente em `huawei-modular-slot-maps-v1.json`): a orientação, o
  encaixe, as portas e as âncoras saem dos dados, não de código específico de modelo.
- **Etapa separada** (catálogo/verificação com documentação de fabricante) deve decidir: `heightU`
  exato, quantidade/ordinal dos slots (MPU/LPU), `moduleKeys` compatíveis e mapa de bbox aprovado.

### Limitações conhecidas (declaradas pelo próprio catálogo)

- M4/M8/NE40E não declaram módulos compatíveis (`compatibleModuleKeys: []`): o Slot Lab mostra
  "sem moduleKeys declarados" e recusa qualquer placa — comportamento correto, não é bug.
- `huawei-pac600s12-cb` (fonte) não tem slot `POWER` mapeado nos chassis atuais: instalação é
  recusada com motivo.
- MA5683T continua sem geometria de slots (nota honesta em vez de desenho inventado).
