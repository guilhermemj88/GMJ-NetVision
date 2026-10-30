# Piloto AGLINK — código, testes e plano curto

Branch `fix/implant-auto-single-pilot`. Base API preparada e conferida:
`0badeba52a5699e08287b7b17e19428f60d1d7b8`. WEB preparada conferida e separada:
`59aecb321adea136cf2a16f0e71488913ad01ce0`. Nenhuma publicação nesta missão.

## Implementação

`FAST TX → três amostras >9 Gbps → serviço ACTIVATE existente → readback → outbox/n8n`.
Tráfego baixo mantém ACTIVE indefinidamente. Somente REMOVE humano autenticado,
com escopo confirmado e readback, libera ownership; cooldown e três amostras novas
precedem outra ativação. AUTO REMOVE não existe.

Somente perfil `cmuoavm4e00bysslhqd0h3q7u`, device
`host-377c554a-8d1e-47c4-baa4-f258693b4d91` / `BHE-VTA-F1A-BGP-01`, interface
`cmsxk21gs03pdssimims9ojlb` / `Eth-Trunk1.3058`, ifIndex 236, TX, banda 10 Gbps,
threshold 90%, três amostras distintas consecutivas. Frescor/intervalo ≤15 s.
Lacuna/reset/perda de telemetria quebra a sequência; restart exige amostras novas.

Reutilizados: `AutoMitigationLifecycle`, `MitigationCommandService.execute`, executor
Huawei, parsers, M8, locks globais/de policy, journal, outbox, auth, confirmação de
escopo e REMOVE manual. O runtime existente chama `tickPilot` com lifecycle ligado;
sweep/promotor e runtime SHADOW ficam parados nesse caminho. SHADOW/ENFORCE indica
fonte de observação, nunca autorização. Boot reidrata snapshots sem criar perfis.
Após REMOVE, atualiza snapshot sem criar perfil. Nenhum driver/worker/fila adicional.

Estados operacionais: IDLE, ACTIVATING, ACTIVE, UNCERTAIN. Rótulos internos legados
de journal/cooldown/entrega permanecem, sem migration para renomeá-los. Registro
durável precede SSH. Readback parcial/timeout: UNCERTAIN, bloqueio e alerta; nunca
undo automático. Runtime NORMAL não prova ausência física. Restart relê Huawei;
operação interrompida fica retida. Não adota nodes manuais.

## Plano físico confirmado somente por leitura

Leitura Huawei em 30/10/2026 13:25:57 UTC; evidência sanitizada em
`evidence/single-pilot.json`. Não houve escrita.

| Item               | Configuração observada                                |
| ------------------ | ----------------------------------------------------- |
| Interface          | UP/UP; alias `AGLINK-IPV4_10GB`; description genérica |
| Import IPv4        | Único peer `10.200.201.2`, policy `PL-AGLINK_IPv4-IN` |
| Node 10            | permit, `AGLINK-BLOCO-TODO-23`, RT `268568:140`       |
| Prefixo do cliente | `167.250.126.0/23`, ge 23 le 24                       |
| Node 1000          | deny, sem prefix-list/RT adicionais                   |
| Nodes 1 e 2        | Livres; permanecem sem criação nesta missão           |
| Prefix-lists       | BOGONS existente; PREFIX8to24 `0.0.0.0 8 ge 8 le 24`  |
| FAST inicial       | VALID, intervalo 9.993 ms, idade 2,876 s              |

São dois nodes **na mesma policy**: deny 1/BOGONS e permit 2/PREFIX8to24 com
RT `268568:660 additive`; nodes 10/1000 são preservados. Sob o lock existente,
antes da escrita, relê BGP/policy/prefix-lists e recusa divergência desse plano
dedicado. Revalida frescor após preflight. Isso não homologa efeitos BGP físicos futuros.

## Testes e pacote

| Verificação                                                       | Resultado                                  |
| ----------------------------------------------------------------- | ------------------------------------------ |
| Suíte API, incluindo regressões manuais IPv4/IPv6, M8, escopo/n8n | 2.619 aprovados; 33 ignorados; zero falhas |
| Integração nova                                                   | 23 aprovados, incluídos no total           |
| PostgreSQL real novo                                              | 2 aprovados, incluídos no total            |
| Typecheck, ESLint alterados, Prettier, build API                  | Aprovados                                  |

Cenário 8 → 9,2 → 9,3 → 9,4: uma escrita pelo serviço real, texto VRP simulado
verificado pelo parser; HTTP local com ACK/retry/eventId estável; 1 Gbps mantém
ACTIVE; restart não duplica; REMOVE passa pela rota humana autenticada.
Cobertos: stale/reset/lacuna/duplicidade/ausência, M8/allowlist, shared policy inclusive
no BGP físico simulado, família/binding, nodes ocupados, RT errado, parcial,
timeout após escrita, concorrência, cooldown e novo episódio.
PostgreSQL reabre cliente/coordenador e preserva ownership/outbox; restart entre
escrita e confirmação vira UNCERTAIN sem repetição/undo.

Reprodução: gerar Prisma, `npm run build -w @gmj/api`, typecheck, ESLint, Vitest.
Build deve preceder a suíte: a primeira execução falhou por ausência do bundle do
Observer; após build, passou. Para os dois testes PostgreSQL, aplicar a migration
existente `20261029090000_auto_lifecycle_durable` em banco descartável vazio;
`SINGLE_PILOT_TEST_DATABASE_URL` aceita somente `127.0.0.1:55077/single_pilot_test`.
Os 33 testes históricos opcionais ignorados não são declarados executados.
Huawei é fake no transporte; receptor n8n é HTTP local; não houve Telegram real.
Entrega HTTP é ao menos uma vez: ACK perdido pode duplicar aviso com mesmo eventId,
sem repetir ACTIVATE. Nenhum mock é apresentado como homologação física.

