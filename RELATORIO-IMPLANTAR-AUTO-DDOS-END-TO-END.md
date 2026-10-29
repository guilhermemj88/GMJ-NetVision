# GMJ NetVision IMPLANTAR — preparação AUTO DDoS end-to-end

Data: 29/10/2026. Trabalho exclusivamente em branch/worktree isolada e consultas de produção somente por leitura.

**Decisão: GO técnico para revisão do código e preparação da fase API-only com AUTO=0. NO-GO para habilitar ACTIVATE/REMOVE AUTO agora.** Não houve publicação, restart, mudança de flag, migration, comando Huawei ou alteração no n8n de produção. VNT, Fibinet e o projeto principal Windows não foram modificados.

## Proveniência e entrega

| Item                                        | Identificação                                                   |
| ------------------------------------------- | --------------------------------------------------------------- |
| Commit da implementação auditada/empacotada | `bdc3514f16b7e7833064abf61823a307d275a944`                      |
| Branch própria                              | `feature/implant-auto-ddos-e2e`                                 |
| Worktree                                    | `C:\projetos\GMJ-NetVision-auto-ddos-e2e`                       |
| Base imediata                               | RC14-F corrigida `dfb7b362ad86bf9a72fdcf8b60a1a75b47c8a19c`     |
| Antecessora RC13                            | `d6c07f24e0352c3e9d6fae9672979a396dc72870`                      |
| Pacote                                      | `.artifacts/auto-ddos-e2e/implant-auto-ddos-api-bdc3514.tar.gz` |
| Arquivo fonte exato                         | `.artifacts/auto-ddos-e2e/source-bdc3514.tar`                   |

O commit da implementação contém oito arquivos de runtime novos/alterados: coordenador, store, outbox, prova independente, command service, reconciler, transporte n8n e composição em `routes.ts`. Inclui dois arquivos de testes, dois scripts de auditoria isolada, schema/migration aditivos e documentação. O commit posterior de entrega acrescenta relatório, evidências, exemplos e inventário BGP à matriz; não altera o código da API empacotada. A branch original do DeepSeek foi preservada.

Não há delta WEB/MCP, alteração de thresholds/perfis reais, feature Huawei LP3000 ou integração de outras frentes. A API atual de produção continua RC13. O pacote novo é candidato para publicação posterior, não uma release publicada.

## Inventário real e integridade da produção

Janela comparada: **11:39:24–12:27:02 UTC**, 08:39:24–09:27:02 de Brasília. Snapshot FAST adicional às 12:03:52 UTC. Todos os acessos PostgreSQL usaram transação READ ONLY, timeout de statement e lock; nenhuma telemetria ou estado operacional foi escrito.

| Serviço | PID antes/depois | CWD efetivo                                                                                        | Resultado                               |
| ------- | ---------------: | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| API     |          2950906 | `/opt/netvision-fast-bridge/releases/rc13-d6c07f2/apps/api`                                        | active/running; NRestarts=0; health 200 |
| WEB     |          2976909 | `/opt/GMJ-NetVision-web-responsive/releases/f4b31fc31dd0ffdc7d454157822a3e85c5a5e8b8/web/apps/web` | active/running; NRestarts=0; `/` 200    |
| MCP     |          2950907 | `/opt/netvision-mcp/releases/mcp-5874fe0`                                                          | active/running; NRestarts=0; health 200 |

API efetiva SHA256 `29d8b03f272b99b78fd784ff06ced0526b1092c9b5f113f2954653ec2c918fe9`, igual antes/depois. Configurações systemd, ambiente efetivo dos processos, CWD, start ticks e `.env` principal permaneceram iguais. WEB BUILD_ID consultado ao final: `NSfXEDCQk4S1AmACLROnj`. API continua `demoMode=false`, `snmpPolling=true`. Disco: **7,1 GB livres, 90% utilizado**, sem limpeza feita por esta missão.

Contagens de eventos iguais antes/depois: **4 ACTIVATE, 4 REMOVE e 3 SIMULATION**. Últimos ACTIVATE/REMOVE registrados em 18/10 e 19/10, respectivamente. Nenhum novo evento de ativação/retirada durante a janela; estados e configuração dos 38 perfis permaneceram iguais. Isso comprova o intervalo observado, não impede uma futura execução pelo código antigo.

Há 22 drop-ins da API e o fragmento principal: 23 arquivos unit. Backup de 41 arquivos de configuração referenciados foi coletado por leitura, cifrado com Windows DPAPI e decifrado somente em memória para conferir todos os hashes. Nenhuma cópia plaintext foi gravada. O backup depende do usuário Windows atual; a implantação futura deve ter também cópia protegida recuperável no servidor.

