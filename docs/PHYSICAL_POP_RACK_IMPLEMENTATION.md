# Visão Física de POP / Rack

## Estado

Implementação iniciada em 2026-09-21. O ZIP `0c924f57-d8af-49b8-ac19-9c78c1541c01.zip` é referência visual fornecida pelo usuário, permanece intacto e não deve entrar no Git.

| Milestone | Estado | Escopo |
| --- | --- | --- |
| 1 | EM ANDAMENTO | Schema, migration, inventário POP/rack/asset, API e testes |
| 2 | PENDENTE | Rack view e equipamento genérico |
| 3 | PENDENTE | Portas, templates e vínculo com Interface |
| 4 | PENDENTE | Conexão porta-a-porta e drawer |
| 5 | PENDENTE | DIO/patch panel e path tracing |
| 6 | PENDENTE | Cable lanes, selected-only e highlights |
| 7 | PENDENTE | Responsividade, acessibilidade e validação final |

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

Nenhuma migration foi aplicada ainda. Atualizar esta seção e a tabela após cada milestone.