`scripts/single-pilot-package/build.ps1 -Output <diretório-novo>` exige árvore limpa
commitada e Docker. Imagem Linux fixa, npm ci, dois builds comparados, Prisma Linux,
catálogo físico e dependências de produção; sem WEB/MCP/Observer/worker bundles ou
configurações. Tar/gzip normalizado e comparado duas vezes. Manifesto externo contém
source SHA, hashes/bytes de cada arquivo, contagem e versões efetivas, inclusive apt;
não se promete reproduzir versões futuras do apt. Hashes finais acompanham a entrega.

Fonte exata do pacote: `31b761423d58cec90eadf593e64e29b133a4e86b`
(código `97976bb77c477a44800cd474ac908f5740f9dafd` + correção do empacotador PowerShell).
SHA256 tar.gz: `55bf94326a94d1fa64cbe87a00adc10cb7d8f3965928d11475ddfd1ff653c1fa`.
SHA256 server.cjs: `92ce503fee9da597e9d63516a01dcd6ac32dc8b20dab6be91bfad098370ea337`.
10.070 arquivos, 300.448.052 bytes; arquivo comprimido 95.257.357 bytes.
Todos os hashes internos foram conferidos. Manifesto completo e pacote em
`C:/projetos/artifacts/netvision-single-pilot-31b7614/`.
Smoke Linux em rede Docker interna, sem rota produtiva: Prisma Linux consultou
PostgreSQL descartável e API DEMO respondeu health/lifecycle 200, todas as flags
de execução/lifecycle/persistência/REMOVE desligadas. Exige runtime OpenSSL 3;
imagem slim sem OpenSSL falhou e não foi aceita. IMPLANTAR já possui OpenSSL 3.5.5.
O commit posterior de evidências não altera o código desse pacote.

Produção antes/depois (13:10:45–13:35:21 UTC): API PID 3418797, WEB 2976909,
MCP 3418799 e Observer 2594846 preservados, sem mudança de restarts, hashes,
drop-ins/env, flags ou migrations. Health/API, WEB e MCP 200; API e78638a,
demo=false, snmpPolling=true; 39 configurações de perfis e eventos ACTIVATE/REMOVE
inalterados. Apenas telemetria/runtime naturalmente atualizados pelos serviços.
Tabela durável continua ausente; AUTO continua 0. WEB BUILD_ID
`NSfXEDCQk4S1AmACLROnj` preservado. Espaço livre 6,63 GB; backup integral de banco
deve usar destino externo, sem tentar ocupá-lo nesse volume.

## Homologação física futura — requer autorização

1. Aprovar SHA/hash; reservar janela **API e MCP**, pois systemd propaga restart.
   Registrar PIDs/saúde, drop-ins ordenados, flags efetivas, WEB BUILD_ID, banco e
   nodes. Reservar exclusividade da policy; não há prova de exclusividade externa hoje.
2. Publicar em release nova com EXECUTION=0, LIFECYCLE=0, PERSISTENCE=0, REMOVE=0,
   DESCRIPTION=0 e allowlist de execução vazia. Preservar WEB/coleta/n8n; conferir
   saúde, auth, catálogo e ausência de comandos. Nada disso foi executado agora.
3. Antes de AUTO real: autorizar backup e aplicar somente a migration durável existente,
   conferindo schema/checksum/histórico Prisma; não aplicar outras pendentes cegamente.
   Preparar PERSISTENCE=1, LIFECYCLE=1, EXECUTION=0, MODE=AUTO, MAX_ACTIVE=1,
   REMOVE=0, DESCRIPTION=0 e allowlists exatamente do perfil/device acima.
   Conferir reconciliação e nenhuma criação de perfil. Não há migration nova no patch.
4. Com aprovação explícita do piloto, habilitar M8 só para AGLINK. Conferir TX/banda,
   FAST ≤15 s e duração do preflight compatível com frescor; o código rejeita vencimento.
   Conferir nodes/RT por readback, botão RC7.1.2, permanência com tráfego baixo e
   REMOVE humano verificado. Não gerar ataques nem expandir allowlist nesta janela.

Parar por identidade/hash/nodes/RT divergentes, stale, writer concorrente, perda de
persistência/lock, timeout/parcial ou escrita repetida. Desarmar M8; conservar
mitigação/evidência; intervenção humana para UNCERTAIN.

Rollback autorizado: EXECUTION=0, LIFECYCLE=0, REMOVE=0, sweep=0 e allowlist vazia;
preservar banco/journal/outbox e **todos os nodes físicos**. Restaurar bundle e
drop-ins anteriores conferidos, em janela API/MCP; verificar flags/saúde/ausência
de comandos e WEB intacta. Não executar REMOVE, apagar tabela ou restaurar banco
inteiro. Downgrade RC13 exige proteção independente, como LIVE_WRITE=false e workers
AUTO parados, com impacto manual aprovado: M8=0 da RC13 não basta.

**GO código/pacote; NO-GO para armar agora.** Bloqueantes reais: autorização da janela
e do piloto, persistência migrada, exclusividade, publicação API/MCP e homologação
física/Telegram. Não é necessária fonte de recuperação: retirada é exclusivamente humana.
