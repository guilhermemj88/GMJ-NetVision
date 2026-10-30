# IMPLANTAR — preparação da persistência durável AGLINK

**30/10/2026 — GO técnico para a operação proposta, mediante autorização específica. Nenhuma operação produtiva executada.**

API preservada: `463769620a2f39f9803b60a43314851fe3a77e0e`; bundle SHA256 `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`. Sem mudança no motor, plano BGP, executor, n8n, catálogo ou pacote. A branch isolada `prep/aglink-durable-persistence` adiciona apenas testes e documentação/evidências.

## Migration e dependências

`20261029090000_auto_lifecycle_durable` é **a única pendente**, com 42 anteriores concluídas e nenhuma interrompida. SHA256 exato: `a64023cfec58be1de1f0be53f411a994f8c3ef482e06a98e58a896344fddb795`.

Cria somente `MitigationAutomationRecord`, com seis colunas obrigatórias (`id`, `kind`, `status`, `payload` JSONB, `createdAt`, `updatedAt`), PK em `id` e índice B-tree `(kind,status,updatedAt)`. PostgreSQL 18 registra também os seis NOT NULL no catálogo de constraints. Sem FK, trigger, enum/check de estados ou alteração de perfis, telemetria, catálogo e histórico BGP. A API já contém o modelo Prisma e os consumidores compatíveis.

Quatro checksums históricos diferem **somente por CRLF/LF**, comprovados byte a byte; nenhum SQL divergente. Não foram reparados ou regravados. O CLI embarcado aceitou esse histórico na cópia restaurada. Permissões efetivas do papel usado pela API para schema, histórico de migrations e advisory lock foram confirmadas por leitura.

## PostgreSQL e recuperação de estado

| Verificação isolada                                                | Resultado                                                                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 18.6, schema produtivo e 42 migrations de referência    | Migration aplicada sozinha; status atualizado                                                                                |
| Cópia completa restaurada, CLI Linux Prisma 6.19.3 do pacote exato | Somente a migration indicada aplicada; 42 → 43                                                                               |
| Dados comparados antes/depois da migration na cópia                | Perfis, runtimes, peers e 13 tabelas físicas idênticos, incluindo timestamps; apenas histórico de migrations ganha uma linha |
| PK, seis NOT NULL e dois índices                                   | Válidos; duplicidade e ausência de updatedAt rejeitadas por SQLSTATE 23505/23502                                             |
| Regressões existentes, incluindo PostgreSQL e transporte fake      | 96/96 aprovadas                                                                                                              |
| Novas provas independentes com PostgreSQL e HTTP loopback          | 4/4 aprovadas                                                                                                                |
| API 4637696, também contra a cópia completa restaurada             | Health 200; persistence=true, lifecycleReady=true; lifecycle/execution/remove=false; MANUAL_ONLY                             |
| Restart real do processo API de laboratório                        | Journal/ownership preservados; mesmo payload/eventId da outbox; UNCERTAIN retido                                             |

**100 testes aprovados, zero falhos ou ignorados nessas suítes.** Typecheck API, ESLint do teste novo e formatação aprovados. Testes cobriram transação concorrente/rollback, ACTIVATE fake único, restart sem segundo ACTIVATE, hold após normalização, UNCERTAIN bloqueando replay, REMOVE manual verificado com M8 desligado, receipt idempotente e HTTP NACK → retry → ACK com o mesmo evento. Os transportes Huawei são fake; o HTTP é local. Nada disso constitui readback físico ou homologação Huawei.

No laboratório, foram corrigidos apenas parâmetros do ensaio: formato base64 da chave efêmera, runtime com OpenSSL 3 e campo de login. A cópia completa usou login legítimo do operador somente no clone, com logout; nenhum login autenticado foi realizado na produção. Nenhum segredo de criptografia produtivo foi importado para a API de teste. Os quatro containers e seus volumes de dados descartáveis foram removidos após as provas.

## Backup externo e restauração

