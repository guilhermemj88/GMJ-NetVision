# GMJ NetVision

GMJ NetVision é uma plataforma map-first para construir, descobrir e observar topologias de rede. A aplicação abre diretamente no mapa: edição, consulta, tráfego e descoberta acontecem sem tirar o operador do contexto da topologia.

Esta primeira versão funcional entrega um backbone ISP demonstrativo com 13 equipamentos, tráfego bidirecional animado, edição manual, drawers contextuais e histórico de interfaces. Ela roda integralmente com `DEMO_MODE=true`, sem Zabbix, SNMP, SSH ou PostgreSQL ativos.

## O que já funciona

- catálogo com múltiplos mapas, seletor na barra superior, CRUD, mapa padrão, mapa vazio e duplicação;
- `Device` global associado a cada mapa por `MapNode`, sem duplicar inventário entre visões;
- modos de node `ICON_2D`, `ICON_3D` e `CARD`, persistidos por mapa;
- estilos de enlace `FLOW`, `WEATHERMAP`, `HYBRID` e `MINIMAL`;
- métricas `A_TO_B` e `B_TO_A` independentes, com throughput, percentual e cor por utilização;
- NOC Rotation Mode com playlist ordenada, intervalos, loop, pausa, navegação, countdown e fullscreen;
- mapa interativo com zoom, pan, fit view, tela cheia e topologia responsiva;
- 13 equipamentos e 16 enlaces de demonstração, incluindo Internet, IX, borda, core, agregação, OLTs e clientes;
- seleção, drag, lock/unlock e persistência local das posições;
- auto-layout Dagre que respeita nodes bloqueados e, no modo `HYBRID`, posições manuais;
- modos conceituais `MANUAL`, `AUTO` e `HYBRID` (preferido);
- modo de edição com inclusão e remoção de equipamentos;
- criação manual de enlace com equipamento e interface em cada ponta, capacidade, label e fonte de métricas;
- edição e exclusão de enlaces;
- tráfego RX/TX animado por direção, intensidade normalizada e espessura por capacidade;
- filtros para tráfego, utilização, labels, equipamentos offline e interfaces;
- drawer de equipamento com identidade, status, uptime, interfaces, throughput, CPU e memória;
- lista de interfaces com `UP`, `DOWN`, `DISABLED`, `WARNING` e `UNKNOWN`;
- detalhe de interface com RX/TX, utilização, erros, discards e gráficos para `15m`, `1h`, `6h`, `24h` e `7d`;
- drawer de enlace com pontas físicas, tráfego, capacidade, erros, discards e fontes;
- fluxo de descoberta com seed device, fallback conceitual, correlação e revisão antes de adicionar;
- API Fastify para mapa, posições, nodes, links, históricos, descoberta e integração Zabbix;
- schema Prisma/PostgreSQL completo para os modelos iniciais;
- contratos e implementações iniciais de LLDP/SNMP, LLDP/SSH, Huawei VRP e Zabbix.

## Arquitetura

O monorepo usa npm workspaces:

```text
apps/
  web/                 Next.js, React Flow, TanStack Query, Zustand, Recharts
  api/                 Fastify, adapters, serviços de aplicação e Prisma
packages/
  shared/              domínio normalizado, formatos e dados demo
  ui/                  componentes visuais compartilhados
docs/
  ARCHITECTURE.md       responsabilidades e fluxos internos
  SNMP_COUNTERS.md      regras para a futura coleta de counters
```

A separação central é:

```text
                         Map Engine
                       /            \
           Topology Engine          Metric Engine
          /               \                |
   LLDP / SNMP       LLDP / SSH          Zabbix
                         |
                 drivers por SO
```

O Topology Engine responde “quem está conectado em quem?”. O Metric Engine responde “como o equipamento ou enlace está se comportando?”. O frontend consome apenas modelos normalizados; não conhece OIDs, comandos SSH, tokens nem communities.

Mais detalhes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- Next.js 16, React 19 e TypeScript strict;
- React Flow para o canvas;
- TanStack Query para estado remoto e Zustand para a sessão do mapa;
- Recharts para séries históricas;
- Tailwind CSS 4 mais um design system CSS próprio;
- Fastify 5 e Zod;
- Prisma 6 e PostgreSQL 16;
- Vitest, ESLint flat config e Prettier.

