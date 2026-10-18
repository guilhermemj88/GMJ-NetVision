# DDoS Telemetry Recovery — candidato isolado

Concluída sobre `44ca717`, na branch `feature/ddos-telemetry-recovery`. **Nenhum deploy, restart, migration operacional, mudança de direção operacional ou comando de mitigação foi realizado nesta missão.** A worktree original e a Fast Response foram preservadas. Esta entrega é a base da missão posterior de integração definitiva.

## Auditoria de 18/10/2026

Consulta em transação PostgreSQL READ ONLY, às 09:14:41 BRT / 12:14:41 UTC. API `fc790ade`, frontend `bc559bec`, observador `69b375f`. PIDs respectivamente 2165618, 2235940 e 2243027, sem reinícios. API health 200. Há 38 migrations operacionais concluídas; a tabela prioritária ainda não foi aplicada ao banco operacional.

Inventário completo de 36 perfis: [CSV](benchmarks/ddos-telemetry-inventory-20261018.csv) e [JSON](benchmarks/ddos-telemetry-inventory-20261018.json). O CSV identifica causa derivada da configuração, sem apresentá-la como decisão histórica capturada do motor. Cada linha inclui cliente/AF, device/interface/ifIndex/ID, contrato, direção/origem, modo/proveniência, RX/TX, timestamp/idade e estado. A tabela não soma tráfego IPv4 e IPv6: eles leem o mesmo contador agregado.

- 32 ALERT_ONLY sem direção; quatro AUTO com TX via ENV, nenhum com direção persistida.
- AUTO manual: BHNET-3043. AUTO promovidos: BHNET-3044, AGLINK e 73S. Os três continuam sujeitos a `MITIGATION_AUTO_EXECUTION_ENABLED=0`; batch do sweep continua zero. Não houve ampliação.
- Mudança externa em relação à primeira missão: BHNET-3043/3044 agora estão UP/UP. O observador passou de ADMIN_DOWN a STATE_TRANSITION e VALID, sem intervenção desta missão.
- Em 09:15 BRT o observador acumulava 3.475 GETs e três falhas, recuperadas, zero reinícios. Últimos 360 intervalos: p50 10,020 s, p95 10,179 s, máximo 11,459 s. Não confundir essa janela com a janela inicial sem falhas.

## PLAY CONNECT: causa comprovada

Os dois perfis, IPv4/IPv6, apontam para `cmsxk21d003nlssim7pd0ehs4`, `Eth-Trunk1.3024`, ifIndex 151. Ambos ALERT_ONLY, UP/UP, contrato 10 Gbps, capacidade física 300 Gbps. Amostra de 09:13:38.403 BRT: RX **148.026.493,5 bps**, TX **1.188.475.610,6 bps**, idade 62,965 s na consulta. São valores históricos da auditoria.

`autoTrafficDirection=null` no banco e IDs ausentes do ENV. `InterfaceTrafficSource.sampleWithId` verifica a direção e retorna `null` **antes** de consultar `latestTraffic`. O motor registra TELEMETRY_UNAVAILABLE para esse `null`; a UI anterior mostrava somente `decision.trafficBps`, perdendo RX/TX existentes. Portanto é falha de configuração/diagnóstico, não ausência de SNMP. Nenhuma direção foi presumida nem gravada.

Fluxo preservado: perfil → device → interface persistida → ifIndex → última linha atômica de RX/TX → direção persistida ou ENV → seleção do motor → decisão. A direção persistida vence o ENV. Limpar a persistida pode revelar novamente o ENV; a prévia informa isso.

## Implementação

