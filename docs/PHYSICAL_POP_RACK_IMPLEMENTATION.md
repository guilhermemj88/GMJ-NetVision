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

## Estado verificado (revisão de 2026-09-21)

- Backend, shared e web já implementam os milestones 1 a 6; o que resta é acabamento e validação contínua (milestone 7).
- Migration `20260921150000_physical_pop_rack` **não foi aplicada** em nenhum ambiente. Foi validada em PostgreSQL descartável: `migrate deploy` aplica as 23 migrations e `migrate diff` não acusa drift em relação ao schema.
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

## Arquivos principais

- `apps/api/prisma/schema.prisma` e migration física
- `apps/api/src/physical-routes.ts`
- `apps/api/src/infrastructure/physical/*`
- `packages/shared/src/physical.ts`
- `apps/web/src/components/physical/*`
- `apps/web/src/lib/api.ts`

## Handoff

- Migration criada e **não aplicada**; nenhum banco de produção foi tocado.
- Commit `93baa7c` (autor: Guilherme, 2026-09-21 10:43 -0300) incluiu, além do trabalho BGP, a fatia inicial deste módulo físico, o ZIP de referência `0c924f57-d8af-49b8-ac19-9c78c1541c01.zip` e os arquivos `flash-*.diff/txt` que estavam no diretório de trabalho. Nada foi removido nem reescrito.
- Continuação do módulo (UI física, testes e ajustes de migration/`app.ts`) permanece **somente no working tree**, sem commit.
- Próximo passo recomendado: aplicar a migration em ambiente de desenvolvimento, validar a view Físico com um POP real e concluir o milestone 7 (responsividade/acessibilidade).
