# Fast Response — integração definitiva candidata / Gate 2

**Implementação e homologação isolada concluídas. Produção permanece no motor anterior e observador independente. Aguardando autorização para deploy. Nenhuma execução real nova está autorizada.**

## Versões, compatibilidade e escopo

- API operacional: `fc790ade3455f2c16eeff372a8a9168deffb0d7d`, PID 2165618, SHA-256 `ba2731fdee415fc7b9446efaf71727432ed019e110e7a49c77f118b5c732e469`.
- Frontend operacional: `bc559bec5d45080228c513db146c987c71c19633`, PID 2235940.
- Observador operacional: `69b375f221b61c022ef446560fb357adb6bc108c`, PID 2243027, OBSERVE, sem executor.
- Fast Response anterior: `44ca717`. Telemetry Recovery encerrada em `3732a1d555d20ce9a7e5bb776a204ec55f005160`; [relatório e inventário dos 36 perfis](DDOS_TELEMETRY_RECOVERY.md).
- Integração: `999ab903b6d4a3c4e25f1ccb542fbccc7422f295`; leitura seletiva do SHADOW: `e983ad9b7c68c50a20921cf6bd8a8e5ce8ae91a7`.
- Candidato unificado de código: **`accd265198f98f2f0e4a41b0a8cc1438c88a3650`**, branch `feature/ddos-fast-integration`, release **`v2026.10.18-ddos-fast-bridge-rc1`**.
- RC2 de compatibilidade: branch `fix/ddos-fast-bridge-legacy-compat`, release **`v2026.10.18-ddos-fast-bridge-rc2`** (seção “RC2 — correção de compatibilidade LEGACY”).

O frontend exigiu alinhamento explícito: sua versão publicada contém mapa V2 e identidade da instalação ausentes na base da API. As mudanças DDoS foram aplicadas primeiro numa worktree sobre o frontend publicado, commit `e667a0aebed0e59484f55e97d0000c346d762c85`, e incorporadas ao candidato unificado em `c9a2e3f6f66bd5d4a8e2e64055f6caa09d72d59f`. Naquele commit, os diretórios `apps/web` e `packages/shared` eram idênticos aos da worktree web; o commit final acrescenta somente a indicação DDoS de execução em andamento e seu teste. CSS global, mapa e identidade publicados foram preservados. Foi corrigida a tipagem do argumento opcional `flag=undefined`, sem mudar sua regra de execução. Não foram incorporadas alterações de backend de preview pertencentes à branch do frontend. [Manifesto dos arquivos e bases de comparação](benchmarks/ddos-fast-bridge-files.json).

A worktree original com alterações de DCIM, a Fast Response e as outras worktrees permaneceram preservadas. Nenhum agente paralelo foi utilizado. Nenhum arquivo/configuração da FIBINET foi alterado. Os commits são locais, sem push ou merge em branch de produção.

## RC2 — correção de compatibilidade LEGACY (`v2026.10.18-ddos-fast-bridge-rc2`)

Branch `fix/ddos-fast-bridge-legacy-compat`, base `accd265` (`v2026.10.18-ddos-fast-bridge-rc1`). **Sem deploy, sem restart, sem migration, sem comando Huawei.**

### Causa raiz, por arquivo e função

| Arquivo | Ponto exato | Defeito |
|---|---|---|
| `apps/api/src/worker/mitigation/mitigation-auto-engine.ts` | `evaluateOnce` → `const maxAgeMs = this.deps.sampling?.maxAgeMs ?? 45_000` (rc1 L650-651) | Fallback global de 45 s aplicado a qualquer fonte |
| idem | `countDistinctSample` (rc1 L335) | `sampleMs - lastSampleAtMs > maxGapMs ⇒ resetSequence` — lacuna LEGACY de 126–248 s zerava `over` |
| idem | `evaluateOnce` (rc1 L351/L883) | `bps >= trigger` e `traffic < threshold`: semântica de limiar alterada |
| `apps/api/src/routes.ts` | `new MitigationAutoEngine({…})` (rc1 L1131) | Motor **operacional** criado sem `sampling`; só o SHADOW recebia as janelas FAST |
| `apps/api/src/infrastructure/bgp/mitigation/prisma-fast-shadow-runtime.ts` | `get()` | SHADOW lia o runtime **operacional** ⇒ `ALREADY_MITIGATED` e nunca `WOULD_ACTIVATE` |

