# Auditoria independente de prontidão AUTO-ALL — GMJ-NetVision IMPLANTAR

> **Contrato corrigido pelo operador em 03/11/2026:** o node 2 deve aplicar exclusivamente RT268568:660, **sem additive**. O [adendo de RT exclusivo](docs/audits/auto-all-20261103/ADENDO-CONTRATO-RT660-EXCLUSIVO.md) substitui as orientações deste relatório de preservar RTs normais no node 2 ou revisar exportações para acomodar o additive. A01 passa a ser uma não conformidade do software publicado com o contrato obrigatório; com RT660 exclusivo, a matriz das oito saídas atende ao destino COMPUTIZE. Os demais bloqueios e o NO-GO permanecem. O corpo abaixo conserva a evidência histórica da versão efetivamente auditada.

**Data: 03/11/2026, America/Sao_Paulo. Produção somente leitura. Nenhuma correção implementada.**

## A. Parecer executivo

| Decisão                                        | Veredito atual | Impedimentos determinantes                                                                                                                                                               |
| ---------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — homologação física manual, um cliente IPv4 | **NO-GO**      | Plano additive da AGLINK não produz a exportação pretendida na COMPUTIZE; ocupação concorrente dos nodes não é revalidada na segunda leitura; prontidão externa e janela não comprovadas |
| B — piloto AUTO restrito                       | **NO-GO**      | Impedimentos de A, nenhum ciclo físico da release comprovado, necessidade de validar ativação/retirada humana e reconciliação no equipamento real                                        |
| C — AUTO-ALL                                   | **NO-GO**      | Impedimentos anteriores, executor não deriva o baseline de 38 perfis atuais, policies compartilhadas, direções incompletas e lifecycle produtivo deliberadamente limitado à AGLINK       |

**0 de 39 perfis estão tecnicamente elegíveis para execução automática E2E neste estado.** Uma avaliação offline dos checks de entrada, sobre configuração Huawei real e assumindo snapshot fresco, passou somente para a AGLINK. Isso não valida exportação, disponibilidade da mitigadora, cache produtivo ou escrita física. Os outros 38 perfis falham na derivação do baseline com os rótulos efetivamente usados pelo executor.

O software possui proteções relevantes e verificadas: bloqueio global, allowlists, baseline durável antes da escrita, locks por policy, journal, outbox, quarentena de incerteza e proibição de REMOVE automático. Essas proteções contêm a produção; não demonstram prontidão para AUTO-ALL.

Foram aprovados **2.855 casos da suíte**, considerando a execução padrão e os complementos opt-in, além do ciclo de laboratório em processos separados. As reproduções independentes desta auditoria encontraram lacunas que a suíte existente não rejeita. Nenhuma simulação é apresentada como homologação física.

## B. Release e integridade da produção

Leituras iniciais em `2026-11-03T17:31:42Z` (14:31 de Brasília); conferência de banco até `17:56:35Z`; estado de serviços/flags reconferido depois. Evidências: [producao.json](docs/audits/auto-all-20261103/producao.json).

| Item                            | Evidência observada                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Release efetiva                 | `908e7b417502930d7945b3d73dded584a7012dd7`                                                      |
| CWD da API                      | `/opt/netvision-auto-activate/releases/908e7b417502930d7945b3d73dded584a7012dd7/apps/api`       |
| SHA256 `server.cjs`             | `2c0068b6e3d8dde39e744e7d65871b6062aa7d8ecf3c6045ded7407b0bdda0ef`                              |
| SHA256 sourcemap                | `cb6003241fce0942aebf45c20be1b045de5b28dad527f749e1e6330d0f965f34`                              |
| Código rastreado no sourcemap   | **233/233 arquivos correspondem** ao SHA auditado, normalizando CRLF/LF                         |
| Artefato gerado Prisma          | Diferença esperada de geração/plataforma; não incluído nos 233 arquivos rastreados              |
| Schema e migrations empacotados | 45 arquivos conferidos com o checkout exato; correspondência integral                           |
| PostgreSQL                      | 43 migrations, última `20261029090000_auto_lifecycle_durable`, zero incompletas                 |
| Disco                           | Aproximadamente **11,25 GiB livres**, 84% usado, no início; valor final registrado na evidência |
| Instalação/processo             | `NETVISION_INSTALLATION_ID=IMPLANTAR`; `NODE_ENV` ausente no ambiente efetivo                   |

O checkout legado `/opt/GMJ-NetVision` está em outro SHA e possui alterações locais. O checkout RC14-F também está em outro SHA. Nenhum deles foi tratado como fonte da release ativa. A auditoria utilizou worktree novo no SHA exato, sem tocar nos trabalhos locais existentes.

O diff `2ad62b8..908e7b4` tem **um arquivo funcional de runtime alterado**, `n8n-media-transport.ts`; inclui também teste, documentação, harness e scripts de empacotamento. A correção funcional é o ACK de simulação, sem alteração do executor BGP nesse intervalo. Há correspondência dos hashes publicados com os relatórios anteriores, verificada por leitura do artefato ativo. O build Windows desta auditoria passou, mas seu hash difere do bundle Linux publicado; **não foi declarada reprodução binária independente do pacote Linux**.

