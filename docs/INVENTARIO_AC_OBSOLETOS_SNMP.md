# Inventário separado: ACs possivelmente obsoletos na persistência SNMP

Achado **independente** do diagnóstico VSI/MCP · registrado em 2026-11-09 · **somente leitura**: nada foi corrigido, removido ou alterado no banco produtivo.

## Achado
Na extração read-only do banco (S6750 BHE-VTA-S6750-MPLS-01): **159 linhas de `MplsAc` com `lastSeenAt` anterior a 2026-11-01, distribuídas em 157 VSIs** (hoje a coleta atualiza `lastSeenAt` de ACs vivos; essas linhas não são mais tocadas). Caso confirmado no equipamento: `Vlanif3064` consta como AC da VSI `3066-BGP-FLASHTELECOM` (última leitura 2026-09-15 07:43) mas o switch lista apenas `Vlanif3066`, e `Vlanif3064` faz `l2 binding vsi 3064-PONTUALNET-IP-BHE-MQT`.

Classificação: **possivelmente obsoletos** — só 1 dos 159 foi confirmado no equipamento. Para os demais é hipótese baseada em `lastSeenAt`.

## Investigação read-only da lógica de reconciliação (código, sem executar nada)
Arquivo: `apps/api/src/infrastructure/mpls/prisma-mpls-repository.ts` (persistência da coleta SNMP).

- Chave natural do AC: `@@unique([hostId, vsiName, ifIndex])` (`prisma/schema.prisma`, modelo `MplsAc`).
- Gravação (linhas ~311–356): **somente `upsert`** por AC observado na coleta; `update` atualiza `lastSeenAt`, `status`, `interfaceId`. Não há `delete`, `deleteMany`, marcação de "removido/stale" nem comparação "o que existe no banco × o que a coleta devolveu" para ACs. (`grep` em todo `apps/api/src`: nenhum `mplsAc.delete`/`updateMany`; a única remoção possível é a cascata de FK quando o `Device` ou a `MplsVsi` é apagado.)
- Leitura (linha ~526): `acs: { include: acInclude, orderBy: { ifIndex: 'asc' } }` — devolve **todas** as linhas da VSI, sem filtrar por `lastSeenAt`.
- Consequência: um AC que saiu da VSI (interface movida para outra VSI, reconfigurada ou removida) permanece para sempre como linha antiga e é exibido como se fosse atual. A mesma política de apenas-upsert vale a verificar para PWs (`mplsPw.upsert`, linha ~377): **não examinado em profundidade**.
- O diagnóstico VSI/MCP já neutraliza o efeito localmente: `PERSISTED_AC_OBSOLETE` (confirmado pela config do equipamento) e `PERSISTED_AC_NOT_IN_LIVE_VSI` (hipótese); a causa-raiz na coleta não é tratada aqui.

## Hipóteses a validar (não provadas)
1. A coleta SNMP nunca retira ACs ausentes (confirmado pelo código; falta confirmar contra um ciclo real de coleta com um AC removido).
2. Parte dos 159 pode ser legítima (VSI desativada com ACs administrativamente down e fora da tabela SNMP) — exige comparação com o equipamento.
3. Impacto em UI/alertas: não medido (quem consome `acs` sem filtrar `lastSeenAt`).

## Etapa independente sugerida (não iniciada, exige decisão e autorização próprias)
1. Medir, read-only, a distribuição de `lastSeenAt` por host/VSI e quais consumidores leem `MplsAc`.
2. Desenhar reconciliação segura: marcar `staleSince` (ou excluir da leitura por janela de `lastSeenAt` baseada no intervalo de coleta) **antes** de qualquer remoção física; coleta incompleta/parcial não pode marcar stale.
3. Teste de regressão com ciclo de coleta onde um AC some, e migração aditiva reversível — fora desta branch.
