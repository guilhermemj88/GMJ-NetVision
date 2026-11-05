# FAST Growth automático no outbound

Integração baseada em `ddb9368` (que já inclui `b5b70e4`). A análise é
informativa: nenhuma nova condição de ataque, autorização ou escrita BGP.

As correções posteriores à auditoria de `97622af`, os testes PostgreSQL e o
GO condicionado para homologação estão em [FAST_GROWTH_AUDIT_FIXES.md](FAST_GROWTH_AUDIT_FIXES.md).

## Caminho real

1. `FastTrafficPoller.poll()` deriva a taxa dos contadores já coletados e chama
   `store.append(observation)`. Somente depois da persistência aceita entrega a
   observação ao `FastGrowthNotifications`, por um observer síncrono opcional.
   Falhas/rejeições quebram o histórico informativo, sem criar zeros.
2. `PriorityTrafficSource` continua entregando a mesma amostra persistida ao
   `MitigationAutoEngine`. No modo observador externo, o hook de
   `FastObservationSource.sampleWithId()` reaproveita a linha já lida e validada
   pelo bridge. Não há GET SNMP ou consulta adicional para calcular Growth.
3. A confirmação do motor continua inalterada. O enriquecimento só decora uma
   notificação que a aplicação já decidiu emitir.
4. Em `routes.ts`, o publisher do `MitigationCommandService` enriquece antes de
   publicar. No caminho durável, os emissores reais são
   `AutoMitigationLifecycle.completeActivation()` e `.detection()`: suas fábricas
   decoram a notificação **antes de `enqueueNotification()`**. O fallback usa o
   produtor existente `buildDetectionAlertNotification()`.
5. `DurableMitigationOutbox` persiste o JSON já enriquecido. Seu transporte real,
   `N8nMediaTransport.publish()`, continua chamando
   `buildMitigationWebhookPayload()`, que já aceita o bloco `growth` desde o
   candidato. Retentativas não recalculam a referência nem alteram identidades.

Coleta não significa roteamento: perfis observados que continuam consumindo
LEGACY não são enriquecidos. O caminho piloto que consome o bridge diretamente
também recebe os metadados, sem alterar sua autorização ou bootstrap.

## Histórico e episódios

- Chave: perfil/cliente + equipamento + interface + direção RX/TX.
- Janela de até 60 amostras válidas, limitada também a cinco minutos; a 5 s,
  corresponde ao buffer circular previsto no candidato.
- Utilização usa a banda efetiva do perfil, e o primeiro cruzamento usa seu
  `thresholdBps`/`triggerPercent`. Não existe limiar de 95 fixo na implementação.
- A média anterior exclui a amostra do primeiro cruzamento. O snapshot é
  imutável: a espera pelas confirmações não o contamina.
- A recuperação usa o limiar e número de amostras do perfil, apenas para soltar
  o snapshot informativo. Esses contadores não alimentam o motor AUTO.
- Lacunas, geração nova, remapeamento, remoção e amostras inválidas não são
  recuperação. Invalidam a referência informativa corrente sem encerrar o
  episódio decisório. Uma referência com mais de cinco minutos também expira.
  Uma nova leitura alta sem cruzamento observado gera `INDETERMINADO`, sem
  inventar horário de cruzamento.
- Após recuperação, o próximo episódio obtém outra referência. Até oito
  referências encerradas por direção são retidas somente para correlacionar
  notificações já confirmadas que terminem com atraso; não voltam ao baseline.
  A ativação usa o `lastSample` já registrado no escopo, sem mudar o journal.
- Histórico insuficiente gera `INDETERMINADO`, com valores desconhecidos nulos
  e utilização atual medida preservada. A notificação segue normalmente.
- Após restart, o histórico de coleta começa vazio; eventos já enfileirados
  conservam o Growth persistido pelo outbox existente. Não há migração de banco.

## Semântica e isolamento

