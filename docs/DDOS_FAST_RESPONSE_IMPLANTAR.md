# IMPLANTAR — Fast Poller em observação operacional

**Estado: ATIVO / OBSERVE. GO para manter observação. NO-GO para habilitar execução automática nova.**

Implantado em 17/10/2026 às 23:33 BRT (18/10 às 02:33 UTC). A API e o frontend de produção continuam nos builds anteriores; nenhuma reinicialização desses serviços foi feita. As correções do motor e a integração para execução permanecem na versão candidata isolada.

## Release e componentes

- Branch local: `feature/ddos-fast-response`, baseada na API `fc790ade3455f2c16eeff372a8a9168deffb0d7d`.
- Código do observador implantado: `69b375f221b61c022ef446560fb357adb6bc108c`.
- Tag: `v2026.10.17-ddos-fast-observer-rc1`.
- Serviço: `netvision-fast-observer.service`, habilitado no boot, `active/running`.
- Runtime independente: `/opt/netvision-fast-observer/releases/rc-69b375f221b6/runtime`.
- Diagnóstico local: `http://127.0.0.1:3355/health` e `/metrics`.
- Banco próprio: `netvision_fast_observe`. A migration aditiva foi aplicada somente neste banco.
- Cadastro operacional: conexão com transações somente leitura; role sem INSERT/UPDATE/DELETE/TRUNCATE nas tabelas operacionais verificadas.
- Dois perfis: BHNET-3043 e BHNET-3044 IPv4. Um dispositivo, um GET de 17 OIDs a cada 10 segundos, timeout 1500 ms, zero retries, concorrência 1.
- Processo sem importação do motor AUTO, executor Huawei, serviço de comandos ou transporte SSH. `executionAvailable=false`.

O serviço foi construído em Linux com Prisma 6.19.3 e dependências copiadas para a release própria. Os diretórios de produção existentes foram usados somente para leitura de ferramentas. A unidade foi adaptada à versão atual do systemd, removendo a opção obsoleta `CPUAccounting`; a limitação por cgroup permanece.

## Medições reais

Janela contínua após o teste de rollback: **17/10 23:34:42.810 a 23:39:42.947 BRT**, equivalente a 18/10 02:34:42.810 a 02:39:42.947 UTC.

| Indicador                                  | Resultado por interface BHNET |
| ------------------------------------------ | ----------------------------: |
| Observações persistidas                    |                            31 |
| Intervalo p50                              |                      10,019 s |
| Intervalo p95                              |                      10,492 s |
| Intervalo máximo                           |                      10,702 s |
| Duração GET p50                            |                          6 ms |
| Duração GET p95                            |                      638,5 ms |
| Duração GET máxima                         |                        947 ms |
| Falhas SNMP / escritas rejeitadas          |                         0 / 0 |
| Duplicadas / fora de ordem                 |                         0 / 0 |
| Regressões de uptime / mudanças de ifIndex |                         0 / 0 |
| Qualidade das linhas                       |               31 × ADMIN_DOWN |
| Taxas válidas para gatilho                 |                             0 |

Percentis da tabela usam `percentile_cont` do PostgreSQL sobre 30 intervalos. O endpoint usa a regra de posto mais próximo e, nesta mesma janela, apresentou p50 10,018 s e p95 10,603 s. A duração de GET inclui espera pelo event loop do processo, além da rede/dispositivo; não representa exclusivamente RTT de fio.

As duas subinterfaces continuam administrativamente DOWN, como antes. Os contadores congelados coincidiram exatamente com o polling geral. O observador registra taxa indisponível e não transforma falha/DOWN em uma confirmação de tráfego ou recuperação.

Foi realizada também **uma sondagem pontual somente leitura**, com dois GETs e nenhuma persistência para o motor, no agregado `Eth-Trunk1` UP e nas duas subinterfaces:

- Intervalo real: **10,012 s**.
- Agregado: **85,431 Gbps RX / 100,547 Gbps TX**, qualidade VALID, capacidade 300 Gbps.
- BHNET-3043 e 3044: qualidade ADMIN_DOWN; taxas descartadas.

Isso comprova leitura de HC counters e cálculo em um objeto UP do NE8000 real sem simular ataque. Não comprova tráfego UP das subinterfaces BHNET, que permanecem desligadas.

Evidências estruturadas: [janela operacional](benchmarks/ddos-fast-implantar-observation.json), [sondagem real](benchmarks/ddos-fast-ne8000-probe.json).

## Impacto e preservação