Foram identificados serviços preview adicionais e o observer externo `netvision-fast-observer` ativo. Não foram alterados. O preview DDoS consultado informa LIVE_WRITE=false. A auditoria de flags em `/proc` não substitui a revisão de dotenv/código de todos os previews: uma janela de homologação deve assegurar exclusividade do writer Huawei e controlar alterações externas à API alvo.

### Flags e risco vigente da RC13

Produção: `MITIGATION_MODE=AUTO`, executor HUAWEI, LIVE_WRITE=true, device permitido `host-377c554a-8d1e-47c4-baa4-f258693b4d91`, AUTO_EXECUTION_ENABLED=0. O observer externo fornece o FAST; não foi reiniciado. Bridge ENFORCE com roteamento para 12 perfis e autorização FAST específica para BHNET. As listas de perfis do motor, exceções legadas e roteamento são distintas; constam nos snapshots.

**M8=0 da RC13 não é garantia global contra AUTO manual/legado.** Essa limitação continua na produção antiga porque esta missão proíbe alterar flags/reiniciar. O retorno à RC13 exige SIMULATION_ONLY + LIVE_WRITE=false, preservando executor e device allowlist, conforme o rollback abaixo.

## Matriz dos 38 perfis

Entrega completa: [matriz CSV](docs/audits/auto-ddos-20261029/MATRIZ-38-PERFIS.csv) e [visão legível](docs/audits/auto-ddos-20261029/MATRIZ-38-PERFIS.md).

- **12 AUTO e 26 ALERT_ONLY**, modos preservados. Os 38 registros estão enabled=true; 37 runtimes NORMAL e um DISABLED. Runtime NORMAL não significa readback físico novo.
- **5 candidatos estruturais à homologação IPv4 dedicada:** 73S, AGLINK, CLICKING, PLAYCONNECT e SUPERNET. Nenhum foi aprovado ou habilitado por esta missão. PLAYCONNECT tem um peer ACTIVE e outro ESTABLISHED no snapshot persistido; exige revisão adicional.
- **7 AUTO com policy compartilhada** ficam bloqueados no novo coordenador: BHNET (.3043/.3044), FLASH (.3066), HORIZONTES (.3011), JUSTNET (.2519/.3962) e RNJ (.3026).
- Os **26 ALERT_ONLY devem permanecer assim** até uma avaliação/autorização própria. IPv6 fica fora do piloto; não foi promovido ou alterado.

Direção efetiva: **20 TX e 18 indefinidas**, considerando perfil > ENV > interface. Quatro TX são resolvidas por ENV; 16 vêm da interface. Não existe default TX para todos. O CSV registra origem por perfil. Banda efetiva contratada: 10/20/40 Gbps, distinta da velocidade física do trunk. Todos os perfis configuram trigger=90%, recuperação=70%, triggerSamples=3, recoverySamples=12, intervalo do motor=5 s. CSV fornece limiares em bps, RT, nodes planejados, famílias, peers, compartilhamento e histórico.

O FAST apresentou **12 interfaces com observações VALID**, intervalos próximos de 10 s e estados administrativos/operacionais UP no snapshot. Isso não comprova normalização independente durante mitigação. O inventário BGP persistido tem 41 vínculos: 24 ESTABLISHED, 13 ACTIVE, 2 CONNECT e 2 IDLE; não foi executado discovery/CLI novo para fabricar uma homologação. Frescor BGP, prefix limits e par/RT físico devem ser revalidados na homologação aprovada.

## Segurança e comportamento implementados

O caminho de escrita continua canônico: motor FAST → coordenador durável → `MitigationCommandService` → lock por device/policy → preflight → executor Huawei → readback. O observer não recebeu mecanismo de escrita.

Barreiras: instalação IMPLANTAR, feature de persistência/lifecycle explícitas, M8, allowlist positiva de perfil e dispositivo, alvo READY/SAFE, direção TX, fonte FAST, thresholds válidos, par positivo/distinto, policy dedicada, ausência de outra família AUTO competindo. Exceções antigas não dispensam esses gates. AUTO não aceita executor MOCK como comprovação de produção.

M8 é reavaliado depois da autorização assíncrona, imediatamente antes da escrita. Reconhecimento AUTO inclui origin, requestId de ACTIVATE/REMOVE, autoEvidence e identidade de journal. Falha de autorização durável impede SSH mutante. As operações manuais passam pelo caminho antigo com hooks de ownership apenas quando a feature de persistência estiver ligada.