Banco de origem: aproximadamente **25,43 GB**. Destino fora do servidor: `D:\NetVision-Backups\IMPLANTAR-AGLINK-20261030`, com **264.326.893.568 bytes livres antes** e **261.876.068.352 depois**. ACL restrita; chave separada/restrita no Windows.

Backup consistente MVCC por `pg_dump` 18.6, custom/gzip:3, transmitido via SSH diretamente para AES-256-GCM: **2.450.078.777 bytes**, sem dump integral no volume produtivo e sem arquivo de dump plaintext no destino. SHA256 do cifrado: `907e437f38a08c1369cf7a928f072f41dbdf25159db97e66feda09ce19f4d9b6`. Globais/papéis também cifrados separadamente.

**Restauração completa aprovada às 15:14:24 de Brasília:** PostgreSQL descartável 18.6, papéis/owners/ACLs restaurados, `pg_restore --exit-on-error --single-transaction` exit 0; tags GCM e SHA256 dos fluxos conferidos; 64 tabelas antes da migration, zero índice inválido e zero constraint não validada. Fingerprints das 16 tabelas estáveis conferidas coincidiram com a origem; counters de runtime, naturalmente voláteis, foram comparados separadamente antes/depois da migration no clone. Backup e chave permanecem preservados; não há pendência de restauração deste ensaio. Renovar o backup para uma janela posterior e manter custódia da chave.

## Configuração e operação futura única

Na próxima operação autorizada, alterar **somente persistência de 0 para 1**, mantendo:

```dotenv
MITIGATION_AUTO_PERSISTENCE_ENABLED=1
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_AUTO_MAX_ACTIVE=1
```

O [roteiro exato de aplicação, gates e rollback](docs/AGLINK_DURABLE_PERSISTENCE_OPERATION.md) reúne uma única janela: revalidar backup/pendências/ausência de comandos → aplicar somente a migration com flags ainda desligadas → validar dados/schema → trocar a única flag → um restart autorizado API/MCP → conferir processo, saúde, lifecycle e ausência de escrita. Nenhuma dessas ações produtivas foi executada nesta missão.

Rollback mantém bundle, tabela, índices, registros duráveis e nodes Huawei. Desabilita persistência e conserva lifecycle/AUTO/REMOVE desligados; diante de dúvida, congela também escrita manual por LIVE_WRITE=false/MODE=SIMULATION_ONLY, com impacto operacional explícito e restart autorizado. Não executar DROP/TRUNCATE, limpar UNCERTAIN/outbox ou restaurar snapshot antigo sobre produção.

## Produção preservada e decisão

Leitura final às **15:15:57 de Brasília**: API/MCP/WEB/Observer ativos, mesmos PIDs **3435626 / 3435627 / 2976909 / 2594846**, flags originais intactas, persistência/lifecycle/execução/REMOVE/description=0, allowlist vazia e maxActive=1. Tabela durável ainda **ausente**; migration permanece pendente. 39 perfis (12 AUTO/27 ALERT_ONLY) e configuração preservados; um runtime DISABLED e 38 NORMAL. Eventos seguem ACTIVATE=4, REMOVE=4, SIMULATION=3. Sem migration, restart, escrita Huawei, Telegram real, alteração de configuração ou equipamento nesta missão.

Catálogo não corrigido: `CATALOG_BOOTSTRAP=DEGRADED`, `MITIGATION_DEPENDENCY=NONE`. Dados das 13 tabelas físicas preservados; cerca de 5,73 GiB livres no servidor, sem dump local.

**GO para aplicar a migration e habilitar somente persistência na operação descrita, após autorização específica que inclua restart API/MCP.** Não é autorização para lifecycle, ACTIVATE, REMOVE ou piloto físico. Persistência não torna a entrega Telegram exactly-once: ACK perdido pode causar repetição com ID estável; FAILED após o limite de retries exige revisão humana. A homologação física e a entrega real permanecem para autorização própria.

[Evidências consolidadas](docs/evidence/aglink-durable-persistence-preparation.json). Trabalho encerrado antes da primeira alteração operacional produtiva.
