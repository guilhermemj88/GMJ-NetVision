# Homologação independente RC14-F

Escopo atual IMPLANTAR: [AUTO ACTIVATE + REMOVE manual](AUTO_ACTIVATE_MANUAL_REMOVE_HOMOLOGATION.md). A matriz M8 abaixo continua aplicável com a barreira adicional: REMOVE AUTO é proibido mesmo com M8 ligado e é recusado antes do preflight. Os resultados RC14-F abaixo são históricos; a verificação atual consta no relatório da nova branch.

Este documento estava ausente no SHA original `e1a00e6`. A documentação existente
era `DDOS_DETECTION_ALERTS_RC14F.md`. O parecer e os hashes finais estão nas
evidências `.artifacts/rc14f-codex/RELATORIO-RC14F-CODEX-AUDITORIA-FINAL.md`.

## Segurança de escrita

Testes independentes passam pelo MitigationCommandService e pelo executor Huawei
real, com uma porta SSH inteiramente em memória. ACTIVATE e REMOVE manuais IPv4
e IPv6 são executados até readback verificado, sem local-preference 3000. Policy
compartilhada exige confirmação e sincroniza os runtimes irmãos. Nenhum teste
contém cliente SSH conectado a equipamento real.

A matriz verifica as três marcas AUTO (origin, prefixo auto-activate- e autoEvidence),
duas ações, duas famílias e dependência desligada/ausente/que lança. Também verifica
rechecagem após preflight e as oito combinações sweep/legacy/allowlist do motor.
O mesmo teste na RC13 comprova o escape de AUTO manual com M8=0 e as barreiras
independentes de MODE e LIVE_WRITE para o rollback. Os casos M8 novos não são
aplicados à RC13 como se aquela versão já tivesse o conserto.

## n8n dinâmico isolado

Foi utilizada a imagem local n8n **2.45.4**, numa rede Docker interna sem rota
para produção. As chamadas HTTP foram feitas no loopback do próprio contêiner.
Não foram usados token, bot ou chat de produção. O workflow de teste preserva
os nós originais de webhook Header Auth, normalização, condições e resposta do
JSON RC7.1.1 de compatibilidade. Só os dois sinks Telegram foram substituídos por
Code nodes de teste; os outros ramos não foram importados.

| Caso                                | Resultado observado                |
| ----------------------------------- | ---------------------------------- |
| Sem header                          | 403, rejeitado                     |
| Header incorreto                    | 403, rejeitado                     |
| MITIGATION_DETECTION_BLOCKED válido | 200, routed=true, delivered=true   |
| Falha simulada do sink Telegram     | 500, sem ACK positivo              |
| Evento desconhecido                 | 200, routed=false, delivered=false |

Também foi executado o motor real → publisher real → transporte HTTP real →
workflow n8n real isolado → sink fake → ACK: 24 amostras reais arquivadas abaixo
do limiar não geraram alerta; 18 amostras sintéticas **somente em memória**
exercitaram o controle positivo. O primeiro envio recebeu 403, o retry recebeu
200/delivered=true com os mesmos eventId/episodeId. Escritas Huawei: zero.

Isso valida o contrato do JSON auditado e o mecanismo do n8n local. Não comprova
a versão/configuração/credencial efetivamente publicada no n8n de produção nem
a entrega Telegram real. Os testes de callback existentes preservam as referências
das três credenciais de retorno, mas os callbacks não foram executados contra produção.

## Segredos e canais

A produção resolve BGP_MITIGATION pelo banco, cujo endpoint tem path
`/webhook/netvision-mitigation`. O segredo outbound foi verificado como decifrável,
distinto do inbound e selecionado para `X-NetVision-Token`, sem imprimir valores.
O token legado ENV não está configurado. A comparação com o valor Header Auth
do n8n de produção não foi feita. Não confundir esse valor com Authorization/Bearer
dos comandos de retorno. Nenhuma credencial foi trocada ou exportada em texto claro.

## Episódios e limites de entrega

Amostras duplicadas, stale ou ausentes não encerram episódio. Threshold é bps e
comparação estrita `>`; Gbps/Mbps são apenas apresentação. A direção não é inferida
do nome do peer. O evento de detecção é simulation=true e verified=false e segue
um ramo sem botões de retirada.

A auditoria reproduziu uma perda após recuperação e a corrigiu: entregas pendentes
continuam separadas da detecção, inclusive sem telemetria nova. Testes verificam
ID estável, recuperação, nova crise, teto de retry, rate limit e retorno de entrega.
A fila e o rate limit continuam em memória: restart pode perder pendência e
duplicar alerta; o timeout após entrega pode produzir duplicação. Falhas terminais
e expiração precisam de monitoramento. Não há garantia durável at-least-once.

## Publicação e rollback

Usar [o plano corrigido](RC14F_CODEX_DEPLOY_ROLLBACK.md). Não publicar a partir do
roteiro original de rollback apenas com M8. Não houve deploy, restart, migration,
comando Huawei ou modificação de métricas reais nesta homologação.
