# Correção final F1–F4 — AUTO-ALL IPv4 + FAST

Branch: `feature/auto-all-ipv4-fast-fixes`.
Base: `640a7014b4b077c54f2adc7fe0e1098d6bb985f9`.
Commit corretivo: **1c37f15a076de9bc9c2fcf83d6caa6024db02c98**.
Referência independente preservada: `5d5f9a13af67e6eebc2335eff12160d1d85102bd`.

**Correções concluídas pelo implementador; sem GO operacional.** Entrega para
auditoria diferencial independente F1–F4, sem reabrir a auditoria histórica.
Não houve conexão à produção, SSH Huawei, deploy, restart, migration produtiva,
alteração de flags, n8n, WEB ou catálogo. Não foi feita nova medição de produção.

## F1 — intenção durável e quarentena de ownership

Antes do primeiro comando REMOVE, o executor exige store durável e grava
transacionalmente o baseline como `REMOVING`, payload **v2**. O snapshot v1
integral é conservado dentro dessa intenção, junto de escopo, requestId e data.
O leitor de ownership só aceita v1: v2 não volta a comprovar posse, inclusive
se RELEASED falhar. A escrita é abortada se a intenção não persistir ou se o
leitor ainda devolver ownership. `save` não sobrescreve uma intenção pendente.
Após retirada verificada, RELEASED v0 também retém o snapshot para auditoria.
Nenhum baseline é apagado indiscriminadamente; nenhum node permanente é adotado.

`UNCERTAIN`, operações em andamento, intenção v2 e journal STARTED/UNCERTAIN
bloqueiam novas mutações por **device/policy**, independentemente do perfil e
requestId. A reserva AUTO, beginManual, autorização manual e APPLY LOCAL usam
essa barreira. No restart, journal interrompido põe o escopo em quarentena;
não ocorre replay. Se a consulta de pendências atingir o limite de 1.000,
a completude não está provada e a operação falha fechada.

Há reconciliação **explícita**, `reconcileManualRelease`, sob o mesmo lock de
policy já existente. Exige ator/motivo, perfil/operação exatos, escopo UNCERTAIN,
snapshot completo, leitura física com par ausente e permanentes sem drift.
A transação compara escopo/baseline novamente, preserva resultados falhos no
journal como RECONCILED, grava recibo RESOLVED_NO_WRITE com hashes da evidência,
libera ownership e inicia cooldown. Não fabrica VERIFIED nem Telegram de sucesso.
Par idêntico presente é recusado. Falha de banco desfaz toda a reconciliação.

É um método interno de domínio: nenhum endpoint novo foi exposto e nenhum
tick/startup/timer o invoca. Sua futura utilização requer operação autorizada e
integração com identidade confiável do operador; o campo actor não é autenticação.
Se o par continuar presente, esta rotina **não** o remove: o escopo permanece
bloqueado para tratamento explícito do operador. Runtime NORMAL isolado não
libera a quarentena; APPLY LOCAL não substitui essa reconciliação.

| Caso adversarial PostgreSQL 16                | Resultado exigido e observado                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A — falha RELEASED                            | Resultado não verificado; intenção v2 e snapshot retidos                                     |
| B — reconnect/restart do coordenador          | UNCERTAIN e ownership inválido persistem                                                     |
| C/D — terceiro cria par idêntico; novo REMOVE | MANUAL_RECONCILIATION_REQUIRED; zero comandos adicionais                                     |
| E — ACTIVATE com novo requestId               | Mesma quarentena; zero comandos adicionais                                                   |
| F — outro perfil na mesma policy              | ACTIVATE e REMOVE bloqueados por escopo                                                      |
| G — banco indisponível após REMOVE fake       | Erro real de conexão Prisma em loopback; retorno/restart não autoriza replay                 |
| H — recuperação explícita                     | Ausência e permanentes comprovados; recibo e RELEASED atômicos; nenhuma adoção de par alheio |
| Falha ao gravar intenção                      | Zero comandos físicos, mesmo antes de RELEASED                                               |

Os testes usam PostgreSQL real e Huawei simulado. A falha de conexão usa porta
loopback recusada, não derruba o PostgreSQL produtivo nem representa falha física
de armazenamento/WAL. Restart significa novo cliente Prisma/coordenador sobre
estado persistido; o processo do banco descartável permanece disponível.

## F2 — nodes permanentes

O classificador deixa de considerar um deny BOGONS isolado como par legado.
Uma RT660 permanente isolada continua sem provar ownership. Um par legado
identificado, meio-par com assinatura legada, node 0 e nodes 1/2 ocupados
continuam bloqueados. Nenhum caminho adota/remove nodes permanentes.

Fixtures sanitizadas das capturas anteriores: LIVINET deny5 BOGONS + permit10
AS-path/LP1000/RT140 + deny1000; CLICKING permit50 com RT660 e node100 normal;
HORIZONTES permit11 com RT660 e deny50. As três ficam NORMAL. Cinco controles
negativos continuam bloqueados. O teste antigo agora usa **deny**, não permit.
Essas fixtures não são uma nova leitura dos equipamentos nem aprovação física.

