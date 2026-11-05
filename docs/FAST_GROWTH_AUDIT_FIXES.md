# FAST Growth: correções da auditoria de 97622af

Branch isolada: `fix/fast-growth-audit`, worktree
`C:\projetos\GMJ-NetVision-fast-growth-audit-fixes`. O commit auditado
`97622af0d186257ad98be1ad1aceb2906c61e2ce`, na branch original
`feat/fast-growth-outbound`, permanece intacto. Data da validação: 2026-11-05.

## Resultado e limites do GO

**GO técnico para homologação integrada dos 23 perfis AUTO-ALL em ambiente
isolado, com execução física desabilitada.** Não é autorização para produção
ou mitigação física. O n8n produtivo não foi acessado; nenhum Huawei, BGP,
deploy, merge ou push foi executado. A guarda `PILOT_SNAPSHOT_UNAVAILABLE`
permanece inalterada. Os 23 perfis sintéticos existentes não foram utilizados
nem limpos: todos os testes PostgreSQL usaram outro container e bancos novos.

O comando global de lint tem uma pendência preexistente: cinco diretivas
`eslint-disable` desnecessárias em `apps/api/src/server.ts`. O mesmo resultado
foi reproduzido no worktree auditado. O lint de todos os arquivos TypeScript
alterados passa com zero avisos. Isso não foi ocultado nem corrigido neste
patch de Growth.

## F1: referência antiga, interrupção e confirmação atrasada

A reprodução sobre o código exato de `97622af` confirmou que 20% → 95%, seguido
por dez minutos sem amostras e nova leitura alta, ainda devolvia o antigo
`BRUSCO` e o horário antigo. O harness externo do Claude não foi disponibilizado;
`audited-reproduction.json` registra a reprodução independente dos cenários
descritos, incluindo a projeção exata de `routes.ts` para F6.

A referência agora tem validade temporal e continuidade. Uma lacuna acima de
`maxGapMs`, uma falha de coleta, mudança de geração ou taxa inválida invalida a
referência corrente, sem confirmar recuperação. Uma referência também expira
após cinco minutos, mesmo com tráfego alto contínuo. O próximo valor alto sem
cruzamento observado em amostras contíguas gera `INDETERMINADO`, com
`thresholdReachedAt=null`; não se infere quando o limiar foi cruzado.

Referências encerradas são retidas separadamente, no máximo oito por direção,
com intervalo de validade. Só uma notificação cuja confirmação original caia
nesse intervalo pode reutilizá-las. A detecção durável e o fallback passam o
`sampleAt`/`at` original ao enriquecimento, em vez do horário posterior de
publicação. Uma confirmação antiga válida continua com seu Growth histórico;
um evento novo após a lacuna não herda `BRUSCO`. O outbox persiste o JSON uma
vez e não recalcula Growth nas retentativas.

Recuperação informativa continua exigindo a quantidade configurada de amostras
abaixo do limiar de recuperação. Um novo episódio com cruzamento observado
recebe outra referência. RX e TX mantêm estados independentes.

## F2 e F6: Float armazenado, contrato decisório inteiro

Contrato verificado, sem alteração do schema ou do motor:

| Camada | Comportamento existente |
| --- | --- |
| Prisma `BgpMitigationProfile` | `triggerPercent` e `recoveryPercent` são `Float` |
| Tipos/repositórios | `number`; upsert não impõe integralidade |
| PATCH REST de mitigação | schema Zod estrito; não expõe esses dois campos |
| Configuração por ambiente | `intEnv` aceita números finitos, apesar do nome; não valida integralidade |
| `MitigationAutoEngine.evaluate` | converte ambos com `BigInt`; fração falha dentro do tratamento por perfil |
| `AutoMitigationLifecycle.allowed` | exige trigger inteiro; recuperação também usa `BigInt` em outro caminho |
| Histórico Growth | aceita utilização percentual real; não define limiares decisórios |

A projeção pura `fastGrowthProfile()` valida antes de converter: banda positiva,
trigger inteiro de 1 a 100, recuperação inteira de 0 até antes do trigger e
contagem de recuperação inteira positiva. Valores não suportados omitem somente
o enriquecimento. Não há arredondamento de configuração, autorização ou ajuste
de limiar. O arredondamento já existente de métricas de apresentação não
alimenta o motor.

Em F2, a ausência de limiar de recuperação deixava o snapshot congelado. Agora
metadados incompletos/fracionários desabilitam Growth daquele perfil e removem
qualquer contexto anterior. Configuração corrigida começa com histórico novo.

