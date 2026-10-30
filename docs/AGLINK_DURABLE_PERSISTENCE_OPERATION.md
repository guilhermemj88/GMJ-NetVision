# AGLINK — operação proposta para habilitar somente persistência

**Preparação de 30/10/2026. Este documento não autoriza execução.** Uma única janela de mudança, com autorização específica para a migration e para um restart da API e seu MCP dependente. Nenhum ACTIVATE/REMOVE físico integra esta operação.

## Escopo imutável

API `463769620a2f39f9803b60a43314851fe3a77e0e`, bundle SHA256 `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`. Não trocar pacote, executar build, modificar FAST/BGP/Huawei/n8n/catálogo ou incluir worker. Banco permanece no servidor atual; o destino externo é de backup.

Migration única: `20261029090000_auto_lifecycle_durable`, SHA256 `a64023cfec58be1de1f0be53f411a994f8c3ef482e06a98e58a896344fddb795`. Cria somente:

- `public."MitigationAutomationRecord"`: `id`, `kind`, `status` TEXT NOT NULL; `payload` JSONB NOT NULL; `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP; `updatedAt` TIMESTAMP(3) NOT NULL, preenchido pelo Prisma.
- PK `MitigationAutomationRecord_pkey` em `id`, com seu índice único.
- Índice B-tree `MitigationAutomationRecord_kind_status_updatedAt_idx` em `(kind,status,updatedAt)`.

Sem FK, enum/check de estados, trigger, atualização de dados existentes ou dependência de migration adicional. Ownership/journal/outbox/episódios compartilham essa tabela, com discriminação e validação no código existente. Transações curtas usam advisory lock; não prendem uma transação ao SSH/HTTP.

## Gates antes da janela

1. Confirmar autorização vigente, operador disponível, ausência de ACTIVATE/REMOVE, scope lock ou outro escritor em andamento. Suspender novas solicitações manuais durante a troca. Não habilitar AUTO como teste.
2. Registrar PIDs/CWD/hash/API health, estado MCP/WEB/Observer, configuração efetiva e permissões manuais. Exigir as sete flags abaixo no estado atual, com persistência ainda `0`. Confirmar os mesmos 39 perfis, configuração AGLINK, DISABLED e contagens/hashes das tabelas estáveis.
3. Confirmar backup externo íntegro, chave acessível por canal protegido, restauração descartável aprovada e espaço livre suficiente no destino de recuperação. Antes de uma janela posterior, renovar backup e conferir o mesmo procedimento; não tratar o snapshot de 30/10 como proteção de dados futuros. Nunca criar dump integral no volume produtivo.
4. Comparar a lista completa de migrations da **release efetiva** com `_prisma_migrations`, consultado em READ ONLY. Exigir 42 concluídas, nenhuma interrompida e **somente** a migration indicada pendente. Confirmar inexistência da tabela nova e ausência de objeto homônimo/índice parcial. Conferir SHA256 de todos os arquivos contra o pacote aprovado.
5. As quatro diferenças históricas de checksum conhecidas correspondem exatamente a CRLF versus LF: `20261018020000_mitigation_priority_traffic`, `20261023000000_mitigation_direction_audit`, `20261024000000_mitigation_fast_bridge` e `20261025000000_interface_mitigation_traffic_direction`. Comparar os bytes normalizados e os hashes CRLF com os registrados. Não editar migrations históricas nem `_prisma_migrations`. Qualquer diferença adicional, mudança SQL ou outra pendência interrompe a operação.

## Sequência única, somente após autorização

1. **Aplicar a migration com persistência ainda desligada**, usando o CLI Prisma 6.19.3 embarcado na release e `DATABASE_URL` obtida apenas em memória do processo API conferido. Não imprimir/exportar a URL, copiá-la para shell history ou usar a árvore `/opt/GMJ-NetVision` como fonte. Como cwd, usar `/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e/apps/api`.

   A invocação do subprocesso, com ambiente protegido, é exatamente:

   ```text
   /usr/bin/node ../../node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
   ```

   Impor `PGOPTIONS=-c lock_timeout=3000 -c statement_timeout=60000` nesse subprocesso, sem alterar o ambiente persistido do serviço. A lista de pendências já foi validada, portanto `migrate deploy` deve anunciar e aplicar **somente** `20261029090000_auto_lifecycle_durable`. Não usar `migrate dev`, `db push`, `reset` ou `resolve` como atalho.

2. **Validar antes de habilitar persistência:** exit 0; nova linha concluída em `_prisma_migrations`, checksum correto, sem `rolled_back_at`; nenhuma outra pendência; tabela vazia; seis colunas, PK e índice conforme acima, válidos/prontos; sem FK/triggers inesperados. Os dados anteriores devem manter os hashes/contagens de referência, descontando somente telemetria/timestamps operacionais que naturalmente evoluem. Exigir API/MCP saudáveis e ausência de nova escrita/evento Huawei.
3. **Trocar somente `MITIGATION_AUTO_PERSISTENCE_ENABLED=0` por `1`** no EnvironmentFile final `/etc/netvision/single-pilot-4637696-auto0.env`. Antes da substituição, exigir exatamente uma definição da chave e conferir a precedência real de todos os drop-ins/EnvironmentFiles. Guardar configuração anterior em backup cifrado; substituir o arquivo atomicamente preservando dono/permissões. Não criar outro drop-in ou modificar o executor/permissões manuais. O restante continua:

   ```dotenv
   MITIGATION_AUTO_PERSISTENCE_ENABLED=1
   MITIGATION_AUTO_LIFECYCLE_ENABLED=0
   MITIGATION_AUTO_EXECUTION_ENABLED=0
   MITIGATION_AUTO_REMOVE_ENABLED=0
   MITIGATION_AUTO_DESCRIPTION_ENABLED=0
   MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
   MITIGATION_AUTO_MAX_ACTIVE=1
   ```

4. **Um restart planejado:** `systemctl restart netvision-api.service`. O grafo atual reinicia o MCP indiretamente; isso deve estar autorizado na mesma janela. Não reiniciar WEB/Observer ou alterar `Requires`. Alterar só o conteúdo de EnvironmentFile não exige criar unit/drop-in ou executar daemon-reload.
5. **Aceitar somente após verificar:** CWD e hash 4637696; flags reais no `/proc`; health API/MCP/WEB/Observer 200; ferramentas MCP funcionando; WEB/Observer com os mesmos PIDs; API/MCP sem loop. Em sessão legítima do operador, GET `/api/bgp/mitigation/auto/lifecycle` deve retornar `persistenceEnabled=true`, `lifecycleReady=true`, `lifecycleEnabled=false`, `executionEnabled=false`, `removeEnabled=false`, allowlist vazia, maxActive 1 e `MANUAL_ONLY`. `pilot=null` é esperado com lifecycle desligado.
6. Conferir registros por kind/status, ausência de intent AUTO STARTED e de novos ACTIVATE/REMOVE/eventos físicos. Ownership desconhecido/UNCERTAIN exige reconciliação humana: não limpar registros nem forçar NORMAL. Confirmar perfis/catálogo/inventário preservados. Observar pelo menos cinco minutos, incluindo ciclos normais de workers existentes, sem criar amostra ou notificação artificial. Persistência ativa pode enfileirar alertas legítimos de detecção e resultados de futuras operações manuais; validar backlog e ACK operacionalmente, sem enviar Telegram de teste nesta mudança.

## Interrupção e rollback

Interromper antes da próxima ação diante de migration extra/interrompida, alteração SQL, backup inválido, indisponibilidade de chave, falha de índice/constraint, perda de dados, flags/hash divergentes, erro de API/MCP, restart não previsto, nova escrita BGP ou catálogo deixando de estar isolado.

- Falha **antes** da troca de flag: manter persistência/lifecycle/AUTO desligados e API 4637696. Uma migration pode deixar objetos parciais ou linha não concluída porque o SQL não envolve explicitamente todos os statements em uma transação. Preservar evidência e interromper; não repetir `deploy`, apagar tabela ou usar `resolve` automaticamente.
- Falha **após** habilitar persistência: congelar solicitações de escrita, preservar registros e nodes e, com autorização operacional de rollback, restaurar persistência=0/lifecycle=0/execução=0/REMOVE=0/description=0/allowlist vazia. Manter o mesmo bundle. Se houver qualquer incerteza operacional, impor adicionalmente `MITIGATION_LIVE_WRITE_ENABLED=false` e `MITIGATION_MODE=SIMULATION_ONLY` antes do restart API/MCP autorizado; isso suspende temporariamente ACTIVATE/REMOVE **manuais** também. Retomada manual exige readback e decisão do operador.
- Manter a tabela, índices, ownership, journal, episódios e outbox, inclusive PENDING/UNCERTAIN. Não apagar registros, truncar fila, alterar estado para NORMAL ou executar compensação Huawei. Desabilitar persistência pausa a outbox; não prova entrega nem autoriza replay.
- Não restaurar snapshot antigo sobre produção como rollback desta migration aditiva: isso perderia dados posteriores. Recuperação por backup é procedimento de desastre, em PostgreSQL separado, com chave, globais e arquivo íntegros, validação completa e autorização própria antes de qualquer eventual troca.
- Se for necessário retornar ao código e78638a, tratar como rollback de release separado, conservando schema/registros e barreiras independentes de escrita. M8 da RC13 isoladamente não é proteção suficiente.

O erro já conhecido do bootstrap do catálogo continua `CATALOG_BOOTSTRAP=DEGRADED`, `MITIGATION_DEPENDENCY=NONE`; sozinho não dispara rollback se consultas e integridade continuarem preservadas. Não o corrigir nem ocultar nesta operação.

## Recuperação externa ensaiada

Destino fora do servidor IMPLANTAR: `D:\NetVision-Backups\IMPLANTAR-AGLINK-20261030` no Windows, ACL restrita ao operador e SYSTEM. Contém `production.pgcustom.aesgcm`, `manifest.json`, `globals.sql.aesgcm` e `globals-manifest.json`. Chave separada em `C:\Users\g_men\.codex\secure-backups\implant-aglink-persistence-20261030\recovery-key.bin`, também restrita. Não colocar a chave no repositório ou junto do dump.

O `pg_dump` 18.6 usa snapshot MVCC consistente, formato custom com gzip nível 3, conexão READ ONLY e timeout curto de aquisição de lock; os bytes passam por SSH diretamente para cifragem AES-256-GCM no destino externo. Não há dump intermediário no servidor. Os globais são extraídos por leitura como postgres e cifrados, incluindo papéis e informações de autenticação.

Para recuperar: verificar tamanho/hash do cifrado e manifestos; disponibilizar a chave protegida; criar PostgreSQL descartável 18.6 com administrador temporário de nome distinto dos papéis originais; decifrar e restaurar globais; decifrar o custom diretamente para `pg_restore --exit-on-error --single-transaction`, em banco separado. Validar tag GCM e SHA256 de ambos os fluxos, exit 0, papéis/owners/ACLs, PK/FKs/índices e fingerprints dos dados estáveis antes de aceitar. Nenhum plaintext de dump precisa ser salvo. Verificar a identidade do destino antes de qualquer restauração.

O relatório de preparação registra o resultado concreto desse ensaio. Uma segunda cópia externa/offline e custódia independente da chave são recomendadas para retenção; o backup desta janela não substitui a política contínua de recuperação.