## F3 — simulador corrigido

O teste antigo foi substituído. O novo caminho usa **FastTrafficPoller,
deriveFastTraffic/Counter64, FastObservationSource, AutoMitigationLifecycle e
serviço/executor canônico** reais; Huawei e relógio são controlados. Não existe
streak nem decisão de ativação duplicada no simulador. Os contadores BigInt
começam em 2^63 e integram somente o tempo efetivamente transcorrido em cada
regime: 3 Gbps normal, 10 Gbps ataque, threshold 9 Gbps. Continuam evoluindo
durante GETs perdidos. Timeout/append falho invalidam baseline/qualidade pelo
próprio poller. Três amostras válidas, distintas e contíguas são verificadas.

O driver chama o scheduler a cada 250 ms e tick do lifecycle a cada 5 s; esses
valores são parâmetros do ensaio, não latência medida de produção. A configuração
atual usa suspectInterval igual ao normal. Um teste separado passa 10 s de
suspeita a uma agenda normal de 30 s para exercitar a aceleração suportada pelo
scheduler real; não foi criada flag nova no produto.

Na matriz principal, a persistência é em memória. Dois testes adicionais usam
PrismaObserverTrafficStore e PostgreSQL real, exigindo commit antes de publicar
o snapshot das duas últimas observações à fonte. Um deles falha o terceiro
append: exige novo BASELINE e três deltas persistidos antes de ACTIVATE. O
snapshot é uma fixture comprometida após o commit, não uma reprodução completa
da topologia de processos/bancos produtivos. Atraso de banco de 20 s também
invalida a evidência, sem ACTIVATE. RX não aciona a direção TX, execução OFF não
escreve, normalização não REMOVE e cadência de 5 s é recusada.

Tempos sintéticos em segundos, p50 / p95 / p99. Confirmação = coleta da terceira amostra; comando inclui readback.

| Cadência / timeout | Primeira anormal         | Confirmação                | Atraso decisão        | Comando / readback                            | Total até verificado fake   |
| ------------------ | ------------------------ | -------------------------- | --------------------- | --------------------------------------------- | --------------------------- |
| 10 s / 0%          | 13,424 / 18,294 / 18,648 | 33,735 / 38,505 / 38,942   | 4,512 / 4,762 / 4,762 | 0,165 / 0,165 / 0,165 / 0,010 / 0,010 / 0,010 | 38,158 / 42,932 / 43,619    |
| 10 s / 3%          | 14,190 / 18,648 / 33,786 | 34,435 / 54,060 / 78,827   | 4,512 / 4,762 / 4,762 | 0,165 / 0,165 / 0,165 / 0,010 / 0,010 / 0,010 | 38,906 / 58,487 / 83,254    |
| 15 s / 0%          | 19,852 / 27,297 / 27,829 | 50,163 / 57,340 / 58,123   | 4,512 / 4,762 / 4,762 | 0,165 / 0,165 / 0,165 / 0,010 / 0,010 / 0,010 | 54,577 / 61,767 / 62,800    |
| 30 s / 0%          | 39,138 / 54,308 / 55,370 | 99,449 / 114,261 / 115,664 | 4,512 / 4,762 / 4,762 | 0,165 / 0,165 / 0,165 / 0,010 / 0,010 / 0,010 | 103,876 / 118,274 / 120,341 |

São 40 ataques + 40 controles sem ataque por linha: 320 cenários. As 160
ativações são verificadas **somente no Huawei fake**; os 160 controles constantes
abaixo do threshold não acionam comandos. Isso não estima falso positivo de
tráfego real, bursts, ruído ou distribuições não ensaiadas. Nearest-rank com
N=40 faz p99 coincidir com o máximo amostral. Mesmo sob hipótese IID, não
satisfeita por todos esses cenários determinísticos, zero falhas em 40 não
excluiria cerca de 7,2% de probabilidade de falha no limite unilateral de 95%.
Não se trata de SLA ou percentis operacionais.

Os tempos da referência independente anterior ficam preservados em
`counter-simulation.json`. O novo modelo acrescenta agenda real, qualidade,
persistência, tick e recheck; não foi ajustado para igualar os números do auditor.
As diferenças e os atrasos por etapa estão em `fast-corrected-simulator.json`.

Relógio real/UDP loopback: parede 44.190 s; confirmação 24.823 s desde a primeira anormal; comando 9.033 s; readback fake 2.014 s; resposta total 33.857 s desde a primeira anormal. Prazo de 60 s: PASS.

O ensaio de relógio real preexistente usa engine/fixture próprios, GET UDP
loopback e delays deliberados do transporte fake. Foi reexecutado como regressão;
N=1 não define percentis e não comprova SSH/readback físico ou BGP efetivo.

## F4 — visões no restart

`reconcile()` limpa diagnósticos antigos, preenche uma visão por perfil e só
atualiza pilotView ao processar a AGLINK. Três ordens de três perfis, com novo
coordenador duas vezes antes de qualquer tick, mantêm AGLINK IDLE, outro cliente
fisicamente UNKNOWN em UNCERTAIN e um terceiro em quarentena própria. O estado
de outro cliente não vaza para o piloto. Falhas de identidade seguem fechadas.