A versão publicada (`fc790ade…`, copiada congelada em `apps/api/src/worker/mitigation/legacy-auto-engine.fc790ad.ts`) **não tem** verificação de idade/lacuna no motor, **não tem** `DUPLICATE_SAMPLE`, **não tem** cooldown e usa `requestId = auto-activate-<profile>-<triggerStartedAt>`.

### Contratos temporais

| Fonte | Frescor (`maxAgeMs`) | Continuidade (`maxGapMs`) | Gate de duplicidade | Cooldown |
|---|---|---|---|---|
| **LEGACY** | 600 s (`MITIGATION_AUTO_TRAFFIC_MAX_AGE_SECONDS`), na fonte e revalidado no motor | **`null` — não existe** | nenhum (reemite o MESMO `requestId`, deduplicado pelo comando canônico) | **nenhum** |
| **FAST** (ENFORCE roteado) | 30 s | 45 s (reset de sequência) | `DUPLICATE_SAMPLE` fora da janela de retry | 30 s após sucesso; backoff 15/30/60/120 s após falha |

`sampling` passou a ser **obrigatório** no construtor (`MITIGATION_AUTO_SAMPLING_REQUIRED`): não existe mais default silencioso. `samplingWindowForProfile` devolve a janela da fonte **realmente roteada** — bridge em SHADOW mantém LEGACY.

### Diferenças deliberadas em relação ao publicado (todas testadas)

1. **Retry limitado da mesma amostra (FAST)**: após falha transitória (`POLICY_BUSY`, `PREFLIGHT_FAILED`, `ACTIVATE_FAILED`, `VERIFY_FAILED`), a mesma amostra é reavaliada sem reconta­gem, com o **mesmo `requestId`** (idempotente no `MitigationCommandService`), no máximo `maxRetriesPerSample = 2` e apenas enquanto a evidência estiver dentro da janela.
2. **Cooldown/backoff somente FAST**, medido no **fim** da execução: falha transitória não consome a janela de 30 s de sucesso.
3. **Restart**: a identidade da amostra persistida é sempre reidratada; confirmações LEGACY sobrevivem apenas com evidência fresca e no máximo `triggerSamples - 1` (exige ao menos uma confirmação nova). FAST nunca reidrata.

### Correções adicionais

- **SHADOW isolado**: `PrismaFastShadowRuntime.get` lê **somente** `MitigationFastShadowState`; decisões passam a expor `evaluationScope`, `physicalState`, `physicalMitigated` e `operationalBlock` separadamente. `operationalState()` reporta o estado físico real.
- **Leitura de runtime por fonte**: `requireRuntimeRead` virou regra por target; só FAST exige. LEGACY não ganhou dependência nova com `bridge.mode=SHADOW`.
- **Chave `sampling` duplicada** removida do objeto do SHADOW (L1189/L1220 do rascunho).
- **Limiar**: `>` restaurado na contagem e `<=` na saída; `revalidateAutoEvidence` usa `>`.
- **`requestId`**: LEGACY preserva o formato publicado; FAST acrescenta o hash da amostra.

### Achados: DeepSeek × Codex × código

| Achado | DeepSeek | Código/RC2 |
|---|---|---|
| 45 s global afetando LEGACY | confirmado | **CONFIRMADO** (fallback + motor sem `sampling`) |
| Contagem de confirmações zerada | confirmado | **CONFIRMADO** (reset por lacuna) |
| AUTO promovido bloqueado indevidamente | não reproduzido | **CONFIRMADO como inexistente**: `autoPromotedBySweep` correto; golden cobre promovido e manual |
| Cooldown antes do preflight | inferido | **CONFIRMADO** no rc1; corrigido só no FAST |
| SHADOW lendo runtime operacional | confirmado | **CONFIRMADO**; corrigido com estado próprio |
| Mudança de limiar `>`→`>=` | confirmado | **CONFIRMADO**; revertido |