| Serviço       | PID antes/depois  | Estado         | NRestarts antes/depois             |
| ------------- | ----------------- | -------------- | ---------------------------------- |
| API           | 3527751 / 3527751 | active/running | 0 / 0                              |
| MCP           | 3527753 / 3527753 | active/running | 0 / 0                              |
| WEB           | 2976909 / 2976909 | active/running | 0 / 0                              |
| FAST Observer | 2594846 / 2594846 | active/running | 1 / 1, histórico anterior à missão |

API `/health` HTTP 200 no início e no fim: `demoMode=false`, `snmpPolling=true`. Observer `/health` HTTP 200, `observationOnly=true`, `executionAvailable=false`, saudável. O MCP depende de `netvision-api.service` por `Requires`; restart futuro da API deve considerar seu efeito sobre o MCP.

Flags verificadas **no processo**, preservadas:

```text
MITIGATION_LIVE_WRITE_ENABLED=false
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_PERSISTENCE_ENABLED=1
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_AUTO_MAX_ACTIVE=1
```

O modo global `MITIGATION_MODE=AUTO` mantém avaliações funcionando, mas não concede escrita. `FAST_BRIDGE_MODE=ENFORCE` e `FAST_BRIDGE_WRITES_ENABLED=true` também não superam essas barreiras. Hoje LIVE_WRITE=false bloqueia **inclusive ACTIVATE/REMOVE físicos manuais**; qualquer janela futura deve autorizar explicitamente a alteração desse controle, mantendo AUTO desligado durante a homologação manual.

## C–D. Inventário e matriz individual

- **39 perfis:** 23 IPv4, 16 IPv6; **12 AUTO**, **27 ALERT_ONLY**; todos `enabled=true`.
- 23 interfaces Eth-Trunk, um Huawei **NetEngine 8000 F1A-8H20Q**, VRP **8.220 / V800R022C00SPC600**, patch **V800R022SPH152**, confirmado por `display version`.
- 24 policies de entrada; **27 perfis compartilham policy**, em grupos de 2, 3 ou 4. Os outros 12 têm escopo cadastral individual.
- 42 vínculos peer/perfil, resolvidos também por endereço/família/device porque os vínculos históricos não trazem `peerId` preenchido. As policies de entrada desses vínculos correspondem à configuração Huawei lida.
- Todos têm trigger 90%, 3 amostras; checkInterval cadastrado 5 s; recovery 70%/12 amostras; limite de 100 prefixos. Recovery aqui não autoriza REMOVE.
- Há 19 perfis sem direção configurada; 20 resolvem TX, por ENV ou herança da interface. **Modo AUTO não foi usado como evidência de aptidão.**

A [matriz dos 39 perfis](docs/audits/auto-all-20261103/MATRIZ-PRONTIDAO.md), o [CSV](docs/audits/auto-all-20261103/matriz-perfis.csv) e [perfis.json](docs/audits/auto-all-20261103/perfis.json) incluem ID, cliente, interface/ifIndex, equipamento/firmware, família, modo, estado, peers, prefix-lists/definições, cláusulas normais/RTs/LP, capacidade física e banda contratada separadas, threshold, direção/fonte, frescor/cadência, disponibilidade de snapshot inferida do motor, executor e bloqueios.

**Resultado do executor sobre o inventário real:** AGLINK passou nos checks offline de ACTIVATE/IN, com nodes 1/2 livres e baseline 10/1000. Os outros **38 falham em `preserved_attributes`**: fora da exceção AGLINK, a fiação usa `PREFIX8to24`, enquanto os clientes utilizam listas próprias ou AS-path. Não é seguro trocar automaticamente as listas ou relaxar o fail-closed. LIVINET apresenta também estrutura parcial/suspeita com BOGONS no node 5. IPv6 está fora do contrato físico IPv4 desta missão e não pode herdar autorização de escrita de um contador agregado.

**NORMAL no banco não significa ausência física de mitigação:** `PL-CLICKING-V4-IN` contém node permanente 50, `PREFIX-DUALNET-V4`, LP4000 e RT660. Outras policies preexistentes `MITIGACAO-*` também aplicam RT660. Não foram adotadas, removidas ou contadas como ownership do NetVision. O limite maxActive=1 controla scopes duráveis da aplicação, não todas as políticas de terceiros existentes no equipamento.

## E. Detecção, telemetria e bloqueios quantitativos

O código consulta direção explícita, banda em **bps**, status/interface, idade, identidade e continuidade. FAST usa diferenças de Counter64 multiplicadas por 8 e divididas pelo intervalo; rebaseia após reset/wrap, uptime regressivo, discontinuity, troca de estado ou identidade, e rejeita leitura atrasada/intervalo excessivo. A fonte convencional filtra taxas inválidas e aplica frescor, com contrato temporal mais permissivo.

