# AGLINK IPv4 — homologação física interrompida no preflight

**30/10/2026 — NO-GO para ACTIVATE físico e para habilitar AUTO. Nenhuma escrita BGP executada.**

Impedimento objetivo: **SEMPRE-DDoS `138.99.240.141` não está Established**. A consulta de resumo mostrou `Active`; a consulta detalhada posterior mostrou `Connect`, com estado anterior `Active`. COMPUTIZE-DDoS está Established, mas isso não comprova prontidão da mitigadora. Exclusividade da janela e prontidão operacional continuam explicitamente não confirmadas pelo operador.

Aplicada a regra da seção 4 da missão: “Se qualquer condição divergir, interromper antes da escrita.” O gate de autorização física da seção 5 não foi alcançado. Não foi solicitado ACTIVATE para contornar o preflight reprovado.

1. **Estado anterior:** equipamento confirmado por leitura como Huawei NetEngine 8000 F1A-8H20Q, VRP 8.220 / `V800R022C00SPC600`, hostname `BHE-VTA-F1A-BGP-01`. Perfil `cmuoavm4e00bysslhqd0h3q7u`; IPv4; `Eth-Trunk1.3058`, ifIndex 236, UP/UP; peer `10.200.201.2`, AS273811, Established, três prefixos recebidos. Policy `PL-AGLINK_IPv4-IN`, com um vínculo no escopo. API preservada em `463769620a2f39f9803b60a43314851fe3a77e0e`; bundle SHA256 `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`.

2. **Autorização física:** não recebida; ACTIVATE não solicitado nem executado. O operador confirmou que acompanhará a homologação e autorizará ACTIVATE/REMOVE separadamente, mantendo exclusividade e prontidão como pendências. A autorização da missão não foi tratada como autorização de escrita.

3. **Comandos utilizados:** somente `display version`, configuração BGP/route-policy/prefix-lists/filtros RT, resumo e detalhe de peers, `received-routes`, `advertised-routes`, detalhes das três rotas BGP e IP, e `display interface Eth-Trunk1.3058`. `screen-length 0 temporary` foi apenas preparação de sessão. Nenhum comando de ACTIVATE/REMOVE foi enviado ao executor ou diretamente ao Huawei. Não houve `system-view`, commit, refresh, soft reset ou hard reset. A lista dos comandos de leitura está nas evidências, sem credenciais.

4. **Nodes:** 1/2 livres; 10/1000 preservados nas leituras. Node 10 continua permit da lista `AGLINK-BLOCO-TODO-23`, LP1100 e `apply extcommunity rt 268568:140 additive`; node 1000 continua deny. BOGONS e lista AGLINK existentes conferidas; nenhuma prefix-list criada. “Depois do ACTIVATE” é **NOT_EXECUTED**.

5. **Prefixos e atributos reais atuais:**

   | Prefixo          | RTs observados         | LP   | Best/select | Próximo salto |
   | ---------------- | ---------------------- | ---- | ----------- | ------------- |
   | 167.250.126.0/23 | 268568:140, 268568:330 | 1100 | Sim         | 10.200.201.2  |
   | 167.250.126.0/24 | 268568:140, 268568:330 | 1100 | Sim         | 10.200.201.2  |
   | 167.250.127.0/24 | 268568:140, 268568:330 | 1100 | Sim         | 10.200.201.2  |

   RT660 exclusivo/LP1100 durante mitigação permanece **resultado esperado, não observado**. Não foi fabricado estado mitigado.

6. **Rotas selecionadas e encaminhamento local:** as consultas BGP e da tabela IP confirmam as três rotas via `10.200.201.2` / `Eth-Trunk1.3058`. Os /24 conservam alternativa de backup pela CIRION, sem substituir a rota AGLINK selecionada. A interface mostrou TX passivo de aproximadamente 443 Mbps na média de 300 segundos, abaixo de 9 Gbps; isso não testa permanência de uma mitigação, pois ela não foi ativada.

7. **Anúncios enviados observados, antes de qualquer mitigação:**

   | Sessão                        | Estado observado | Os três prefixos AGLINK no advertised-routes                  |
   | ----------------------------- | ---------------- | ------------------------------------------------------------- |
   | SEMPRE-DDoS — 138.99.240.141  | Active → Connect | NOT_VERIFIED: sessão não estabelecida e sem tabela utilizável |
   | COMPUTIZE-DDoS — 198.19.4.145 | Established      | Ausentes; tabela completa de 11 rotas interpretada            |
   | SEMPRE — 138.99.240.117       | Established      | Presentes                                                     |
   | SEABORN — 198.18.1.152        | Established      | Presentes                                                     |
   | SEABORN-BH — 198.18.36.26     | Established      | Presentes                                                     |
   | CIRION — 200.194.223.85       | Established      | Presentes                                                     |
   | IP-TUDDO — 172.30.251.33      | Established      | Presentes                                                     |
   | VS-IX — 45.163.144.6          | Established      | Presentes                                                     |

   As oito policies de exportação e suas definições necessárias de prefixos/filtros RT coincidem com a evidência aprovada do plano BGP. Isso preserva a expectativa estática de permitir RT660 nas DDoS e rejeitá-lo nas seis saídas normais; a transição real não foi ensaiada. No VS-IX, a contagem de prefixos foi integral e as três linhas AGLINK foram lidas; os avisos do parser são de AS-PATH não interpretado em outros prefixos, não de ausência das rotas AGLINK. Não foram interpretados como falha ou ausência dessas três rotas.

