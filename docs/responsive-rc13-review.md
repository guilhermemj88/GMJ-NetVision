# NETVISION-WEB-RESPONSIVE-IMPLANTAR-01

Entrega exclusiva WEB/UI, sem deploy. Produção, API, banco, migrations, FAST,
equipamentos, serviços, nginx e feature flags não foram alterados.

## Base e isolamento

- Branch: `integration/web-responsive-implant-rc13`.
- Worktree local: `C:\projetos\GMJ-NetVision-responsive-rc13`.
- Base: `d6c07f24e0352c3e9d6fae9672979a396dc72870`.
- Fonte verificada por SSH: `/opt/GMJ-NetVision-vsi-ui-context-integration`.
  `git status --porcelain=v1` vazio antes do trabalho.
- Prova de publicação: a propriedade `WorkingDirectory` do serviço `netvision-web`
  apontava para
  `/opt/GMJ-NetVision-diagnostics-integrated/releases/d6c07f24e0352c3e9d6fae9672979a396dc72870/web`.
  Foram feitas apenas leituras do serviço.
- A cópia local original estava em `04167cd` com alterações em andamento; foi
  preservada. O RC13 foi importado por bundle e o novo worktree nasceu limpo.
- O SHA final e os caminhos da cópia de revisão no servidor constam no relatório
  `.artifacts/responsive/RELATORIO-FINAL.md` e em `candidate-head.txt`.

## Auditoria da referência mobile

SHA: `433b8a5a5a19227fc201cd96c8c18be82329e82f`.
Parent: `ac584c9c6a9b64bf0688e3b05d71d90d664a5d36`.
Patch-id estável: `e0e86ce5bf589e7864fa645282ef2df62637a7c8`.
Merge-base com RC13: `df3346de5c4f0eb77a87cae105de3595dd191086`.

Esse commit contém somente a guarda de capabilities em
`bgp-peer-detail.tsx` e seus testes em `bgp-peer-admin-capabilities.test.tsx`.
O trabalho responsivo está no histórico herdado do parent. Não houve cherry-pick.

| Mudança auditada                                                       | Situação no RC13 e decisão                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guarda BGP do próprio `433b8a5`                                        | Ausente/incompatível com o contrato anterior de capabilities do RC13; fora da missão visual, não integrada.                                                                            |
| Shell/viewport de `087fef2`                                            | Ausente; aproveitados safe areas e remoção do mínimo de altura, com nova arquitetura de header.                                                                                        |
| Rail compacta de `d45d246`                                             | Ausente; adaptada para estado local no mobile, preservando a preferência desktop. Viewport mobile deixa de ser publicado no mapa compartilhado.                                        |
| Navegação inferior/actions sheet e menus “Mais” de `087fef2`/`133b88a` | Conflitantes com a exigência atual de faixa completa; substituídos pela navegação rolável e faixa do mapa. Nenhuma ação é ocultada por breakpoint.                                     |
| Busca em uma linha de `328f21f`                                        | Equivalente aplicado por CSS WEB, sem alterar o pacote compartilhado de UI.                                                                                                            |
| Cards Hosts de `1e892c7`                                               | Ausentes; componente e regras de conteúdo reaproveitados seletivamente.                                                                                                                |
| Cards BGP de `0aaf47d`                                                 | Ausentes; reaproveitados com os mesmos estados/ações da tabela; teste passa a validar as duas representações.                                                                          |
| Físico de `28ba89f`/`6c023f5`                                          | Ausente; navegação POP/rack em sheet, palco com scroll local, inspetor e dialogs adaptados.                                                                                            |
| Fixtures API de `ac17f48`/`c978fe8`                                    | Desnecessárias para esta missão: Playwright intercepta HTTP, sem processo API.                                                                                                         |
| Harness `2acb0a3`/auditoria `ac584c9`                                  | Aproveitada a matriz e a medição de overflow; seletores antigos da navegação inferior tornaram-se obsoletos. Nova suite inclui Alertas, RC13 completo, mitigação e todos os viewports. |

Foram encontrados 49 arquivos de screenshots no worktree mobile anterior,
`C:\projetos\GMJ-NetVision-mobile\e2e\screenshots`. As evidências desta entrega são
novas e estão na galeria; as antigas não são usadas como prova do RC13.

## Topbar e interação

O header tem uma área primária de marca e navegação e uma área de controles.
A navegação contém Físico, Mapa, Hosts, BGP, Alertas e Diagnóstico, com rolagem
independente. No Mapa, a segunda área contém todos os seletores, busca, Fonte/API,
coleta, NOC, edição, descoberta, Links, Configurações, usuários e sessão.
Em outras telas, mantém busca e sessão, sem ações específicas do mapa.
A navegação permanece disponível enquanto o mapa carrega.

Quando a largura medida comporta todos os elementos, `topbar--single-row`
retorna à disposição em uma linha. Sem espaço, as áreas ocupam duas linhas.
Não há remoção de ações por largura. Permissões ADMIN e disponibilidade V1/V2
permanecem as mesmas.

`HorizontalScroll` oferece scroll nativo por touch, trackpad e roda horizontal,
`overscroll-behavior-x: contain`, `touch-action: pan-x`, conteúdo max-content,
min-width zero, scrollbar nativa fina e fades condicionais nas bordas. Há também
um controle range sincronizado de 6px, para manter a barrinha permanentemente
visível nos sistemas que ocultam as scrollbars nativas. Ele aceita teclado e
arrasto. A região aceita Home/End e setas. Reduced motion desliga smooth scroll.