Referências: `fast-traffic-rate.ts:13`, `traffic-rate.ts:144`, `mitigation-traffic-source.ts:132`, `mitigation-sampling-policy.ts:23`, `mitigation-auto-engine.ts:800`, `single-pilot-trigger.ts:116`.

| Caminho                      | Contrato observado                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Observer FAST atual          | 12 interfaces, normal/suspect de 10 s, banco separado; sem mecanismo de escrita Huawei     |
| Roteamento FAST da API       | 12 perfis explícitos; auditoria persistida ENFORCE somente para BHNET-3043                 |
| FAST geral                   | Frescor 30 s / continuidade 45 s                                                           |
| Piloto lifecycle             | Frescor e continuidade **15 s**, três amostras novas adjacentes; pin AGLINK/TX/10 Gbps/90% |
| LEGACY                       | Frescor efetivo 600 s, sem limite de gap consecutivo; não equivale à cadência do piloto    |
| Queda/ausência de telemetria | Zera sequência, bloqueia nova ativação; não comprova normalização nem retira mitigação     |
| Contadores IPv4/IPv6         | Compartilhados na interface; não demonstram que ambas as famílias estão sob ataque         |

No recorte de uma hora, a AGLINK teve 357 observações FAST, 356 VALID, p95 de intervalo aproximadamente 10,20 s, máximo 11,43 s. Outras oito interfaces tiveram um gap acima de 15 s, com máximos de 21,00 ou 23,20 s. Portanto, 10 s nominal não é garantia universal de 15 s. Esses gaps devem reiniciar a sequência do piloto, sem flexibilizar o contrato automaticamente. Qualidade/frescor são medidos no instante da coleta indicado nos anexos; não constituem promessa contínua.

Todas as 23 interfaces tinham amostras convencionais no recorte consultado. **Sem direção configurada não significa SNMP ausente.** O vínculo físico Eth-Trunk/description foi corroborado pelo `display interface description`, incluindo AGLINK-IPV4_10GB, 73S e PLAY CONNECT. TX é saída do NE8000 em direção ao cliente; a evidência não inclui captura de pacotes nem classificação de ataque.

### O que significam centenas de decisões

Última janela fechada registrada: **305 s**, término `2026-11-03T17:37:17Z` (14:37:17 de Brasília):

| Motivo                 | Avaliações | Perfis distintos no último estado conhecido | Interpretação                                                                                                             |
| ---------------------- | ---------: | ------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------- |
| THRESHOLD_NOT_EXCEEDED |        400 |                                          20 | NO_ACTION esperado; tráfego abaixo do limiar, não é erro nem ataque                                                       |
| TELEMETRY_UNAVAILABLE  |        360 |                                          18 | Nestes perfis, direção não configurada; bloqueio de segurança esperado diante de cadastro incompleto                      |
| SNAPSHOT_UNAVAILABLE   |         20 |                                           1 | WF_Bonsucesso_02 / Eth-Trunk1.1052 / PL-WFREDES-V4-IN; cache não disponível para esse vínculo; causa exata não comprovada |
| **Total**              |    **780** |                                      **39** | 380 avaliações BLOCKED não significam 380 clientes                                                                        |

Em 36 janelas fechadas desde o startup: **26.559 avaliações**, sendo 12.289 TELEMETRY_UNAVAILABLE, 13.575 THRESHOLD_NOT_EXCEEDED e 695 SNAPSHOT_UNAVAILABLE. O início teve snapshots transitórios ausentes antes da reidratação. INFO registra transições e resumos, não todo tick; não somar transições aos totais dos resumos. A última transição por perfil permite reconstruir os 39 estados conhecidos, sem afirmar que todos foram reemitidos no mesmo instante.

`MitigationFastDecision` registrou, no recorte consultado, 210 avaliações/uma hora e 5.522/24 horas para **um perfil ENFORCE**, abaixo do limiar. Esse conjunto não representa todos os 39 perfis. Evidências, seleção e timestamps: [bloqueios-telemetria.json](docs/audits/auto-all-20261103/bloqueios-telemetria.json).

O detector implementa **saturação de banda sustentada**, não diferencia por si só DDoS de tráfego legítimo elevado. Não há, nesse caminho de decisão, prova de assinatura, flows/pps ou confirmação da mitigadora. Três amostras reduzem ruído, mas não eliminam falso positivo. Isso precisa ser aceito operacionalmente por perfil, sem alterar thresholds nesta auditoria.

## F. Executor Huawei e conflito de anúncio

### Proteções comprovadas no código e testes

O builder valida nomes/RTs, rejeita metacaracteres e monta lista canônica. O executor deriva LP, RTs e outros atributos do baseline, bloqueia baseline não derivável, match adicional/goto desconhecido, sobreposição anterior insegura e nodes ocupados no preflight. Ele grava e relê o baseline durável antes da primeira escrita. O transporte aborta por prompt interativo, erro de CLI, erro dividido entre chunks ou falta de prompt, impedindo avanço cego até commit.

