# IMPLANTAR — plano de ativação AUTO DDoS

Preparação isolada de 29/10/2026. **Este documento não autoriza execução.** Não executar comandos desta seção sem aprovação da fase correspondente. WEB, MCP, observer FAST, VNT e Fibinet ficam fora da publicação.

## Contrato implementado

`MitigationAutoEngine` continua detectando; `AutoMitigationLifecycle` é o coordenador durável de escrita e recuperação. Toda escrita usa o mesmo `MitigationCommandService`, lock da policy, executor Huawei, preflight e readback das operações manuais. Não há executor SSH alternativo no coordenador. O status legado `AUTO_REMOVE_DISABLED` do motor representa sua decisão de observação; o coordenador separado decide a retirada e registra o resultado no journal.

O ciclo exige instalação IMPLANTAR, persistência, lifecycle, M8, profile e dispositivo explicitamente permitidos. REMOVE exige ainda sua própria flag. Padrão: tudo desligado. As exceções legadas da allowlist do motor não passam pela autorização adicional do coordenador. AUTO nunca usa MOCK como resultado de produção.

Policies compartilhadas e duas famílias AUTO na mesma interface são recusadas. Limite inicial: uma ownership AUTO ativa/em execução/incerta em toda a instalação. Incerteza consome capacidade e impede retry físico. Cooldown padrão 600 s; permanência mínima 900 s; recuperação mínima 60 s e `recoverySamples` novas; frescor e gap máximos 15 s. Configurações inválidas usam limites seguros ou bloqueiam. Thresholds são inteiros em bps; trigger estritamente `>` e recuperação estritamente `<`, com histerese.

## Recuperação não pode ser inferida do desvio

TX baixo na interface do cliente pode resultar da mitigação. REMOVE exige mapeamento explícito de uma **interface diferente**, no mesmo dispositivo, cuja direção meça o tráfego oferecido ao alvo mesmo durante o desvio. Validar causalmente esse ponto com a operação antes de configurar. Um agregado sem separação por cliente pode impedir recuperação; um contador que deixe de enxergar o ataque não serve.

`MITIGATION_AUTO_RECOVERY_PROOF_JSON` tem formato:

```json
[
  {
    "profileId": "PERFIL_IPV4_APROVADO",
    "interfaceId": "INTERFACE_INDEPENDENTE_HOMOLOGADA",
    "direction": "rx"
  }
]
```

Não preencher com a interface mitigada. O adapter verifica dispositivo, interface, UP administrativo/operacional atual, amostra utilizável, intervalo e frescor de até 15 s. Usa `InterfaceMetricSample.rxBps/txBps` em bits/s, sem multiplicar por oito. O polling convencional atual não comprovou essa cadência para uma fonte independente: **REMOVE permanece NO-GO até instrumentação/homologação**. Esta missão não alterou o polling.

Múltiplas amostras distintas, duração mínima e permanência antecedem readback físico. Dentro do lock canônico, imediatamente antes da escrita, a fonte independente é lida novamente; prova ausente, stale, alta, com gap ou configuração diferente impede REMOVE. Readback divergente conserva a mitigação e exige reconciliação. ACTIVATE manual ou APPLY LOCAL revoga ownership AUTO, inclusive ACTIVATE idempotente. O sistema não adota uma mitigação legada/manual como sua.

## Persistência e migration

Migration única nova: `20261029090000_auto_lifecycle_durable`, tabela aditiva `MitigationAutomationRecord` e um índice. Sem alteração ou remoção de tabelas/colunas existentes. Registra ownership, intent/result de comando, episódios atuais/históricos, outbox e recibo durável de rate limit.

Quatro checksums históricos diferem entre branch e banco exclusivamente por LF/CRLF. Os arquivos da release RC13 ativa coincidem com `_prisma_migrations`; sua conversão para LF coincide byte a byte com a branch. Arquivos históricos da branch e histórico do banco foram preservados. O ensaio isolado de compatibilidade reproduz os checksums CRLF antes da nova migration, sem alterar produção.

Transações curtas usam advisory lock exclusivo de automação; nenhum SSH/HTTP ocorre dentro dessas transações. O lock canônico da policy continua protegendo preflight/escrita/readback e a revogação manual. Uma intenção `PLANNED` só pode virar `STARTED` uma vez, sob a policy lock. Sucesso exige comando iniciado pelo journal e resultado físico exato, sem erro de sincronização do runtime. Estado e notificação são gravados na mesma transação após o resultado.

