# AUTO-ALL: snapshot legítimo e homologação isolada

Base preservada: `2046278`. Branch: `fix/pilot-snapshot-homolog`.
Worktree: `C:\projetos\GMJ-NetVision-pilot-homolog`.
Evidências externas: `C:\projetos\artifacts\pilot-auto-all-homolog-20261105`.
Horários dos JSONs em UTC; screenshots usam o horário local de Brasília.

**GO técnico para auditoria independente e uso isolado em HOLD.** A entrega real
de mais 23 eventos após a janela de 30 minutos permanece **PENDENTE**, conforme
a orientação de encerrar sem essa espera. Não se declara homologação temporal
real integral. **NO-GO para produção ou execução BGP física.**

## Causa exata de PILOT_SNAPSHOT_UNAVAILABLE

`registerRoutes()` solicita `mitigationService.rehydrateSnapshots()` no
`onReady`. Havendo qualquer falha, ou nenhum equipamento reidratado com sucesso,
a guarda impede `app.ready()` e `listen()`. Ela permanece exatamente igual.

O snapshot não é uma linha de `BgpMitigationProfilePeer`: é o cache de discovery
do `BgpMitigationService`, reconstruído por processo. A reidratação usa os
equipamentos dos perfis e chama discovery com `persistence=SNAPSHOT_ONLY`.
O contrato exige:

1. `Device` com SSH habilitado e interfaces/ifIndex/banda identificáveis.
2. `BgpPeer` persistido e correlacionado por `interfaceId`, com família e dados
   de sessão. `PrismaBgpRepository.listDashboardPeers()` fornece essas linhas.
3. `persistedPeersToBgpOutcome()` produz o resultado BGP usado pela classificação.
4. A leitura agregada de configuração resolve peer → policy IN → nodes reais
   do fixture. Descriptions com banda, identidade e planejamento passam pelos
   parsers e validadores existentes.
5. O serviço repovoa seu cache, tornando `snapshotAvailable` e readiness válidos.

Sem `BgpPeer`, o fallback tenta `discoverMitigationProfiles(..., SNAPSHOT_ONLY)`;
esse caminho é deliberadamente rejeitado com
`READ_ONLY_DISCOVERY_REQUIRES_PERSISTED_PEERS`. O resultado degrada e a guarda
externa apresenta `PILOT_SNAPSHOT_UNAVAILABLE`. Apenas adicionar relacionamentos
do perfil não satisfaz esse contrato.

O controle negativo criou um perfil e um `BgpMitigationProfilePeer`, sem
`BgpPeer`, em outro banco novo. O boot falhou com a guarda esperada. O seed
positivo passou pelo SSH simulado local, `BgpDiscoveryService`, correlação de
interfaces, persistência dos peers e discovery `REGISTER_NEW`. Os 23 perfis
foram criados pelo serviço; a configuração AUTO/95% foi aplicada explicitamente
apenas aos perfis sintéticos. Cada API reidratou seu próprio cache no boot.

## Correções de integração

- AUTO-ALL embutido em HOLD agora usa o `MitigationAutoEngine` canônico, sua
  confirmação e seu publisher de detecção durável. O caminho de piloto externo
  permanece para sua configuração original; não se injeta `pilotTraffic` no
  caminho embutido em HOLD. Isso evita criar avisos de reconciliação física do
  piloto durante o boot de uma avaliação informativa.
- A fonte `PriorityTrafficSource`, a janela de sampling e a elegibilidade de
  Growth reconhecem o escopo dinâmico AUTO-ALL. Antes exigiam a lista estática,
  apesar de o coletor já medir os 23 perfis. A ausência de amostra FAST válida
  continua fail-closed, sem fallback para LEGACY.
- O runtime aguarda o lifecycle estar pronto e, em AUTO-ALL, a posse da lease.
  A segunda API serve diagnósticos, mas não conta as observações da primeira.
- A conexão exclusiva da lease força `connection_limit=1`,
  `max_idle_connection_lifetime=0` e `max_connection_lifetime=0`. O pool geral da
  aplicação não é alterado. A aquisição, verificação de PID, perda de posse e
  liberação do lock permanecem iguais.

