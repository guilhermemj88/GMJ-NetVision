# AGLINK IPv4 — plano com COMPUTIZE como única mitigadora

**Decisão do operador em 30/10/2026: vigente para o plano; mudanças operacionais ainda não aplicadas.** Substitui o requisito anterior de duas sessões DDoS. Não altera outras frentes do NetVision.

| Destino                                  | Decisão                                               | Prontidão exigida para AGLINK              | Situação de aplicação                                                        |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| COMPUTIZE-DDoS — 198.19.4.145 / AS270735 | Única mitigadora autorizada                           | BGP e confirmação operacional do provedor  | BGP Established; prontidão externa pendente                                  |
| SEMPRE-DDoS — 138.99.240.141             | **NEVER_MITIGATE**, permanentemente fora dos destinos | Não; não investigar nem recuperar a sessão | Exclusão registrada neste plano; bloqueio de exportação RT660 ainda pendente |
| SEMPRE normal — 138.99.240.117           | Preservar operação normal                             | Conforme preflight das seis saídas normais | Não modificar peer, policy ou exclusão administrativa existentes             |

## Exclusão administrativa e exportação

O banco já registra SEMPRE-DDoS como `excluded=true`, motivo `BACKBONE`. COMPUTIZE também está protegida como alvo (`BACKBONE`) e SEMPRE normal como `TRANSIT`. **Preservar as três exclusões.** A exclusão preventiva existente significa “não mitigar este peer como cliente/alvo”; não controla anúncios enviados ao peer. Não limpar a exclusão da COMPUTIZE para utilizá-la como destino.

`NEVER_MITIGATE` não é um novo valor de enum da API. A decisão foi registrada no plano, sem migration ou gravação produtiva. Caso se deseje refletir o rótulo em uma nota administrativa, usar a configuração existente mediante autorização de escrita, preservando `BACKBONE`; isso não substitui o bloqueio Huawei.

## Bloqueio Huawei necessário — proposta não executada

A leitura de 30/10/2026 às 19:48 de Brasília confirmou:

```text
route-policy PL-SEMPRE-DDoS-IPv4-OUT permit node 50
 if-match extcommunity-filter MITIGACAO
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 100

ip extcommunity-filter basic MITIGACAO index 10 permit rt 268568:660
```

Logo, o RT660 **continua permitido** nessa saída se a sessão estiver disponível. A exclusão administrativa ou retirar a sessão dos gates de prontidão não satisfazem a decisão de exportação.

Proposta mínima, sujeita a autorização específica e nova conferência de que o node 5 permanece livre:

```text
# PROPOSTA — NÃO APLICADA
route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
 if-match extcommunity-filter MITIGACAO
```

O primeiro deny rejeita qualquer rota contendo RT660 antes do permit 50, independentemente do estado futuro da sessão. Preservar os nodes 50/100 e a definição compartilhada `MITIGACAO`; não modificar o filtro compartilhado para “desabilitar” a SEMPRE, pois ele também é usado por COMPUTIZE e outras policies. Não alterar `PL-SEMPRE-IPv4-OUT`, a saída normal.

**Alcance da autorização necessária:** bloqueio global de qualquer prefixo com RT660 nessa policy SEMPRE-DDoS, não apenas os três prefixos AGLINK. Essa abrangência implementa a exclusão permanente do destino. Não se aplica automaticamente em produção e não deve ser removida no REMOVE da AGLINK. Reavaliar a proposta se node 5 estiver ocupado, o binding do peer mudar ou o filtro deixar de corresponder exatamente ao RT660.

Não há necessidade identificada de alterar o motor, criar worker, cadastrar outra mitigadora ou publicar API para essa mudança de exportação. Readback e validação de exportação após eventual aplicação são obrigatórios. Se for necessário refresh/soft reset, identificar peer/direção/alcance e obter autorização própria; nunca executar reset automaticamente.

## Plano AGLINK preservado

Perfil `cmuoavm4e00bysslhqd0h3q7u`; Huawei BHE-VTA-F1A-BGP-01; IPv4; `Eth-Trunk1.3058`, ifIndex 236; peer cliente `10.200.201.2` / AS273811; policy `PL-AGLINK_IPv4-IN`.

- ACTIVATE pelo executor manual canônico: node 1 deny BOGONS; node 2 permit `AGLINK-BLOCO-TODO-23`, LP1100, RT `268568:660` **sem additive**.
- Prefixos: `167.250.126.0/23`, `167.250.126.0/24`, `167.250.127.0/24`. Não utilizar PREFIX8to24 ou copiar RT140/330 para o node 2.
- Nodes 10 (LP1100/RT140 additive) e 1000 permanecem intactos.
- REMOVE exige comando humano separado e retira somente nodes 1/2. Não retirar o deny permanente da policy de exportação SEMPRE-DDoS.
- Persistência=1; lifecycle, execução AUTO, REMOVE AUTO e description=0; allowlist de execução de perfis vazia; maxActive=1. Nenhuma flag alterada nesta missão.

| Prefixos do piloto | Normal / após REMOVE humano             | Mitigação esperada após autorizações                                           |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| Os três prefixos   | RT140,330 / LP1100; seis saídas normais | RT660 exclusivo / LP1100; somente COMPUTIZE entre as oito saídas especificadas |
| SEMPRE-DDoS        | Fora dos destinos                       | RT660 rejeitado pelo deny permanente proposto                                  |

A exclusividade testada cobre COMPUTIZE, SEMPRE-DDoS e as seis saídas normais indicadas no escopo; não é uma auditoria de todos os peers internos/externos do equipamento.