No restart, `ACTIVATING`/`REMOVING` viram `UNCERTAIN`, sem reexecutar. `ACTIVE` exige novo readback com par/RT/configuração iguais. Não inferir sucesso de um timeout SSH. O operador deve revisar journal, configuração e equipamento antes de qualquer liberação de estado incerto; não apagar records para liberar capacidade.

Migrations completas foram testadas em PostgreSQL 16 descartável; testes de store verificaram concorrência, rollback e restart de cliente. Antes da migração real: conferir checksums das migrations aplicadas, garantir que somente esta migration está pendente, backup validado e acesso para restauração. Aplicação futura pelo Prisma da release, com URL obtida de arquivo protegido, nunca impressa no terminal. Não usar `migrate dev` ou `db push` em produção.

Rollback de schema: manter a tabela aditiva e seus dados. RC13/RC14-F anteriores a ignoram. O rollback de código/configuração não depende de removê-la. Se for necessária reversão estrutural, exportar e validar backup, desligar lifecycle/persistência e, em manutenção separadamente aprovada, renomear tabela/índice para arquivo histórico. O ensaio transacional de rename/rollback não remove evidências. Não executar DROP automático nem marcar migrations arbitrariamente como revertidas.

## Outbox e n8n

ID de evento estável; payload inicial preservado; lease 60 s; retries de 30 s até 600 s; máximo 12 tentativas, depois `FAILED` retido. Rate limit de detecção de 30 min por perfil persiste após restart. Retry independe de o ataque continuar ou de o perfil ainda constar na lista. Monitorar PENDING/SENDING envelhecidos e qualquer FAILED. Reenvio de FAILED exige revisão do recibo e autorização, pois pode duplicar entrega externa.

ACK exige HTTP 2xx **e** `delivered=true` em todos os eventos quando a persistência está ligada. Header outbound `X-NetVision-Token`; retorno de comandos continua com sua credencial Authorization/Bearer própria. Não substituir as credenciais `HTTP - NetVision Command`, `Scope Confirm` e `Scope Cancel`.

Proposta `docs/n8n/AUTO-DDOS-STATUS-OUTBOUND-PATCH.json`: alterações apenas de normalização/ACK e ramo de status para retirada verificada/falha, sem botões. Derivada do fixture RC7.1 disponível; **não é export da RC7.1.1 publicada**. Mesclar no export real revisado, nunca substituir o workflow inteiro. Preservar os fluxos IMPLANTAR/VNT/Fibinet existentes. Testes dinâmicos usaram n8n 2.45.4 em rede Docker interna e Code sinks no lugar do Telegram.

Entrega é **at-least-once**, não exactly-once. Telegram pode receber e o ACK se perder antes do commit; após lease expirar poderá haver duplicação. `eventId` permite auditoria, mas o workflow proposto não tem ledger transacional no destino. Rate limit não elimina essa janela. Não prometer ausência absoluta de duplicação, nem confirmação física com base nos mocks.

## Fase 0 — publicação API-only, sem AUTO

GO técnico para revisão da implementação isolada; execução depende de autorização explícita para publicação e restart. NÃO aplicar migration nesta fase se a aprovação for apenas de código.