REMOVE passa pelo readback físico, exige baseline armazenado, compara nodes permanentes e recusa ausência, corrupção, drift, múltiplos pares ou estrutura parcial. Não há restauração automática dos nodes permanentes. Fonte: `mitigation-write-guard.ts:21`, `mitigation-policy-clauses.ts:146`, `huawei-mitigation-executor.ts:246`, `:528`, `:665`, `ssh-client-impl.ts:18`, `:249`, `mitigation-command-service.ts:652`.

B3/B4/B5/B6 foram conferidos no código ativo e reexecutados nos testes pertinentes. As referências históricas a B1/B2 não aparecem como rótulos explícitos nos relatórios rastreados; seus mecanismos correspondentes de preservação/derivação, nodes ocupados e restrição de clauses foram avaliados pelos testes existentes, sem declarar certificação por nome de um relatório não encontrado.

### CRÍTICO — additive versus exportação efetiva

O contrato atual preserva RT140 e acrescenta RT660. A leitura real mostra, para os três prefixos AGLINK, RT140/330 e LP1100, best/select via `10.200.201.2`. Assim, o node 2 candidato produz **RT140/330/660**, mantendo LP1100. Não se presume execução do node 10 depois do node 2; o builder repõe seus atributos.

Na `PL-COMPUTIZE-IPv4-OUT`, existe **deny node 90**, `if-match extcommunity-filter 140`; o filtro 140 corresponde a RT268568:140. Ele antecede os permits de mitigação 200/300. Não há exceção anterior que aceite os três prefixos AGLINK com esse conjunto de atributos.

| Prefixos         | Antes / após REMOVE humano | Durante ACTIVATE additive candidato, inferência estática |
| ---------------- | -------------------------- | -------------------------------------------------------- |
| 167.250.126.0/23 | RT140/330, LP1100          | RT140/330/660, LP1100; COMPUTIZE **deny 90**             |
| 167.250.126.0/24 | RT140/330, LP1100          | RT140/330/660, LP1100; COMPUTIZE **deny 90**             |
| 167.250.127.0/24 | RT140/330, LP1100          | RT140/330/660, LP1100; COMPUTIZE **deny 90**             |

Na avaliação de referência das oito saídas, SEMPRE normal, SEABORN e SEABORN-BH rejeitam RT660 no node 5; CIRION, IP-TUDDO e VS-IX **ainda aceitam** o conjunto additive. SEMPRE-DDoS está bloqueada pelo deny 5 efetivo, conforme a decisão NEVER_MITIGATE. A COMPUTIZE está Established há aproximadamente oito dias e anuncia 11 outras rotas; isso não comprova scrubbing, importação ou retorno limpo da AGLINK.

**Conclusão:** o preflight IN pode passar e o Telegram dizer MITIGATION_VERIFIED após conferir a policy, enquanto o objetivo de desvio exclusivamente pela COMPUTIZE não foi atingido. Não houve ACTIVATE nem perda de serviço observada; o problema é uma incompatibilidade comprovável antes da escrita.

