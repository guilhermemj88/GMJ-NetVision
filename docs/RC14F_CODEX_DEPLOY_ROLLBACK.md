# RC14-F — plano API-only corrigido pelo Codex

**Documento de preparação. Não executado. Publicação depende de autorização
explícita e separada do operador.** O parecer operacional atual está no
`RELATORIO-RC14F-CODEX-AUDITORIA-FINAL.md`.

## Base, correção e limites

Original DeepSeek: `e1a00e65aa1327acf6eadc2e18d6ef36f3b7ea30`, filho direto
da RC13 `d6c07f24e0352c3e9d6fae9672979a396dc72870`. O SHA candidato auditado
consta no manifesto de release, sem usar abreviações como identidade de build.

A auditoria corrigiu uma perda reproduzida: a recuperação eliminava um episódio
cujo webhook ainda não tinha sido entregue. Agora existe uma fila de entrega em
memória, independente do episódio ativo. Cada tick tenta entregas devidas antes
da leitura dos targets, mesmo sem telemetria nova. O episódio mantém seu ID e
seu primeiro payload; recuperações não fabricam novas detecções. As entregas
do mesmo perfil são serializadas; o intervalo mínimo continua sendo respeitado.
Sucesso e falha terminal removem a entrada da fila; a vida máxima de seis horas
limita retenção de pendências, com falha e log explícitos ao expirar.

Não há outbox durável. Crash/restart pode perder pendências e reemitir o mesmo
ataque com novo ID. ACK perdido pode duplicar uma entrega já feita. O rate limit
é por processo e não impede crash-loop. Portanto, **não prometer at-least-once
durável, exactly-once ou rate limit global**. A configuração episodeIdleSeconds
existe mas não encerra episódio por silêncio: recuperação positiva é obrigatória.

O detector usa tráfego acima da banda/threshold e histerese; isso não prova, por
si só, que o tráfego é malicioso. O produtor deste evento atende o caminho
AUTO/TX com escrita bloqueada; RX monitor-only e ALERT_ONLY não foram transformados
em um produtor genérico de alertas nesta missão. IPv4/IPv6 manuais permanecem
no caminho RC13, sem LP3000 e com as confirmações existentes.

## Proveniência e pacote reproduzível

Usar o arquivo Git do SHA final, package-lock inalterado, Node/npm/esbuild
registrados no manifesto e imagem Linux fixada por ID/digest. Executar somente:

```bash
npm ci --workspace @gmj/api --include-workspace-root --ignore-scripts --no-audit --no-fund
npm run typecheck -w @gmj/api
npm run build -w @gmj/api
```

Os hooks Prisma fazem **generate**, sem aplicar schema/migration e sem conexão
com banco de produção. O build não pode receber `.env` nem credenciais reais.
O pacote inclui somente runtime API e dependências Linux; não inclui WEB/MCP,
worker ou observer para publicação. Bundles auxiliares podem ser construídos
para validação, mas não serão instalados por esta troca API-only.

O script de empacotamento registra hashes e confirma o SHA do arquivo Git. A
recompilação Linux deve reproduzir os hashes de bundle/artefatos compilados;
tar gzip pode ter timestamp diferente e não é a identidade primária.

## Configuração efetiva encontrada

API ativa em `/opt/netvision-fast-bridge/releases/rc13-d6c07f2/apps/api`,
bundle SHA-256 `29d8b03f272b99b78fd784ff06ced0526b1092c9b5f113f2954653ec2c918fe9`.
O source map do bundle coincide com a RC13 nos cinco módulos críticos auditados.

Existem **22 drop-ins carregados**, além do fragmento principal: 23 arquivos
de unidade, não 23 drop-ins. A ordem e hashes estão nas evidências. Último atual:
`zzzzzzzzzzzzzzzzzzzz-rc13-d6c07f2.conf`. Há vários ExecStart/WorkingDirectory
históricos e referências repetidas ao mesmo EnvironmentFile. Não remover nem
reescrever esses arquivos nesta entrega.

Novo nome proposto: `zzzzzzzzzzzzzzzzzzzzzzzz-rc14f-codex.conf`, ordenado depois
dos existentes na auditoria. A lista deve ser revalidada no momento da publicação.

**EnvironmentFile tem precedência sobre Environment.** Um Environment tardio
sozinho não é uma barreira suficiente se outro arquivo de ambiente definir a
mesma variável. Acrescentar o arquivo de guardas por último na lista efetiva de
EnvironmentFile, sem resetar os arquivos com credenciais existentes.