## Como executar

Requisitos: Node.js 20+ (Node 24 LTS testado), npm 10+ e, para persistência real, Docker ou PostgreSQL 16.

```bash
cp .env.example .env
npm install
npm run dev
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:3333>
- Healthcheck: <http://localhost:3333/health>

O frontend possui fallback local: se a API não estiver ativa, o mapa demo, o histórico, a edição e a persistência de posições continuam funcionando no navegador.

### PostgreSQL e Prisma

```bash
docker compose up -d postgres
npm run db:generate
npm run db:migrate -- --name initial
```

O schema está em `apps/api/prisma/schema.prisma`. O repositório demo em memória é usado nesta entrega para permitir início imediato; conectar o repositório Prisma ao Map Service é o próximo passo de persistência do servidor.

## Variáveis de ambiente

| Variável                    | Uso                                       | Padrão                               |
| --------------------------- | ----------------------------------------- | ------------------------------------ |
| `DEMO_MODE`                 | habilita dados e métricas demonstrativos  | `true`                               |
| `PORT`                      | porta da API Fastify                      | `3333`                               |
| `NEXT_PUBLIC_API_URL`       | URL pública da API GMJ (nunca do Zabbix)  | `http://localhost:3333`              |
| `DATABASE_URL`              | conexão PostgreSQL usada pelo Prisma      | exemplo no `.env.example`            |
| `CREDENTIAL_ENCRYPTION_KEY` | chave base64 de 32 bytes para AES-256-GCM | obrigatória antes de salvar segredos |
| `ZABBIX_URL`                | endpoint base do Zabbix                   | vazio                                |
| `ZABBIX_TOKEN`              | token usado somente pela API              | vazio                                |

Gere uma chave local com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Editor manual e Map Engine

Ative **Editar mapa** na barra superior. O toolbar permite adicionar equipamentos, criar enlaces, excluir a seleção, auto-organizar, bloquear/desbloquear, descobrir vizinhos e salvar.

Arrastar um node define `positionSource=MANUAL`. Nodes com `locked=true` nunca são movidos pelo auto-layout. Em `HYBRID`, o layout também preserva posições manuais sempre que possível. As posições são salvas na API e, como tolerância a falhas do modo demo, em `localStorage`.

Um link sempre representa explicitamente:

```text
sourceDevice + sourceInterface <-> targetDevice + targetInterface
```

Topologia e métricas mantêm fontes independentes (`discoverySource` e `metricSource`).

### Visual do mapa e enlaces

O painel **Visual do mapa**, no canto superior direito do canvas, troca entre ícones 2D, ícones 3D discretos e os cards originais. No mesmo painel é possível escolher o estilo global dos enlaces e se o label mostra throughput, utilização, ambos ou nada. As escolhas pertencem ao mapa ativo, são gravadas na API e possuem fallback em `localStorage`.

Em `WEATHERMAP`, os sentidos `A_TO_B` e `B_TO_A` usam faixas, setas, métricas e cores independentes. Em `FLOW` e `MINIMAL`, o pior sentido define a cor resumida. As faixas padrão são: normal abaixo de 40%, atenção de 40% a 70%, alto de 70% a 90%, crítico de 90% a 100% e inconsistente acima de 100%. O cálculo nunca soma os sentidos de um enlace full-duplex.

A capacidade pode vir automaticamente da menor velocidade entre as interfaces ou ser sobrescrita em Mbps/Gbps. Criação e edição de enlace também aceitam estilo e métrica locais, que sobrepõem a preferência global do mapa.

IDs locais são gerados por `createLocalId`: o helper usa `globalThis.crypto.randomUUID()` quando disponível e cai com segurança para `Date.now()` mais `Math.random()` em browsers antigos ou ambientes restritos.

### Múltiplos mapas e NOC Mode

O botão ao lado do seletor de mapas abre o gerenciador para criar, renomear, descrever, duplicar, excluir, abrir ou definir o mapa padrão. Um equipamento é global; sua presença, posição e lock em cada visão são representados por um `MapNode` próprio.

