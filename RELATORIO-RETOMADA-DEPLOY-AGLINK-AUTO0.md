# IMPLANTAR — retomada do deploy AGLINK AUTO=0

**30/10/2026. Publicação concluída; aceite final às 14:37:12, horário de Brasília.**

A API aprovada foi reativada às **14:32:27**, com um restart da API e restart indireto autorizado do MCP. Não houve rollback nesta retomada. Os 25 critérios de aceite passaram. O erro conhecido do bootstrap do catálogo permaneceu registrado e foi aceito somente após comprovação de isolamento e preservação dos dados, conforme a instrução revisada do operador.

## 1. Versão publicada

- Commit efetivo: `463769620a2f39f9803b60a43314851fe3a77e0e`.
- SHA256 do pacote: `f47210e4d018d954f1723d31e29a050995169d5e9dd57ce35ad7a01e68172afe`.
- SHA256 do `server.cjs` executado: `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`.
- CWD efetivo: `/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e/apps/api`.

Reutilizada a release existente: 10.070 arquivos e 13 links conferidos. Sem alteração de código, novo build ou novo pacote. A release `e78638af51762db93f52f61195ca57d8c72d988e` permanece preservada para rollback.

## 2. Serviços

| Serviço       | PID anterior | PID final | Resultado                                                      |
| ------------- | ------------ | --------- | -------------------------------------------------------------- |
| API           | 3433280      | 3435626   | active/running; health 200; versão e hash conferidos           |
| MCP           | 3433281      | 3435627   | active/running; health 200; ferramentas de leitura respondendo |
| WEB           | 2976909      | 2976909   | active/running; HTTP 200; preservada                           |
| FAST Observer | 2594846      | 2594846   | active/running; health 200; preservado                         |

API/MCP com `NRestarts=0`, sem loop. WEB com BUILD_ID `NSfXEDCQk4S1AmACLROnj`, inalterado. Nenhum outro serviço reiniciado. O n8n permaneceu saudável, com workflow RC7.1.2 e configuração preservados.

## 3. Flags efetivas

Confirmadas no processo e pelo GET autenticado de lifecycle, com sessão própria encerrada:

```dotenv
NETVISION_INSTALLATION_ID=IMPLANTAR
MITIGATION_AUTO_PERSISTENCE_ENABLED=0
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_AUTO_MAX_ACTIVE=1
```

O endpoint retornou `executionEnabled=false`, persistence/lifecycle/lifecycleReady/remove desligados, allowlist vazia, `MANUAL_ONLY` e nenhum registro durável. `pilot=null` é esperado neste estado inativo. As permissões manuais anteriores foram mantidas. AUTO REMOVE permanece proibido.

Configuração aplicada: `/etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzzzz-single-pilot-4637696-auto0.conf` e `/etc/netvision/single-pilot-4637696-auto0.env`. Precedência dos 24 drop-ins conferida e `systemd-analyze verify` aprovado. Nenhuma alteração no vínculo `Requires` do MCP.

## 4. AGLINK

Perfil `cmuoavm4e00bysslhqd0h3q7u`, interface `Eth-Trunk1.3058` (ifIndex 236), direção TX, banda 10 Gbps, threshold 9 Gbps/90%, três amostras FAST: configuração preservada. AUTO não foi habilitado.

A leitura Huawei confirmou `PL-AGLINK_IPv4-IN` ainda somente com nodes 10/1000; prefixos, RT e vínculo do peer preservados. Nodes 1/2 não foram instalados. Não houve ACTIVATE, REMOVE ou refresh BGP nesta missão.

## 5. Integridade dos dados

- **39 perfis preservados:** 12 AUTO e 27 ALERT_ONLY; configurações e `updatedAt` idênticos. WF-REDES preservado; runtime `cmuoavmgi00e7sslhgh7quv0f` continua DISABLED.
- Contagens e hashes estruturais, excluindo timestamps, idênticos nas **13 tabelas verificadas**: seis de catálogo e sete de inventário.
- Catálogo: 134 templates, incluindo os 13 extras; 161 slots de template, 1.624 portas de template, 35 templates de módulo, 412 portas de módulo e 218 associações slot/módulo.
- Inventário: 3 sites, 3 racks, 7 assets, 20 slots, 8 módulos, 300 portas e 3 conexões. GET `/api/physical` retornou 200, com mesmos identificadores e contagens.
- Sem transação longa, lock pendente, índice inválido ou constraint não validada observados; PostgreSQL primário saudável. Histórico de migrations inalterado; tabela de automação durável ausente.
- Reidratação de mitigação: um dispositivo, um sucesso, zero falhas. Nenhum perfil criado no startup.

Nenhuma migration, reparação SQL ou alteração de templates/interfaces/thresholds foi executada. Telemetria e timestamps operacionais continuaram sua atualização normal.

## 6. Catálogo físico

**`CATALOG_BOOTSTRAP = DEGRADED`**  
**`MITIGATION_DEPENDENCY = NONE`**

O journal mantém o erro em `physicalTemplatePort.createMany()`: unicidade de `(templateId, side, sortOrder)`. Na janela observada houve um erro de API, exclusivamente esse bootstrap tratado; zero falhas fatais, erros do MCP, falhas não tratadas ou HTTP 5xx observados.

O inventário existente continuou funcional e os dados persistidos permaneceram iguais. A falha ficou isolada, sem efeito operacional inesperado detectado nos módulos verificados. O catálogo não foi corrigido nem declarado saudável. Qualquer perda desse isolamento exige reavaliação e rollback conforme os critérios autorizados.

## 7. Ausência de escrita Huawei e preservação operacional

Leituras físicas antes/depois, eventos e logs concordam: nenhuma escrita Huawei ou ACTIVATE/REMOVE adicional observados. Agregados permanecem ACTIVATE=4, REMOVE=4 e SIMULATION=3. Nenhum writer avulso ou comando de mitigação em andamento identificado. Nenhuma mensagem Telegram de teste enviada. WEB, Observer, n8n, VNT e Fibinet não foram modificados.

Backup operacional novo, cifrado, com recuperação em memória validada e chave separada: `/var/backups/netvision-single-pilot-resume-auto0-4637696-20261030/operational-config.aesgcm`. SHA256: `9d444e07904302bdf2e2bcf54ce635873cab86444c438b2484bbc9478574143d`. Reserva final de disco: aproximadamente 5,71 GiB, acima do mínimo de 5 GiB.

## 8. Decisão e encerramento

**GO para manter a publicação API-only com AUTO=0. GO somente para preparar a persistência durável em trabalho posterior autorizado.**

Nenhuma preparação adicional, migration, ativação AUTO ou homologação física foi iniciada. Aplicar persistência, habilitar AUTO ou executar ACTIVATE/REMOVE real exige autorização específica. O deploy atual não comprova homologação Huawei do fluxo automático.

Evidência resumida: [aceite final](docs/evidence/resume-single-pilot-auto0.json). A [tentativa anterior](RELATORIO-DEPLOY-SINGLE-PILOT-AGLINK-AUTO0.md) permanece registrada como histórico; seu rollback não descreve o estado atual. Trabalho encerrado após publicação e validação.
