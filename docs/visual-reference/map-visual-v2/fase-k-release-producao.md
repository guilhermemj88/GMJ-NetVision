# Fase K — release controlado da MAP-VISUAL-V2 em produção

Integração rastreável do trabalho das Fases A–J (`feature/map-visual-v2`) na linha
realmente servida pela porta 3000, com publicação reversível e sem alteração de
API, banco (exceto a flag do mapa piloto) ou geometria de mapas.

## Base de produção identificada (preflight)

| Item | Valor |
| --- | --- |
| Worktree que serve a porta 3000 | `/opt/GMJ-NetVision-production-alarm-chart` (drop-in `zzz-huawei-profiles.conf`) |
| HEAD desse worktree | `fc790ad` (feature/huawei-snmp-profiles) |
| Artefato servido | `apps/web/.next/standalone`, BUILD_ID `LZaw2d9_LS1EZ0-64Dkng`, `server.js` de 15/10/2026 17:50 |
| `origin/main` | `4cd04a0` |
| `main` do repositório do servidor | `df3346d` (obsoleto, 26 arquivos não commitados) |
| HEAD da feature V2 | `fcbc733` |

O artefato em execução contém o MAP-LINK-GRAPHS (`cc68f9b`), que **não** está no
HEAD `fc790ad` — ele foi construído quando o worktree ainda apontava para a linha
que continha `cc68f9b`. Verificado no bundle servido (`linkAToBFill`,
`amostras SNMP`, `TRAFEGO HIST`). Por isso o release parte de `fcbc733`, que é
um superconjunto: `fc790ad` (mitigação/huawei/alarm-chart) + `cc68f9b` (gráficos)
+ Fases A–J da V2.

## Conteúdo do release

`git log fc790ad..fcbc733` = 13 commits (12 da MAP-VISUAL-V2 + `cc68f9b`).
Nenhuma migração Prisma, nenhuma alteração de schema, nenhuma alteração de
página/rota de produção fora do motor de desenho do mapa.

## Flags de build (isolamento do preview)

- `NEXT_PUBLIC_PREVIEW_MODE` **ausente/false** → o seletor `VISUAL DO MAPA`, o
  seletor `ANIMAÇÃO` e a faixa de preview não são embutidos; a página do
  laboratório responde 404 (`app/map-visual-preview/page.tsx`).
- `NEXT_PUBLIC_PREVIEW_META` e `apps/web/.env.production` do preview **não** são
  copiados (o arquivo é untracked; o worktree de release nasce limpo).
- Env de produção lido de `/opt/GMJ-NetVision/.env` (`NEXT_PUBLIC_DDOS_MITIGATION_UI=true`,
  `NEXT_PUBLIC_API_URL=` vazio). Base da API no servidor: padrão
  `http://127.0.0.1:3333` (`lib/api.ts`), sem `API_INTERNAL_URL` do preview.
- Animação: `resolveWeatherMap` e a preferência de sessão (`gmj:preview:link-animation:v2`)
  têm `off` como padrão — em produção não há runner, nem animação de hover/seleção,
  nem modo Inteligente/Sempre ativa na UI.

## Publicação

1. Backup do artefato atual + unidades systemd em
   `/opt/GMJ-NetVision-backups/web-mapv2-<timestamp>/`.
2. Novo drop-in `netvision-web.service.d/zzzz-mapv2-release.conf` apontando
   `WorkingDirectory` para `/opt/GMJ-NetVision-release-mapv2/apps/web/.next/standalone`.
3. `systemctl daemon-reload` + `systemctl restart netvision-web` (somente esse serviço).
4. Ativação da flag no mapa piloto `map-dbd74184-5e3f-46a1-88aa-9ad6edf63c44`
   (`Map.filters.visualMode = MAP_VISUAL_V2`), com backup do valor anterior.

## Rollback

```bash
# 1. release Web: volta ao artefato preservado (worktree alarm-chart, inalterado)
rm -f /etc/systemd/system/netvision-web.service.d/zzzz-mapv2-release.conf
systemctl daemon-reload
systemctl restart netvision-web

# 2. funcional: desliga a V2 só no mapa piloto
#    MAP_VISUAL_V2 → MAP_VISUAL_V1 (ou remover a chave visualMode)
```

Sem migração reversa, sem alteração de dados históricos, sem dependência do banco.

## Evidências

Registradas durante a execução em `/opt/GMJ-NetVision-backups/web-mapv2-<timestamp>/`
(BUILD_ID, sha256 do `server.js`, cópia das unidades) e no relatório da fase.