O botão **NOC** abre a configuração da rotação. Selecione e ordene os mapas, escolha 30 segundos, 1, 2, 5 ou 10 minutos e defina se barra superior e controles devem ser ocultados. A apresentação roda continuamente e oferece anterior, próximo, pausar/retomar, fullscreen, saída e countdown. Quando habilitada, qualquer seleção no mapa pausa a rotação para inspeção.

## Descoberta LLDP via SNMP

`LldpSnmpDiscoveryAdapter` implementa o contrato `TopologyDiscoveryAdapter` e encapsula a LLDP-MIB padrão. A primeira estrutura normaliza chassis ID, system name/description, porta local/remota, descrição de porta e identidade do vizinho sem expor OIDs ao frontend.

O transporte `SnmpClient` é injetável. A implementação concreta de sessão v2c/v3 e IF-MIB ainda não está ligada, portanto consultas reais dependem do próximo adapter de transporte. O schema aceita payload criptografado de credenciais; community, auth password e privacy password não possuem campo plaintext.

## Descoberta LLDP via SSH

`LldpSshDiscoveryAdapter` escolhe um `SshDeviceDriver` por fabricante/SO. `HuaweiVrpDriver` já define comandos e parsing inicial para `display version`, `display interface brief`, `display lldp neighbor brief` e `display lldp neighbor`.

O transporte `SshClient` também é injetável. Cisco IOS, IOS XE, IOS XR, chave SSH e execução SSH real estão preparados pela abstração, mas ainda não implementados. SSH é reservado a identidade, inventário e LLDP — não a polling periódico de tráfego.

## Zabbix

`ZabbixAdapter` usa JSON-RPC exclusivamente no backend e já implementa chamada autenticada, healthcheck e listagem/normalização inicial de hosts. O mapeamento de itens Zabbix para interfaces e as consultas de histórico ainda são stubs explícitos.

A correlação de identidade usa hostname, IP e nomes normalizados, retornando `MATCHED`, `UNMATCHED` ou `AMBIGUOUS`; resultados ambíguos nunca são aceitos silenciosamente.

## Segurança de credenciais

- o navegador nunca recebe `ZABBIX_TOKEN`, community ou senha SSH/SNMP;
- segredos são modelados como `encryptedPayload Bytes` no PostgreSQL;
- `CredentialVault` usa AES-256-GCM com IV aleatório e autenticação;
- a chave de envelope fica fora do banco e deve vir de secret manager em produção;
- TLS, RBAC, auditoria, rotação de chaves e um vault externo são obrigatórios antes de produção.

## Dados demo

As séries são determinísticas e combinam ondas suaves; não usam valores totalmente aleatórios a cada render. A API em memória persiste durante o processo e o navegador preserva posições entre reloads.

## Qualidade

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run format:check
```

## Roadmap

1. conectar o Map Service ao repositório Prisma e criar migração de produção;
2. implementar transportes SNMP v2c/v3 e SSH com timeouts, pools, auditoria e secret manager;
3. completar IF-MIB e testes com captures reais multi-vendor;
4. mapear itens, tendências e histórico Zabbix às interfaces importadas;
5. implementar aprovação persistida dos `DiscoveryResult` e criação transacional de links;
6. drivers Cisco IOS/IOS XE/IOS XR e fallback genérico;
7. descoberta recursiva com limites, fila, cancelamento e rate limiting;
8. autenticação, RBAC, playlists nomeadas e auditoria;
9. coleta SNMP futura baseada em tempo real entre amostras, conforme [docs/SNMP_COUNTERS.md](docs/SNMP_COUNTERS.md).

## Limitações conhecidas do MVP

- o CRUD do mapa usa memória na API; o schema PostgreSQL está pronto, mas ainda não é o repositório ativo;
- SNMP e SSH reais exigem a implementação dos transportes injetáveis;
- Zabbix lista hosts, porém mapeamento de interfaces/items e históricos reais ainda não estão implementados;
- descoberta demo aceita apenas vizinhos já correlacionados; cadastro de vizinho desconhecido abre o editor manual;
- não há autenticação/RBAC nesta primeira versão.