O ensaio encontrou uma reciclagem de sessão aos cinco minutos, que parou a
coleta corretamente, mas impedia a continuidade da homologação. Uma sonda local
reproduziu trocas de PID com lifetime/idle de três segundos; com idle zero o PID
permaneceu estável. O teste PostgreSQL valida os parâmetros exclusivos, a
exclusão de outro proprietário e a perda real de conexão. A documentação do
[pool Prisma](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool)
também descreve os parâmetros e o default de idle do motor v6.

O painel candidato ganhou acompanhamento somente de leitura: clientes,
elegibilidade, interfaces monitoradas, RX/TX, utilização, progressão,
confirmação, lease e execução física desabilitada. Os dados vêm dos endpoints
reais. O hook opcional de simulação altera apenas os contadores do equipamento;
é rejeitado quando o leitor guardado `SIMULATED` não está selecionado.

## Resultado verificável

| Verificação | Estado | Evidência |
| --- | --- | --- |
| Seed incompleto bloqueado / seed legítimo aceito | PASS | logs de boot negativo e positivo |
| `app.ready()`, `listen()`, health e `demoMode=false` | PASS | `boot-success.json` |
| 23 AUTO IPv4, 23 elegíveis, 23 interfaces monitoradas | PASS | seed, timeline e Playwright |
| Dois episódios por cliente, `1/3 → 2/3 → 3/3` | PASS | `progressions.json`, 46 eventos |
| Growth de amostras FAST, congelado no cruzamento medido | PASS | replay exato dos 46 blocos a partir das observações persistidas |
| Recepção HTTP local e retries byte a byte idênticos | PASS | 46 identidades, 230 recepções reais |
| ACK positivo e estado `SENT` | PASS parcial | 23 eventos enviados |
| Entrega restante após janela real de 30 minutos | **PENDENTE** | 23 registros `PENDING` preservados; não aguardada por orientação do usuário |
| Limites temporais com relógio injetado apenas em memória | PASS | três testes novos, incluindo deadline −1 ms e deadline exato |
| Dois processos: somente um coletor/proprietário | PASS | segunda API com zero coletas e zero decisões |
| Perda de lease na API real | PASS | detecção em cerca de 8,8 s; observações estáveis por mais 11 s |
| Comandos BGP físicos / conexões Huawei / n8n produtivo | PASS | zero; SSH somente no fixture de loopback, com allowlist de leituras |
| Typecheck e build de todos os workspaces | PASS | logs `typecheck-release.log`, `build-release.log` |
| Lint dos arquivos alterados | PASS | `lint-changes-final.log` |
| Lint global | **FAIL preexistente** | cinco diretivas não utilizadas em `server.ts`, idêntico à base |

Foram aprovadas **4.566 regressões**, mais **três testes temporais novos** e
**um teste PostgreSQL novo**: 4.570 casos únicos executados nesta tarefa.
Os oito testes unitários de lease reexecutados junto ao PostgreSQL já integram
o total de regressões. Os 48 opcionais preexistentes aprovados na base não foram
repetidos nas portas vedadas; o novo opcional de lease foi executado
explicitamente na porta nova. Após a orientação de encerramento, não foi
iniciada outra bateria prolongada.

As confirmações levaram **10.355–15.320 ms**; `decisionMs`, que mede a avaliação
do motor e não a janela inteira, ficou em **1–9 ms**. O atraso entre amostra e
avaliação ficou em **42–4.981 ms**. `decision-times.json` e CSV registram os 46
eventos individualmente, com `firstAbnormalAt`, confirmação e recepção HTTP.

O primeiro episódio conservou baseline de 20% e snapshot de 95%, mesmo com
confirmação a 98%. No segundo, 20 clientes obtiveram baseline de 40% e três de
41,9%: nestes, duas leituras em torno de 95% ficaram numericamente abaixo do
limiar na taxa original e o primeiro cruzamento medido ocorreu a 99%.
`growth-replay.json` inclui a amostra anterior e a do cruzamento e confirma
integralmente os valores recebidos. O Growth aprovado não foi reescrito nem
substituído por métricas fabricadas para uniformizar o ensaio.

Todos os eventos são `MITIGATION_DETECTION_BLOCKED`, `verified=false`, com
`AUTO_EXECUTION_DISABLED`. Confirmação de detecção não é mitigação aplicada.