## Novo preflight e confirmações

1. Revalidar API 4637696, persistência e flags acima, ausência de operação/ownership UNCERTAIN/lock conflitante, escopo AGLINK, backup e acesso manual de recuperação. Não corrigir catálogo ou ampliar auditoria.
2. Conferir a exclusão administrativa existente e **o deny RT660 efetivamente aplicado** na exportação SEMPRE-DDoS. Não exigir disponibilidade dessa sessão, não investigar sua conectividade e não tentar recuperá-la. Até o deny autorizado ser aplicado e lido, não declarar o destino permanentemente bloqueado.
3. COMPUTIZE: confirmar Established, estabilidade, `PL-COMPUTIZE-IPv4-OUT` e filtros efetivos. A leitura atual mostrou ausência de prefix-list, update-filter, distribute-policy e route-filter de exportação adicionais no detalhe do peer; a policy admite RT660 exclusivo para os três prefixos nos testes estáticos. Ainda não é prova de anúncio durante mitigação.
4. **Obter do operador COMPUTIZE:** três prefixos aceitos no serviço, scrubbing habilitado, capacidade/limites e caminho de retorno do tráfego limpo acordados, equipe disponível e forma de comprovar recepção/encaminhamento. Established, 11 anúncios de outros prefixos ou capacidade de route-refresh não provam essas condições.
5. Confirmar operador local presente, janela/exclusividade da policy e preservação das seis saídas normais: SEMPRE 138.99.240.117, SEABORN 198.18.1.152, SEABORN-BH 198.18.36.26, CIRION 200.194.223.85, IP-TUDDO 172.30.251.33 e VS-IX 45.163.144.6. As três rotas devem estar best/select via AGLINK, LP1100, RT140/330, nodes 1/2 livres, prefix-lists corretas e nodes 10/1000 intactos.
6. Apresentar estado/impacto ao operador e solicitar **autorização específica de um ACTIVATE manual**. Não utilizar a decisão de uma mitigadora como autorização física. Não repetir ACTIVATE incerto.
7. Após ACTIVATE autorizado, ler policy, best routes, LP/RT660 exclusivo, anúncios à COMPUTIZE e ausência nas seis normais. Para SEMPRE-DDoS, exigir a proteção permanente na configuração; se houver sessão disponível no momento da validação, confirmar ausência dos anúncios proibidos sem a transformar em requisito de prontidão. Separar Adj-RIB-Out local, recepção do provedor e encaminhamento efetivo.
8. Verificar journal/outbox e recibo real Telegram. Manter mitigação apesar da queda de tráfego. Solicitar REMOVE humano separadamente; sem comando, preservar mitigação. Retirada deve restaurar RT140/330 e anúncios normais, com readback e ownership coerentes. Nenhum rollback físico automático.

Riscos do destino único: ausência de redundância DDoS, dependência da capacidade e encaminhamento COMPUTIZE e risco de indisponibilidade se os anúncios normais forem suprimidos e o serviço não estiver pronto. Falha/timeout exige decisão humana, sem desviar automaticamente para SEMPRE-DDoS ou executar REMOVE automático.

## Menor correção proposta para os prefixos no Telegram

Adicionar um campo opcional `prefixes: string[] | null` ao contrato canônico e ao payload HTTP, preservando evento, eventId, autenticação, RT, verified, ACK e callbacks. Obter a lista de uma leitura completa dos prefixos recebidos do cliente no escopo validado; o snapshot atual expõe apenas contagem/existingNodes, portanto a integração deverá transportar a lista real pelo resultado do comando até a notificação. Nunca inferir a lista pelo nome/profileId ou apenas pela prefix-list configurada.

Persistir essa lista com o mesmo evento/outbox, sem recalculá-la durante retries. Sem evidência completa e vinculada ao perfil/policy/peer/família, enviar `null` e marcar `prefixes` em `fieldsUnavailable`. “Prefixos envolvidos” identifica o escopo; não substitui a prova física de RT660/LP1100 em cada rota. Não promover `verified` ou `delivered` por causa desse campo.

O normalizador n8n publicado não renderiza esse campo. Exibi-lo no Telegram requer, posteriormente, uma pequena alteração de apresentação, com autorização própria. Não há alteração de workflow/credenciais nesta missão. Os testes do protótipo estão inteiramente no arquivo de teste; **não há integração runtime implementada/publicada**. Os consumidores antigos seguem compatíveis sem o campo.

## Autorizações ainda necessárias

1. Alterar somente a exportação SEMPRE-DDoS conforme a proposta, incluindo o alcance global RT660 e os readbacks; nenhum refresh/reset embutido.
2. Confirmar prontidão COMPUTIZE e janela/exclusividade. Se desejado, autorizar somente a atualização textual da nota administrativa NEVER_MITIGATE, mantendo a proteção BACKBONE existente.
3. Autorizar ACTIVATE físico, depois de preflight válido; autorizar REMOVE em decisão separada.
4. Se a lista explícita no Telegram continuar sendo requisito de aceite, autorizar integração/publicação futura do pequeno contrato API e a alteração de apresentação n8n, separadamente. Não depender de alteração tácita do workflow.

**GO para o plano de uma mitigadora e para preparar as alterações propostas. NO-GO para ACTIVATE físico agora:** a exportação SEMPRE-DDoS ainda permite RT660 e a prontidão COMPUTIZE/janela exclusiva não foi confirmada. AUTO permanece desligado.