Em F6, as conversões introduzidas pelo Growth em `autoTargets.list` podiam
lançar antes do tratamento individual do motor e abortar a lista toda. Agora a
lista usa a projeção validada e mantém os valores decisórios originais. Um
perfil inválido continua `FAILED`/fail-closed no motor; os demais são avaliados.
O coletor também isola trigger fracionário por perfil. Recuperação fracionária
não impede coletar a taxa com trigger válido, mas desabilita seu Growth.

Aceitar frações como configuração decisória exigiria mudança própria do contrato
AUTO, dos validadores e dos cálculos; essa migração fica fora deste patch.

## Controle exclusivo do Growth

`MITIGATION_FAST_GROWTH_ENABLED` é consultada pelo sidecar a cada operação.
Ausente mantém o comportamento habilitado do candidato; `1`, `true`, `yes` e
`on` habilitam, sem distinção de maiúsculas. `0`, `false`, vazio e valores
desconhecidos desabilitam. A injeção de callback permite mudança em runtime.

Desabilitar limpa apenas o histórico volátil e impede novo enriquecimento;
reativar começa sem baseline. Payloads já persistidos no outbox continuam
idênticos. A flag não altera coleta SNMP, gates, confirmações, lease ou BGP.
Alterar o ambiente de outro processo não modifica automaticamente `process.env`
de um processo já iniciado; não foi criado endpoint operacional para isso.

## F3/F4: medição e correções limitadas

`recordBridge` antes reconstruía todos os contextos a cada amostra de um perfil.
Agora atualiza somente o perfil recebido. A propriedade dos contextos é
registrada por origem: um refresh do poller remove seus próprios perfis
ausentes, preservando os pertencentes ao bridge. Remover os metadados do perfil
no bridge encerra seu contexto. Testes cobrem dois clientes simultâneos,
refresh vazio do poller e remoção explícita no bridge.

Microbenchmark Windows/Node 24.19.0: escopo prealocado, tráfego normal de 20%,
10 aquecimentos e 150 chamadas medidas por caso; tempos em milissegundos por
chamada. Não mede SNMP, PostgreSQL, latência do evento nem capacidade física.

| Perfis | Média auditado | p95 auditado | Média corrigido | p95 corrigido |
| ---: | ---: | ---: | ---: | ---: |
| 23 | 0,02462 | 0,05360 | 0,00453 | 0,00560 |
| 100 | 0,06486 | 0,11520 | 0,00597 | 0,00730 |
| 1.000 | 0,54590 | 0,80080 | 0,00394 | 0,00780 |
| 3.000 | 1,65577 | 2,34480 | 0,00296 | 0,00330 |

Todos os casos conservaram a quantidade de contextos. O campo
`estimatedSweepMs` no JSON é apenas média × perfis, uma extrapolação, não uma
varredura medida. Correções pequenas de F3/F4 foram incluídas por compartilharem
o mesmo ciclo de vida; otimizações adicionais, benchmark de carga real e coleta
de lixo de perfis do bridge que deixem de ser consultados podem ser tratados
separadamente. Não são condição para homologar 23 perfis isolados. A proteção
existente contra configurações operacionais incompatíveis não foi removida.

## Validação e evidências

Os novos testes cobrem F1/F2/F6, lacunas/idade, confirmação atrasada, restart,
retentativas, recuperação e novo episódio, reset real de Counter64,
independência RX/TX e entre clientes, flag, perfis inválidos com válidos e
continuidade da notificação. Os testes anteriores com Growth habilitado,
ausente e lançando erro continuam comparando as mesmas decisões, contagens e
chamadas ao executor fictício. Não há chamada BGP real.

Typecheck e build de todos os workspaces passaram. Os resultados completos e a
contagem final estão em `validation-summary.json` no pacote de evidências.
O lint global falha somente pelos cinco avisos preexistentes descritos acima.

Consolidando os casos sem contar reexecuções: **4.610 PASS, zero FAIL, zero
SKIP pendente** (API: 3.003, frontend: 1.406, shared: 191,
snapshot-renderer: 10). A suíte padrão deixa 48 opcionais pendentes por não
receber URLs; todos os 48 foram aprovados separadamente. Foram adicionados 27
casos em relação ao candidato auditado. Uma invocação adicional da API a partir
do diretório incorreto falhou ao localizar arquivos de schema; seu log foi
preservado, e a invocação correta no workspace passou integralmente.

As **46 integrações anteriormente pendentes passaram, sem FAIL ou SKIP**:
45 PostgreSQL e uma com relógio real/SNMP UDP em loopback. O runner registra
49 PASS porque o arquivo do observer inclui também três testes que já eram
unitários não opcionais. Mais dois novos testes PostgreSQL verificam outbox
real, desconexão/reconexão de Prisma, sidecar reiniciado e duas recepções HTTP
idênticas, tanto com Growth válido quanto com recuperação fracionária
(`growth:null`, sem bloquear entrega).

