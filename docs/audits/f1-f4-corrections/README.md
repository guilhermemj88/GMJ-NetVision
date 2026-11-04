# Evidências das correções F1–F4

Esta é a reexecução pelo implementador, não uma nova auditoria independente.
Base: `640a7014b4b077c54f2adc7fe0e1098d6bb985f9`. A worktree e o commit
documental `5d5f9a1` do auditor permanecem preservados.

- `reproduce.mts` e `reproduce-postgres.mts`: mesma sequência adversarial do
  auditor, agora exigindo baseline v2, quarentena, zero novas escritas e visões
  individuais. A expectativa do BOGONS isolado passa de falha conhecida a NORMAL.
- `guards.mts`: nove probes anteriores, sem relaxar suas expectativas.
- `counter-simulation.mts`: referência anterior do auditor, sem substituir o
  novo ensaio completo do poller/lifecycle. Seus números não são alvo a reproduzir.
- `reproduction-provenance.json`: hashes dos scripts originais preservados.
- `suite-api.json`: resultados por teste da suíte completa final.
- `validation.json`: totais, ambiente descartável, hashes do build e limitações.
- `fast-corrected-simulator.json`: 40 ataques e 40 controles sem ataque para cada
  uma das quatro configurações; relógio determinístico, transporte Huawei fake.
- `fast-real-clock.json`: ensaio anterior preservado de relógio real e UDP loopback,
  executado novamente, com engine e transporte fake próprios. Não mede o Huawei
  físico nem substitui a simulação nova do lifecycle.

## Reexecução local

Somente em worktree de desenvolvimento com Docker, Node/npm e Python.
Os scripts `.mts` usam importações relativas à raiz; os caminhos de saída
correspondem à worktree desta entrega. Ajustar somente esses caminhos se copiá-la.

1. `python docs/audits/f1-f4-corrections/lab.py`
2. `python docs/audits/f1-f4-corrections/run-suite.py`
3. Após a suíte, `npx tsx docs/audits/f1-f4-corrections/reproduce.mts`
4. `npx tsx docs/audits/f1-f4-corrections/reproduce-postgres.mts`
5. `npx tsx docs/audits/f1-f4-corrections/guards.mts`
6. `npx tsx docs/audits/f1-f4-corrections/counter-simulation.mts`
7. `python docs/audits/f1-f4-corrections/cleanup-lab.py`

O laboratório cria somente dois containers identificados e ligados a
127.0.0.1:55077/55439, com dados em tmpfs, sem volume do usuário. A limpeza
verifica nome, label, portas e mounts. Os testes novos recusam URLs diferentes
dos bancos descartáveis esperados. Não executar reproduções PostgreSQL e suíte
simultaneamente: usam fixtures no mesmo banco descartável.

Não disponibilizar credenciais de produção aos testes. O launcher substitui as
URLs de bancos e habilita explicitamente PostgreSQL e `FAST_REALTIME_TEST=1`.
Nenhum script desta pasta autoriza deploy, flags, SSH real ou migração produtiva.

## Escopo da auditoria diferencial solicitada

Revisar apenas o delta F1–F4 e suas regressões: intenção durável antes do REMOVE,
quarentena por escopo/journal, reconciliação explícita sem adoção, classificação
BOGONS/RT permanente, integração dos contadores e scheduler reais, visões por
perfil no restart. Conferir D1–D12 na matriz do relatório.

GO de piloto ou de AUTO-ALL continua pendente de revisão independente e dos
bloqueios operacionais anteriores. Nenhum mock comprova homologação física.