- Novo GET `/api/bgp/mitigation/telemetry`: consulta independente de direção e de autorização, sem discovery ou nova coleta. Uma leitura por interface, compartilhada por IPv4/IPv6, obtém identidade, estado e a última linha mesmo quando inválida. Não busca uma amostra antiga válida para esconder a mais recente inválida.
- Razões específicas: DIRECTION_NOT_CONFIGURED, INTERFACE_NOT_LINKED, INTERFACE_NOT_FOUND, SAMPLE_NOT_FOUND, SAMPLE_STALE, INVALID_SAMPLE, INTERFACE_ADMIN_DOWN, INTERFACE_NOT_UP e COLLECTION_UNAVAILABLE. O último significa erro comprovado na fonte de dados; não afirma falha SNMP quando o banco falha.
- A tela mostra ambos os últimos valores conhecidos, origem da direção, timestamp/idade, estado, modo, bloqueio específico e autorização separada. Dados antigos continuam identificados como antigos. A idade avança mesmo se o refresh falhar; a apresentação da autorização expira.
- Prévia individual/lote em POST `/api/bgp/mitigation/directions/preview`, confirmação em `/directions/apply`, somente ADMIN/OPERATOR. Nenhum executor ou runtime está disponível para esse serviço. A prévia expira em cinco minutos, pertence ao operador e é de uso único.
- Somente ALERT_ONLY/DISABLED podem ter direção alterada por esse fluxo; AUTO é recusado com AUTO_DIRECTION_REQUIRES_SEPARATE_AUTHORIZATION. Uma alteração de direção num AUTO já autorizado poderia liberar ação, por isso exige outra homologação. O PATCH legado não contorna a revisão quando o serviço está configurado.
- Aplicação SERIALIZABLE, com bloqueio por perfil, revisão integral da configuração e auditoria na mesma transação. Promoção concorrente para AUTO ou mudança de configuração invalida o lote inteiro. Falha de auditoria não deixa aplicação parcial.
- Motor AUTO, limiares, triggerSamples=3, autorizações, policies, remoção e origem AUTO foram preservados nesta etapa. O endpoint diagnóstico não entra na porta de atuação.

O ENV operacional aceita idade de 600 s no leitor legado; isso não é garantia de continuidade. As guardas estritas de continuidade de 45 s da Fast Response continuam no candidato. Mostrar o último valor conhecido não torna uma sequência de vários minutos válida para disparar mitigação.

## Verificação

- API completa: 1.854 testes aprovados, zero falhas; oito testes condicionais não ativados nesse comando. Os testes existentes de PostgreSQL/observador foram depois executados explicitamente: dez aprovados, incluindo os sete condicionais. O teste de relógio real permanece registrado na missão Fast Response e será repetido no candidato final integrado.
- Novos testes de telemetria/revisão: 25 aprovados, incluindo quatro com PostgreSQL real isolado. Cobrem direção ausente/RX/TX/persistida/ENV, AF compartilhada, stale/invalid/DOWN/remoção/fonte indisponível, modos, autorização, confirmação, permissões e concorrência.
- Frontend DDoS: **58 aprovados, zero falhas**. Corrigida a espera dos testes antigos para respeitar o timer de notificação do React Query, sem mudar comportamento do produto para acomodar testes.
- Frontend completo: **967 aprovados, uma falha** em `snapshot-view.test.tsx`, fora desta alteração. A mesma falha foi reproduzida na base intacta `fc790ade` (oito aprovados/uma falha no arquivo). Não declarar a suíte global inteiramente verde.
- Builds de API e frontend otimizados e typechecks aprovados.
- Migrations aplicadas somente no PostgreSQL Docker loopback, banco `netvision_ddos_telemetry_test`. Os testes recusam banco remoto/operacional.
- Edge headless: 1440, 768, 390 e 320 px sem overflow da página. Prévia real da UI com backend de fixture local e botão de confirmação bloqueado até aceite. [Medições visuais](benchmarks/ddos-telemetry-visual.json).

Evidências da interface nova em ambiente isolado (valores de referência, sem conexão com produção): [desktop](evidence/ddos-telemetry-1440.png), [tablet](evidence/ddos-telemetry-768.png), [mobile](evidence/ddos-telemetry-390.png), [320 px](evidence/ddos-telemetry-320.png).

## Migration, deploy e rollback preparados

Nova migration `20261023000000_mitigation_direction_audit` cria somente tabela/índice de auditoria. Não atualiza perfis, modos, limiares ou direções. A migration prioritária anterior continua separada. Nenhuma foi aplicada à produção.

Deploy futuro, somente após aprovação: revisar diff e estado operacional atual; preservar bundle/env/config/frontend e snapshot do banco; aplicar migrations aditivas revisadas; publicar API/frontend compatíveis e fazer restart planejado; validar GET de diagnóstico e comparação com interface geral; manter revisão apenas em prévia; pedir autorização específica antes de gravar direções operacionais. Nenhum bulk apply faz parte do deploy.

Rollback: retornar bundles/API/frontend anteriores e reiniciar somente serviços previamente autorizados, mantendo observador independente. Tabela aditiva pode permanecer, preservando auditoria. Não apagar histórico. Se direções forem alteradas em janela futura, reversão exige prévia com valores anteriores e autorização do operador; nunca promover/demover AUTO para contornar bloqueios.

**GO para incorporar esta base à integração isolada. NO-GO para deploy ou configuração operacional sem aprovação.** A falha de snapshot global permanece uma pendência anterior a qualquer release frontend ampla.
