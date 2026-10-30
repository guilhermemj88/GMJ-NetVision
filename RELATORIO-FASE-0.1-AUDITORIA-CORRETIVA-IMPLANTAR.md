# IMPLANTAR — auditoria corretiva Fase 0.1

Data: 29/10/2026. Missão exclusivamente de investigação produtiva por leitura e correções locais isoladas. **Nenhum deploy foi executado.**

**Decisão: NO-GO para aceitar/homologar a Fase 0 produtiva no estado atual. GO para revisão técnica das candidatas preparadas.** As correções ainda não estão instaladas; restart estritamente API-only preservando o MCP real não foi homologado. Lifecycle/SHADOW/FAST autenticados atuais são `NOT_VERIFIED`, por decisão expressa do operador de não disponibilizar sessão. Isso não foi contornado.

## 1. Estado produtivo observado

Comparação principal: **23:15:23–23:58:28 UTC** (20:15:23–20:58:28 BRT). Catálogo/grafo tiveram coleta inicial adicional às 23:06 UTC. Evidência: [production-integrity.json](docs/evidence/phase01/production-integrity.json).

| Serviço | PID inicial → final | NRestarts inicial → final | Estado final |
| --- | --- | --- | --- |
| API | 3418797 → 3418797 | 0 → 0 | active/running |
| WEB | 2976909 → 2976909 | 0 → 0 | active/running |
| MCP | 3418799 → 3418799 | 0 → 0 | active/running |
| FAST Observer | 2594846 → 2594846 | 1 → 1 | active/running |

API `/health`, WEB `/`, MCP `/health` e Observer `/health`: HTTP 200. API: `demoMode=false`, `snmpPolling=true`. O restart histórico do Observer não foi causado nesta missão. As coletas confirmaram os mesmos CWDs, start ticks, artefatos, units, drop-ins e EnvironmentFiles. n8n permaneceu com zero restarts do container e activeVersionId `6a97fe4a-31ea-49e6-b892-1ac55f85d115` no workflow `SVh8Z-zUcSzQYOOJZ-DKP`.

Permaneceram 39 perfis: 12 AUTO, 27 ALERT_ONLY; runtimes 38 NORMAL e 1 DISABLED. Configurações completas dos perfis, inclusive updatedAt, permaneceram iguais. Contadores/amostras de telemetria continuam evoluindo pelo funcionamento normal; não foram tratados como configuração imutável nem alterados pela auditoria.

Histórico estável: 4 ACTIVATE, 4 REMOVE e 3 SIMULATION. Último ACTIVATE em 18/10 e último REMOVE em 19/10. Nenhum evento novo dessas operações durante a comparação. Permaneceram 42 migrations, sem tabela `MitigationAutomationRecord`, sem índice inválido, constraint não validada ou espera de lock observada. Espaço livre final: 6.782.140.416 bytes, sem instalação de release nesta missão.

## 2. SHA/API efetiva e candidatas

Produção continua em **e78638af51762db93f52f61195ca57d8c72d988e**. Bundle ativo intacto:

`c8a71fbf1537199ce689627ce5774f8306261fb27f7c3ac1b2e423a515fa1c9c`

CWD API: `/opt/netvision-auto-activate/releases/e78638af51762db93f52f61195ca57d8c72d988e/apps/api`.

WEB produtiva permanece na responsiva f4b31fc, BUILD_ID **NSfXEDCQk4S1AmACLROnj**. MCP mantém bundle `ec5816c8a2c72a583861869df6ea7c4c4682eb6a20b0e451dcd5d3c8cbad9356` e CWD `/opt/netvision-mcp/releases/mcp-5874fe0`. Observer mantém CWD `/opt/netvision-fast-observer/releases/rc-aaafdde/runtime`.

Candidatas são independentes:

- API: branch `fix/implant-phase0-operational-incidents`, criada limpa sobre e78638a; código/contrato até `1e920fb2a9d71b1c943720ae57ded6b881de1c87`, testes PostgreSQL incorporados em `205457452502d0d5ced1a5d0dc4daa29ce170ca4`.
- WEB: branch `fix/implant-phase01-web-authority`, sobre **f4b31fc31dd0ffdc7d454157822a3e85c5a5e8b8**. Código final e teste de frescor até `59aecb321adea136cf2a16f0e71488913ad01ce0`.