Reserva transacional impede concorrência por escopo e impõe **maxActive=1 por padrão**, contando operações em execução/ACTIVE/UNCERTAIN. Cooldown padrão 600 s e permanência mínima 900 s. Policies compartilhadas não recebem exceção automática. Alterar configuração/ownership ou divergir readback coloca o escopo em UNCERTAIN, preservando a mitigação e consumindo capacidade até revisão.

ACTIVATE idempotente de uma policy preexistente não cria ownership AUTO. ACTIVATE/REMOVE manual e APPLY LOCAL revogam ownership sob a mesma policy lock. Após reinício, operação interrompida não é reexecutada às cegas; ACTIVE persistido só permanece elegível após novo readback exato de par/RT/configuração. O journal autoriza cada comando uma única vez.

### REMOVE e prova de recuperação

**TX baixo no cliente após desvio BGP não prova que o ataque terminou.** Foi implementada prova adicional por interface independente, explicitamente mapeada e homologada. Deve medir tráfego oferecido ao alvo mesmo durante a mitigação. Nenhum perfil de produção recebeu esse mapeamento.

Recuperação exige amostras novas distintas, histerese, recoverySamples, duração mínima e hold. Stale, ausência, gap, interface DOWN, contador inválido ou direção desconhecida não normalizam. O adapter valida identidade/dispositivo, UP, taxa utilizável e intervalo/frescor máximo de 15 s. Não aceita a própria interface mitigada como prova independente.

Antes de REMOVE: ownership AUTO exata, escopo/família/RT/par/configuração imutáveis, readback físico MITIGATED reconhecido e nova validação da prova independente dentro do lock, após preflight. REMOVE não ocorre com readback falho. Depois da escrita, só `REMOVED_VERIFIED` com readback e runtime sincronizado gera alerta de retirada verificada. Falha mantém estado incerto, sem inventar sucesso.

O polling atual não comprovou uma fonte independente com esse contrato; **não está homologado um ciclo real de REMOVE automático**. Essa é uma pendência operacional obrigatória, não um requisito contornado pelo código.

## Persistência e integração de alertas

Uma tabela aditiva `MitigationAutomationRecord` registra ownership, command intents/resultados, episódios, aliases de episódios do motor, outbox e rate limit. Não altera dados/colunas existentes. Transações de state são curtas, sem SSH/HTTP dentro do lock de banco.

Aliases persistentes impedem que retry de um episódio já recuperado crie outro evento. Após restart, um ataque ainda aberto mantém identidade; recuperação positiva fecha o episódio, sem apagar alerta pendente. Resultado do comando, estado da ownership e notificação são persistidos juntos. Falhas conservam evidências.

Outbox: IDs/payload estáveis, lease 60 s, até 12 tentativas, backoff 30–600 s; depois FAILED retido. Rate limit de detecção: 30 min/perfil, durável. Notificações de controle têm prioridade sobre backlog de detecção; registros futuros não bloqueiam uma retirada verificada. Entrega só é confirmada com **HTTP 2xx e delivered=true**. O endpoint read-only autenticado `/api/bgp/mitigation/auto/lifecycle` expõe flags, limites e contagens por kind/status para monitoramento.

Endpoint de produção configurado: `https://automacao.gmjtelecom.com.br/webhook/netvision-mitigation`, canal BGP_MITIGATION habilitado, segredos outbound e inbound presentes. Nenhum valor foi impresso. Header outbound `X-NetVision-Token` é distinto da credencial Authorization/Bearer de retorno. Não foram enviadas mensagens reais, testados segredos contra o n8n real ou alteradas credenciais dos três comandos de retorno.

A proposta [patch outbound n8n](docs/n8n/AUTO-DDOS-STATUS-OUTBOUND-PATCH.json) adiciona ramo de retirada verificada/falha sem botões e preserva os comandos existentes no fixture. É derivada do fixture RC7.1, **não do export real RC7.1.1**. Precisa de merge/revisão no workflow publicado pelo operador, sem substituir fluxos VNT/Fibinet.

## Testes e evidências