## Pré-condições objetivas para publicação posterior

1. Autorização explícita para o SHA exato corrigido e para API-only.
2. Árvore limpa, diff aprovado, testes/build verdes, manifesto e hashes conferidos.
3. Resolver a pressão de disco antes de publicar. Política proposta: pelo menos
   5 GiB livres e uso abaixo de 95%, incluindo pacote, release, backup e logs.
   A auditoria encontrou 98% e cerca de 1,5 GB livres; nenhuma limpeza foi feita.
4. Revalidar PIDs, start ticks, NRestarts, CWDs, hashes de unidades/ambientes,
   bundle RC13, WEB BUILD_ID e health. Mudança externa invalida o baseline.
5. Confirmar o segredo outbound BGP_MITIGATION contra o Header Auth do webhook
   de mitigação, em comparação protegida, sem imprimir valores. Foi comprovado
   que o segredo de saída é decifrável e diferente do inbound; não foi obtido
   o valor da credencial do n8n de produção para comparar sua igualdade.
6. Não trocar as credenciais de retorno Authorization/Bearer dos três nós
   Command, Scope Confirm e Scope Cancel. Não usar esse segredo no header outbound.
7. Guardas de deploy e rollback prontos e revisados antes de qualquer restart.

## Troca controlada proposta — não executada

Preparar release nova em `/opt/netvision-fast-bridge/releases/rc14f-<SHA_COMPLETO>`
com o pacote validado. Preservar a RC13 e todas as suas dependências. Não fazer
npm install, pull/reset, build ou migration dentro de release ativa.

Criar na **release nova** `deploy-guard.env`, sem segredos:

```dotenv
MITIGATION_AUTO_EXECUTION_ENABLED=0
```

Esse arquivo não muda os demais valores operacionais; a escrita manual continua
dependente das três barreiras RC13. Proposta de drop-in:

```ini
[Service]
WorkingDirectory=/opt/netvision-fast-bridge/releases/rc14f-<SHA_COMPLETO>/apps/api
ExecStart=
ExecStart=/usr/bin/node /opt/netvision-fast-bridge/releases/rc14f-<SHA_COMPLETO>/apps/api/dist/server.cjs
EnvironmentFile=/opt/netvision-fast-bridge/releases/rc14f-<SHA_COMPLETO>/deploy-guard.env
```

O ExecStart precisa ser resetado: o atual usa um caminho absoluto RC13 e não
seria alterado apenas mudando o WorkingDirectory. A API usa a mesma chave de
criptografia e os mesmos canais do banco, sem copiar tokens para o drop-in.

Depois de conferir precedência/configuração e somente após autorização:

```bash
systemctl daemon-reload
systemctl restart netvision-api
```

Reiniciar **apenas API**. WEB/MCP/observer/nginx não fazem parte da troca.

Verificações dentro de 60 segundos: API active/running; PID novo e CWD/bundle
exatos; health 200, demoMode=false e snmpPolling=true; M8 exatamente 0 no ambiente
de startup e nenhum EnvironmentFile posterior; WEB e MCP nos mesmos PIDs e com
os mesmos artefatos/health. Não registrar o ambiente completo em logs.

Observar por pelo menos 10 minutos sem tráfego artificial: logs de inicialização,
rehidratação do discovery/cache (o startup já faz leitura Huawei e pode ficar
DEGRADED), fonte FAST/frescor/direção, decisões AUTO_EXECUTION_DISABLED e métricas
de entrega. Health 200 sozinho não comprova detecção nem Telegram. Sem telemetria
acima do gatilho, a ausência de alerta é controle negativo, não prova positiva.
Não disparar discovery manual, ACTIVATE/REMOVE ou teste de webhook nesta auditoria.

Interromper a publicação se: hash/SHA divergente; flag diferente de 0; PIDs de
WEB/MCP alterados; health não recuperar no prazo; worker instável; nova operação
ACTIVATE/REMOVE não atribuída ao operador; ou erro de autenticação/ACK do n8n.
Se houver evidência de escrita indevida, primeiro parar a API sob a autorização
operacional correspondente e aplicar o rollback congelado abaixo, sem remover
mitigação física existente. Não tentar limpar policies por SSH.

## Rollback RC13 fail-closed — comprovado em mocks, não executado