Não empacotar a WEB antiga existente na base e78638a. O projeto principal, a release congelada e as árvores de publicação anteriores não receberam edição de código. Não houve merge nem push.

## 3. Diagnóstico dos quatro incidentes

| Incidente | Causa | Situação |
| --- | --- | --- |
| MCP reiniciou junto da API na publicação anterior | Requires da API no MCP e correspondente RequiredBy na API; pré-flight não seguiu esse vínculo reverso | Comprovado por grafo efetivo e reprodução em systemd descartável |
| Criação do 39º perfil | Boot chamou discovery com persistência; nova identidade interface/família/policy provocou create | Comprovado por código, timestamps e binding persistido |
| Catálogo falhou em name | YAML ausente no novo pacote; fallback usa algumas chaves diferentes para nomes já existentes; bootstrap não era transacional | Comprovado por arquivos, índice real, registros e reprodução PostgreSQL |
| WEB afirmou AUTO ativo | Banner inferia autorização de MODE=AUTO + HUAWEI + LIVE_WRITE, sem lifecycle | Comprovado diretamente no helper e por testes com M8=0 |

## 4. Causas comprovadas e limites de prova

O primeiro conflito nominal alcançável no fallback é **MikroTik CCR2116-12G-4S+**: chave embutida `mikrotik-ccr2116-12g-4s-plus`, contra SYSTEM preexistente `mikrotik-ccr2116-12g-4splus`. A tabela real tem os índices únicos `PhysicalEquipmentTemplate_name_key` e `PhysicalEquipmentTemplate_catalogKey_key`. Há outros três conflitos potenciais equivalentes no fallback. Não se deve adotar ou renomear esses registros apenas por nome.

O YAML da release antiga está presente; na release e78638a não há arquivo em nenhum caminho então pesquisado, nem override configurado. O arquivo antigo e o versionado têm hashes brutos diferentes por formatação. A comparação recursiva do YAML parseado encontrou **zero diferenças após normalizar espaços em strings**, com 121 templates em ambos. Não se afirmou igualdade byte a byte.

A seleção/rotulagem da AGLINK no diagnóstico FAST tem defeito adicional comprovado por código/configuração e reproduzido com fixture. A forma exata da resposta autenticada em memória agora não foi consultada. Leituras e readbacks Huawei físicos não foram feitos; testes de transporte fake e browser não comprovam execução física.

## 5. Evidências dos testes

| Verificação | Resultado final |
| --- | --- |
| Suíte API | 2.594 aprovados, zero falhas; 33 skips na execução padrão |
| PostgreSQL descartável separado | 10 aprovados; são os 10 novos testes que ficam skipped sem URL explícita na suíte padrão |
| Suíte WEB | 1.447 aprovados, zero falhas, 119 arquivos |
| Playwright | 15 aprovados, API offline mockada, servidor local exclusivo |
| Pré-flight systemd | 6 testes aprovados |
| Laboratório systemd | 6 casos executados com serviços fake |
| Typecheck | API e WEB aprovados |
| ESLint | API, WEB e contrato compartilhado aprovados |
| Builds | API e WEB produção aprovados; WEB identidade IMPLANTAR |
| Diff check | Aprovado |

Os 23 skips remanescentes são 21 testes PostgreSQL preexistentes de FAST/bridge/direção e 2 cenários que exigem execução live. Não foram declarados aprovados. A nova bateria PostgreSQL real cobre os repositórios modificados: duas inicializações concorrentes, idempotência, conflito CUSTOM, falha em filhos, rollback do lote, retry, YAML integral, ausência de escrita no boot, mudança de snapshot, interfaces distintas na mesma policy e concorrência com estado/configuração manual.