| Grupo anteriormente opcional | PASS |
| --- | ---: |
| baseline-store | 2 |
| manual-release-quarantine | 3 |
| durable-persistence-readiness | 4 |
| single-pilot | 2 |
| fast-traffic-postgres | 6 |
| fast-lifecycle-simulation | 2 |
| mitigation-telemetry-postgres | 7 |
| fast-bridge-postgres | 8 |
| mitigation-phase01-postgres | 10 |
| fast-observer: startup/stop/restart PostgreSQL+UDP | 1 |
| mitigation-fast-realtime | 1 |
| **Total anteriormente pendente** | **46** |

O teste realtime concluiu em 44.153 ms de relógio de parede, com cinco GETs UDP
locais e executor fictício. Esse teste mede o fluxo existente, não configura uma
capacidade ou SLA de produção para Growth.

O ambiente original não continha `DATABASE_URL` nem `FAST_TEST_DATABASE_URL`.
Foi criado exclusivamente para a tarefa o container
`gmj-growth-audit-0a4a970a09`, ID
`f7c0bb9b8e065965fcc66268e03fcef74cd5caae9ded8ff46a469c32a7b71bcc`,
PostgreSQL 16 Alpine em tmpfs, portas 55439 e 55077 ligadas somente a
`127.0.0.1`. Ambos os binds apontam ao mesmo container novo. Bancos novos:
`netvision_ddos_fast_test`, `netvision_ddos_telemetry_test`,
`netvision_ddos_observe_test`, `mitigation_baseline_test`, `single_pilot_test`,
`aglink_persistence_readiness`, `phase01` e banco de controle vazio.

Antes de rodar, foram conferidos host, banco, container, label, binds e operações
de limpeza. O schema foi criado com `prisma db push --skip-generate`, sem reset
nem `accept-data-loss`; cada banco começou com zero perfis. Limpezas dos testes
restringiram-se a esses bancos novos. O container existente `nv-autoatest-pg`
teve somente metadados Docker inspecionados, com ID e horário de início
preservados; nenhuma conexão SQL a ele foi feita.

Após terminar as validações, somente o container descartável desta tarefa foi
removido, mediante nova conferência de ID, nome, label, tmpfs e binds. O
container existente continuou em execução com o mesmo ID e horário de início.
`fast-growth-audit-postgres-cleanup.json` registra a limpeza.

Evidências versionadas:

- `docs/evidence/fast-growth-http.json`: evidência auditada anterior, preservada.
- `docs/evidence/fast-growth-audit-http.json`: nova recepção HTTP do caminho real
  poller → motor → publisher → outbox → transporte, sem comandos reais.
- `docs/evidence/fast-growth-postgres-http.json`: retry e reconexão PostgreSQL.
- `docs/evidence/fast-growth-audit-integrations.json`: PASS/FAIL/SKIP individual.
- `docs/evidence/fast-growth-benchmark.json`: medição comparativa.
- `docs/evidence/fast-growth-realtime.json`: relógio real e UDP local.

Pacote externo: `C:\projetos\artifacts\fast-growth-audit-fixes-20261105`, com
logs, preflight/allowlist PostgreSQL, reprodução dos defeitos, scripts do runner
e benchmark, relatório de isolamento, diff e hashes. As credenciais nesse runner
pertencem somente ao PostgreSQL descartável local. Não há credenciais de n8n ou
equipamentos nas evidências.

## Riscos remanescentes e próxima etapa

- Configurações fracionárias continuam fora do contrato decisório inteiro; o
  Growth não as corrige ou autoriza. A homologação deve usar perfis válidos.
- Histórico é volátil. Após restart, lacunas ou referência expirada, o resultado
  pode ser `INDETERMINADO`; a entrega do evento segue independente.
- Até oito referências históricas por direção são retidas. Atrasos além da
  retenção podem perder enriquecimento; não afetam a emissão ou o retry já salvo.
- Contextos do bridge que nunca mais forem consultados podem permanecer em
  memória até remoção explícita/reconfiguração/restart. A medição cobre até
  3.000 perfis, não substitui teste prolongado de churn de perfis.
- Homologação dos 23 perfis existentes e observação de execuções legítimas ainda
  são a próxima etapa autorizável; não foram alegadas como realizadas aqui.
- Qualquer impedimento do piloto, inclusive `PILOT_SNAPSHOT_UNAVAILABLE`, deve
  continuar bloqueando execução física; nenhum contorno foi incluído.

**NO-GO para habilitação física ou produção nesta entrega.** A conclusão desta
tarefa é o candidato corrigido e validado localmente, pronto para revisão e
homologação integrada isolada.
