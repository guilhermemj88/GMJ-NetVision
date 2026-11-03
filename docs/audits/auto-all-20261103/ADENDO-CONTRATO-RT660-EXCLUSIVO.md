# Adendo obrigatório — node 2 com RT660 exclusivo

**03/11/2026. Auditoria somente leitura. Não conformidade BLOQUEANTE para AUTO até correção e homologação.**

Este adendo substitui a premissa additive da auditoria `af9e692`. O software efetivamente publicado continua sendo `908e7b417502930d7945b3d73dded584a7012dd7`; nenhum arquivo funcional ou teste versionado foi alterado. Novas leituras Huawei: `2026-11-03T19:26:14.913Z` (16:26:14 de Brasília).

## 1. Contrato vigente

- Node 1: deny com `if-match ip-prefix BOGONS`.
- Node 2: permit da lista autorizada do cliente; preservar LP adequado, **substituir o conjunto de RTs por somente `268568:660`**.
- A única cláusula RT do node 2 deve ser `apply extcommunity rt 268568:660`, sem `additive`, RT140, RT330 ou outra RT anterior.
- Node 10 e demais nodes permanentes são intocados. A linha original do node 10 pode continuar contendo `additive`; a proibição incide no node 2 temporário.
- REMOVE exclusivamente humano: excluir somente 1/2. A avaliação normal volta ao node 10. Não reescrever os RTs normais, não restaurar nodes permanentes por comandos compensatórios e não executar REMOVE por queda do tráfego.

Para a AGLINK, LP do node 2 continua **1100**, e a lista é `AGLINK-BLOCO-TODO-23`. Os três prefixos autorizados no escopo são `167.250.126.0/23`, `167.250.126.0/24` e `167.250.127.0/24`.

## 2. Investigação da semântica Huawei

