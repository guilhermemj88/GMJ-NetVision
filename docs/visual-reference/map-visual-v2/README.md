# MAP-VISUAL-V2 — capturas do laboratório

Capturas da rota interna `/map-visual-preview`: laboratório isolado de comparação dos
glifos V2 (Fase A), dos enlaces inteligentes/cenários densos (Fase B) e da preparação
para integração operacional (Fase C).

- Disponível apenas em `next dev` local ou build de preview
  (`NEXT_PUBLIC_PREVIEW_MODE=true`); no build de produção a rota devolve a página 404 do
  framework (nenhum conteúdo do laboratório é servido). O status HTTP nesse caso continua
  200 por comportamento do App Router — um 404 "duro" exigiria middleware de produção, que
  ficou fora do escopo autorizado (registrado como limitação).
- Todos os nós, estados e alarmes são mock: nada é lido do mapa real, nenhuma chamada
  de API é feita e nada é gravado.
- A V1 permanece intacta: nenhum arquivo do mapa atual (device-node, ícones, canvas,
  traffic-edge, ContextDrawer) foi alterado.

## Fase A — glifos

| Arquivo | O que mostra |
| --- | --- |
| `01-laboratorio-controles-cabecalho.png` | cabeçalho, avisos de escopo e controles do canvas (motor V1/V2 e tamanho do ícone em 16/24/32/48 px) |
| `02-catalogo-v1-x-v2-16-24-32-48.png` | catálogo V1 × V2 em 16/24/32/48 px: 11 tipos legados com glifo V2, 12 tipos em fallback V1 e o glifo PNI (ainda sem tipo legado no picker) |
| `03-core-switch-candidato.png` | comparação lado a lado do desenho em uso (SWITCH, mapeamento provisório) com o candidato novo (dois chassis) + seletor de avaliação |
| `04-bng-normal-x-compacta-16-24-32-48.png` | matriz BNG normal × compacta em 16/24/32/48/112 px, a linha "Preferência (compacta ≤ 24 px / normal ≥ 32 px)" e o início do canvas |
| `05-react-flow-v2-provisorio-32px.png` | React Flow real com a engine V2 em 32 px e o mapeamento provisório (SW-CORE-01 usa o desenho SWITCH) |
| `06-react-flow-core-switch-candidato.png` | o mesmo canvas com o candidato selecionado (SW-CORE-01 passa a usar o desenho de dois chassis) |
| `07-react-flow-16px-bng-compacta.png` | canvas em 16 px com a preferência do BNG em ação (compacta em tamanhos pequenos) |
| `08-react-flow-v1-atual.png` | canvas com a engine V1 — baseline de produção (orbe + glifos atuais) |

## Fase B — enlaces inteligentes e cenário denso

Pasta `fase-b/`:

| Arquivo | O que mostra |
| --- | --- |
| `01-catalogo-final-icones.png` | catálogo final V1 × V2 em 16/24/32/48 px (11 tipos com glifo V2, 12 em fallback, PNI) |
| `02-backbone-simples-v1.png` | cenário A com o renderer V1 real (duas pistas + rótulos detalhados) e ícones V1 |
| `03-backbone-simples-v2.png` | cenário A no V2: linha única, cores por estado, seta na tangente, rótulos inteligentes |
| `04-backbone-denso-v2.png` | cenário B (27 nós, 33 linhas) provando legibilidade em condição densa |
| `05-enlace-critico.png` | enlace crítico 94% selecionado (halo) + painel lateral com A/B, A→B, B→A, capacidade, qualidade |
| `06-enlace-down.png` | enlace DOWN (vermelho tracejado, rótulo DOWN) + painel |
| `07-sem-telemetria.png` | enlace sem telemetria (cinza tracejado) + painel |
| `08-stale.png` | telemetria desatualizada ("· antigo") + painel |
| `09-link-curto-rotulo-inteligente.png` | "mostrar todos os rótulos": o enlace curto recebe rótulo deslocado pela anticolisão |
| `10-links-paralelos-lag.png` | quatro paralelos + grupo LAG 2×10G com membro DOWN (painel com capacidade agregada comprovada) |
| `10b-lag-expandido.png` | o mesmo grupo LAG expandido em membros individuais (identidade preservada) |
| `11-core-switch-candidato.png` | comparação dos dois desenhos de CORE_SWITCH (provisório × candidato) |
| `12-bng-normal-vs-compacta.png` | matriz BNG normal × compacta em 16/24/32/48/112 px com a preferência ≤ 24 px |
| `13-zoom-25.png` | cenário B a 25%: topologia inteira visível; degraus de espessura praticamente indistinguíveis |
| `14-zoom-100.png` | cenário B a 100% |
| `15-zoom-220.png` | cenário B a 220% (leitura de detalhe) |
| `16-painel-lateral-enlace.png` | enlace selecionado com tooltip completo (RX/TX, qualidade divergente) + painel com histórico demonstrativo |

