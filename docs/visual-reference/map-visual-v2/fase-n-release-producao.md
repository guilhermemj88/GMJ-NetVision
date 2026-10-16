# Fase N — release da MAP-VISUAL-V2 na produção (3000)

Integração das Fases A–M no código de produção da IMPLANTAR e publicação
reversível **somente da Web**. API 3333, banco, SNMP e configurações não mudam.

## Base da integração

| Ponto | Valor |
| --- | --- |
| Produção (antes) | `integration/map-visual-v2-production` @ `40adaa1` (release da Fase K) |
| Desenvolvimento | `feature/map-visual-v2` @ `f6bb147` (Fases A–M) |
| Commits integrados | Fase L `8471bbd` + Fase M `f0a295f` (cherry-pick sem conflito) |
| Ajustes da Fase N | seletor de sessão e animação desligada no produto (este commit) |

O laboratório continua fora do build de produção (`_map-visual-preview`, decisão
da Fase K). Nada foi copiado de `/opt/GMJ-NetVision-map-visual-v2`.

## O que muda no produto

1. **Seletor de sessão V1/V2** (`VISUAL DO MAPA`) passa a existir também na
   produção: é a forma de o operador usar a V2 num mapa **sem gravar nada no
   banco**. A flag `Map.filters.visualMode` continua sendo o padrão do mapa e
   mapa sem flag continua abrindo em V1.
2. **Seletor `ESTILO DOS ENLACES`** (Fase M) aparece sempre que o mapa está em
   V2, com `Direcional (padrão)` e `Operacional (experimental)`; preferência da
   aba (`gmj:preview:link-style:v1`), sem escrita no mapa/banco.
3. **Animação desligada por decisão do operador**: `resolveLinkV2AnimationModeForUi`
   devolve sempre `off` fora do preview (mesmo com preferência antiga na aba) e o
   controle `ANIMAÇÃO` continua exclusivo do preview. O código experimental dos
   runners permanece no lugar, apenas não é acionado.
4. **Legenda** acompanha o modo ativo (direcional: ciano/roxo; operacional:
   verde-sálvia/âmbar/coral, com as setas indicando o sentido).

Nada disso altera geometria, posições, offsets manuais, anticolisão, seleção,
ContextDrawer, MAP-LINK-GRAPHS, alarmes ou telemetria.

## Regras de cor no modo Operacional (Fase M)

- `--wm-op-normal` `#43866e` — utilização < 50%;
- `--wm-op-attention` `#c79a45` — 50% ≤ utilização < 80%;
- `--wm-op-critical` `#c65c63` — utilização ≥ 80%;
- `--wm-op-text` `#e1e8e5` — texto da plaqueta (fundo opaco escuro).

Linha, seta e borda da plaqueta de UMA direção compartilham a mesma cor; estados
DOWN / sem dados / stale / inconsistente mantêm os tokens semânticos.

## Build de produção

```bash
cd /opt/GMJ-NetVision-release-mapv2
npm run build -w @gmj/web        # sem API_INTERNAL_URL (padrão 127.0.0.1:3333)
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -a apps/web/public       apps/web/.next/standalone/apps/web/
```

O build **não** recebe `NEXT_PUBLIC_PREVIEW_MODE`, `NETVISION_READ_ONLY` nem
`API_INTERNAL_URL` apontando para a API read-only 3342 — o proxy continua em
3333 e o `.env` de produção (`/opt/GMJ-NetVision/.env`) não é alterado.

## Publicação reversível

1. backup do standalone publicado: `/opt/GMJ-NetVision-backups/web-<release>-<data>/`;
2. `mv` do standalone antigo para o backup e `cp -a` do novo no lugar;
3. `systemctl restart netvision-web` (o drop-in `zzzz-mapv2-release.conf` é quem
   aponta `WorkingDirectory=/opt/GMJ-NetVision-release-mapv2/apps/web/.next/standalone`);
4. validação em `http://127.0.0.1:3000`.

**Rollback do release**: restaurar o standalone do backup e reiniciar apenas
`netvision-web`.
**Rollback funcional (V2 → V1)**: escolher `Clássico (V1)` no seletor de sessão
(ou remover a flag `visualMode` do mapa piloto, em `Map.filters`, sem migration).

Rollback não usa migration reversa e não altera dados históricos.
