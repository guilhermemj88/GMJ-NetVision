# MAP-VISUAL-V2 — capturas do laboratório

Capturas da rota interna `/map-visual-preview`: laboratório isolado de comparação dos
glifos V2 (Fase A) e dos enlaces inteligentes/cenários densos (Fase B).

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
- Nenhum deploy, merge, restart ou publicação foi executado nesta fase.