1. Revalidar PID/CWD/ExecStart/hash API RC13, PID/hash/BUILD_ID WEB, PID/hash MCP, `/health`, `/`, disco, logs e últimas contagens ACTIVATE/REMOVE. Interromper com saúde diferente de 200, produção diferente da inventariada, espaço menor que 5 GiB antes da cópia ou menor que duas vezes o pacote mais 2 GiB, ou mudança operacional não explicada.
2. Selecionar SHA completo da implementação no relatório. Worktree limpa, source archive e lockfile íntegros. Linux Node 24.19, `npm ci --workspace @gmj/api --include-workspace-root --ignore-scripts --no-audit --no-fund`, `npm run build -w @gmj/api`. Build não recebe env/URL/credenciais de produção. Conferir manifesto/hash do bundle e runtime Prisma Linux. Não usar o client Prisma Windows no servidor.
3. Preparar release nova sob `/opt/netvision-auto-ddos/releases/<SHA>`, sem alterar RC13 ativa ou `/opt/GMJ-NetVision`. Copiar somente API (`server.cjs`, mapa, runtime Prisma e dependências), manifests/lockfile e migrations para uso futuro. Não publicar WEB, MCP, worker ou observer.
4. Guardar backup protegido do unit, todos os drop-ins, EnvironmentFiles e configuração efetiva. O levantamento encontrou 22 drop-ins + fragmento principal = 23 arquivos unit. Backup de 41 arquivos foi coletado por leitura e cifrado com Windows DPAPI; para execução real criar também backup protegido recuperável no servidor, com restauração ensaiada. Não depender de um único usuário Windows para recuperação.
5. Propor um drop-in cujo nome ordene **depois** de `zzzzzzzzzzzzzzzzzzzz-rc13-d6c07f2.conf`. Resetar somente `ExecStart`, definir CWD/ExecStart da nova release e acrescentar um último EnvironmentFile dedicado. Conferir ordem real e todos os EnvironmentFiles: valores de EnvironmentFile podem sobrepor `Environment=`. Não presumir segurança só pela quantidade de letras `z`.
6. Arquivo dedicado da fase 0, sem segredos:

```ini
NETVISION_INSTALLATION_ID=IMPLANTAR
MITIGATION_AUTO_PERSISTENCE_ENABLED=0
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_AUTO_MAX_ACTIVE=1
```

Preservar HUAWEI, LIVE_WRITE e device allowlist aprovados para operação manual. Somente a fase de rollback abaixo congela também a escrita manual. Preservar os demais arquivos e flags FAST.

7. Só após aprovação: validar unit, daemon-reload e **um restart somente da API**. Nada disso foi executado nesta missão. Reinício perde caches em memória; aguardar discovery/readiness reais e registrar aquecimento, sem habilitar AUTO com snapshot ausente. WEB/MCP/observer não reiniciam.
8. Em até 60 s exigir API active/running, PID novo esperado, CWD/hash corretos, health 200 `demoMode=false`, `snmpPolling=true`; verificar flags efetivas em `/proc/<PID>/environ` e status autenticado `/api/bgp/mitigation/auto/lifecycle`. NRestarts não cresce; WEB/MCP e seus hashes/PIDs ficam iguais; sem ACTIVATE/REMOVE novo. Falha de qualquer gate: interromper e aplicar rollback aprovado.

## Fase 1 — migration, alertas duráveis e homologação IPv4

Autorizações próprias: migration aditiva, patch no n8n real, restart de API e ensaio físico controlado de um perfil IPv4 dedicado. Aprovar cada operação real ACTIVATE/REMOVE e o escopo exato; esta missão não autoriza nenhuma delas.

Aplicar somente migration aprovada; ligar persistência=1 com lifecycle=0/M8=0/REMOVE=0. Confirmar tabela/índice e outbox funcionando, alerta de teste pelo procedimento aprovado, secreto Header Auth correto, ACK real e conteúdo recebido pelo operador. Estado pendente não conta como entrega. Antes de qualquer piloto, zerar backlog por revisão, sem apagar evidência.

Prioridades possíveis de homologação: 73S, AGLINK, CLICKING, PLAYCONNECT ou SUPERNET IPv4 (ver matriz/IDs exatos). Não escolher automaticamente. Confirmar banda contratada, TX, thresholds/samples, RT `268568:660`, nodes, peers e escopo dedicado por readback real recente. Demonstrar que a recuperação independente permanece mensurável durante a mitigação. Sem isso, NO-GO para REMOVE e para ciclo completo.

## Fase 2 — um perfil AUTO aprovado

Autorizar explicitamente profileId, deviceId, família IPv4, RT/par, interface/direção, fonte independente, limites, janela e responsáveis. Configurar allowlist com **um único ID**, maxActive=1, lifecycle=1, M8=1. REMOVE=1 somente se homologação independente já aprovada; caso contrário o piloto é apenas de ativação e requer plano manual de permanência/retirada, com aprovação específica dessa limitação.

