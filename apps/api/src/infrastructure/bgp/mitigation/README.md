# Discovery e segurança de inicialização

O boot utiliza `SNAPSHOT_ONLY`: analisa peers persistidos e a configuração lida, sem mutadores do repositório. Se peers persistidos não existirem, falha de forma explícita; não cai no discovery BGP que grava associações. O operador continua podendo solicitar discovery/cadastro por seu fluxo autenticado existente.

`RECONCILE_EXISTING` não cria identidades. `REGISTER_NEW` cadastra ALERT_ONLY e informa revisão pendente. Nenhum desses caminhos altera allowlists ou promove AUTO. Identidade é device + interface + família + policy, não apenas policy. Observações iguais não chamam upsert do perfil; configurações administradas ficam preservadas. Reconciliação de runtime usa comparação condicional com o estado, versão e par lidos, para não sobrescrever um comando concorrente.

Estado NORMAL não comprova ausência física. DISABLED não é reativado pelo discovery. Snapshot perdido/divergente revoga prontidão sem alterar configuração persistida.

Ver [plano de estabilização](../../../../../../docs/PHASE01_STABILIZATION.md) e testes de discovery, reidratação e PostgreSQL da Fase 0.1.