O roteiro do DeepSeek que usava apenas M8=0 foi rejeitado. A RC13 efetiva escapa
desse bloqueio para AUTO manual; a allowlist de execução vazia significa ausência
de restrição por perfil, e não bloqueio universal.

Preparar previamente `rollback-guard.env` fora da release descartável, protegido
contra escrita indevida, e um drop-in de nome ainda posterior ao da RC14-F:
`zzzzzzzzzzzzzzzzzzzzzzzzz-rc13-frozen-rollback.conf`.

```dotenv
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_MODE=SIMULATION_ONLY
MITIGATION_LIVE_WRITE_ENABLED=false
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_EXECUTOR=HUAWEI
# Preservar exatamente a allowlist de devices do baseline autorizado:
MITIGATION_ALLOWED_DEVICE_IDS=host-377c554a-8d1e-47c4-baa4-f258693b4d91
```

```ini
[Service]
WorkingDirectory=/opt/netvision-fast-bridge/releases/rc13-d6c07f2/apps/api
ExecStart=
ExecStart=/usr/bin/node /opt/netvision-fast-bridge/releases/rc13-d6c07f2/apps/api/dist/server.cjs
EnvironmentFile=/CAMINHO_PROTEGIDO/rollback-guard.env
```

Essas guardas se complementam: MODE impede o início do runtime AUTO (`routes.ts`)
e bloqueia dispatch no motor; LIVE_WRITE=false bloqueia ACTIVATE **e REMOVE**
dentro do próprio HuaweiMitigationExecutor, antes do transporte mutante. Mantém-se
HUAWEI e a allowlist existente para **não cair no executor MOCK** ao tentar comando
manual. Esvaziar allowlist de devices isoladamente evita SSH, mas pode selecionar
MOCK e produzir runtime simulado; portanto não é o rollback recomendado.

A prova executou o mesmo teste contra a RC13 exata: 15 casos passaram. Quatro
combinações de AUTO manual escaparam de M8=0 quando não promovidas; MODE e LIVE_WRITE
bloquearam independentemente. ACTIVATE/REMOVE manuais com LIVE_WRITE=false chegaram
ao executor Huawei fake e nenhuma escrita saiu. As policies em memória permaneceram
iguais. O motor nunca gera REMOVE automático e MODE desliga seu timer operacional.

Procedimento posterior, autorizado separadamente: congelar acesso operacional
manual; preparar/configurar o drop-in de rollback com guardas; daemon-reload;
inspecionar CWD/ExecStart/EnvironmentFile finais; reiniciar **somente API**; verificar
RC13/hash/health e as guardas reais em `/proc/<PID>/environ`. Não confiar em
systemctl show Environment como substituto dos valores carregados por arquivos.

Condições de aceite do retorno: health 200; API na RC13; MODE=SIMULATION_ONLY,
LIVE_WRITE=false, M8=0; worker AUTO sem timer iniciado; nenhuma nova linha ACTIVATE
ou REMOVE no banco/logs desde a troca; runtimes/policies ativas não removidos; PIDs
WEB/MCP preservados. Usar comparação de eventos e logs, sem readback mutante.

**Impacto manual temporário:** ACTIVATE e REMOVE reais ficam bloqueados. Leitura
STATUS e preflight podem continuar. Não operar esses comandos durante o congelamento;
uma tentativa bloqueada pode sinalizar reconciliação no runtime, sem alterar policy
física. Reabilitar escrita manual exige decisão explícita posterior, mantendo MODE
SIMULATION_ONLY e revendo as guardas. Nunca ligar AUTO no rollback.

## Evidências e restauração de configuração

Backup read-only: 41 arquivos de unidades/drop-ins/EnvironmentFile, cifrado com
Windows DPAPI para o usuário local da auditoria. Manifesto contém só caminhos e
hashes. Não há valores de segredos no relatório. A restauração deve preservar
permissões e não sobrepor guardas de congelamento inadvertidamente.

As evidências da auditoria ficam em `.artifacts/rc14f-codex/`. Os arquivos `.proposed`
representam modelos e não foram copiados para `/etc/systemd/system`.

Referências de ferramenta: [CLI n8n](https://docs.n8n.io/hosting/cli-commands/)
e [task runners n8n](https://docs.n8n.io/hosting/configuration/environment-variables/task-runners/).
Os comandos n8n da auditoria foram usados somente na instância descartável local.