Notas de avaliação da Fase B:

- Em 25% de zoom os degraus 1.2/2.0/3.0/4.5 px deixam de ser distinguíveis na tela
  (o traço escala com o zoom). Se o operador trabalhar muito nesse zoom, avaliar um
  mínimo de espessura por tela (clamp por zoom) antes de promover o V2.
- Os rótulos têm tamanho constante na tela; a anticolisão usa `1/zoom` para continuar
  fiel ao que se vê (ver captura de 25%).
- O painel lateral e o tooltip são demonstrativos; o ContextDrawer real e os gráficos
  do MAP-LINK-GRAPHS não foram alterados.

## Fase C — preparação para integração operacional

Pasta `fase-c/`: usa o **cenário C** (fixture de geometria real sanitizada) para
comparar V1 × V2 sobre os mesmos nós, enlaces e curvaturas do mapa real.

| Arquivo | O que mostra |
| --- | --- |
| `c-01-v1-zoom25.png` | mesmo mapa real no V1 a 25% (duas pistas, rótulos CARD) |
| `c-02-v2-zoom25.png` | mesmo mapa real no V2 a 25% — espessura compensada, nada desaparece |
| `c-03-v1-zoom100.png` | V1 a 100% (baseline visual) |
| `c-04-v2-zoom100.png` | V2 a 100% com a flag `MAP_VISUAL_V2` |
| `c-05-v2-zoom220.png` | V2 a 220% com `Zoom · clamp (A)` — traço continua fino |
| `c-06-v2-zoom220-nonscaling.png` | mesmo zoom com `non-scaling (B)` — alternativa por `vector-effect` |
| `c-07-v2-zoom220-baseline.png` | mesmo zoom com `Escala com zoom (Fase B)` — traço engorda (regressão que a Fase C corrige) |
| `c-08-v2-zoom150-labels-all.png` | "mostrar todos os rótulos": 31/31 posicionados pela anticolisão sobre a geometria real |
| `c-09-v2-parallel-selected.png` | membro do pacote paralelo de 3 (`r-link-8`) selecionado + painel com o contrato `{ kind: 'link', id }` |
| `c-10-v2-manual-offset.png` | rótulo em posição MANUAL (offset da V1) respeitado no V2, fora da anticolisão |
| `c-11-v1-manual-offset-inline.png` | o MESMO offset aplicado pelo renderer V1 (modo em linha) — compatibilidade e reversibilidade |
| `c-12-v2-sim-down.png` | simulação DOWN no mapa real (prioridade nunca escondida) |
| `c-13-v2-sim-nodata.png` | simulação "sem dados" (cinza tracejado) |
| `c-14-v1-flag-ausente.png` | flag ausente (`Campo ausente (fallback)`) → resolvida em V1 a 150% |
| `c-15-v2-flag-explicita.png` | `MAP_VISUAL_V2` explícito no mesmo zoom |
| `c-16-narrow-1024-v2.png` | viewport estreito 1024×700 no V2 (sem clipping de rótulos) |
| `c-17-scenario-b-lag-expandido.png` | cenário B com o LAG demonstrativo expandido em membros |
| `c-18-scenario-b-lag-membro-down.png` | cenário B com membro DOWN no grupo expandido |
| `c-19-scenario-b-multipath-selected.png` | segundo caminho visual (`ll-bng-norte:path:1`) selecionado → painel confirma `{ kind: 'link', id: 'll-bng-norte' }` (mesmo link do caminho primário) |

Decisões tomadas nesta fase (opção recomendada, conforme autorizado):

1. **Espessura**: modo padrão `zoom` (clamp em px de tela, `strokeWidth = clamp/zoom`, dash
   escalado). O `non-scaling` fica disponível como alternativa B e o baseline da Fase B
   permanece selecionável para comparação. Em 220% a diferença para o baseline é visível
   nas capturas `c-05` × `c-07`.
