# Adendo corrigido — contrato final BGP, node 2 sem if-match

**03/11/2026. Auditoria somente leitura em produção. NO-GO para AUTO até correção e homologação.**

Este documento substitui integralmente o adendo anterior e suas exigências não autorizadas de prefix-list e local-preference no node 2. Não há nova implementação. O código publicado continua `908e7b417502930d7945b3d73dded584a7012dd7`.

## 1. Contrato definitivo do operador

```text
route-policy PL-CLIENTE_IPv4-IN deny node 1
 if-match ip-prefix BOGONS

route-policy PL-CLIENTE_IPv4-IN permit node 2
 apply extcommunity rt 268568:660
```

Node 2 **não contém if-match, prefix-list, local-preference, additive, goto ou cópia/derivação de cláusulas de node permanente**. O conjunto efetivo de RTs da rota mitigada deve ser exatamente `{268568:660}`. Não se conserva RT140, RT330 ou qualquer outra RT anterior. Isso não exige apagar tipos diferentes de extended-community ou outros atributos BGP indiscriminadamente.

Nodes permanentes, incluindo 10/1000 quando existentes, permanecem intocados. A remoção é exclusivamente manual e exclui somente o par 1/2 cuja propriedade gerenciada esteja comprovada. A redução do tráfego não aciona REMOVE.

O modelo é explicitamente IPv4. Não foi inventado um contrato BOGONS/IPv6 nem estendida autorização aos 16 perfis IPv6.

## 2. Leituras e ocupação física

Nova leitura do F1A: **2026-11-03T19:56:22.692Z**, 16:56:22 Brasília. NE8000 F1A-8H20Q, VRP8.220 / V800R022C00SPC600 / SPH152. Foram usados exclusivamente os leitores existentes e comandos display, sem importar/chamar o transporte de escrita. `screen-length 0 temporary` afeta somente a paginação da sessão de leitura.

Resultado para **39 perfis / 24 policies**: **nenhum node 0, 1 ou 2 ocupado no conjunto consultado**. Logo, não há nesta captura cliente a listar como NÃO APTO por ocupação preexistente de 1/2. Isso é uma constatação de snapshot, não reserva de exclusividade nem autorização de ACTIVATE.

Regra de aptidão por ocupação, para a futura implementação:

- Qualquer node 1 ou 2 ocupado sem evidência durável e leitura coerente de ownership NetVision: **NÃO APTO**, informar cliente, device, policy e cada node ocupado. Não sobrescrever, adotar por semelhança, remover ou deslocar para outro par. O operador corrigirá manualmente no F1A.
- Par comprovadamente gerenciado e ativo: reconciliar o estado e impedir segundo ACTIVATE. Apenas a forma textual ou RT660 não comprova ownership.
- Par parcial, drift, leitura inconclusiva, journal/ownership incompatível ou operação em andamento: bloquear escrita. Runtime NORMAL não invalida presença física de nodes.
- Repetir a verificação sob serialização e na leitura final antes da escrita. A corrida de ocupação identificada na auditoria anterior continua relevante.

A captura anterior e a nova diferem em um node permanente: `PL-HORIZONTES_IPv4-IN`, node 11, passou de `apply extcommunity rt 268568:140` para `apply extcommunity rt 268568:660`. As demais cláusulas desse node permaneceram iguais. **Esta auditoria não executou a alteração e não atribui sua autoria.** O node fica intocado e seu ownership não é presumido. CLICKING também mantém RT660 preexistente no node 50. Nenhum deles é o par temporário gerenciado 1/2.

## 3. Efeito do permit sem if-match e proteção de prefixos