Regressões incluídas na suíte API: matriz M8 **16**, paridade manual RC13 **11**, lifecycle **71**, confirmação de remoção compartilhada **14**, além dos contratos n8n e regressões de delivery. Os caminhos de comando, motor AUTO, rotas e migrations não receberam alteração funcional nesta correção.

Houve falhas intermediárias corrigidas/explicadas: dependências WEB inicialmente incompletas e symlink incompatível com Turbopack, expectativa antiga do catálogo sem caminho empacotado, testes antigos esperando AUTO armado indevidamente, tipos incompletos do contrato do bridge e fixture de relógio que podia gerar amostra 1 ms no futuro. A WEB passou a usar instalação própria por lockfile; a fixture usa um único instante explícito. Uma expectativa histórica de horário exige `TZ=UTC` na suíte WEB, sem alterar timezone de produção. Os resultados acima se referem às verificações finais, não às tentativas falhas.

## 6. Systemd e proposta operacional

Foram capturados 27 serviços NetVision e seus fragmentos/drop-ins efetivos, incluindo Requires/RequiredBy, Wants/WantedBy, PartOf/ConsistsOf, BindsTo/BoundBy, Requisite/RequisiteOf, propagação de stop/reload, After/Before e hooks de execução.

O fechamento de propagação relevante da API contém **API e MCP**. A dependência weathermap API→WEB pertence a outro grupo; não apareceu propagação da API IMPLANTAR para ela, WEB principal ou Observer. O novo pré-flight rejeita API-only ao encontrar MCP não autorizado, incluindo vínculos transitivos e units não capturadas. Ordenação After/Before não foi confundida com propagação. A relação Requires pode propagar parada/restart; ver [systemd.unit oficial](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Requires=).

Laboratório local systemd 259.9, sem rede e sem credenciais: restart mudou PID MCP 135→152; try-restart 152→163; stop encerrou ambos. Dois restarts com `ignore-dependencies` mantiveram MCP PID 175. Crash da API provocou recuperação da API e mudança do MCP para PID 215, preservando o mecanismo normal da dependência.

Isso não comprova o MCP real nem a versão produtiva 259.5. Não foi aplicada unit/drop-in nem removido Requires. **Procedimento recomendado: manter topologia e exigir autorização explícita de janela conjunta API+MCP para a próxima troca de código API.** Se o requisito continuar sendo PID MCP invariável, NO-GO até homologação adicional equivalente. O bypass `ignore-dependencies` não está liberado para produção.

## 7. Correções implementadas

- Boot usa `SNAPSHOT_ONLY`, sem mutadores de perfil, peers ou runtime. Falta de peers persistidos não cai em discovery BGP que grava associações.
- `RECONCILE_EXISTING` não cria identidades; `REGISTER_NEW` preserva o cadastro solicitado por operador, em ALERT_ONLY com aviso de revisão e sem allowlist. A revisão pendente não foi inventada como estado durável no schema.
- Identidade e contagens usam device/interface/família/policy; observações iguais não atualizam perfil; configurações manuais e DISABLED são preservados. Atualização de runtime é condicional à versão/estado/par lidos, evitando sobrescrever comando concorrente. Estado físico/ownership prevalece sobre um plano recalculado.
- Snapshot perdido/inválido substitui a evidência anterior. Divergência de banda observada no boot revoga prontidão sem escrever configuração.
- Build inclui YAML em `dist/catalog`. Catálogo usa transação única/advisory lock, rejeita identidade nominal conflitante, preserva CUSTOM e referências, evita timestamps redundantes e não esconde conflitos de portas com skipDuplicates.
- WEB usa lifecycle autenticado recente e gates individuais, distingue avaliação de autorização, revoga apresentação positiva após erro/staleness e não trata runtime MITIGATED como readback.
- FAST usa decisão operacional do próprio perfil quando omitida no resumo ENFORCE. Não toma decisão de outro perfil, não inventa 0/3 sem dados e não deduz autorização ou fonte da decisão apenas porque há amostra FAST. O contrato compartilhado passa a descrever `engine.decisions`, que a API já retornava; nenhum novo endpoint ou escrita foi criado.