| Verificação                                                             | Resultado                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Suíte completa API                                                      | **2.574 aprovados, 23 ignorados, zero falhas**; 179 arquivos aprovados, 4 ignorados                      |
| Testes novos de lifecycle/outbox/HTTP                                   | **59**, incluídos na suíte completa                                                                      |
| Typecheck API                                                           | Verde                                                                                                    |
| ESLint API `--max-warnings=0`                                           | Verde                                                                                                    |
| Prettier nos arquivos TS/MD/JSON alterados                              | Verde                                                                                                    |
| Diff check com CRLF reconhecido (`cr-at-eol`)                           | Verde; formato histórico do schema preservado                                                            |
| Migrations em PostgreSQL 16 vazio                                       | **43 aplicadas**                                                                                         |
| Migração incremental de baseline com 42 registros/checksums de produção | **Somente a migration nova aplicada**                                                                    |
| Store PostgreSQL real descartável                                       | 20 transações concorrentes; rollback; reconexão; lease; BigInt; uma entrega                              |
| Reversão estrutural ensaiada                                            | Rename da tabela/índice em transação + ROLLBACK; registros/índices preservados                           |
| RC13 real em worktree isolada                                           | 15 testes das barreiras de rollback passaram; 38 testes do M8 novo intencionalmente ignorados nessa base |
| n8n 2.45.4 isolado, rede interna e Telegram fake                        | Auth 403; quatro eventos entregues/ACK; retirada inválida 200/delivered=false; falha Telegram 500/retry  |
| Build API Linux                                                         | Dois builds com hashes idênticos de `server.cjs` e mapa                                                  |
| Smoke do pacote Linux                                                   | Health 200, DEMO=true/SNMP=false; biblioteca Prisma Linux carregada; rede desconectada                   |

Testes comportamentais usam o motor real, command service e executor Huawei com porta SSH fake: ativação, retirada, readback, timeout após escrita parcial, reinício nas duas operações, revogação manual, contenda, capacidade, flapping, samples duplicadas/stale/ausentes, mudança de prova durante preflight e ausência de ownership. A suíte anterior de paridade manual IPv4/IPv6, escopo compartilhado, FAMILY_CONTENTION, readback legado e policies sem LP3000 continua verde.

O replay histórico incluído na suíte usa amostras reais normais da FLASH .3066; não é prova de ataque real. Casos positivos usam dados sintéticos somente em memória. **Nenhum resultado de mock foi apresentado como readback físico ou homologação Huawei.**

A primeira execução da suíte a partir do diretório superior falhou por ENOENT nos testes que usam cwd; foi corrigida a invocação para o workspace da API, sem enfraquecer testes existentes. A composição inicial n8n isolada detectou colisão de variável na expressão; o patch final corrigiu o escopo e passou dinamicamente. A suspeita inicial de drift de migrations foi esclarecida: quatro diferenças eram apenas LF/CRLF. Arquivos históricos e `_prisma_migrations` de produção foram preservados.

Evidências brutas e scripts: `.artifacts/auto-ddos-e2e/`. Índice com hashes: [EVIDENCIAS.json](docs/audits/auto-ddos-20261029/EVIDENCIAS.json). Backup cifrado e manifesto completo do pacote permanecem nesse diretório local, fora do Git.

## Artefato reproduzível

| Item                    | Valor                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Node / npm / plataforma | 24.19.0 / 11.17.0 / Linux x64                                             |
| Imagem base             | `sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24` |
| SHA256 source tar       | `35c31170c6d21bdf186c28e8c5bfcc8a30a8ab87b563323dc658087d2eecddaf`        |
| SHA256 server.cjs       | `e89eece6a7835d2833c48ec4edb899d70f5327105c8d615afaee8f740b0b24ca`        |
| SHA256 server.cjs.map   | `ae618755271b3d0a26aa0dcf1580c4574ddc7aa6b1c6ec1fdf87c8fb20f9eac8`        |
| SHA256 pacote tar.gz    | `417fe56364998cee34bec1839459fb52d21da89cfc385b4aa8ce10dd7a54c00d`        |
| Pacote comprimido       | 95.533.570 bytes                                                          |
| Conteúdo                | 10.068 arquivos; 300.238.437 bytes, sem contar manifesto externo          |

O pacote contém API, dependências de produção, Prisma gerado Linux, lockfile e schema/migrations. Não inclui publicação de WEB/MCP/observer/worker, `.env` ou credenciais de produção. O build normal do workspace também gera bundles diagnósticos do observer/worker, mas eles não foram incluídos na release API-only.

Dependências dev foram removidas do pacote; **o CLI Prisma para a futura migration deve ser preparado separadamente a partir do mesmo lockfile, versão 6.19.3**, em ferramenta/release isolada aprovada. Não usar npx sem versão ou instalar migrations automaticamente ao iniciar a API. A fase 0 usa persistência=0 e não exige aplicar a tabela nova.

## Limitações e riscos residuais