## Isolamento, estado final e pendência

Container novo: `gmj-pilot-homolog-4d8154ed73`, ID
`463dee9e974a37c870d644e7864136771c813b1107d65508db904ea79875976e`.
PostgreSQL em tmpfs, ligado somente a `127.0.0.1:55448`.
Banco final: `pilot_auto_all_homolog_verified_20261105`.
Os bancos de controle e ensaios anteriores desta tarefa também foram mantidos.
`nv-autoatest-pg`, seu volume, as portas 55433/55439/55077 e os 23 perfis
anteriores não foram usados. O ID e horário de início do container anterior
continuaram iguais; nenhuma conexão SQL foi feita nele.

O host, porta, database, label e identidade do container foram verificados
antes da criação de schema e de cada seed. Não foram copiados dados ou
credenciais produtivos. Peers usam endereços de documentação `192.0.2.0/24`;
as conexões de equipamento, API, WEB e webhook usam loopback. O processo de API
inclui bloqueio de sockets externos no launcher de homologação.

As APIs, WEB, navegador e fixtures foram encerrados. **O PostgreSQL descartável
permanece em execução para revisão**, com os 23 perfis e o outbox intactos.
`synthetic-database.sql` é um backup exclusivamente sintético, sem os dados de
sessão de login. `local-config.json`, mantido fora do pacote versionado, contém
somente as credenciais novas deste ambiente.

Os testes de tempo avançam somente uma variável passada ao construtor do outbox
em `MemoryAutomationStore`, sem banco ou destinatários reais. Validam:
deduplicação a 30 minutos −1 ms e no limite exato, retries a 30/60 segundos,
teto de backoff de dez minutos e payload estável. Não alteraram o relógio do
sistema, os timestamps do banco, as configurações produtivas ou os mecanismos
reais de segurança. No ensaio HTTP os ACKs só foram aceitos quando o transporte
real voltou a tentar pelas regras originais. A janela real restante não foi
antecipada e ficou explicitamente pendente.

`isolation.json` compara 19 arquivos protegidos com `2046278`: motor AUTO,
lifecycle, autorizações, comandos, Growth, transporte, outbox e schema. A guarda
de snapshot e as operações de lease também foram comparadas. Nenhum deploy,
merge, push, escrita BGP, acesso n8n produtivo ou alteração em GMJ-FLOW/SENTINELA
foi realizado.

## Reprodução local

O `run-homolog.ps1` anterior não estava nos worktrees/artefatos examinados.
O launcher reproduz o contrato dos nomes completos do código real, aplicando
todas as variáveis juntas no ambiente de cada processo filho, antes dos imports.
Ele fixa permanentemente o ensaio em `MOCK`, live write falso, execução AUTO
zero e remoção zero. `NETVISION_INSTALLATION_ID=IMPLANTAR` só é usado após
validar o container e o banco descartáveis.

1. `tools/homolog/prepare-postgres.py` cria outro container e bancos vazios
   quando a porta de teste estiver livre; não aponta para bancos existentes.
2. `tools/homolog/run-homolog.ps1` ou o launcher TypeScript executa o controle
   negativo, discovery legítimo e as duas APIs. `--resume` reutiliza apenas os
   23 perfis já criados no container explicitamente validado.
3. O stdin controla somente o equipamento sintético e seu receptor:
   `{"action":"traffic","fraction":0.2}`, depois 0.95/0.98, recuperação 0.4
   e novo cruzamento. Não envia eventos ou decisões artificiais à API.
4. `tools/homolog/browser.mjs` usa Playwright real contra WEB/API locais, com
   login real e sem interceptação HTTP. O pacote utilizado neste ensaio foi
   Playwright 1.64.1 com Chromium local já instalado.
5. `replay-growth.ts` e `tools/homolog/assert-results.py` conferem dados reais.
   `--allow-policy-pending` apenas documenta a pendência no verificador; não
   altera nenhuma configuração de deduplicação ou runtime da aplicação.

As screenshots e o índice dos JSONs estão em `docs/evidence/pilot-auto-all/`.
O pacote externo contém as recepções HTTP completas originais, logs, CSV,
backup sintético, diff, commits exportados e hashes para auditoria independente.