### Testes

- `mitigation-sampling-policy.test.ts` — contrato das janelas (SHADOW não muda a fonte operacional, 599/600/601 s, FAST 30/45 s, `matchesAutoEvidence`).
- `mitigation-golden-decisions.test.ts` — **20 cenários GOLDEN** comparando o motor congelado `fc790ad` com a RC2 nas mesmas amostras: 126 s, 248 s, frescor 599/600/601 s, lacuna de 601 s, amostra repetida, stale, restart, limiar, promovido/manual, ALERT_ONLY, MITIGATED, policy compartilhada, gates de elegibilidade, autorizações de escrita, `ACTIVATED_NOT_VERIFIED` e evidência.
- `mitigation-rc2-fast-contracts.test.ts` — 16 testes dos contratos novos (duplicidade, retry, backoff, SHADOW, leitura de runtime por fonte, promovido).
- Suíte completa da API: **1.935 aprovados, 19 ignorados, zero falhas** (eram 1.905 no rc1); typecheck e lint dos arquivos alterados limpos.

### Riscos restantes

| Risco | Severidade | Observação |
|---|---|---|
| `requestId` LEGACY sem hash depende da deduplicação em memória do comando | baixa | mesmo comportamento publicado; o lock por policy continua serializando |
| Backoff/retry FAST não persistido entre processos | baixa | restart reinicia a contagem e exige amostra nova |
| SHADOW não mede tempo de SSH real | média | prova decisão, não aplicação Huawei |
| SLA ≤60 s continua não homologado | — | depende de Gate 3 autorizado |

## Arquitetura final

```text
OBSERVADOR EXISTENTE (OBSERVE, sem SSH/executor)
  SNMP GET → baseline privado → netvision_fast_observe
                       ↓ SELECT por role própria somente leitura
API: health do observador + inventário atual + par HC + qualidade/frescor
  → FastObservationSource (identidade FAST, geração, direção e revisão)
  → SHADOW: avaliador SIMULATION_ONLY, estado próprio, sem executor
  → ENFORCE explicitamente selecionado: motor AUTO canônico
       → 3 amostras válidas → autorizações existentes → lock da policy
       → preflight → revalidação de evidência/configuração → Huawei existente
       → readback estrito → evento/runtime canônico + auditoria FAST
```

Não há novo executor Huawei, credencial SSH no observador ou nova coleta para resolver direção ausente. A API não escreve no banco observacional. O coletor continua sendo o único dono do baseline HC; polling geral nunca o modifica.

`MITIGATION_FAST_BRIDGE_MODE` nasce OFF. SHADOW tem estado em `MitigationFastShadowState`, auditoria em `MitigationFastDecision` e uma porta de comando que rejeita qualquer execução. Não escreve `BgpMitigationRuntime`, perfil ou Huawei. O AUTO LEGACY existente continua com suas autorizações anteriores; SHADOW não desliga nem amplia essa autorização.

ENFORCE exige simultaneamente modo explícito, `MITIGATION_FAST_BRIDGE_WRITES_ENABLED=true` e `MITIGATION_FAST_ENFORCE_PROFILE_IDS` não vazio, contido no escopo observado. Isso não substitui modo AUTO, allowlist de device, executor, live-write, provenance, exclusões, família, policy compartilhada ou preflight. RX pode ser observado; no novo caminho prioritário, a atuação BGP é limitada a TX. A remoção continua manual.

O modo de coleta na API precisa permanecer OFF quando se usa o observador externo. Configuração que tente iniciar ambos é rejeitada. Uma única avaliação AUTO escritora roda por vez entre processos, usando advisory lock PostgreSQL. UI, n8n e AUTO usam o mesmo lock distribuído por device/policy e o mesmo comando canônico. Processos antigos precisam ser parados antes de iniciar a nova API; o rollout não admite sobreposição de versões escritoras.

## Contrato, continuidade e fallback