Nenhum schema, migration, threshold, sentido RX/TX, perfil, flag ou worker produtivo foi alterado. AUTO REMOVE permanece proibido; os botões e confirmação/autenticação de REMOVE manual permanecem nos caminhos existentes.

## 8. Arquivos modificados

Worktree API (base e78638a):

- `README.md`
- `RELATORIO-FASE-0.1-AUDITORIA-CORRETIVA-IMPLANTAR.md`
- `apps/api/src/infrastructure/bgp/mitigation/README.md`
- `apps/api/src/infrastructure/bgp/mitigation/in-memory-mitigation-repository.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-discovery-service.test.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-discovery-service.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-phase01-postgres.test.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-rehydration.test.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-repository.ts`
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-service.ts`
- `apps/api/src/infrastructure/bgp/mitigation/prisma-mitigation-repository.ts`
- `apps/api/src/infrastructure/physical/README.md`
- `apps/api/src/infrastructure/physical/physical-catalog-yaml.test.ts`
- `apps/api/src/infrastructure/physical/physical-catalog-yaml.ts`
- `apps/api/src/infrastructure/physical/prisma-physical-repository.test.ts`
- `apps/api/src/infrastructure/physical/prisma-physical-repository.ts`
- `apps/api/tsup.config.ts`
- `docs/AUTO_DDOS_ACTIVATION_PLAN.md`
- `docs/PHASE01_STABILIZATION.md`
- `docs/evidence/phase01/build-artifacts.json`
- `docs/evidence/phase01/catalog-constraints.json`
- `docs/evidence/phase01/incident-observations.json`
- `docs/evidence/phase01/production-integrity.json`
- `docs/evidence/phase01/systemd-graph.json`
- `docs/evidence/phase01/systemd-lab.json`
- `docs/evidence/phase01/test-matrix.json`
- `packages/shared/src/mitigation.ts`
- `scripts/.gitignore`
- `scripts/systemd-lab/Dockerfile`
- `scripts/systemd-restart-lab.py`
- `scripts/systemd-restart-preflight.py`
- `scripts/test_systemd_restart_preflight.py`
- `scripts/verify-api-release.mjs`

Worktree WEB (base responsiva f4b31fc):

- `apps/web/src/components/bgp/bgp-mitigation-workspace.test.tsx`
- `apps/web/src/components/bgp/bgp-mitigation-workspace.tsx`
- `apps/web/src/components/bgp/mitigation-fast-bridge.test.tsx`
- `apps/web/src/components/bgp/mitigation-fast-bridge.tsx`
- `apps/web/src/components/bgp/mitigation-telemetry.test.tsx`
- `apps/web/src/components/bgp/mitigation-telemetry.tsx`
- `apps/web/src/lib/README-mitigation-authority.md`
- `apps/web/src/lib/mitigation-api.ts`
- `apps/web/src/lib/mitigation-authority.ts`
- `apps/web/src/lib/mitigation-engine-status.test.ts`
- `apps/web/src/lib/mitigation-labels.ts`
- `apps/web/src/lib/mitigation-telemetry-authority.ts`
- `e2e/responsive/phase01-authority.spec.ts`
- `packages/shared/src/mitigation.ts`

## 9. Commits e worktrees

API: `C:\projetos\GMJ-NetVision-phase01-incidents`.

| Commit | Finalidade |
| --- | --- |
| `1f86ea430d7f66b2b8f29ee7c1ea808cadfea01f` | Pré-flight do grafo systemd |
| `4056d24a029698105441e90e04df0dae8225c036` | Laboratório descartável systemd |
| `e5d8c41afe6541156f284cc8ae53d4096e225f62` | Discovery/reidratação/concorrência |
| `555b2eb86600df76a35fb791250b07d25af44965` | Catálogo atômico e YAML no build |
| `1e920fb2a9d71b1c943720ae57ded6b881de1c87` | Contrato tipado do bridge |
| `205457452502d0d5ced1a5d0dc4daa29ce170ca4` | Regressão real PostgreSQL |

WEB: `C:\projetos\GMJ-NetVision-phase01-web`.

| Commit | Finalidade |
| --- | --- |
| `ec6fce9209710f5f701055924411a253f8ae8f09` | Autoridade lifecycle, frescor e evidência física |
| `c8f6a0359982467bbb882e8309e9ce419b33cc51` | Documentação do módulo |
| `7f32026df7a83ff74462152d062d1e815adbe5ea` | Decisão operacional de perfil roteado FAST |
| `b7606b4c688424a32a585cd5d3d55ec58e9ab426` | Tipagem do campo existente e fixtures |
| `59aecb321adea136cf2a16f0e71488913ad01ce0` | Fixture determinística de frescor |

O commit documental que contém este relatório identifica a entrega integral na branch API; seu SHA pode ser obtido por `git log -1 --format=%H -- RELATORIO-FASE-0.1-AUDITORIA-CORRETIVA-IMPLANTAR.md`. Não houve integração em main.

## 10. Artefatos e resultados finais

Build API local de validação: bundle `413d8dae0d7d9794f7206818975f7c678d7a9911460b4937c5cbc65ac84b3edc`, 2.103.436 bytes. YAML empacotado: `2a255fc270755c3511637b5763b859335ad1f574929625f461e01f674b143d64`, 126.505 bytes. Hash do sourcemap e artefatos WEB em [build-artifacts.json](docs/evidence/phase01/build-artifacts.json).

WEB candidata BUILD_ID: **whv4844yme6PHcP_BMw61**, diferente da WEB produtiva preservada. Este é build Windows para validação; **não é um pacote Linux liberado para instalação**. A publicação futura exige pacote Linux do SHA revisado, manifesto completo e nova aprovação. O bundle produtivo c8a71f… não foi modificado.

## 11. Proposta para o 39º perfil

| Registro | Interface | Situação |
| --- | --- | --- |
| Novo `cmvu0f0vd00axl7ylpkznwlc2` | Eth-Trunk1.1056, ifIndex 339, `WF-REDES-IPv4_10GB` | ALERT_ONLY; NORMAL; sem promoção nem allowlist AUTO |
| Antigo `cmuoavmgi00e7sslhgh7quv0f` | Eth-Trunk1.1052, ifIndex 124, `WF_Bonsucesso_02_10GB` | ALERT_ONLY; DISABLED; sem snapshot atual informado |

Ambos mencionam PL-WFREDES-V4-IN e peer 10.200.201.122. O BgpPeer persistido liga esse peer à **1.1056**, ESTABLISHED, 1 prefixo na leitura. Ambos os perfis mantêm relações de profile-peers; os dois têm zero eventos/simulações observados. A ausência desses eventos não autoriza excluir histórico ou inferir ausência física.

**Conclusão:** o novo registro é consistente com a associação persistida, não duplicata da chave lógica antiga. Legitimidade da associação física e aposentadoria da 1.1052 ainda precisam de revisão/readback autorizados. Preservar ambos; manter novo ALERT_ONLY/fora da allowlist, marcar para revisão operacional externa e não reativar DISABLED por discovery. Nenhuma alteração foi feita nos registros.

## 12. Integridade do catálogo físico

Na janela do boot anterior, há **13 templates com createdAt novo**, **23 updatedAt** (incluindo os novos), **8 slots**, **1 módulo** e **4 portas de módulo** criados. São 134 templates atuais frente aos 121 do YAML. Os 13 novos correspondem a identidades do fallback e não têm assets associados na coleta.

Isso refuta a hipótese de bootstrap sem escrita antes do erro. Não é possível quantificar retroativamente todas as alterações em portas de template/links slot-module: essas tabelas não têm timestamps de criação correspondentes. Também não há snapshot pré-boot completo dos metadados para afirmar ausência de alterações semânticas.

A coleta inicial/final desta missão mostrou catálogo e referências observadas invariáveis. A correção evita futuras escritas parciais; não desfaz as antigas. Não houve deleteMany, truncate, reset ou recriação de catálogo produtivo. O próximo deploy precisa revisar, em cópia descartável, as reconciliações SYSTEM esperadas e preservar os extras até decisão específica. Evidências: [observações](docs/evidence/phase01/incident-observations.json) e [índices/FKs](docs/evidence/phase01/catalog-constraints.json).

## 13. Revisão WEB

A candidata preserva a base responsiva publicada; não altera CSS, navegação, busca, filtros ou handlers de comando manual. Browser passou em 360/390/412 px, landscape 844×390, tablets e desktop até 1920×1080. Os testes novos verificam M8=0, erro 401, perfil FAST roteado, limiar real no contrato simulado e ausência de overflow global. Capturas locais estão em `.artifacts/responsive/screenshots` da worktree WEB.

Com executionEnabled=false, o banner mostra **MONITORAMENTO AUTOMÁTICO ATIVO / MITIGAÇÃO AUTOMÁTICA DESABILITADA** quando o avaliador está RUNNING. Sem endpoint confirmado, mostra autorização não confirmada. Autorização global exige instalação, persistência/lifecycle/prontidão/M8, allowlists, limite e REMOVE=0; perfil ainda tem gates próprios. Estado físico exige evidência verificada da API e prazo limitado, não runtime isolado. A correção não foi publicada nem submetida à aprovação visual em produção.

## 14. AGLINK/SHADOW — diagnóstico somente por leitura

AGLINK `cmuoavm4e00bysslhqd0h3q7u`: BHE-VTA-F1A-BGP-01, Eth-Trunk1.3058, ifIndex **236**, banda contratada **10.000.000.000 bps**, threshold **90%=9.000.000.000 bps**, **3 amostras distintas**, TX via ENV. Direção nula no perfil/interface não implica ausência: há fallback ENV comprovado nos logs. Velocidade física do trunk de 300 Gbps não foi usada como contrato. Policy PL-AGLINK_IPv4-IN, família IPv4, RT 268568:660, plano 1/2. BgpPeer 10.200.201.2 está associado à interface correta, ESTABLISHED, 3 prefixos na leitura; isso não substitui readback Huawei atual.

Evidências temporais dos logs:

- 20:42:26 UTC: SNAPSHOT_UNAVAILABLE, limiar nulo, durante inicialização.
- 20:43:01 UTC: NO_ACTION/THRESHOLD_NOT_EXCEEDED, tráfego 181.353.429 bps, limiar 9.000.000.000 bps, TX/ENV.
- 22:32:37 UTC: TELEMETRY_UNAVAILABLE e limiar nulo.
- 22:33:08 UTC: recuperação de leitura, NO_ACTION/THRESHOLD_NOT_EXCEEDED, tráfego 525.377.077 bps e limiar 9 Gbps.

Na coleta das 23:15 UTC, FAST da interface estava VALID/UP, intervalo **10.130 ms**, idade **6,52 s**. SNMP legado tinha amostra mais recente às 23:11:20 UTC, muito mais antiga; os diagnósticos não devem confundir essas fontes. Logs são suprimidos quando repetidos, portanto último log não é prova de último tick em memória.

**Causa de SHADOW/limiar indisponível no painel:** bridge global ENFORCE, mas sua allowlist ENFORCE contém somente `cmuoavm4x00c3sslhworjdb9i`; AGLINK está na lista de roteamento FAST e fora dessa allowlist. O shadow exclui perfis roteados; o resumo `decisions` do endpoint inclui decisões operacionais somente de ENFORCE. A WEB antiga procura apenas esse resumo e chama todo perfil não ENFORCE de SHADOW. Assim perde a decisão operacional que já existe em `engine.decisions`. A correção WEB usa esse campo por profileId exato, mantendo fonte da amostra e autorização separadas.

Logo, **não é exclusivamente M8 desligado**: há seleção/rotulagem de dados no painel, período de snapshot indisponível e ao menos uma interrupção real de leitura registrada. O cálculo de 9 Gbps está demonstrado. Nenhum threshold, contador, binding, flag ou tráfego foi alterado.

`GET /api/bgp/mitigation/auto/lifecycle`, `/api/bgp/mitigation/auto/shadow`, `/api/bgp/mitigation/fast-bridge` e seus estados atuais em memória: **NOT_VERIFIED**. Não houve login, extração de sessão, uso de cookie de terceiro ou bypass. Para homologação posterior faltam respostas autenticadas legítimas atuais, prontidão dos gates, readbacks/escopo físicos autorizados e validação operacional; o piloto permanece NO-GO.

## 15. Plano de publicação API/WEB independente

Roteiro preciso, gates de interrupção e fluxogramas: [PHASE01_STABILIZATION.md](docs/PHASE01_STABILIZATION.md). O plano antigo de ativação recebeu aviso da Fase 0.1 e perdeu a instrução insegura de restart exclusivo sem análise MCP.

API: aprovar commits/pacote Linux, ensaiar catálogo em cópia descartável, capturar estado, preservar flags 0 e EnvironmentFiles, instalar release separada somente mediante autorização futura e usar a janela de serviços explicitamente aprovada. Sem migration. WEB: release própria derivada de f4b31fc, identidade IMPLANTAR, BUILD_ID/hashes próprios, sem reiniciar API/MCP/Observer. N8n RC7.1.2 permanece publicado e intocado. Nenhuma etapa foi executada em produção.

## 16. Rollback e dependência MCP

Retorno imediato de código seria à e78638a atual, com flags 0 preservadas e análise dos efeitos conhecidos de boot/catalog. Restart/rollback tem o mesmo problema de Requires: exige janela MCP autorizada ou nova prova de isolamento real. Não restaurar banco inteiro nem excluir perfis/templates para compensar um retorno de código.

RC13 é um retorno mais distante e exige nova revisão fail-closed: não depender apenas de M8=0 da RC13; preparar barreiras independentes comprovadas e observar que LIVE_WRITE=false bloqueia temporariamente ACTIVATE/REMOVE manuais também. Nenhum retorno deve retirar mitigação física automaticamente. Nenhum rollback foi executado.

## 17. Riscos residuais e autorizações pendentes

- As correções estão isoladas; a produção ainda executa o boot e a WEB anteriores. Não reiniciar incidentalmente supondo que já foram corrigidos.
- O laboratório usa systemd 259.9 e serviços fake, não MCP real/259.5. Preservação estrita de MCP durante restart API permanece não homologada.
- Integridade retroativa total do catálogo não pode ser afirmada. Os 13 templates extras e o 39º perfil exigem revisão, não limpeza automática.
- Os endpoints autenticados atuais permanecem NOT_VERIFIED; dados em memória não foram inferidos de logs antigos como se fossem respostas atuais.
- Fonte SNMP legada e FAST têm frescor diferente. A WEB permanece conservadora quando falta evidência individual; indicador global não libera um perfil.
- Há 23 testes preexistentes skipped, nenhum Huawei físico homologado aqui e nenhum pacote Linux novo autorizado.

Autorizações restantes: revisão desta entrega; eventual sessão legítima/retorno dos GETs pelo operador em tarefa futura; pacote Linux e publicação API; escopo de restart MCP ou homologação prévia do isolamento; publicação WEB e aprovação visual; revisão separada de catálogo/perfis se necessária. Migration/outbox, piloto AGLINK e habilitação AUTO ACTIVATE exigem missões/autorizações próprias. **AUTO REMOVE não é uma autorização pendente: permanece proibido pelo produto.**

## 18. Decisão e encerramento

**NO-GO para aceitar a Fase 0 produtiva ou iniciar homologação física agora.** Causas foram identificadas, correções e regressões estão preparadas para revisão, e o novo pré-flight impede repetir a suposição API-only que reiniciou MCP.

**GO apenas para revisão técnica dos commits e evidências locais.** Todos os 17 critérios comparativos de integridade produtiva passaram. Nenhum restart/stop/daemon-reload produtivo, deploy, migration, alteração de perfil/configuração, comando Huawei, mensagem Telegram ou mudança n8n foi executado. As únicas execuções mutantes de systemd e PostgreSQL de teste ocorreram em containers locais descartáveis.

Parar aqui. Revisão e nova autorização operacional são necessárias antes de qualquer mudança em produção.