2. **Rótulo manual**: o offset gravado pelo operador vence a anticolisão e é lido no
   formato original da V1 (`gmj:traffic-labels:<mapId>`, `{dx,dy}` em unidades de fluxo,
   lanes `a`/`b`); o laboratório escreve apenas na chave fictícia `LAB-DEMO`.
3. **Flag por mapa**: `Map.filters.visualMode` opcional e aditivo; ausente/desconhecido
   resolve para V1 (padrão do produto). Nenhum mapa real é alterado nesta fase.
4. **Seleção**: aresta = `linkId` no caminho primário e `linkId:path:n` nos extras;
   a seleção do mapa é sempre `{ kind: 'link', id: linkId }`, igual ao `network-canvas`.
   O painel do laboratório apenas exibe esse contrato — o ContextDrawer real não foi
   alterado.
5. **Sem middleware**: mantido o comportamento do build de produção (rota inexistente com
   página 404 do framework, status 200 do App Router), conforme decidido anteriormente.

Medições registradas (headless Edge, viewport 1920×1080, Node 24):

| Cenário | Arestas | Reconstrução do modelo (média / máx) | Rótulos (média / máx) |
| --- | --- | --- | --- |
| A simples | 11 | 0,105 ms / 0,641 ms | 0,010 ms / 0,084 ms |
| B denso | 33 | 0,189 ms / 0,558 ms | 0,023 ms / 0,261 ms |
| C real | 31 | 0,159 ms / 0,786 ms | 0,017 ms / 0,095 ms |
| C real, todos os rótulos | 31 | 0,151 ms / 0,400 ms | 0,039 ms / 0,216 ms |
| C real a 25% | 31 | 0,182 ms / 0,705 ms | 0,048 ms / 0,298 ms |

Contagem de elementos no DOM (cenário C): V2 = 31 linhas / 31 paths + 31 áreas de clique /
320 paths SVG / 1 820 nós de DOM; V1 = 31 linhas / 364 paths SVG / 2 123 nós de DOM.
A contagem do V2 é **idêntica** em 100% e 220% (geometria independe do zoom) e a seleção
acrescenta 1 rótulo, 3 paths (halo/seta) e o painel.

## Como rodar o laboratório

```bash
# worktree feature/map-visual-v2
npm ci                        # somente se o node_modules ainda não existir
npm run dev -w @gmj/web       # abrir http://localhost:3000/map-visual-preview
```

As capturas usam o driver CDP `tools/preview-screenshots/nv-shot.mjs` com Edge/Chrome
headless (`--headless=new --remote-debugging-port=9222`), viewport 1920 px de largura e
`--eval` apenas para rolar até a seção, trocar os radios de avaliação e remover o
indicador de desenvolvimento do Next das imagens.

## Limites desta fase

- O mapeamento global segue provisório: `resolveDeviceGlyphV2('CORE_SWITCH')` continua
  devolvendo `SWITCH`; a troca para o desenho novo depende de aprovação visual.
- A variante compacta do BNG é opt-in do componente; a preferência
  "compacta ≤ 24 px / normal ≥ 32 px" é apenas uma opção de avaliação do laboratório.
- O PNI só entra no picker quando a taxonomia for aprovada; o resolvedor AUTO nunca o
  infere.
- A fixture do cenário C vem de um snapshot SOMENTE-LEITURA do mapa
  `MPLS - LLDP AUTO TESTE` (25 nós: 15 ancorados em device + 10 conceituais; 31 linhas,
  todas com as duas pontas resolvidas). Só existem duas classes de capacidade nesse mapa
  (29 enlaces acima de 40G e 2 entre 1G e 10G) e **nenhum** enlace com múltiplos
  `visualPaths` — esse caso só é exercitado pelo cenário B mock. Posições, curvaturas,
  paralelos e comprimentos são os reais; nomes, IPs, status, telemetria e alarmes são
  fictícios.
- O painel lateral e o tooltip são demonstrativos; o ContextDrawer real e os gráficos
  do MAP-LINK-GRAPHS não foram alterados.
- Nenhum deploy, merge, restart, migration, escrita em banco ou alteração de mapa real
  foi executado em nenhuma das fases.