Cada avaliação verifica device, interface, ifIndex e ifName atuais, UP/UP, direção explícita, timestamp/identidade, geração e revisão da configuração. Lê as duas últimas observações e recalcula RX/TX a partir dos HC counters de 64 bits, com limites unsigned, uptime/descontinuidade/estado e capacidade física. Taxa persistida, intervalo e par anterior precisam coincidir. Não seleciona uma amostra antiga válida para ocultar uma última inválida.

O health vivo precisa confirmar OBSERVE, sem executor, qualidade VALID e o mesmo timestamp do banco. HTTP tem timeout de 800 ms e aceita somente `http://127.0.0.1/.../health`, sem redirects, credenciais ou query string. Banco observacional exige `transaction_read_only=on`; timeout transacional de leitura 1,5 s e leitura vinculada ao inventário em até 3 s. URL preparada limita pool a duas conexões e conexão/espera a dois segundos.

Frescor FAST máximo **30 s**, intervalo/continuidade máximo **45 s**. Falha não vira zero. Uma taxa zero só é aceita quando comprovada por contadores válidos. Amostras repetidas e regressões temporais não aumentam confirmações. Geração nova, lacuna ou configuração alterada zeram a suspeita. Reinício da API zera contagens não comprovadas e conserva a identidade consumida persistida; reinício do observador exige novo baseline/par.

**Fallback automático: nenhum.** Perfil ENFORCE selecionado com FAST indisponível fica bloqueado; nunca consulta LEGACY como substituto. Perfis fora desse escopo mantêm LEGACY. OFF é uma escolha explícita de configuração/rollback, aplicada com restart autorizado. Não há mistura de fontes na mesma sequência.

Antes de escrever, a evidência é relida após preflight, incluindo direção/revisão, modo, habilitação, provenance, exclusões e tráfego recente ainda acima do limiar. Uma alteração durante a suspeita ou preflight não herda confirmações anteriores. `triggerSamples=3`, limiares, direções autorizadas e autorizações existentes foram preservados.

## Estado operacional auditado e validação real sem escrita

Às 09:14 BRT foram auditados 36 perfis: 32 ALERT_ONLY sem direção e quatro AUTO com TX via ENV. BHNET-3043 é manual; BHNET-3044, AGLINK e 73S são promovidos e continuam sujeitos a `MITIGATION_AUTO_EXECUTION_ENABLED=0`. Batch de promoção continua zero. Nenhum perfil foi promovido/configurado nesta missão.

PLAY CONNECT IPv4/IPv6 têm a mesma interface 151 UP/UP e dados RX/TX; faltam direção persistida e fallback ENV. O diagnóstico agora mostra os dois valores independentemente da direção e mantém bloqueio específico de configuração. [Inventário CSV](benchmarks/ddos-telemetry-inventory-20261018.csv).

BHNET-3043/3044 agora estão UP/UP, diferentemente da janela ADMIN_DOWN da missão anterior. Às **10:09:21 BRT / 13:09:21 UTC**, o observador acumulava **3.799 GETs, três falhas recuperadas e zero reinícios**, com ambas as interfaces VALID. Última janela de 360 intervalos: p95 **10,179 s**. Na amostra das 10:09:15.367 BRT: 3043 RX **16,972 Mbps**, TX **203,126 Mbps**; 3044 RX/TX **0**, comprovados por contadores, sem substituição de erro por zero.

Esses dois pares reais foram exportados por SELECT somente leitura e validados localmente pelo consumidor novo: ambos aceitos, mesma identidade, taxas recalculadas e timestamps conferidos. Os timestamps PostgreSQL sem timezone do export foram interpretados explicitamente como UTC, conforme o contrato Prisma. Não foi executado um motor/atuador em produção. [Snapshot bruto mínimo](benchmarks/ddos-fast-bridge-real-snmp-snapshot.json) e [resultado do consumidor](benchmarks/ddos-fast-bridge-real-snapshot-validation.json).

Consulta Huawei somente leitura às **09:42:27 BRT** confirmou:

- Policy `PL-BHNET_IPv4-IN` já contém deny 1/BOGONS, permit 2/PREFIX8to24/RT `268568:660`; node normal 10 conserva RT `268568:140`; deny 100 permanece.
- A mitigação física já estava presente; os runtimes BHNET já constavam MITIGATED no inventário inicial. Não foi aplicada nem removida nesta missão, nem se presume que nodes 1/2 estejam livres.
- BGP: 59 peers, 41 Established. BHNET-3043 Established; 3044 Idle.
- CPU instantânea 17%, um minuto 17%, cinco minutos 15%.
- Três conexões SSH: p50 **870 ms**, p95/máximo **942 ms**. Consulta da policy: p50 **68 ms**, p95/máximo **71 ms**. Zero falhas/timeouts/retries nesse conjunto pequeno.

Essas consultas medem estabelecimento/leitura, não escrita, commit ou preflight completo. Fixture anonimizada do formato real passa pelo verificador canônico; RT divergente ou prefix-list ausente é recusado. [Evidência SSH](benchmarks/ddos-fast-bridge-huawei-readonly.json).

Na checagem final das **10:38:53 BRT / 13:38:53 UTC**, API/frontend/observador mantinham os PIDs originais, API SHA inalterado, 38 migrations, nova role da ponte ausente e zero eventos de mitigação após o início da auditoria. Os 36 registros de perfil foram comparados integralmente: nenhuma diferença. O observador seguia saudável e sem executor, com **3.976 GETs**, as mesmas três falhas acumuladas e zero reinícios. Na janela de 360 intervalos: p50 **10,022 s**, p95 **10,141 s**, máximo **11,151 s**; idade da amostra **4,171 s**. BHNET-3043 RX **462,322 Mbps**, TX **2,261 Gbps**; 3044 RX/TX zero. A contagem de falhas agrega coleta/persistência e não permite atribuir as três somente ao SNMP. [Preservação operacional e health final](benchmarks/ddos-fast-bridge-production-unchanged.json).

## Testes e latência

| Verificação | Resultado |
|---|---|
| API completa com todos os testes PostgreSQL condicionais ativados | **1.905 aprovados, zero falhas**; somente realtime separado |
| Realtime, UDP loopback real + ponte nova + comando canônico/Huawei sintético | **aprovado**, 33,861 s da primeira anormal válida ao readback simulado |
| Frontend sobre a versão publicada, incluindo mapa/identidade | **1.339 aprovados, uma falha anterior de snapshot** |
| Frontend de mitigação, incluindo telas DDoS, diagnóstico/revisão/FAST | **76 aprovados, zero falhas**; 62 nas três telas principais |
| Pacote compartilhado, incluindo identidade | **187 aprovados, zero falhas** |
| Typechecks API/web/shared e lint dos arquivos DDoS alterados | aprovados |
| Build Linux API/web e Prisma OpenSSL 3 | aprovados; manifest do pacote contém resultado do smoke |

A falha restante é `snapshot-view.test.tsx`, caso “usa a MESMA serie do dashboard (mapa + gap temporal)”, já reproduzida na base intacta. O arquivo e seu código não foram alterados por DDoS. Não apresentar a suíte global frontend como totalmente verde. A base antiga antes do alinhamento tinha 970 aprovações e essa mesma falha; o resultado de 1.339 é o relevante para a release final.

Cobertura integrada: PostgreSQL operacional e observacional separados, conta SELECT read-only que recusa DELETE, scheduler/HC/ponte/motor/comando canônico/evento real de banco e hardware sintético; exclusão entre instâncias por policy; auditoria sem duplicação; estado SHADOW sem tocar runtime operacional. Falhas reais de conexão dos dois bancos, HTTP indisponível/redirect/timeout, SNMP timeout/perda/stale/repetição/reordenação/restart/ifIndex/DOWN, múltiplos perfis, IPv4/IPv6, AUTO manual/promovido, ALERT_ONLY/DISABLED, shared-policy, preflight/SSH/readback divergente/parcial, cooldown e atraso acima de 60 s estão cobertos pelo conjunto.

Benchmarks da ponte externa:

| Cenário isolado | p50 | p95 | máximo |
|---|---:|---:|---:|
| Um perfil, relógio virtual | 33,850 s | 33,850 s | 33,850 s |
| Quatro perfis, relógio virtual | 33,850 s | 42,525 s | 42,525 s |
| Um perfil, relógio real | 33,861 s | amostra única | 33,861 s |

No realtime final, a execução completa levou 54,109 s incluindo baseline inicial; os intervalos após suspeita foram 10,228 / 10,255 / 10,248 s. Confirmação 24,840 s; preflight sintético 3,011 s; execução sintética 4,004 s; readback sintético 2,002 s. O benchmark de quatro perfis distribui os perfis por quatro devices sintéticos; não comprova quatro execuções no mesmo NE8000, onde locks e fila podem ampliar o tempo. Amostra→decisão, avaliação, comando, preflight/execução/readback, total e violações de orçamento são instrumentados separadamente. SSH registra conexão/comando/falhas/timeout/retries em buffer limitado, sem comando/credencial no payload.

Não existe medição de aplicação Huawei nova. **O SLA real de 60 s não está homologado nem garantido.** O cenário de readback lento marca explicitamente orçamento excedido. Falha de coleta recupera disponibilidade somente após novo baseline/par íntegro e exige novamente três confirmações; não reutiliza suspeita anterior.

[Benchmarks 1](benchmarks/ddos-fast-bridge-benchmark-1.json), [4](benchmarks/ddos-fast-bridge-benchmark-4.json), [realtime](benchmarks/ddos-fast-bridge-real-clock.json), [resumo de testes](benchmarks/ddos-fast-bridge-tests.json).

## Observabilidade e frontend

GET autenticado `/api/bgp/mitigation/fast-bridge`: modo/escopos, FAST/LEGACY, amostra/qualidade, erro, geração, intervalo, latência de leitura, decisões, runtime SHADOW/AUTO, orçamento, perfis em execução e métricas SSH. `/fast-poller` anterior permanece para o coletor embarcado, que fica OFF nesse rollout. Health do produtor segue em `127.0.0.1:3355`.

A tela preserva diagnóstico de RX/TX do NetVision e mostra o pipeline FAST separadamente: SHADOW/ENFORCE, SUSPECTED/CONFIRMED/MITIGATING/MITIGATED/UNAVAILABLE, contador/limiar, autorização/motivo, execução/readback e total. Após a terceira confirmação, MITIGATING e IN_FLIGHT ficam visíveis enquanto o comando aguarda; MITIGATED exige readback verificado. Valores antigos são identificados mesmo com refresh falhando. Revisão individual/lote tem prévia e confirmação, auditoria transacional e bloqueia alteração de direção AUTO por esse fluxo. Não houve aplicação de direção em produção.

SHADOW usa a mesma cadência de avaliação configurada da API (atualmente 5 s), carregando somente os perfis selecionados. Não faz listagem completa de peers/runtimes a cada segundo. A captura prioritária continua em aproximadamente 10 s, independente da varredura SNMP global.

Evidências visuais isoladas, sem rede de produção: [desktop](evidence/ddos-fast-bridge-1440.png), [mobile](evidence/ddos-fast-bridge-390.png). Testados também 768/320 px sem overflow. PLAY CONNECT usa valores de referência; o painel FAST da imagem é identificado como cenário sintético. Nenhuma tela simulada é apresentada como screenshot operacional do Huawei.

## Migrations e build candidato

Produção tem 38 migrations; candidato tem 41. As três pendentes são aditivas:

1. `20261018020000_mitigation_priority_traffic`: stream prioritário anterior; a ponte externa usa o banco observacional, sem misturar baselines. Tabela operacional mantida para compatibilidade do candidato.
2. `20261023000000_mitigation_direction_audit`: auditoria de revisão de direção.
3. `20261024000000_mitigation_fast_bridge`: estado SHADOW e decisões FAST, com unicidade perfil/modo/amostra.

