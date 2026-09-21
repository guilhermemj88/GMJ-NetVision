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
- `apps/api/src/infrastructure/physical/physical-catalog.ts` é a fonte versionada (`PHYSICAL_CATALOG`). Regras aplicadas:
  - `vendorVerified: true` **apenas** quando altura, quantidade e tipo de portas vieram da página oficial do fabricante (`referenceUrl`);
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

### UI

- Modal de equipamento reescrito: `Categoria → Fabricante → Modelo/template → Device → Nome → Start U`, com resumo do template, selo `VERIFICADO NO FABRICANTE` / `TEMPLATE GENÉRICO` / `ESTRUTURA NÃO CONFIRMADA` e campos manuais quando o dado não foi confirmado.
- Canvas desenha slots, placa instalada e portas da placa; portas ganham estado visual (`LIVRE`, `MAPEADA`, `LLDP`, `CONECTADA`) e marcador de vizinho LLDP.
- Inspetor: lista de slots com instalar/remover placa, vínculo com `Interface`, observações da porta, vizinho LLDP e painel de sugestões com o botão “Confirmar conexão física” (apenas `READY`).
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