1. Falta homologação física dedicada e prova independente de recuperação; não há GO para escrita AUTO real. Frescor BGP, prefix limits, units, peers e escopo devem ser confirmados na janela aprovada.
2. O n8n/Telegram real não foi exercitado nesta missão; configuração presente e histórico 200 não comprovam o novo contrato. O export RC7.1.1 real precisa ser revisado/mesclado.
3. A outbox oferece at-least-once. Se Telegram receber e o ACK/commit se perder, o retry pode duplicar; não há ledger transacional no destino. EventId estável facilita auditoria, mas não é exatamente uma entrega. A durabilidade começa no commit; não há replay retrospectivo completo de eventos nunca persistidos antes de uma queda.
4. Escrita física e commit PostgreSQL não são uma transação distribuída. Crash/timeout intermediário gera UNCERTAIN e exige operador, preservando a mitigação. Não existe replay físico automático inseguro para tentar esconder essa limitação.
5. Mudança manual idêntica feita diretamente no Huawei, fora da API, não pode ser atribuída causalmente apenas pelo readback. Homologação exige exclusividade do writer e controle de mudança externo. Revogação automática de ownership cobre UI/n8n/APPLY LOCAL desta API.
6. A fonte independente por interface depende de instrumentação/direção corretas e cadence validada. Agregação inadequada ou contador afetado pelo desvio não podem ser aprovados como prova por conveniência.
7. Avaliações reais de latência/carga com PostgreSQL/SSH dos clientes ainda precisam de janela controlada. FAILED/UNCERTAIN/backlog e espaço em disco devem ser monitorados; não foi criada limpeza automática de evidências. Retry esgotado fica retido para revisão.
8. Na RC13 vigente, AUTO_EXECUTION_ENABLED=0 isoladamente continua insuficiente; rollback precisa congelar também a escrita manual temporariamente. A missão não tinha autorização para mudar esse estado agora.

## Implantação gradual, rollback e autorizações

Roteiro detalhado: [AUTO_DDOS_ACTIVATION_PLAN.md](docs/AUTO_DDOS_ACTIVATION_PLAN.md). Propostas concretas de drop-in/EnvironmentFiles em `docs/deploy/`; nenhuma foi instalada.

| Fase                               | GO/NO-GO                                    | Autorização/evidência ainda necessária                                                  |
| ---------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Implementação e ensaios isolados   | **GO técnico**                              | Revisão do commit auditado                                                              |
| API-only com AUTO=0/persistência=0 | **Preparada; não executar sem autorização** | Janela de publicação/restart API, backup recuperável e revalidação dos gates            |
| Migration/outbox de produção       | **NO-GO operacional**                       | Aprovar a única migration nova, ferramenta Prisma pinada, backup e n8n real             |
| Homologação física IPv4            | **NO-GO**                                   | Escolher perfil dedicado, janela, RT/par/família e cada ACTIVATE/REMOVE real            |
| AUTO ACTIVATE de um perfil         | **NO-GO**                                   | Homologação e aprovação explícita da ativação, allowlist unitária/maxActive=1           |
| AUTO REMOVE/ciclo completo         | **NO-GO**                                   | Fonte independente homologada, ciclo físico/readbacks e Telegram recebidos              |
| Expansão                           | **NO-GO**                                   | Resultado do piloto e aprovação individual; compartilhadas/IPv6 fora do primeiro escopo |

Paradas objetivas: saúde diferente de 200, versão/configuração inesperada, espaço insuficiente, command sem intent/STARTED, escrita fora da allowlist, readback divergente, family contention/compartilhamento não permitido, perda/gap de telemetria, UNCERTAIN/FAILED, entrega sem ACK ou impacto em cliente. Não retirar mitigação ativa automaticamente para encerrar um ensaio.

Rollback preferencial para RC14-F corrigida, se release Linux íntegra aprovada existir. Para RC13: impor **SIMULATION_ONLY + HUAWEI + LIVE_WRITE=false + M8=0 + sweep=0**, desligar novo lifecycle/persistência/REMOVE e preservar a allowlist de dispositivo. Não depender de allowlist vazia de perfil nem trocar executor para MOCK. Isso congela ACTIVATE/REMOVE manual temporariamente, preserva policies e evita remoção automática. Manter a tabela aditiva e os dados; voltar o código não exige DROP ou restauração destrutiva do banco. Só restaurar operação manual após autorização e readback verdadeiros.

Após um futuro restart aprovado: verificar hash/CWD/PID/health/flags efetivas e NRestarts, outbox/status, logs e contagens de eventos; WEB/MCP/observer devem permanecer intactos. Aguardar aquecimento do discovery/cache e READY/SAFE antes de qualquer ativação. Esta missão termina **antes da primeira alteração operacional**.