O equipamento foi novamente identificado por leitura como NE8000 F1A-8H20Q, VRP8.220 / V800R022C00SPC600 / V800R022SPH152. A [fonte primária Huawei específica de NE8000-F1A/8.22.0](https://github.com/Huawei/yang/blob/926ac3b33660d6b07caa035263d80d34cffd7b60/network-router/8.22.0/ne8000-f1a/huawei-routing-policy.yang#L2625-L2664), no container `apply-ext-community`, distingue adição e substituição para VPN-target/RT. O modo replace troca o atributo original pelo conjunto configurado, em vez de uni-los.

Isso sustenta a semântica de **substituir as RTs anteriores por RT660**, que é a finalidade da forma CLI sem additive. Não se deve interpretar esse requisito como apagar AS-path, LP, communities padrão ou todos os outros tipos de extended-community.

**Limite da comprovação:** foi obtido o modelo oficial do produto/versão, com commit e SHA256 registrados. Não foi recuperada uma referência CLI oficial que associe explicitamente a ausência do parâmetro ao modo replace nessa revisão de firmware; essa associação é a interpretação técnica esperada, não uma medição física nesta missão. Nenhuma rota foi alterada para demonstrar substituição de RT140/330 no SPC600/SPH152. O efeito físico exato, inclusive qualquer particularidade de outras extended-communities, fica **NOT_VERIFIED até homologação autorizada**. Não foi usada documentação Cisco/H3C como prova de comportamento Huawei.

As policies preexistentes já contêm `apply extcommunity rt 268568:660` sem additive, mas observar sua configuração, isoladamente, não prova quais atributos uma rota possuía antes. A confirmação física futura precisa comparar o conjunto efetivo de RTs em cada rota, não somente o texto do node.

## 3. Não conformidade do motor publicado

O código está preservando RTs normais no node temporário, contrariando o contrato vigente:

| Ponto                                               | Comportamento atual / dependência                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `mitigation-policy-clauses.ts:146`, `:460`          | Deriva RTs do baseline e `buildRouteTargetLine` une RTs normais com RT660, sempre acrescentando `additive`      |
| `mitigation-write-guard.ts:119`                     | Usa essa linha no builder canônico do ACTIVATE                                                                  |
| `aglink-bgp-plan.ts:27`                             | Espera literalmente `apply extcommunity rt 268568:140 rt 268568:660 additive`                                   |
| `mitigation-executor.ts:276`                        | Readback com `preservedClauses` compara clauses exatas contra o plano additive                                  |
| `mitigation-policy-physical.ts:113`                 | Reconhecimento AGLINK exige o template antigo; uma ativação exclusiva correta fica divergente                   |
| `huawei-mitigation-executor.ts:179`, `:560`, `:665` | Preflight e segunda leitura dependem das RTs do baseline; REMOVE também depende do reconhecimento físico do par |
| `mitigation-executor.ts:149`, `:167`                | Mock serializa/aplica RT com additive e não modela substituição das RTs recebidas na rota BGP                   |

Reprodução isolada com funções reais da release, sem transporte:

| Node 2 apresentado ao verificador atual           | Readback com plano derivado | Reconhecimento físico AGLINK |
| ------------------------------------------------- | --------------------------- | ---------------------------- |
| RT140 + RT660 additive, contrato antigo           | **Aceita**                  | MITIGATED                    |
| Somente RT660, sem additive, contrato obrigatório | **Rejeita**                 | RECONCILIATION_REQUIRED      |
| Somente RT660 com additive                        | Rejeita com plano derivado  | RECONCILIATION_REQUIRED      |
| RT660 + RT999 sem additive                        | Rejeita com plano derivado  | RECONCILIATION_REQUIRED      |

No helper `verifyActivation` **sem** `preservedClauses`, as quatro variantes são aceitas porque a verificação básica exige presença de RT660, não exclusividade. O caminho produtivo possui checagens adicionais; não se afirma que todas essas variantes seriam aceitas ponta a ponta. O achado mostra por que a correção futura precisa alinhar builder, leitura/verificação e reconhecimento físico, em vez de trocar apenas uma string de comando.

As quatro variantes mantiveram zero divergências no fingerprint dos nodes permanentes. A verificação de retirada sobre o texto original, sem 1/2 e com 10/1000 intactos, passou. Isso comprova separação lógica no código, **não** retorno físico de tráfego.

## 4. Dependências das proteções B1–B6

Os rótulos históricos B1/B2 não foram encontrados explicitamente nos relatórios rastreados; a tabela identifica os mecanismos de derivação/preservação avaliados, sem inventar uma numeração de teste ausente.

| Proteção                                                                       | Depende de RT normal no node 2?                                            | Consequência para correção futura, não executada                                                                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1/B2 — baseline derivável, cláusulas reproduzíveis e expectativa de atributos | **A expectativa de RT/aplicação atual depende**; a proteção estrutural não | Preservar LP, restrição de prefixos, bloqueios por ambiguidade e registro dos RTs originais. Alterar somente a projeção RT do node 2 e as expectativas de readback para RT660 exclusivo           |
| B3 — sobreposição de prefixos/nodes anteriores                                 | **Não**                                                                    | Manter fail-closed e validação das listas reais; ajustar fixtures do resultado temporário, sem relaxar o teste de escopo                                                                          |
| B4 — transporte, prompt e erros antes de commit                                | **Não**                                                                    | Manter todos os abortos e a sequência canônica; revalidar igualdade entre preview e escrita com a nova linha RT                                                                                   |
| B5 — fingerprint durável e drift dos nodes permanentes                         | **Não**; a inspeção física adjacente ainda usa o template antigo           | Registrar node 10 com seus RTs normais originais e comparar no REMOVE. Atualizar reconhecimento do par exclusivo; não apagar RTs do baseline nem reinterpretar nodes permanentes como temporários |
| B6 — persistência obrigatória, gravação e releitura antes da escrita           | **Não**                                                                    | Manter store durável, scope, hash, transações, journal/outbox e recuperação após restart. Corrigir fixtures/asserções que acoplam o ciclo ao additive                                             |

`activationBaselineDiverged` compara RTs **originais do baseline** entre preflight e leitura final. Isso continua necessário. Não se deve esvaziar `preserved.routeTargets` indiscriminadamente para forçar o builder a emitir RT660: esses dados continuam sendo evidência do estado normal. O conjunto a aplicar no node 2 e o conjunto original a auditar têm funções distintas.

Testes relacionados: `aglink-activate-contract`, `aglink-bgp-plan`, `aglink-bgp-export`, `mitigation-audit-corrections`, `mitigation-final-defects`, `mitigation-b6-durability`, `ne8000-observed-readback` e `ssh-client-write-guards`. Foram reexecutados **93 testes, todos aprovados**, sem modificar suas expectativas. Estão verdes sob o contrato antigo; isso **não homologa o contrato corrigido**.

## 5. Exportação reavaliada com RT660 exclusivo

A leitura nova confirma o deny permanente no node 5 da SEMPRE-DDoS e as policies de saída. A avaliação é estática, sobre configuração real capturada, cobrindo as oito saídas especificadas:

| Saída                          | Resultado para cada um dos três prefixos com somente RT660 | Primeiro match |
| ------------------------------ | ---------------------------------------------------------- | -------------- |
| COMPUTIZE-DDoS — 198.19.4.145  | **Permit**                                                 | 300            |
| SEMPRE-DDoS — 138.99.240.141   | Deny / NEVER_MITIGATE preservado                           | 5              |
| SEMPRE normal — 138.99.240.117 | Deny                                                       | 5              |
| SEABORN                        | Deny                                                       | 5              |
| SEABORN-BH                     | Deny                                                       | 5              |
| CIRION                         | Deny                                                       | 100            |
| IP-TUDDO                       | Deny                                                       | 100            |
| VS-IX                          | Deny                                                       | 6000           |

Sem RT140, o deny 90 da COMPUTIZE deixa de casar. Os três prefixos alcançam permit 300. Portanto, **o conflito anterior desaparece sob o contrato exclusivo**, e não há necessidade demonstrada de alterar essas policies OUT para acomodar os três prefixos. A causa bloqueante passa a ser o motor gerar/verificar RTs indevidas, além das demais pendências já registradas.

| Prefixo          | Antes da mitigação, leitura real | Durante, resultado exigido ainda não aplicado           | Após REMOVE manual, resultado esperado               |
| ---------------- | -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| 167.250.126.0/23 | RT140/330, LP1100                | **Só RT660**, LP1100; somente COMPUTIZE nas oito saídas | RT140/330, LP1100, comportamento normal pelo node 10 |
| 167.250.126.0/24 | RT140/330, LP1100                | **Só RT660**, LP1100; somente COMPUTIZE nas oito saídas | RT140/330, LP1100, comportamento normal pelo node 10 |
| 167.250.127.0/24 | RT140/330, LP1100                | **Só RT660**, LP1100; somente COMPUTIZE nas oito saídas | RT140/330, LP1100, comportamento normal pelo node 10 |

O retorno de RT330 depende dos atributos normais recebidos do cliente continuarem presentes na reavaliação da rota. Não se grava RT330 em node temporário nem se modifica node 10 para fabricar esse retorno. A captura demonstra o estado normal atual; o estado durante/depois só poderá ser comprovado em homologação física autorizada.

## 6. Critérios obrigatórios para encerrar a divergência

1. Em missão posterior autorizada, corrigir geração e validação para RT set **exatamente `{268568:660}`**, sem additive, mantendo LP e escopo da lista. Garantir que RT140/330/qualquer outra RT causem rejeição quando residirem no resultado mitigado.
2. Manter B1–B6, M8, locks e journal. A corrida de ocupação de 1/2 e a colisão de recibos identificadas antes continuam pendentes; esta mudança de contrato não as resolve.
3. Testar entrada sem RT, com RT140, RT330, múltiplas RTs e uma RT não prevista. Uma simulação futura precisa modelar replace, não apenas construir texto ou usar `.includes(660)`.
4. Confirmar baseline e nodes permanentes idênticos antes/durante/depois, além de retirar apenas 1/2 por ação humana. Não reinterpretar ou remover automaticamente instalações antigas additive ou nodes de terceiros.
5. Na homologação autorizada, exigir leitura da RIB dos **três** prefixos: LP1100, rota do cliente correta, nenhuma RT residual além de RT660; comprovar anúncios só à COMPUTIZE no escopo avaliado, aceitação/limpeza/retorno pela mitigadora e notificações verificadas. Depois de REMOVE humano, conferir retorno à semântica normal e aos anúncios originais.

## 7. Encerramento

Evidência: [rt660-exclusive-review.json](rt660-exclusive-review.json), com fonte primária fixada por commit/hash, captura nova, matriz dos três estados de RT, resultados da reprodução de verificadores e 93 regressões. Não houve implementação, alteração de tests versionados, configuração Huawei, ACTIVATE/REMOVE, refresh, restart, flag, deploy ou migration.

API permaneceu no mesmo PID/bundle e as flags efetivas continuaram LIVE_WRITE=false, AUTO=0, lifecycle=0, REMOVE=0, persistência=1. **NO-GO para AUTO até correção e homologação.** O parecer NO-GO físico manual/AUTO restrito/AUTO-ALL permanece pelas pendências descritas; a conclusão de exportação agora considera o contrato correto, RT660 exclusivo.