8. **Recepção e tráfego na mitigadora:** NOT_VERIFIED. Adj-RIB-Out local não comprova recepção pelo provedor nem limpeza/encaminhamento efetivo. Nenhum acesso à RIB do provedor ou recibo operacional da mitigadora foi fornecido. Established da COMPUTIZE não substitui essa confirmação. Não houve ping, ataque ou tráfego artificial.

9. **Journal/ownership e persistência:** 43 migrations concluídas; tabela durável disponível, zero registros antes/depois e zero comando AUTO STARTED. Nenhum comando foi iniciado, portanto não há journal de ACTIVATE ou ownership novo. Não foi criado UNCERTAIN artificialmente. Persistência permanece `1`; lifecycle, execução AUTO, REMOVE AUTO e description permanecem `0`; allowlist de execução de perfis vazia e maxActive=1. Os 39 perfis, configurações, histórico de migrations, eventos, unidades systemd e arquivos de ambiente foram preservados. API/MCP/WEB/Observer responderam 200 e conservaram os mesmos PIDs; PostgreSQL saudável.

   Backup externo anterior de 2,45 GB continua acessível, com SHA256 conferido, chave separada e recuperação da configuração em memória revalidada. A restauração integral já comprovada na etapa anterior foi preservada como evidência. O snapshot integral é anterior à migration 43; adequação/atualização para a futura janela física deve ser revalidada antes de qualquer escrita. Nenhum dump ou restauração produtiva foi executado nesta missão. O caminho de retirada continua sendo o comando manual autenticado existente, após autorização humana, preservando nodes 10/1000; não existe retirada automática neste roteiro.

10. **n8n/Telegram:** instância saudável (health 200), sem restart; activeVersion `6a97fe4a-31ea-49e6-b892-1ac55f85d115`, correspondente ao RC7.1.2 publicado, com 58 nodes. O nome do workflow ainda é legado RC7.1.1, sem alterar a versão publicada conferida. Nenhum evento real MITIGATION_VERIFIED ou mensagem Telegram foi produzido; recebimento e botão REMOVE em uma nova mensagem ficam NOT_TESTED. Lacuna identificada por leitura: o contrato canônico do evento manual e o normalizador publicado não carregam/renderizam uma lista explícita dos três prefixos. A exigência de conferi-los na mensagem não pode ser declarada satisfeita. Nenhuma correção no n8n ou código foi feita.

11. **REMOVE:** não solicitado, não autorizado e não executado. Não houve mitigação de teste a retirar. Nenhuma compensação ou rollback BGP automático foi executado.

12. **Operações não autorizadas:** zero ACTIVATE/REMOVE, refresh/reset, mudanças de policy/peer, alteração de flags/allowlist/perfis, migration, deploy ou restart. Histórico continua ACTIVATE=4, REMOVE=4, SIMULATION=3; logs de entrega de mitigação continuam em 43, sem nova tentativa. Credenciais não foram reveladas e nenhuma credencial n8n foi decifrada ou modificada. Catálogo, WEB, Observer, VNT e Fibinet não foram alterados. A primeira coleta estendida teve erro de interpretação local do retorno SSH agregado e foi descartada como evidência de anúncios; a leitura repetida e aproveitada valida os limites por eco dos comandos e usa o parser existente. Nenhuma ausência de rota foi inferida do resultado inválido.

13. **Decisão e pendências:** NO-GO para o ACTIVATE físico e para habilitar AUTO agora. Antes de retomar: disponibilizar/confirmar a sessão SEMPRE-DDoS conforme o escopo; confirmar janela/exclusividade e prontidão real das mitigadoras; revalidar o preflight e o backup; apresentar novamente o impacto e obter autorização específica de ACTIVATE. Depois, ainda serão necessárias provas reais de RT660/LP1100, anúncios DDoS/bloqueio normal, entrega Telegram e, mediante comando humano separado, REMOVE/readback/reconvergência. A lacuna da lista de prefixos na notificação deve ser tratada sem presumir homologação desse requisito.

[Evidências de leitura consolidadas](docs/evidence/aglink-physical-preflight.json). Leituras concluídas; aguardando orientação e confirmações do operador, sem escrita física.