O arrasto com mouse começa apenas em espaço livre e após 6px de deslocamento.
Botões, links, inputs, selects, textarea, elementos interativos e texto não
iniciam arrasto. A captura de pointer só começa após o limiar e termina em up,
cancel ou perda de captura. Touch mantém o comportamento nativo.

A busca usa portal para `document.body`, posição fixed limitada à viewport,
altura com scroll interno e acompanhamento de resize/scroll/visualViewport.
Cliques no resultado funcionam; Escape e clique fora fecham o painel. Quando o
anchor sai da faixa, a busca fecha. Os demais seletores do topbar são nativos,
e os painéis operacionais já ficam fora da faixa clipada.

`useTopbarLayout` observa a altura real com ResizeObserver e publica
`--topbar-height` na raiz da aplicação. Mapa, Hosts, BGP, Alertas, Físico e
Diagnóstico, inclusive drawers com offset do header, usam essa variável.
O modo NOC sem header usa zero; a página pública conserva o fallback de 62px.
Constantes de 62px que representam outras dimensões não foram substituídas.

## Telas

- Mapa: canvas ocupa o restante da viewport; pan/zoom mantidos. Rail inicia
  recolhida no mobile, legenda e status podem ser expandidos sem sobrepor os
  controles flutuantes. O conteúdo técnico permanece acessível.
  Viewport mobile não sobrescreve o viewport compartilhado. Animações pendentes
  são canceladas/ignoradas ao desmontar o canvas.
- Hosts: cards no mobile e tabela com rolagem localizada em telas maiores;
  filtros e drawer adaptados, ações preservadas.
- BGP: cards por equipamento no mobile, tabela no tablet/desktop, filtros e
  detalhe com abas e scroll interno.
- Mitigação: os próprios perfis operacionais passam a cards até 1100px,
  preservando cliente, host/interface, modo, runtime, direção, tráfego,
  capacidade, decisão, blockedReason, policy e ações. Detalhes e gatilhos
  permanecem no drawer. Não existe fallback para uma tabela gigante no mobile.
- Alertas: filtros, cards, listagem, paginação, drawer e modal. Em landscape
  curto, o módulo inteiro pode rolar verticalmente para preservar a lista.
- Diagnóstico VSI: seletores, health cards, andamento, stepper, resultado,
  topologia com scroll local, contexto por PE, limitações e evidências.
  Contratos e conteúdo técnico RC13 preservados.
- Físico: navegação POP/rack em sheet, rack/chassis em palco com scroll local,
  catálogo, inspetor, módulos, portas e dialogs acessíveis.
- Home é a própria workspace do mapa; não há dashboard separado nesta linha.

## Verificação reproduzível

```powershell
npm ci --ignore-scripts
$env:TZ='UTC'
npm run test -w @gmj/web -- --maxWorkers=2
npm run typecheck -w @gmj/web
node node_modules/eslint/bin/eslint.js apps/web/src e2e/responsive playwright.responsive.config.ts --max-warnings=0
node node_modules/@playwright/test/cli.js test -c playwright.responsive.config.ts
$env:NETVISION_INSTALLATION_ID='IMPLANTAR'
npm run build -w @gmj/web
git diff --check
```

UTC é usado apenas nos testes porque um teste legado de snapshot espera o
horário UTC literal; o produto conserva o fuso do usuário. A identidade
IMPLANTAR usa o mecanismo existente, sem mudar feature flags. Não foi feito
build API nem iniciado processo API.

Playwright/Chromium executa a aplicação real com fixtures interceptadas no
browser. São dados controlados, não uma sessão autenticada contra produção.
Há 72 cenários: nove tamanhos × mapa e seis áreas, RUNNING, mouse/roda/barra,
touch real via CDP e painéis/modais em retrato, landscape e tablet.

Viewports: **360×800, 390×844, 412×915, 844×390, 768×1024, 820×1180,
1024×768, 1366×768 e 1920×1080**. O mapa tem início/meio/fim e busca em cada
um, com testes de acionabilidade até NOC, Editar, Descobrir, Links, Config,
Usuários e Sair. As seis áreas têm conteúdo e detalhes em todos os nove.

Testes específicos cobrem drag, interativos, seleção de texto, cancelamento,
click, teclado, fades, portal, fechamento, toolbar completa e navegação.
Os testes visuais medem document/body/app, geometria do canvas, limites dos
drawers e ausência de erro JavaScript.

Logs, contagem final, screenshots e SHA: `.artifacts/responsive/`.
A galeria `index.html` permite filtrar as capturas por tela e viewport.
O arquivo `RELATORIO-FINAL.md` registra o resultado final dos checks e caminhos.

## Regressões corrigidas e revisão humana

Foram corrigidos clipping da busca, desaparecimento de controles por breakpoint,
offsets fixos do header, legenda alta cobrindo o mapa, mínimo intrínseco do grid
VSI causando overflow ao abrir evidências e colapso da listagem de Alertas em
844×390. O callback de animação após desmontagem do canvas também foi corrigido.
A contagem de estados BGP foi atualizada para conferir tabela e cards.

A validação automatizada cobre Chromium. Safari, Firefox e dispositivos físicos
não foram usados nesta missão. A aprovação visual do operador segue pendente;
as capturas são evidência e não substituem essa aprovação. Nenhum deploy foi
realizado ou autorizado por esta entrega.