Nenhuma atualiza perfil, limiar, modo, autorização, runtime antigo ou histórico. Todas foram aplicadas e exercitadas somente no PostgreSQL Docker isolado. A nova role é preparada em [fast-bridge-reader.sql](../deploy/fast-bridge-reader.sql), com alvo de banco verificado, SELECT somente na tabela observacional e default read-only. Não recebeu grants de credenciais, interfaces ou banco operacional.

Build local Linux x64, Node 24.19.0, Prisma 6.19.3, OpenSSL 3; imagem base digest `a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`. [Script reproduzível](../deploy/build-fast-bridge-linux.sh). O empacotamento não contém `.env` operacional, senhas reais ou credenciais exportadas. Binários/API, frontend standalone, migrations e configuração de exemplo são entregues no pacote `.artifacts/linux/netvision-fast-bridge-linux-candidate.tar.gz`; SHA em `.artifacts/linux/SHA256SUMS`, proveniência/smokes em `.artifacts/linux/BUILD.json`. O frontend foi compilado com identidade IMPLANTAR declarada.

Os patches para revisão estão em `.artifacts/review/api-production.diff`, `.artifacts/review/frontend-production.diff` e `.artifacts/review/integration-after-telemetry.diff`. Podem ser reproduzidos com `git diff fc790ade accd265 -- apps/api`, `git diff bc559bec accd265 -- apps/web packages/shared` e `git diff 3732a1d accd265 -- apps/api apps/web/src/components/bgp packages/shared/src/mitigation.ts deploy tools`, respectivamente. São 59 arquivos de API relativos à produção e 12 de frontend/shared relativos ao frontend publicado.

Para recompilar, exportar `accd265` com `git archive` para `candidate-source.tar`, a API-base `fc790ade` para `rollback-api-source.tar`, extrair o primeiro em `/work` do container descartável e montar os arquivos em `/source` somente leitura e a saída em `/out`. Executar o script com `RELEASE_COMMIT=accd265198f98f2f0e4a41b0a8cc1438c88a3650` e `LINUX_SMOKE_DATABASE_URL` apontando exclusivamente ao PostgreSQL de testes isolados, com as 41 migrations já aplicadas. O empacotamento final acrescenta o dossiê de evidências, registra separadamente o commit de código e o commit documental e calcula SHA-256. Nenhum comando desse processo usa a instalação de produção.

## Gate 2 — plano exato, ainda NÃO executado

Proposta inicial: **API integrada em SHADOW, dois perfis BHNET somente**, sem tocar o observador. Atualizar frontend é etapa separável; sua falha preexistente precisa ser tratada ou aceita explicitamente antes de um rollout frontend amplo.

1. Confirmar novamente hashes/PIDs, health, sessões BGP, estado físico da policy, os 36 perfis, flags e fila de operações. Não iniciar janela com comando Huawei em andamento. Registrar backup do bundle real da API, unidade/drop-ins, ENV com permissões preservadas e dump consistente do banco; backup frontend se essa parte for autorizada. Não imprimir segredos.
2. Verificar SHA/proveniência do artefato; extrair em `/opt/netvision-fast-bridge/releases/<release>`, sem sobrescrever as árvores atuais. Revisar diff API relativo a `fc790ade` e frontend relativo a `bc559bec`.
3. Aplicar somente as três migrations revisadas no banco operacional e provisionar a role SELECT no banco observacional. Verificar read-only com a nova conexão, SELECT permitido e escrita recusada. Nunca reutilizar credencial escritora do observador na API.
4. Preparar ambiente da API com [fast-bridge.shadow.env.example](../deploy/fast-bridge.shadow.env.example), credencial nova protegida em arquivo 0600 e **todos os flags operacionais atuais preservados**. Coletor embarcado OFF; bridge SHADOW; scope só 3043/3044; writes FAST false; allowlist ENFORCE vazia. Não promover perfis, editar direções, remover mitigações ou alterar equipamento.
5. Parar a API anterior, alterar somente o caminho autorizado de ExecStart/WorkingDirectory para o novo runtime, daemon-reload e iniciar **uma** instância `netvision-api`. Isso é um restart planejado e exige aprovação específica. Não usar reload concorrente, blue/green escritor ou reiniciar observador/web por conveniência.
6. Validar `/health` 200; reidratação do snapshot; banco/role; endpoint autenticado `/fast-bridge` em SHADOW; `executionAvailable=false`, `shadowExecutionAvailable=false`; confirmar três observações únicas quando houver sinal anormal legítimo, sem gerar ataque. Em condição normal, comparar taxas/identidade e decisões abaixo do limiar. BHNET já mitigada deve continuar reconhecida, sem ACTIVATE duplicado.
7. Observar pelo menos 30 minutos: p50/p95/máximo e idade, timeouts/falhas, lacunas/restarts/duplicações, latência da API/bancos, CPU/memória, CPU Huawei, BGP e comparação com polling geral. Estado SHADOW não pode alterar runtime antigo, perfis, flags ou equipamento. Nenhum comando de escrita para validar esse gate.
8. Se frontend também for autorizado: usar exclusivamente o standalone alinhado à versão publicada, preservando seu ambiente, identidade IMPLANTAR e preferências dos mapas; reiniciar somente o frontend nessa etapa aprovada. Conferir `/installation`, aba DDoS e mapa V2. Não publicar o frontend antigo da base da API.

