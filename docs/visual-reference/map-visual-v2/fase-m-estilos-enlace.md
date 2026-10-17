# MAP-VISUAL-V2 — Fase M: estilo dos enlaces (A/B Direcional × Operacional)

Experimento controlado **somente no preview** (3004). A V1 continua sendo o padrão
global do produto e a produção (3000/3333) não muda por causa desta fase.

## Objetivo

Comparar duas formas de representar os MESMOS dados, no MESMO mapa e no MESMO
enquadramento, sem tocar em telemetria, geometria, seleção ou persistência:

- **A · DIRECIONAL (padrão)** — visual aprovado na Fase L: A→B ciano, B→A violeta,
  setas na cor do sentido e utilização apenas na borda/cor da plaqueta;
- **B · OPERACIONAL (experimental)** — a cor representa a utilização de CADA
  metade: linha, seta e borda da plaqueta compartilham a MESMA cor; o sentido
  continua explícito pela forma da seta (cheia A→B / chevron B→A).

## Tokens (globais, novos)

| Token | Valor | Uso |
| --- | --- | --- |
| `--wm-op-normal` | `#43866e` | utilização < 50% (verde-sálvia fosco) |
| `--wm-op-attention` | `#c79a45` | 50% ≤ utilização < 80% (âmbar fosco) |
| `--wm-op-critical` | `#c65c63` | utilização ≥ 80% (coral fosco) |
| `--wm-op-text` | `#e1e8e5` | texto da plaqueta no modo operacional |

Nenhum token da Fase L foi alterado: `--wm-dir-*`, `--wm-util-*`, `--wm-state-*`
continuam iguais, e o modo direcional resolve exatamente as mesmas cores de antes
(`weatherHalfStyle(..., 'directional')` devolve `half.color`/`half.pillColor`).

## Precedência visual no modo operacional

1. **DOWN** — falha operacional manda, mesmo com última medição baixa
   (`--wm-state-down`, traço tracejado);
2. **Sem dados** — nunca verde (`--wm-state-no-data`);
3. **Stale** — leitura antiga não vira leitura saudável (`--wm-state-stale`);
4. **Inconsistente / parcial / UNKNOWN** — token semântico próprio
   (`--wm-state-inconsistent` / `--wm-state-unknown`), sem dominar a topologia;
5. **Utilização por sentido** — só entra quando o modelo confirma a faixa
   (`normal` / `attention` / `critical`).

Capacidade desconhecida ou percentual indisponível continuam no estado neutro do
modelo (`no-data`, motivo `capacity-unknown`) — nunca são lidos como 0% nem
pintados de verde. Zero **válido** (contador com origem) segue sendo normal.

## Seletor

`ESTILO DOS ENLACES` na barra superior (ao lado de `VISUAL DO MAPA` e, só no
preview, `ANIMAÇÃO`), com os nomes de produto definidos no adendo da Fase N:

- **Direcional (azul/roxo)** — padrão inicial;
- **WeatherMap (utilização)** — valor interno `operational`.

- independente da flag `Map.filters.visualMode` (V1/V2);
- preferência **por aba** em `sessionStorage` (`gmj:preview:link-style:v1`);
- nenhuma escrita no banco, nenhuma chamada de rede;
- trocar de estilo não altera zoom, pan, seleção, ContextDrawer, gráficos,
  posições, rótulos nem anticolisão — apenas as cores.

## Legenda

A legenda acompanha o modo ativo: no direcional explica a identidade fixa
(ciano/roxo) e as plaquetas; no operacional explica que a cor é a utilização de
cada sentido (verde-sálvia / âmbar / coral) e que a seta diz o sentido. Os
estados especiais aparecem nos dois modos.

## Testes

- `apps/web/src/lib/map-visual-v2-style.test.ts` — preferência da aba, chave
  versionada, independência da animação/V1-V2, ausência de rede e o invariante de
  que apenas os três pontos de apresentação leem o estilo (canvas, geometria e
  anticolisão não conhecem a paleta).
- `apps/web/src/lib/map-visual-v2-weathermap.test.ts` — 22 casos da Fase M:
  direcional preservado, bandas normal/atenção/crítico, 49/50/79/80%, A/B
  assimétricos, SINGLE_ENDED (TX/RX da mesma interface), DOUBLE_ENDED, capacidade
  desconhecida, percentual indisponível, zero válido × ausência, DOWN, sem dados,
  stale, inconsistente, animação OFF e plaquetas da Fase L.
- `apps/web/src/components/traffic-edge-v2-weathermap.test.tsx` — no desenho:
  cor por metade em linha/seta/borda, texto branco suave, estados especiais,
  SINGLE_ENDED, seleção preservada e geometria/rótulos idênticos entre modos.
- `apps/web/src/components/map-v2-legend.test.tsx` e
  `map-visual-v2-weathermap-styles.test.ts` — legenda por modo, tokens novos e
  garantia de que nenhuma regra nova alcança as classes da V1.

## Medições reais (preview 3004, mapa `MPLS - LLDP AUTO TESTE`)

| Métrica | Direcional | Operacional |
| --- | --- | --- |
| Nós / enlaces / metades | 25 / 31 / 62 | 25 / 31 / 62 |
| Setas / plaquetas / ocultas | 62 / 62 / 0 | 62 / 62 / 0 |
| Plaquetas full / small / compact | 43 / 2 / 17 | 43 / 2 / 17 |
| Runners | 0 | 0 |
| Hash de geometria (mesmo enquadramento) | `a6f6f115` | `a6f6f115` |
| Hash das posições de plaqueta | `7c3815fe` | `7c3815fe` |
| Requisições de API em 6 s (troca de estilo) | 0 | 0 (controle também 0) |
| Seleção + ContextDrawer + gráficos | preservados | preservados |

Capturas A/B e a fixture isolada (crítico/estados especiais) ficam no artefato de
evidências da fase, fora do repositório.

## Limites desta fase

Sem deploy de produção, sem alteração na FIBINET/VNT, sem migration, sem escrita
no banco, sem mudanças de SNMP e sem animação — os dois modos são estáticos.
