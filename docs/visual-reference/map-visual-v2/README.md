# MAP-VISUAL-V2 — capturas do laboratório de glifos

Capturas da rota interna `/map-visual-preview`: laboratório isolado de comparação dos
glifos V2, do desenho candidato `CORE_SWITCH` e das variantes do BNG.

- Disponível apenas em `next dev` local ou build de preview
  (`NEXT_PUBLIC_PREVIEW_MODE=true`); em produção a rota responde 404.
- Todos os nós, estados e alarmes são mock: nada é lido do mapa real, nenhuma chamada
  de API é feita e nada é gravado.
- A V1 permanece intacta: nenhum arquivo do mapa atual (device-node, ícones, canvas)
  foi alterado.

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