Não executar os passos acima com base neste relatório: **aguardar autorização do operador**, incluindo restart da API. Gate 3 é outra autorização, por IDs explícitos e plano de homologação de escrita. Uma aprovação de SHADOW não libera ENFORCE.

## Rollback e validação isolada

Rollback operacional preparado: parar a API candidata, restaurar **bundle/unidade/ENV reais previamente preservados** e iniciar a versão anterior no caminho original. Manter `netvision-fast-observer.service`, seu banco e sua coleta independentes. Se o web tiver sido atualizado, retornar seu standalone/unidade/ENV anterior. Confirmar PIDs/health, perfis, flags, sessões BGP e estado físico previamente registrado. Não remover mitigações como efeito colateral.

Não desfazer migrations por DROP: as tabelas são aditivas e podem permanecer, preservando auditoria. Não apagar dados e não regravar limiares/direções durante rollback de binário. Direções novas, se vierem a ser autorizadas em outra etapa, exigem revisão própria para reversão.

Testes de rollback realizados: parada/retomada do produtor independente em PostgreSQL/UDP isolados; retomada de contagens com identidade persistida e suspeita zerada; retorno de locks após exceção; perda dos dois bancos sem fallback; estado físico MITIGATED imune a contadores SHADOW. No Linux, startup do candidato, execução de query Prisma no schema novo, startup do motor anterior recompilado da base `fc790ade` com schema aditivo e startup do frontend standalone. O teste de startup usa DEMO, executor sem escrita e não substitui a futura janela controlada em produção.

## Matriz de decisão e autorização pendente

| Etapa | Decisão | Fundamento |
|---|---|---|
| Código/contrato/continuidade e pipeline isolado | **GO** | testes unitários e com PostgreSQL, bench e realtime aprovados |
| RC2 (`v2026.10.18-ddos-fast-bridge-rc2`) — compatibilidade LEGACY | **GO técnico** | 20 cenários golden idênticos ao publicado; 1.935 testes verdes; build Linux OK |
| Preparar e revisar deploy API SHADOW | **GO técnico, aguardando autorização** | separação de escrita, role RO, migrations aditivas, rollback preparado |
| Executar deploy/restart na IMPLANTAR agora | **NO-GO sem autorização específica** | Gate 2 ainda não aprovado |
| Rollout frontend amplo | **condicionado** | candidato alinhado; uma falha preexistente global precisa tratamento/aceite explícito |
| Habilitar FAST ENFORCE / mitigar Huawei | **NO-GO** | falta Gate 3 por perfil e homologação de escrita; policy BHNET já ativa |
| Declarar SLA Huawei ≤60 s garantido | **NO-GO** | há pipeline sintético e leitura real; falta medição de aplicação autorizada |

O resultado entregue é um candidato funcional e verificável. O observador continua operacional em produção; a integração do motor permanece isolada até aprovação.