## Validação e matriz D1–D12

Suíte completa da API: **2.912 PASS, 0 falhos, 0 ignorados**, 209 arquivos. PostgreSQL **16.15**, dois containers loopback/tmpfs, nove bancos com 43 migrations cada. Typecheck de todos os workspaces, ESLint, build API, Prettier dos arquivos alterados e diff check: PASS. Reproduções derivadas do auditor em memória/PostgreSQL e nove guards: PASS. A referência independente de contadores também foi reexecutada, sem alterar o original.

Na primeira suíte foram 2.908 PASS e três falhas em testes que chamavam REMOVE
diretamente sem ownership. As fixtures foram corrigidas usando o helper de
baseline existente; os asserts dos quatro comandos canônicos foram preservados.
Foi incluído o negativo de REMOVE sem ownership, com zero comandos. Nenhuma
barreira foi afrouxada para deixar testes verdes. As duas correções de prefer-const
apontadas inicialmente pelo lint também foram aplicadas no harness de teste.

PASS abaixo é evidência de regressão pelo implementador, **não GO independente**.

| Item                    | Resultado / evidência                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| D1 node 0               | PASS; preflight, segunda leitura e guards; zero escrita em ocupação           |
| D2 idempotência         | PASS; mesmo pedido simultâneo com uma escrita; conflitos não herdam recibo    |
| D3 ownership/release    | F1 corrigido; A–H PostgreSQL, memória, quarentena e reconciliação explícita   |
| D4 cadência             | PASS; 10/15/30 s e janelas reais, 5 s recusado; simulador F3 novo             |
| D5 teto por device      | PASS; excedente de um device não interrompe os demais                         |
| D6 gaps                 | PASS; BASELINE após falha conta chegada; 15 s separado da janela configurada  |
| D7 PostgreSQL           | PASS; nove bancos descartáveis, 43 migrations em cada; sem schema novo        |
| D8 mock REMOVE          | PASS; builder canônico e par fora de 1/2 recusado                             |
| D9 reconciliação física | F2 corrigido; LIVINET/CLICKING/HORIZONTES e negativos                         |
| D10 gates AUTO          | PASS; M8, OBSERVE sem escrita, IPv6 fora, allowlists/direção/binding/escopo   |
| D11 allowlist           | Configuração e autorização regressadas; **estado produtivo atual não relido** |
| D12 configuração/visões | F4 corrigido; ordens/restarts antes do tick; limites inválidos recusados      |

B3–B6, M8, locks PostgreSQL, concorrência, journal/outbox, idempotência,
confirmação de escopo, operação manual e proibição de AUTO REMOVE permanecem
cobertos pela suíte e pelos nove guards derivados do auditor. Há 44 testes nos
arquivos PostgreSQL de integração, mais o teste PostgreSQL de startup do Observer.
O teste de relógio real e os testes novos de PostgreSQL não ficaram ignorados.

O contrato BGP não mudou: node1 deny BOGONS; node2 permit irrestrito com **somente**
`apply extcommunity rt 268568:660`; nodes permanentes intocados. Não se acrescentou
if-match, LP, prefix-list ou additive. Não há mudança em schema, migrations,
executor de comandos n8n ou motor FAST de produção. O executor Huawei mudou
somente na persistência de intenção de REMOVE; nenhum comando físico novo.

## Limites e encaminhamento

- Auditoria diferencial independente F1–F4 ainda obrigatória; nenhuma aprovação
  A/B/C anterior é promovida por este relatório. **Sem GO para deploy/piloto/AUTO-ALL.**
- Persistem os bloqueios operacionais já documentados: homologação física,
  exportação/RT660 exclusiva e mitigadora autorizada, direções/bindings,
  cobertura de observação e policies compartilhadas. Não foram reavaliados
  globalmente nem corrigidos por expansão de escopo nesta missão.
- Lock do NetVision não impede CLI externo. A janela entre readback e commit
  de reconciliação continua sujeita a alteração de terceiro; exigir exclusividade
  operacional e nova inspeção autorizada. Texto idêntico nunca substitui posse.
- Quarentena impede inclusive REMOVE humano comum. Uma mitigação ainda presente
  pode exigir intervenção operacional específica; não há retirada/reconciliação
  física automática. Lacunas de histórico, baseline ausente ou conflito não são
  resolvidos por adivinhação nem apagando evidência.
- v2/RECONCILED usam o JSON/journal existentes, sem migration. Um downgrade para
  código anterior não preserva todas as barreiras novas. Não voltar ao código
  vulnerável com escopos pendentes; reconciliar/revisar os registros e planejar
  proteção operacional antes de qualquer rollback autorizado. Não apagar linhas.
- Não se mediram filesystem/WAL de produção, CPU no F1A sob falha nem tempo
  físico de mitigação. AUTO permanece sem habilitação por esta missão.

Evidências, scripts e instruções de reexecução:
[docs/audits/f1-f4-corrections/README.md](docs/audits/f1-f4-corrections/README.md).
