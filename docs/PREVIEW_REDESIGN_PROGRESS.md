# REDESIGN na preview — estado da execução e como retomar

Documento de retomada da fase de redesign do GMJ-NetVision. Todo o trabalho
visual/experimental acontece **somente** na branch `preview/deepseek-ui`, que
alimenta a Web de preview (`:3001`) usando a **mesma API real** (`:3333`).

> Os dados da preview são reais. Nenhuma ação destrutiva deve ser usada para
> validar tela. Nunca rode `deploy/update.sh` (produção) aqui, e nunca aplique
> migration pelo preview.

## Onde o trabalho parou

Em 2026-09-25 o servidor `45.163.144.8` ficou **inacessível** (sem ICMP e sem
resposta em 2222/3000/3001/3333) enquanto a conectividade local estava normal.
O último deploy concluído com sucesso foi a **Fase 2**. As fases seguintes estão
**commitadas e publicadas**, mas ainda não foram implantadas na `:3001`.

| Commit | Entrega | Status na preview |
| --- | --- | --- |
| `9b5f019` | Design system + shell global (StatusPill, ModuleHeader, Panel, ConfirmDialog, SearchInput, EmptyState, SegmentedControl) | **implantado** |
| `dca5898` | Workspace do mapa (rail de camadas, 3 presets, foco/atenuação, barra de status, chip de tipo, alarme compacto) | **implantado** |
| `6714b6f` | Hosts (filtro de estado, problema primeiro, coluna BGP, mapas clicáveis, ações), busca global em todos os módulos, frescor real, ConfirmDialog nas ações destrutivas | **implantado** |
| `458afb7` | Barra de status usa o carimbo de **coleta** (não a última edição do mapa) | **implantado** |
| `763dbd1` | Documento de retomada + ferramenta de screenshots | **implantado** |
| `9631577` | Globais de Node no eslint para os scripts de `tools/` | **implantado** |
| `9dfdf33` | BGP: coluna de quedas 48h + "down há X", falhas de refresh por equipamento, ações Abrir host / Abrir interface no mapa (só com MATCHED + equipamento no mapa ativo) | **implantado** |
| `e1ca07d` | Correlação interface→porta física: endpoint de leitura + "Localizar no Físico" | commitado, **endpoint depende de deploy da API** |

Produção (`main`) permanece intacta em `2bdc4f7` em todos os commits.

## Como retomar

### 1. Confirmar que o servidor voltou

```bash
curl -fsS http://127.0.0.1:3333/health          # API
curl -fsSI http://127.0.0.1:3000/               # produção
curl -fsSI http://127.0.0.1:3001/               # preview
systemctl is-active netvision-api netvision-web netvision-web-preview
```

### 2. Implantar o que já está pronto

```bash
cd /opt/GMJ-NetVision-preview
sudo bash deploy/update-preview.sh
```

O script valida produção/API antes e depois, faz fast-forward só da branch
`preview/deepseek-ui`, roda `npm ci`, lint/typecheck/testes **apenas de
`@gmj/web` e `@gmj/shared`** (o workspace da API tem hooks de Prisma e não é
executado), builda com `NEXT_PUBLIC_PREVIEW_MODE=true`, prepara o standalone,
instala só `netvision-web-preview.service` e reinicia só o preview.

### 3. Atualizar o worktree se o `git fetch` reclamar da chave SSH

O `origin` no servidor é SSH e a chave de root é protegida por passphrase (sem
agent), então um fetch não interativo falha. O próprio `update-preview.sh` já
cai para leitura **HTTPS anônima** da mesma branch, sem alterar configuração de
remote. Se o repositório deixar de ser público, corrija a credencial de deploy.

## Reproduzir a UI localmente (sem servidor)

O redesign é visual: para iterar rápido e gerar screenshots sem depender do
servidor, rode a Web em `DEMO_MODE` contra a API local demo.

```powershell
cd C:\projetos\GMJ-NetVision
npm run dev            # API demo em :3333 e Web em :3000
```

- acesse por **`http://localhost:3000`** (não `127.0.0.1` — o Next 16 bloqueia
  os chunks de dev fora do host esperado; ver `tools/preview-screenshots/README.md`);
- login `admin` / `admin` (senha padrão do `DEMO_MODE`, repositório em memória);
- `?view=hosts`, `?view=bgp`, `?view=physical` trocam de módulo.

Screenshots: ver [`tools/preview-screenshots/README.md`](../tools/preview-screenshots/README.md).
As capturas já feitas (antes/depois e os três presets do mapa) estão em
`.artifacts/redesign/` (diretório ignorado pelo Git).

## Decisões de UX já tomadas (e o que foi preservado)

- **Mapa em três colunas**: rail de camadas à esquerda, canvas no centro,
  inspector contextual à direita. O painel permanente "Visual do mapa" deixou de
  cobrir o canvas; virou a seção recolhível da rail.
- **Três presets VISUAIS** (`Operacional`, `Topologia`, `Engenharia`) sobre o
  MESMO mapa e os MESMOS dados. Nenhum mapa é criado/duplicado; topologia,
  métricas e posições não mudam — só o que fica em evidência.
- **Atenuação, nunca ocultação**: elemento fora da camada/recorte fica com
  opacidade reduzida e continua legível e clicável (a rail informa quantos
  elementos estão atenuados e oferece "Mostrar tudo").
- **Frescor honesto**: `Atualizado agora` foi removido. O rótulo usa o carimbo
  de coleta mais recente dos equipamentos e admite "sem carimbo de coleta"
  quando não existe; a barra de status também marca "pode estar desatualizado".
- **Tipo de equipamento por texto**: chip `RT/SW/OLT/FW/SRV/CORE/AGG/...`
  derivado do `deviceType` real — a distinção não depende de cor.
- **Confirmação única** (`ConfirmDialog`) para excluir enlace, node, equipamento
  do mapa, link público e mapa. As confirmações com semântica própria do BGP
  (ação administrativa com read-back) continuam nos seus painéis.

Preservados sem alteração de comportamento: React Flow, identidade de
nodes/edges, posições persistidas, `positionSource`, locked, `MANUAL/AUTO/HYBRID`,
auto-layout Dagre, smart guides, curvatura manual, geometria persistida, métricas
direcionais A→B/B→A, capacidade, RX/TX, alarmes, drawers, criação/edição de
enlaces, PPP TOTAL, NOC Rotation e links públicos.

## Próximos passos planejados

1. **Implantar a API em produção** para habilitar a correlação reversa: o
   endpoint `GET /api/physical/ports/by-interface/:interfaceId` está na branch,
   mas a API que roda em `:3333` é a de `main`. Enquanto isso, a UI diz
   explicitamente "o endpoint de leitura ainda não foi implantado" em vez de
   afirmar que a interface não tem conector.
2. **Fase 5 — Físico (restante)**: reorganizar o inspector em abas
   (identidade/portas/slots/correlação/caminho). O cabeçalho do módulo,
   tooltips e a integração "Localizar no Físico" já foram entregues; a
   reorganização do inspector não foi feita para não arriscar o contrato da
   área sob o orçamento disponível.
3. **Aprofundar a correlação**: levar "Localizar no Físico" também para o
   detalhe do host (Hosts) e para o peer BGP quando `MATCHED`, e exibir a
   hierarquia de confiança CONFIRMADO/INFERIDO/AMBÍGUO/DESCONHECIDO na UI.
4. **Mapa, fase 2b**: revisar espaçamento/orientação do auto-layout Dagre
   (sem remover Dagre e preservando posições manuais) e agrupamento visual por
   POP/site quando os dados permitirem.