As 72 avaliações de referência estão em [huawei-readonly.json](docs/audits/auto-all-20261103/huawei-readonly.json). Os testes antigos de exportação continuam verdes, inclusive o teste que demonstra RT140+660 bloqueado na COMPUTIZE: eles não impõem o contrato atual de desvio com additive. A ordem crescente e o encerramento no primeiro match são coerentes com a [documentação geral Huawei de route-policy](https://support.huaweicloud.com/intl/en-us/usermanual-rc/rc_01_0003.html). A conclusão específica deriva da configuração lida; não é uma simulação certificada do firmware.

Há evidência que justifica revisar a compatibilidade das policies de saída, mas **nenhuma alteração foi proposta como executável ou aplicada**. Preservar o contrato additive e os nodes permanentes até decisão operacional explícita; não voltar unilateralmente ao RT exclusivo para fazer o teste passar. Qualquer ajuste Huawei futuro precisa de autorização específica e revisão do alcance.

### ALTO — ocupação concorrente entre preflight e escrita

Reprodução independente, executor real da release + transporte fake: preflight AGLINK aprovado com 1/2 livres; a segunda leitura passa a mostrar node 1 ou node 2 criado por outro operador. `activationBaselineDiverged` deriva o baseline excluindo o par e compara seus atributos, mas **não reconfirma que o par continua livre**. `activate` então chega a `applyMitigationCommands`, inclusive commit na lista fake, e o registro salvo contém somente 10/1000.

Os dois casos chegaram a uma tentativa de escrita fake, sem erro bloqueante. O lock NetVision serializa seus chamadores, mas não um operador direto no Huawei. Essa lacuna viola a intenção de nunca modificar node já existente e deve ser corrigida/retestada antes do piloto. Fonte: `huawei-mitigation-executor.ts:179`, `:258`, `:275`, `:760`; evidência em [testes.json](docs/audits/auto-all-20261103/testes.json), `independentOccupancyRace`. **Nenhuma corrida foi injetada em produção.**

## G. Persistência, concorrência, recuperação e falhas

`PrismaAutomationStore` usa transações e advisory lock para estado; `PrismaPolicyScopeLock` exclui escritores por device/policy; o tick global tem lock próprio. O journal registra PLANNED/STARTED antes de escrever, e o resultado/ownership/outbox são confirmados juntos. Interrupção/timeout não é sucesso: reserva permanece ou entra em UNCERTAIN e não é reexecutada automaticamente. Runtime NORMAL nunca substitui a leitura física no lifecycle.

| Falha                                       | Evidência / comportamento                                                  | Limite                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Banco indisponível antes da escrita         | Registro/autorizações falham; transporte fake recebe zero escrita no teste | Não foi interrompido o PostgreSQL produtivo                                                 |
| Queda antes/durante ACTIVATE                | PLANNED/STARTED/ACTIVATING são reconciliados para UNCERTAIN; sem replay    | Prova de software, sem sessão física interrompida                                           |
| Timeout após comando possivelmente aplicado | Ownership bloqueia nova escrita; readback/reconciliação exigidos           | Não assumir que fechar SSH descartou candidata Huawei                                       |
| Restart depois de ACTIVATE verificado       | Registro e baseline recuperados; sem segundo ACTIVATE                      | Reexecutado em PG real local e processos separados com equipamento fake                     |
| Readback divergente/indisponível            | Não fabrica verified; mantém quarentena, não remove automaticamente        | Precisará de runbook humano na janela real                                                  |
| Baseline ausente/corrompido/drift           | REMOVE bloqueado e nenhuma escrita fake                                    | Hash guardado não é assinatura contra administrador do banco                                |
| Nodes permanentes alterados                 | B5 detecta alteração/adição/remoção e impede retirada                      | Fingerprint cobre clauses/nodes, não toda dependência externa da policy/prefix-list/exports |
| Dois workers, mesmo scope                   | Advisory lock e journal excluem segundo escritor                           | Não é lock por equipamento nem fencing contra operador externo                              |
| Dois clientes simultâneos                   | maxActive e transação reservam capacidade; piloto aceita somente um perfil | Não comprova operação em massa; shared policy pode atingir mais de um vínculo               |
| Evento duplicado / retry HTTP               | Outbox com eventId estável, lease, backoff e dedupe                        | Entrega HTTP pode se duplicar se receptor aceitou e ACK/gravação local se perdeu            |
| Reinício de servidor inteiro                | Persistência suporta recuperação lógica, sem replay cego                   | Boot físico, rede, storage/backup e Huawei após falta de energia **NOT_VERIFIED**           |

**REMOVE automático não existe e não é requisito pendente.** `MITIGATION_AUTO_REMOVE_ENABLED=0` é obrigatório; tentativa automática identificada por origem, requestId, autoEvidence ou autoOperationId é recusada. Mitigação ativa espera indefinidamente. Apenas REMOVE humano autenticado, confirmado por readback, libera ownership e inicia cooldown; novo ACTIVATE exige episódio/amostras posteriores. recoverySamples/baixo tráfego fecham episódios de observação quando apropriado, sem gerar comando Huawei.

O cooldown padrão do lifecycle é 600 s; pin da configuração produtiva exige um perfil AGLINK, um device e maxActive=1. `assertSinglePilotAuthorization` impede ampliar a lista para AUTO-ALL sem alteração deliberada de software. O caminho legado recebe bloqueio composto persistence+lifecycle+flag antes de poder escrever. A exceção legada BHNET não supera esse bloqueio.

### Notificações e ACK

Integração BGP_MITIGATION habilitada, segredos outbound/inbound presentes; valores não foram consultados para comparação nem expostos nos entregáveis. Header outbound `X-NetVision-Token` e Bearer de retorno são contratos distintos. A correção 908e7b4 aceita simulação apenas com HTTP 2xx e `received=true/routed=false/delivered=false`; eventos físicos/detecção continuam exigindo `delivered=true`. A identidade de ACK é comparada quando informada; não se exige eventId no ACK real como defesa universal de replay.

Banco confirma um evento de simulação SENT em uma tentativa, `2026-11-03T14:34:33Z`; o antigo FAILED com 12 tentativas permanece preservado. **SENT de simulação não significa Telegram entregue nem homologação Huawei.** Não há entrega física nova dessa release para observar. Histórico tem quatro ACTIVATE e quatro REMOVE com verified=true, anteriores à release e sem comprovação de transporte físico suficiente para homologar o código atual.

Outbox é durável, com lease de 60 s, até 12 tentativas, backoff limitado a 10 min; FAILED requer tratamento operacional. DETECTION_BLOCKED tem limite por perfil de 30 min, não um orçamento global de Telegram para dezenas de clientes. Há prioridade dos eventos de controle. Não foi comprovada deduplicação ponta a ponta no workflow publicado nesta missão.

**MÉDIO — replay de recibo em memória:** `MitigationCommandService.execute:415` consulta cache apenas por requestId antes de validar ação/perfil. Com harness fake, ACTIVATE seguido de REMOVE com mesmo ID devolve recibo ACTIVATE_VERIFIED; outro perfil inexistente com esse ID recebe o recibo do primeiro. Houve somente uma escrita fake. O journal durável valida o escopo, mas é contornado por esse cache durante o processo vivo. Corrigir o vínculo do recibo antes do aceite do fluxo manual; não é evidência de escrita no perfil errado. Reprodução em `testes.json/independentReplayProbe`.

## H. AUTO-ALL: alcance e riscos

O sistema atual impede a expansão física por flags e pelo pin de piloto. Esses limites devem continuar. Habilitar dezenas de perfis exige resolver, individualmente, prefix-list autorizada, attributes baseline, destino de scrubbing, família, compartilhamento e direção. Não basta promover os 27 ALERT_ONLY ou remover a validação de identidade.

As avaliações podem rodar com concorrência 2; o lock é por policy, não por device. Não foi identificado orçamento global de mudanças por minuto/janela ou um circuit breaker de falso positivo correlacionado. Há maxActive/cooldown, mas não são equivalentes a esses mecanismos, e não limitam a configuração feita fora do NetVision. Policies compartilhadas amplificam o alcance de uma ativação; o lifecycle restrito as bloqueia.

Não há recuperação BGP em massa autorizada: a retirada é manual. Expandir AUTO sem capacidade humana de confirmar/retirar múltiplos escopos e sem entrega confiável de notificações cria risco operacional. Falha global de telemetria deve bloquear novas ativações e preservar as ativas, não provocar retirada ou fallback de caminho.

O kill switch de ENV é lido no boot: alterar o arquivo não o torna efetivo imediatamente; exige restart controlado da API, com efeito sobre MCP. Ele não recolhe comandos já em voo. Um plano de parada precisa reconhecer essa janela e exigir readback/ownership antes de outra escrita.

## I. Achados por severidade

| ID  | Severidade             | Achado                                                                                                                                               | Menor ação segura recomendada para missão posterior autorizada                                                                                                 |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | **CRÍTICO**            | RT140 additive cai no deny90 COMPUTIZE e permanece aceito em três saídas normais                                                                     | Reconciliar contrato IN/additive e filtros de exportação com o operador, provar todos os prefixos; qualquer alteração Huawei depende de autorização específica |
| A02 | **ALTO**               | Segunda leitura não bloqueia ocupação nova dos nodes 1/2                                                                                             | Revalidar ocupação/conteúdo do par na última leitura, abortar com zero escrita e adicionar regressões; manter janela exclusiva                                 |
| A03 | **ALTO**               | 38 baselines atuais não deriváveis; labels genéricos incompatíveis com listas reais                                                                  | Mapear explicitamente os clientes/listas e validar sem afrouxar o baseline; não ampliar allowlist                                                              |
| A04 | **ALTO**               | Lifecycle é single-pilot; nenhuma homologação física atual e capacidade externa não comprovada                                                       | Concluir piloto AGLINK manual antes de autorizar AUTO restrito; manter a trava de identidade                                                                   |
| A05 | **ALTO**               | SSH normal de configuração não fixa host key; read/write usam a mesma identidade                                                                     | Definir confiança verificável do host para transporte de configuração, revisar AAA/escopo da credencial e testar rejeição de chave divergente                  |
| A06 | **ALTO para AUTO-ALL** | Trigger exclusivamente por banda; sem proteção global comprovada contra falso positivo correlacionado ou orçamento de mudanças                       | Homologar limiar/semântica com cada cliente e estabelecer limites operacionais antes de expansão                                                               |
| A07 | **MÉDIO**              | Recibo por requestId não vinculado à ação/perfil no cache vivo                                                                                       | Validar identidade do comando antes de servir recibo, rejeitar colisão e testar ACTIVATE/REMOVE/cross-profile                                                  |
| A08 | **MÉDIO**              | 19 direções ausentes, um snapshot ausente, escopos compartilhados e IPv6 sem homologação                                                             | Manter bloqueios/ALERT_ONLY; corrigir somente cadastros comprovados em missão própria, sem inferir direção ou isolamento                                       |
| A09 | **MÉDIO**              | Dependências externas do baseline e garantias de entrega/rollback de host não completamente comprovadas                                              | Registrar limites, assegurar runbook de reconciliação e testar recuperação autorizada em laboratório                                                           |
| A10 | **BAIXO**              | Relatórios históricos/fixtures descrevem contratos anteriores; comentários SIMULATION_ONLY e faixa genérica 1..9 não refletem integralmente o piloto | Manter fonte/versão explícitas; antes de generalizar, impor contrato de somente 1/2 e atualizar testes de aceitação                                            |

O hostVerifier de `ssh-client-impl.ts:163` só é configurado quando há `diagnostic`; `HuaweiBgpSshService.applyMitigationCommands` não usa esse modo. Logo, proteção de host key dos diagnósticos não foi atribuída indevidamente à escrita BGP. Não foi executado MITM, teste de permissões mutante ou modificação de AAA. O nível real de privilégio/ACL da conta Huawei permanece **NOT_VERIFIED**.

### Incidente de custódia da própria auditoria

O coletor inicial filtrava nomes TOKEN/SECRET/PASSWORD/KEY, mas não DATABASE/URL, e incluiu indevidamente **um campo de conexão do leitor FAST** na saída de ferramenta. Foi uma falha desta auditoria. O filtro foi corrigido imediatamente e o JSON local saneado; nenhum valor ou hash de credencial foi incluído nos entregáveis. A saída já emitida não pode ser revogada. Nenhuma credencial foi rotacionada ou configuração alterada. Deve-se avaliar separadamente a rotação dessa credencial de leitura, com autorização própria; isso não é atribuído como falha do motor auditado.

## J. Testes, evidências e reprodução

| Verificação                              | Resultado independente                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| API padrão no CWD canônico `apps/api`    | 2.814 PASS, 41 skip opt-in, zero falhas                                                                 |
| PostgreSQL descartável real              | 39 casos opt-in PASS, incluindo baseline, ownership/journal/outbox, locks, transação e bridge/read-only |
| Observer/UDP e relógio real em loopback  | 5 PASS, dos quais 2 eram os skips restantes; três repetem testes já aprovados                           |
| Cobertura consolidada sem duplicar casos | **2.855 PASS; zero casos pendentes/falhos**                                                             |
| Typecheck API                            | PASS                                                                                                    |
| ESLint das áreas auditadas               | PASS                                                                                                    |
| Build local da API                       | PASS                                                                                                    |
| Ciclo em dois processos distintos        | ACTIVATE fake, novo processo, REMOVE fake; configuração final idêntica à original                       |
| Seis negativos do laboratório            | PASS: ausente, corrompido, drift, PG indisponível, SSH com erro, estrutura ambígua                      |
| Reprodução independente BGP              | 72 avaliações estáticas, evidência do conflito, sem anúncio físico                                      |
| Reprodução independente de ocupação      | Dois casos revelam tentativa de escrita fake em node recém-ocupado                                      |
| Reprodução independente de recibo        | Confirma colisão ação/perfil; somente uma escrita fake                                                  |

Os dois PostgreSQL foram criados exclusivamente em containers próprios, tmpfs e portas loopback 55077/55439; 43 migrations aplicadas somente em bancos descartáveis. Containers da auditoria foram removidos ao terminar. Nenhum teste utilizou URL produtiva. Não se alterou código para passar testes.

A primeira invocação da suíte usou `--root apps/api` a partir da raiz, causando ENOENT nos testes de schema. Corrigiu-se apenas o CWD. A preparação PostgreSQL inicialmente usou porta incompatível com dois guards e não possuía o banco separado de observação; corrigiu-se apenas o laboratório e reexecutaram-se os testes afetados. As falhas de preparação não foram ocultadas nem apresentadas como defeito funcional corrigido.

O teste UDP usa agente sintético GET-only em 127.0.0.1; resposta medida em 33,865 s desde a primeira amostra anormal, com 54,159 s de execução total. **Não mede SLA nem readback do NE8000 real.** O harness de erro de CLI descarta candidata fake; não prova que todo VRP descarte configuração ao fechar SSH.

Reprodução canônica, no checkout exato e com bancos locais guardados:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run db:generate -w @gmj/api
npm run build -w @gmj/api
Set-Location apps/api
..\..\node_modules\.bin\vitest.cmd run
```

Opt-ins usam `MITIGATION_BASELINE_TEST_DATABASE_URL`, `SINGLE_PILOT_TEST_DATABASE_URL`, `SINGLE_PILOT_READINESS_DATABASE_URL`, `TELEMETRY_TEST_DATABASE_URL`, `FAST_TEST_DATABASE_URL`, `NETVISION_PHASE01_TEST_DB` e `FAST_REALTIME_TEST=1`; respeitar as portas/nomes fixos nos guards e executar suítes PG sequencialmente. O laboratório em processos separados está em `apps/api/lab-homolog/README.md`. Não apontar essas variáveis para produção.

Evidências estruturadas: [produção](docs/audits/auto-all-20261103/producao.json), [inventário](docs/audits/auto-all-20261103/perfis.json), [Huawei e 72 avaliações](docs/audits/auto-all-20261103/huawei-readonly.json), [logs/telemetria](docs/audits/auto-all-20261103/bloqueios-telemetria.json), [testes e reproduções](docs/audits/auto-all-20261103/testes.json). Scripts temporários de auditoria ficaram fora do código funcional, em `C:\projetos\.netvision-auto-all-audit-20261103`; não foram publicados.

## K–M. Menor caminho seguro e critérios para GO

### A — converter NO-GO manual em GO

1. Resolver A01 com decisão explícita do operador sobre o anúncio com additive, preservando LP1100 e nodes 10/1000. Provar, para os três prefixos e RTs efetivos, aceitação pela COMPUTIZE, rejeição das seis saídas normais previstas e bloqueio SEMPRE-DDoS inclusive se voltar a Established. Somente evidência IN não basta. Qualquer ajuste Huawei depende de autorização específica fora desta auditoria.
2. Corrigir e testar A02 e A07 em missão isolada autorizada; confirmar confiança da identidade SSH e acesso manual de recuperação. Não improvisar bypass de preflight ou reconstrução destrutiva de baseline.
3. Obter confirmação COMPUTIZE de importação dos três prefixos, scrubbing/template/capacidade, caminho limpo, contato técnico e forma de provar encaminhamento. Confirmar janela e exclusividade sobre a policy. Established não cumpre esses critérios.
4. Preparar autorização one-shot de ACTIVATE **manual** AGLINK IPv4, com LIVE_WRITE temporariamente autorizado e AUTO/lifecycle/REMOVE AUTO mantidos em 0. Confirmar que a autorização alcança apenas o escopo pretendido e que operadores conhecem o alcance do controle global de escrita.
5. Exigir baseline durável confirmado, preflight fresco, journal, readback de policy e **atributos/anúncios BGP efetivos**, verificação de conectividade/limpeza pelo provedor e recibo Telegram. Não repetir escrita se resultado incerto. REMOVE humano exige autorização separada, baseline íntegro, readback e retorno observado dos anúncios normais.

### B — converter NO-GO AUTO restrito em GO

Além de A, concluir e registrar o ciclo físico manual na versão exata a homologar. Conferir transporte Telegram e callbacks autenticados, confirmação de escopo, ownership/baseline após restart e fallback humano. Liberar somente a identidade AGLINK fixa, um equipamento e maxActive=1, com três amostras FAST novas/adjacentes de até 15 s, cooldown e proibição de REMOVE automático. A ativação de flags será outra autorização; esta auditoria não a concede. Não gerar ataque artificial nem reduzir threshold produtivo para conseguir uma prova.

### C — converter NO-GO AUTO-ALL em GO

Manter o pin de piloto até haver evidência operacional. Resolver os 38 baselines/listas, 19 direções, snapshot ausente, 27 vínculos em policies compartilhadas e famílias fora do contrato. Demonstrar por cliente a rota recebida/autorizada, atributos preservados e exportação/retorno pretendidos. Só então revisar, mediante missão própria, limites por device/janela, proteção contra falso positivo correlacionado, capacidade de Telegram e capacidade humana de retirada. Reexecutar matrizes de concorrência, falha de banco/SSH, restart e dupla família sobre o desenho aprovado. Não remover a trava de identidade como atalho.

### Parada e rollback operacional futuro

Nenhum rollback foi necessário ou executado. Diante de resultado incerto, preservar mitigação, baseline, ownership, journal, outbox e nodes físicos; não emitir segundo ACTIVATE nem REMOVE automático. Desabilitar novas execuções requer procedimento autorizado com verificação das flags no processo e janela API/MCP. Não apagar registros ou restaurar o banco para desfazer uma ação BGP.

A release anterior 2ad62b8 mantém o motor B6; rollback para ela desfaz ACK, não resolve A01/A02. RC13 não é destino seguro presumido para AUTO: não depender apenas de seu M8. Qualquer retorno de bundle deve preservar AUTO desligado e a compatibilidade do schema, com health e reconciliação antes de novas escritas. Backup/restauração produtiva e reinício do host inteiro não foram executados ou homologados nesta auditoria.

## N. Limitações e encerramento

- Nenhum ACTIVATE/REMOVE físico, refresh, soft reset, modificação Huawei ou falha real foi executado. Sessão SEMPRE-DDoS não foi investigada; sua exclusão de destino foi preservada.
- Não houve login, extração/reutilização de sessões ou chamada de endpoint autenticado. Estado exato do endpoint `/auto/lifecycle` e detalhes do cache por endpoint são **NOT_VERIFIED**; usaram-se processo, SQL, logs e código. Para WF/1052, a causa exata do snapshot ausente permanece pendente.
- Não houve acesso/alteração n8n, envio Telegram, migração produtiva, restart, deploy, flags, catálogo físico, WEB, Observer, VNT ou Fibinet. O erro de catálogo observado no startup foi apenas registrado.
- Configuração Huawei foi lida em sessões sequenciais, não em snapshot atômico do equipamento. As configurações inicial/final coincidem após excluir banners de login; os dados de telemetria têm timestamps próprios.
- A avaliação estática de exportação cobre as oito saídas especificadas, não todos os peers/VRFs do Huawei. Não prova recepção ou encaminhamento no provedor.
- Os dados produtivos de perfis, migrations, histórico de eventos, registros duráveis e logs de mídia comparados permaneceram iguais. Runtime/amostras normais continuam sendo atualizados pelo sistema; não se afirma imobilidade do banco inteiro.

**Decisão final: NO-GO A / NO-GO B / NO-GO C; 0/39 elegíveis E2E agora; AGLINK é a única candidata que passa nos checks locais de IN, ainda bloqueada pelos achados e pelas confirmações operacionais.** Trabalho encerrado na auditoria, com documentação e evidências apenas. Aguardar autorização antes de implementar qualquer correção ou iniciar homologação física.