Antes/depois do restart autorizado verificar todas as flags, profileId, owner, revision, backend real HUAWEI e health. Observar detecção → journal → preflight → ACTIVATE → readback real → Telegram recebido. Recuperação exige samples novas/duração mínima/hold e ownership; REMOVE e Telegram só contam após readback real. Nunca gerar ataque nesta preparação; a fonte do estímulo e a janela de teste real precisam de autorização operacional própria.

Interrupção imediata: escrita fora da allowlist, comando sem intent/STARTED, divergência de RT/nodes/família, policy compartilhada, estado UNCERTAIN, readback falho, perda/gap de telemetria, ausência de ACK/Telegram, flapping, restart inesperado ou degradação de cliente. Desligar novas escritas por procedimento aprovado; **não remover automaticamente mitigação ativa para limpar o ensaio**. Preservar evidência e passar ao operador.

## Fase 3 — expansão

Após um ciclo físico completo documentado e monitoramento em janela aprovada, promover um perfil dedicado por vez. Os sete AUTO de policies compartilhadas ficam bloqueados neste desenho conservador; os 26 ALERT_ONLY preservam seu modo. IPv6, compartilhamento e exceções exigem nova homologação/projeto; não ampliar allowlist em massa.

## Rollback fail-closed

Gatilhos: falha de saúde, erro de runtime/migration, escrita inesperada, readback incerto, instabilidade ou decisão do operador. Congelar novas execuções antes de voltar a código sem o M8 corrigido.

Preferir voltar ao bundle RC14-F corrigido `dfb7b362ad86bf9a72fdcf8b60a1a75b47c8a19c`, se release Linux íntegra aprovada estiver disponível. Se o destino for RC13 efetiva, exigir barreiras independentes; M8=0 da RC13 é insuficiente para AUTO manual.

Último EnvironmentFile de rollback aprovado deve impor:

```ini
MITIGATION_MODE=SIMULATION_ONLY
MITIGATION_EXECUTOR=HUAWEI
MITIGATION_LIVE_WRITE_ENABLED=false
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_PERSISTENCE_ENABLED=0
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_ALLOWED_DEVICE_IDS=host-377c554a-8d1e-47c4-baa4-f258693b4d91
```

Preservar a allowlist do dispositivo e HUAWEI evita cair em MOCK com sincronização fictícia de runtime. LIVE_WRITE=false bloqueia fisicamente também ACTIVATE/REMOVE manual no executor Huawei; informar indisponibilidade temporária dessas operações. Não remover nodes/policies, não zerar runtimes nem outbox/ownership. Não restaurar banco antigo sobre telemetria recente como rollback padrão.

Somente na janela aprovada: apontar o drop-in à release antiga verificada, aplicar flags fail-closed e restart único API. Verificar `/proc`, CWD/hash, health, NRestarts, WEB/MCP/observer intactos e ausência de ACTIVATE/REMOVE. A implementação RC13 dos módulos foi confrontada com o source map do bundle efetivo e as barreiras independentes têm testes comportamentais de transporte fake; nenhum ensaio físico foi feito. Retomada manual exige autorização adicional e readback verdadeiro, separadamente da recuperação da API. Não depender de allowlist vazia da RC13: vazio pode significar ausência de gate.

## GO/NO-GO e autorizações pendentes

| Fase                       | Decisão nesta missão                   | Pendência para executar                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Código/testes isolados     | GO técnico, conforme evidências finais | Revisão do commit                                                  |
| Publicação API-only AUTO=0 | Preparada; sem autorização de execução | Release Linux, backup recuperável, janela e autorização de restart |
| Migration/outbox real      | NO-GO operacional                      | Aprovação migration + checksums/backup + n8n real                  |
| Homologação física IPv4    | NO-GO                                  | Perfil/escopo/janela/operações reais explicitamente aprovados      |
| AUTO ACTIVATE piloto       | NO-GO                                  | Homologação, allowlist e ativação explícita                        |
| AUTO REMOVE/ciclo completo | NO-GO                                  | Prova independente de normalização + readback/Telegram reais       |
| Expansão                   | NO-GO                                  | Ciclo físico completo e aprovação por perfil                       |

Matriz detalhada: `docs/audits/auto-ddos-20261029/MATRIZ-38-PERFIS.csv`. Relatório final e manifesto informam commit exato, artefatos, testes, limitações e integridade da produção. Parar antes da primeira alteração operacional.
