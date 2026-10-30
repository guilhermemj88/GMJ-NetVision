# IMPLANTAR — persistência durável AGLINK ativada

**30/10/2026 — operação concluída e aceita. Persistência ativa; mitigação automática desligada.**

Procedimento seguido: [operação validada em fe50dd3](docs/AGLINK_DURABLE_PERSISTENCE_OPERATION.md), com autorização específica do operador nesta missão. Código/API preservado em `463769620a2f39f9803b60a43314851fe3a77e0e`; SHA256 do bundle executado `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`. Nenhum build, pacote ou código novo publicado.

1. **Migration aplicada:** somente `20261029090000_auto_lifecycle_durable`, entre **16:24:34 e 16:24:39 de Brasília**, com todas as flags ainda desligadas. SHA256 `a64023cfec58be1de1f0be53f411a994f8c3ef482e06a98e58a896344fddb795`. São **43 migrations concluídas**, nenhuma interrompida; os 42 registros históricos anteriores, inclusive checksums, foram preservados. Tabela `MitigationAutomationRecord`, seis colunas NOT NULL, PK e dois índices conferidos e válidos, sem FK/trigger inesperados. Nenhum outro escritor DDL observado nos gates privilegiados.

2. **Flags efetivas:** alterada somente persistência de `0` para `1`, às **16:25:12**, no EnvironmentFile final `/etc/netvision/single-pilot-4637696-auto0.env`. Substituição atômica, dono/permissões preservados; mesma precedência dos 24 drop-ins, sem novo drop-in ou daemon-reload. Valores confirmados no processo:

   ```dotenv
   NETVISION_INSTALLATION_ID=IMPLANTAR
   MITIGATION_AUTO_PERSISTENCE_ENABLED=1
   MITIGATION_AUTO_LIFECYCLE_ENABLED=0
   MITIGATION_AUTO_EXECUTION_ENABLED=0
   MITIGATION_AUTO_REMOVE_ENABLED=0
   MITIGATION_AUTO_DESCRIPTION_ENABLED=0
   MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
   MITIGATION_AUTO_MAX_ACTIVE=1
   ```

   As demais configurações e permissões manuais foram preservadas, incluindo executor Huawei, allowlist de dispositivo, MODE e LIVE_WRITE. Não foi habilitado AUTO ACTIVATE ou AUTO REMOVE.

3. **API/MCP saudáveis:** um restart planejado às **16:25:17**, com restart indireto do MCP conforme o grafo systemd existente. Ambos com HTTP 200 e `NRestarts=0`; ferramentas MCP respondendo. WEB e FAST Observer permaneceram com os mesmos PIDs, artefatos e flags, ambos HTTP 200. Nenhum serviço adicional reiniciado.

   | Serviço       | PID anterior | PID final |
   | ------------- | ------------ | --------- |
   | API           | 3435626      | 3440280   |
   | MCP           | 3435627      | 3440281   |
   | WEB           | 2976909      | 2976909   |
   | FAST Observer | 2594846      | 2594846   |

4. **Persistência disponível, lifecycle desligado:** GET autenticado `/api/bgp/mitigation/auto/lifecycle` retornou 200, `persistenceEnabled=true`, `lifecycleReady=true`, `lifecycleEnabled=false`, `executionEnabled=false`, `removeEnabled=false`, `allowedProfiles=[]` e `removalPolicy=MANUAL_ONLY`. `pilot=null`, maxActive=1 e **zero registros duráveis**, esperado nesta inicialização sem comandos; nenhuma entrada artificial foi criada. Sessão própria legítima encerrada por logout. Reidratação de snapshots: um dispositivo, um sucesso, zero falhas.

5. **Dados preservados:** os 39 perfis e seus parâmetros/timestamps ficaram idênticos: 12 AUTO e 27 ALERT_ONLY, sem habilitar execução. Estados preservados: 38 NORMAL e um DISABLED. As **13 tabelas de catálogo/inventário** conservaram contagens e hashes completos, **incluindo createdAt/updatedAt**, antes/depois da migration e do restart. Permanecem 134 templates, incluindo os 13 extras, 3 sites, 3 racks, 7 assets e 3 conexões; inventário e catálogo consultáveis por HTTP 200. Zero índice inválido, constraint não validada, transação longa ou lock pendente observado.

   **`CATALOG_BOOTSTRAP=DEGRADED`; `MITIGATION_DEPENDENCY=NONE`.** O journal preserva o erro conhecido de unicidade em `physicalTemplatePort.createMany()`, campos `(templateId,side,sortOrder)`. Foi o único erro de API observado, isolado no bootstrap; zero falhas fatais, erros MCP, falhas não tratadas ou HTTP 5xx. O catálogo não foi corrigido, ocultado ou declarado saudável.

6. **Ausência de comandos Huawei/Telegram:** readbacks físicos somente por leitura, renovados antes da migration e após a observação, confirmaram AGLINK `PL-AGLINK_IPv4-IN`, peer `10.200.201.2`, **nodes 1/2 ausentes e 10/1000 preservados**, com os mesmos prefixos, RTs e vínculo import. Nenhum ACTIVATE, REMOVE ou refresh BGP executado. Histórico permanece ACTIVATE=4, REMOVE=4, SIMULATION=3. Logs de entrega de mitigação permanecem em 43, com mesmos marcadores de tentativa/sucesso; nenhuma notificação real ou teste Telegram disparado. n8n não foi modificado.

7. **Rollback não necessário:** os **29 critérios de aceite passaram**, com **324 segundos de observação** na leitura final, PIDs estáveis e nenhuma mudança fora do escopo. Tabela, índices e histórico permanecerão preservados; não houve DROP, TRUNCATE, restauração produtiva ou alteração de LIVE_WRITE. O rollback preparado limita-se a restaurar a configuração anterior de persistência e ao restart API/MCP autorizado se necessário; qualquer dúvida sobre operações manuais exige informar o operador antes de mudar permissões.

   Backup **renovado nesta janela**, fora do servidor, em `D:\NetVision-Backups\IMPLANTAR-AGLINK-EXEC-20261030T1905`: **2.451.057.776 bytes**, cifrado AES-256-GCM, SHA256 `5e57b896a6c70a6cc2e059a55b23095ddad05c4c44d54a1e9844cfef2c42c53b`. Globais e configuração operacional também cifrados; chave separada com custódia e recuperação revalidadas. Restauração completa em PostgreSQL descartável 18.6 aprovada às **16:23:57**, antes da primeira escrita: 64 tabelas, papéis/owners/ACLs, hashes/tags e fingerprints estáveis válidos. Não houve dump integral no volume produtivo. Banco descartável e volume de dados removidos; backups cifrados e chave preservados.

8. **GO técnico para a próxima homologação física da AGLINK**, mediante autorização específica para o teste BGP real. Esta missão não executou homologação física, ACTIVATE/REMOVE ou habilitação de lifecycle/AUTO. Persistência permanece ativa; retirada continua exclusivamente manual. Encerrado após publicação da configuração e validação.

[Evidências consolidadas](docs/evidence/aglink-durable-persistence-execution.json), sem credenciais, cookies ou chaves.