A [explicação técnica publicada no fórum oficial Huawei](https://forum.huawei.com/enterprise/cn/zh/thread-372283.html) descreve que um permit sem condições abrange todas as rotas; a avaliação termina no primeiro node que casa. É referência de semântica geral Huawei, não homologação física desta revisão.

Assim, para as policies consultadas, sem node 0:

1. Node 1 rejeita as rotas que casarem com a definição real de BOGONS.
2. Todas as demais rotas avaliadas por essa policy casam com node 2, recebem o tratamento RT exclusivo e não chegam aos nodes permanentes.
3. Prefix-lists, AS-path, denies e aplicações de atributos nos nodes 5/10/11/50/100/1000 ficam fora desse caminho enquanto 1/2 estiverem presentes. O conteúdo desses nodes não é alterado.

**Proteção independente:** a configuração BGP completa capturada não apresentou `peer ip-prefix`, `filter-policy`, `as-path-filter`, route-filter, grupo com filtro herdado, nem validação de origem unicast demonstrada que imponha a lista de prefixos da AGLINK fora da sua policy IN. Os vínculos observados de `10.200.201.2` são import `PL-AGLINK_IPv4-IN` e export `PL-AGLINK_IPv4-OUT`. A definição `AGLINK-BLOCO-TODO-23` sozinha não filtra rotas quando o node que a referencia não é avaliado. A configuração de validação encontrada em IPv4 FlowSpec não comprova proteção do unicast. `undo check-first-as` também consta na configuração; não é uma validação de propriedade dos prefixos.

Não foi comprovado filtro no roteador do cliente, em outro equipamento ou outra proteção externa. ACL de transporte BGP, autenticação e limite de quantidade de rotas, isoladamente, não equivalem a validar quais NLRIs o cliente pode anunciar. **Não há proteção independente de prefixos comprovada para sustentar que só os três atuais serão aceitos.**

Avaliação de referência sobre as listas reais, sem enviar qualquer prefixo ao Huawei:

| Prefixo          | Normal pela policy AGLINK | Durante o contrato solicitado | Após retirada manual de 1/2 |
| ---------------- | ------------------------- | ----------------------------- | --------------------------- |
| 167.250.126.0/23 | Permit node 10            | Permit node 2                 | Comportamento normal        |
| 167.250.126.0/24 | Permit node 10            | Permit node 2                 | Comportamento normal        |
| 167.250.127.0/24 | Permit node 10            | Permit node 2                 | Comportamento normal        |
| 167.250.126.0/25 | Deny node 1000            | **Permit node 2**             | Deny node 1000              |
| 167.250.128.0/24 | Deny node 1000            | **Permit node 2**             | Deny node 1000              |
| 8.8.8.0/24       | Deny node 1000            | **Permit node 2**             | Deny node 1000              |
| 0.0.0.0/0        | Deny node 1000            | **Permit node 2**             | Deny node 1000              |
| 10.1.0.0/24      | Deny node 1000            | Deny node 1 / BOGONS          | Deny node 1000              |

Somente os três primeiros foram observados como rotas AGLINK existentes. Os demais são contraexemplos sintéticos de avaliação offline, não anúncios reais. A BOGONS capturada não barra a default route por esse match e não substitui uma lista de propriedade do cliente.

**Risco concreto:** aceitação de anúncios adicionais ou indevidos e seu encaminhamento ao caminho de mitigação. A amplitude do node 2 alcança todos os peers que compartilhem a policy, não apenas a interface/perfil que detectou o limiar. O contrato não foi alterado para esconder esse efeito. Se for necessária proteção adicional em outra camada, sua definição e implantação dependem de decisão/autorização própria; nenhuma foi implementada aqui.

## 4. Local-preference e RTs

A cláusula `apply local-preference 1100` permanece no node 10 da AGLINK, mas não é executada para rotas que terminam no node 2. **Não se promete LP1100 durante a mitigação e não se copia essa cláusula para node 2.** O LP efetivo passa a depender dos atributos e defaults aplicáveis fora do node 10, devendo ser lido na RIB em homologação autorizada. Não houve medição desse resultado nesta missão.

| Estado                    | RTs esperadas AGLINK                                                      | Local-preference                                |
| ------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Normal, leitura atual     | RT140/330                                                                 | 1100, node 10                                   |
| Durante o contrato final  | Somente RT660                                                             | Não definido por node 2; **1100 não garantido** |
| Após REMOVE manual de 1/2 | Comportamento normal; RT140/330 se atributos recebidos continuarem iguais | Node 10 volta a aplicar 1100                    |

O [modelo oficial Huawei NE8000-F1A/8.22.0](https://github.com/Huawei/yang/blob/926ac3b33660d6b07caa035263d80d34cffd7b60/network-router/8.22.0/ne8000-f1a/huawei-routing-policy.yang#L2625-L2664) documenta modos distintos de adição e substituição de RTs. A associação da CLI sem additive ao modo de substituição continua sendo a interpretação técnica esperada; a referência CLI exata e o efeito físico no SPC600/SPH152 continuam **NOT_VERIFIED**. A homologação deve comprovar RT set exatamente `{268568:660}`, não só sua presença no texto.

## 5. Reavaliação dos 38 bloqueios de baseline

A exigência de achar uma prefix-list/baseline reproduzível para copiar suas cláusulas ao node 2 **foi retirada do contrato**, não removida do código nesta missão.

| Conjunto                                      | Resultado pelo contrato final                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22 perfis IPv4 antes bloqueados por derivação | Os 22 motivos de derivação ficam obsoletos. Nodes 1/2 livres na leitura. Isso não os torna automaticamente aptos E2E                                  |
| 16 perfis IPv6 antes bloqueados por derivação | O motivo de derivação também não é requisito do novo modelo, mas permanecem fora do contrato físico IPv4; sem declarar aptidão ou inventar plano IPv6 |
| AGLINK IPv4, antes passando no baseline       | Também não precisa derivar/copiar node 10; deve seguir o mesmo node 2 exato, sem exceção LP/lista                                                     |

**38/38 bloqueios de derivação reclassificados como requisito obsoleto; zero liberações operacionais.** O código atual ainda contém essa exigência e continua barrando os 38 casos na avaliação antiga. Há 27 perfis em policies compartilhadas e os demais impedimentos independentes de direção, família, modo ALERT_ONLY, concorrência, identidade e homologação continuam separados. LIVINET ter BOGONS no node permanente 5 não ocupa 1/2 nem autoriza mexer no node 5.

A [matriz dos 39 perfis](MATRIZ-CONTRATO-FINAL.md), o [CSV](matriz-contrato-final.csv) e a [evidência estruturada](contrato-final-node2-sem-match.json) identificam cliente, policy, família, ocupação e restrições remanescentes individualmente.

## 6. Divergência do software e proteções B1–B6

O código publicado ainda gera cláusulas derivadas, lista de alvos, LP e RT additive. Portanto, diverge integralmente do novo node 2. Não foi corrigido funcionalmente.

| Mecanismo auditado                                                           | Avaliação sob o contrato final                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Derivação/reprodução, correspondentes a B1/B2 sem rótulo histórico explícito | Deixa de ser requisito do node 2. Preservar evidência completa do estado permanente, sem copiá-la ao par temporário                                                                   |
| B3, sobreposição/prefix-list do plano antigo                                 | Não exigir prefix-list no node 2 ou proibir a amplitude deliberada do contrato. Documentar o novo alcance; manter validação dos vínculos peer/policy/família e contenda compartilhada |
| B4, transporte/prompt/erros/commit                                           | Preservar todas as barreiras e igualdade preview/escrita. Só um plano exato poderá ser autorizado na futura correção                                                                  |
| B5, fingerprint/drift de nodes permanentes                                   | Preservar integralmente. Não excluir RTs/LP do baseline durável para forçar emissão do plano. Os atributos continuam como evidência, sem uso como cláusulas de node 2                 |
| B6, persistência/journal/transações/releitura antes de escrever              | Preservar integralmente. UNCERTAIN, operação incompleta ou falha do store continuam bloqueando escrita e duplicidade após restart                                                     |

Pontos que dependerão de correção futura: `mitigation-policy-clauses.ts`, builder em `mitigation-write-guard.ts`, template `aglink-bgp-plan.ts`, verificadores em `mitigation-executor.ts`, inspeção em `mitigation-policy-physical.ts` e chamadas em `huawei-mitigation-executor.ts`. Não basta alterar a linha RT: o reconhecimento físico atual exige a antiga lista de alvos.

Readback futuro deve conferir **o node 1 deny com sua única condição BOGONS e node 2 permit com somente a linha RT660**, mais o fingerprint de todos os nodes permanentes. Qualquer RT adicional, additive, if-match, LP ou cláusula não contratada no node 2 deve ser divergência. Ownership deve estar comprovado independentemente da forma textual. Manual REMOVE continua exigindo autorização, escopo, lock e readback de ausência de 1/2 com permanentes intactos. Nenhum node preexistente de RT660 é adotado por inferência.

## 7. Exportação para COMPUTIZE

A referência estática foi reexecutada com a captura nova. Para **cada um dos três prefixos conhecidos**, supondo rota elegível à exportação e somente RT660:

| Saída                        | Resultado / primeiro match               |
| ---------------------------- | ---------------------------------------- |
| COMPUTIZE 198.19.4.145       | Permit / node 300                        |
| SEMPRE-DDoS 138.99.240.141   | Deny / node 5; NEVER_MITIGATE preservado |
| SEMPRE normal 138.99.240.117 | Deny / node 5                            |
| SEABORN / SEABORN-BH         | Deny / node 5                            |
| CIRION / IP-TUDDO            | Deny / node 100                          |
| VS-IX                        | Deny / node 6000                         |

O conflito RT140/deny90 da COMPUTIZE continua resolvido pelo RT exclusivo. Não foi demonstrada necessidade de mudar essas policies OUT para os três prefixos. Entretanto, essa tabela **não prova anúncio físico, seleção best-path após mudança de LP, recebimento/scrubbing/retorno pela COMPUTIZE, nem exclusividade de exportação de qualquer prefixo adicional** que o node 2 agora possa aceitar. Não estender o resultado dos três a uma full table ou default route. SEMPRE-DDoS não foi investigada para recuperação.

## 8. Verificações executadas e preservação da produção

- 39 perfis reavaliados, 24 policies lidas, nenhum 1/2 ocupado; 38 motivos antigos de baseline reclassificados.
- 8 casos de referência de prefixos, com expansão de aceitação explícita acima; todos atenderam ao modelo declarado. Não são testes físicos.
- 23 probes IPv4, exclusivamente de funções locais da release, com o par final exato: **0/23 aceitos pelo verificador atual**, **23/23 RECONCILIATION_REQUIRED** no reconhecimento físico. Isso demonstra a incompatibilidade atual, sem simular sucesso Huawei.
- Os mesmos 23 probes preservaram o fingerprint dos nodes permanentes e passaram na comparação textual de remoção apenas de 1/2. Não comprovam rollback físico nem operações reais.
- 24 avaliações OUT exclusivas (3 prefixos × 8 saídas), todas com somente COMPUTIZE permitida; os 72 casos de três conjuntos RT usados como referência também foram reavaliados.
- Os 93 testes de regressão da rodada anterior permanecem evidência do contrato antigo. Não foram alterados nem reexecutados como se homologassem o novo contrato. Nenhum build ou pacote novo foi gerado.

Leitura produtiva **2026-11-03T19:57:41.283458Z**: API/MCP/WEB/Observer active/running, mesmos PIDs da captura anterior. API PID 3527751, NRestarts=0, source `908e7b417502930d7945b3d73dded584a7012dd7`; bundle SHA256 `2c0068b6e3d8dde39e744e7d65871b6062aa7d8ecf3c6045ded7407b0bdda0ef`. Os 39 perfis mantêm os vínculos/configuração identificadora comparados. Consultas SQL executadas em transação READ ONLY; sem login da API ou criação de sessão de aplicação.

Flags efetivas preservadas: LIVE_WRITE=false, AUTO_EXECUTION=0, AUTO_LIFECYCLE=0, AUTO_REMOVE=0, AUTO_PERSISTENCE=1. Nenhuma escrita Huawei foi executada por esta auditoria, nem refresh, restart, migration, alteração de código/configuração operacional ou n8n. A diferença HORIZONTES observada foi explicitamente registrada, portanto não se declara que toda configuração Huawei permaneceu estática entre capturas.

## 9. Decisão

**NO-GO para AUTO.** A avaliação documental adota exatamente o contrato solicitado, sem lista, LP, additive ou derivação no node 2. Os 38 bloqueios antigos deixam de ser exigências do contrato; isso não publica uma correção nem declara aptidão física.

Permanecem bloqueantes a incompatibilidade do código e de seus readbacks, as falhas de concorrência já documentadas, a ampliação de aceitação de NLRIs sem proteção independente comprovada e a ausência de homologação do comportamento real — RTs, LP/best-path, exportação e serviço pela COMPUTIZE. A decisão operacional sobre esse risco precisa ser explícita; não foi acrescentado filtro ao contrato para resolvê-lo unilateralmente.

Parar nesta auditoria. Nenhuma alteração funcional ou física foi realizada.