- CPU Huawei: média de cinco minutos **16% antes / 15% depois**; instantânea 16% / 17%. Não foi observado aumento material nesta janela curta; isso não é uma estimativa de capacidade para expansão de escopo.
- BGP: **59 peers, 40 Established**, antes e depois. Peers BHNET `10.200.200.222` e `.226` permaneceram Idle, coerente com o shutdown existente.
- Observador: aproximadamente **2,72 segundos de CPU em 308 segundos** e RSS de cerca de 99 MiB na captura; zero reinícios automáticos.
- API: PID **2165618**, iniciado em 15/10 22:23:20 UTC, preservado.
- Bundle da API: SHA-256 `ba2731fdee415fc7b9446efaf71727432ed019e110e7a49c77f118b5c732e469`, preservado.
- Hash integral dos dois perfis, flags de execução e quantidade de migrations operacionais: preservados.
- Eventos novos de mitigação BHNET durante a janela: **zero**.
- Nenhum comando de configuração, mitigação, remoção ou ativação de interface foi enviado ao Huawei.
- Nenhuma alteração na FIBINET.

## Testes e diferenças em relação à simulação

O pipeline completo isolado confirmou readback simulado em **33,909 segundos** com relógio real e UDP loopback na versão final; a execução anterior havia medido 33,833 segundos. O cenário virtual com quatro perfis simultâneos mediu p95/máximo **42,525 segundos**.

As durações de preflight, escrita e readback desses testes são sintéticas. Na implantação atual, **somente a coleta SNMP é real**. Não houve ataque real ou simulado na rede, nem execução Huawei para medir latência de ativação.

**1.836 testes de API aprovados, zero falhas**, mais o teste de rel?gio real executado separadamente. Build da API e checagens de tipos API/shared/web aprovados. A suíte da API foi executada integralmente com banco isolado, incluindo testes de concorrência, identidade, stale, reinício, AUTO manual, AUTO promovido, policy compartilhada e readback. O teste opcional de relógio real foi executado separadamente. O relatório técnico contém os comandos reproduzíveis.

Frontend: 951 testes passaram e 13 falharam no checkout de referência. Uma reprodução dos arquivos afetados na base intacta também falhou (14 falhas nessa execução, incluindo variação de um teste). Nenhum arquivo frontend ou shared foi alterado; esta entrega não deve ser apresentada como release frontend inteiramente aprovada.

## Rollback executado e procedimento

O observador foi parado no servidor. Durante **12 segundos**, o número de linhas permaneceu em **16**. A API manteve o mesmo PID e continuou em operação. O serviço foi retomado às 23:34:39 BRT; a coleta voltou com nova sessão, sem ativação ou perda da configuração global.

Para interromper a funcionalidade:

```sh
sudo systemctl disable --now netvision-fast-observer.service
sudo systemctl is-active netvision-api.service
```

Para retomar a mesma release observacional:

```sh
sudo systemctl enable --now netvision-fast-observer.service
curl -fsS http://127.0.0.1:3355/health
```

O rollback não remove dados nem mitigações e não exige reinício da API. O banco e a configuração própria podem permanecer para auditoria. A role somente leitura impede que o coletor altere os perfis operacionais.

Pacote Linux: `netvision-fast-observer-linux-69b375f221b6.tar.gz`.
SHA-256: `20d728a8ecfdaabc60cad5c3002f502e0613dcef9f9a3253cfb26a4c696dae44`.
Bundle Linux: SHA-256 `00e5560d4546597452d0885a6a3c37d2f92c4db28633f192f60c4b05fe9acdcb`.

## Checklist real e decisão

- [x] Serviço separado iniciado, com persistência própria e execução indisponível.
- [x] Cadência real próxima de dez segundos demonstrada sem ataque.
- [x] Identidade, HC counters, uptime, descontinuidade e estado administrativo conferidos.
- [x] Correlação com os contadores do polling convencional.
- [x] Stop/start testado sem reinício da API ou alteração dos perfis.
- [x] CPU e sessões BGP comparadas antes/depois.
- [x] Zero falhas SNMP, duplicação ou reordenação na janela medida.
- [ ] Validar sequência UP da BHNET quando o operador restaurar suas interfaces por procedimento próprio.
- [ ] Homologar latências reais de preflight/readback e orçamento total antes de nova escrita automática.
- [ ] Revisar e autorizar rollout do candidato da API, migration operacional e eventual reinício.
- [ ] Autorizar explicitamente o perfil mínimo para ENFORCE; preservar provenance e bloqueio do sweep.
- [ ] Tratar falhas frontend preexistentes antes de uma release que inclua apresentação.

**GO para observação contínua. NO-GO para execução automática nova pelo Fast Poller.** A execução depende de autorização explícita futura; não basta mudar o modo deste serviço, pois ele rejeita ENFORCE e não contém executor.

Arquitetura, critérios de amostragem, testes e plano completo: [DDOS_FAST_RESPONSE.md](DDOS_FAST_RESPONSE.md).