O módulo não cria eventos. Não transforma utilização alta em mitigação aplicada.
`APLICADA` no bloco informativo exige evento `MITIGATION_VERIFIED`,
`verified=true` e `simulation=false`. Um estado incerto permanece
`DESCONHECIDA`; a mensagem informativa não afirma sucesso ou ausência de escrita.
Retirada, teste, eventos fora do FAST e Growth explicitamente fornecido são
preservados. `eventId`, `profileId`, `episodeId`, demais campos e deduplicação
não são reescritos.

O código de `mitigation-auto-engine.ts`, o executor, a lease, a política de
sampling e os gates não foram alterados. Os hooks capturam erros e devolvem a
notificação original quando o enriquecimento falha. A guarda
`PILOT_SNAPSHOT_UNAVAILABLE` continua exatamente como na base; seu conserto não
faz parte deste commit.

## Evidência e testes

Validação histórica do candidato `97622af` (resultados atuais no relatório de auditoria):

| Verificação                              | Resultado                               |
| ---------------------------------------- | --------------------------------------- |
| Typecheck de todos os workspaces         | aprovado                                |
| Build de todos os workspaces             | aprovado                                |
| Testes API                               | 2.930 aprovados; 46 opcionais ignorados |
| Testes frontend                          | 1.406 aprovados                         |
| Testes snapshot-renderer                 | 10 aprovados                            |
| Testes shared                            | 191 aprovados                           |
| Total executado                          | 4.537 aprovados, zero falhas            |
| Novos testes Growth                      | 18 aprovados, incluídos no total API    |
| ESLint dos arquivos TypeScript alterados | aprovado                                |

As dependências foram instaladas localmente neste worktree via
`npm ci --ignore-scripts --offline`. Os logs finais estão no pacote externo
`C:\projetos\artifacts\fast-growth-backend-20261105`.

`docs/evidence/fast-growth-http.json` contém o JSON realmente recebido em um
servidor HTTP local por `N8nMediaTransport`, com ACK inicialmente negativo e
posteriormente positivo. Foi gerado pelo poller e motor reais, com leitor de
contadores e executor locais de teste. Nenhum equipamento ou destinatário
produtivo participa.

Nesse cenário, o primeiro cruzamento foi 95%; o motor só confirmou depois, com
tráfego de 98%. O evento conserva o tráfego de confirmação e seu Growth conserva
a referência do primeiro cruzamento (20% → 95%, BRUSCO, +75 p.p.). As duas
recepções HTTP são idênticas, inclusive após recuperação e recriação do outbox.
Foram 24 chamadas ao leitor para 24 ciclos e zero chamadas de comando.

O teste novo também cobre gradual, moderado, histórico insuficiente, limiar de
82%, recuperação/novo episódio, isolamento entre perfis/interfaces/direções,
falhas SNMP, persistência rejeitada, gaps, duplicatas, observador externo,
confirmação atrasada e direção TX na ativação dual. Comparações com Growth
ausente, ativo e quebrado verificam as mesmas decisões AUTO, contagens de
confirmação e chamadas ao executor falso, tanto com execução autorizada quanto
com kill switch desligado.

Reprodução local, sem URLs ou credenciais produtivas:

```powershell
npm ci --ignore-scripts
npm run build
npm run typecheck
$env:TZ = 'UTC'
npm test
```

O build precede a suíte porque um teste existente verifica o arquivo compilado
do observador. `TZ=UTC` corresponde à expectativa existente do teste de gráfico
do frontend; não altera a configuração de execução da aplicação. As integrações
opcionais PostgreSQL dependem de bancos de teste explicitamente configurados.
As 46 anteriormente pendentes foram executadas posteriormente, com sucesso,
conforme o relatório de correções da auditoria.

Para gerar outra evidência, antes do teste configurar `FAST_GROWTH_EVIDENCE_PATH`
com um arquivo local desejado e executar
`npm run test -w @gmj/api -- src/application/fast-growth-notifications.test.ts`.

Nenhuma alteração ou chamada ao n8n produtivo, Huawei, GMJ-FLOW ou GMJ-SENTINELA
faz parte desta implementação. Nenhum deploy, merge ou push foi executado.
