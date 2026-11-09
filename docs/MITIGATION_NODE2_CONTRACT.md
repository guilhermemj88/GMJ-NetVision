# Node 2 de mitigação: contrato, verificação física e procedimento

Escopo: executor BGP Huawei (manual, B2/AUTO e executor compartilham o mesmo caminho).
Nada aqui foi comprovado em equipamento real; ver "Pendências na janela".

## Contrato do node 2

```
route-policy <P> deny node 1
 if-match ip-prefix BOGONS
route-policy <P> permit node 2
 if-match ip-prefix <LISTA do node permanente>
 apply local-preference <N do node permanente>
 apply extcommunity rt 268568:660        (rtMode: REPLACE, sem additive)
```

- Elegível só com **um** node `permit` permanente com um `if-match ip-prefix` IPv4, um
  `apply local-preference N` absoluto e um único `apply extcommunity rt 268568:140 [additive]`.
  Demais nodes: `deny` (vazio ou com if-match) ou vazios. Allowlist de cláusulas exportada em
  `MITIGATION_CONTRACT_CLAUSE_ALLOWLIST`. Qualquer outra forma: `MITIGATION_CONTRACT_UNSUPPORTED`.
- Um `deny` anterior ao node do cliente só é aceito com prova (prefix-lists reais) de que não
  alcança a lista do cliente.
- **BOGONS ∩ lista do cliente** (B4): se houver interseção, inelegível (o node 1 passaria a negar
  prefixos que o node permanente aceita).
- **Export** (A2): a export policy do peer de mitigação (descoberto pela configuração) é avaliada
  na ordem dos nodes. Se um `deny` anterior ao `permit` MITIGACAO genérico puder casar a lista do
  cliente, ou não for possível provar que não casa: `MITIGATION_EXPORT_SHADOWED` (caso UAY,
  `deny node 47 TRIPLO_A-BLOCO-TODO` da COMPUTIZE).
- **REPLACE é obrigatório** (B1). O `deny node 5` de SEABORN/SEMPRE tem duas condições
  (MITIGACAO e NO-EXPORT-x): pela regra AND uma rota só com a RT 660 não o casa. O que tira a
  rota desses trânsitos é a saída da RT 140 (o `permit node 90` deles depende dela). Com
  `additive` a rota (140+660) continuaria exportada por esses nodes 90 e a COMPUTIZE a negaria no
  `deny node 90` (filtro 140). Há teste que documenta isso.

Efeito durante a mitigação: a RT 140 e qualquer outra RT recebida (ex.: 330) saem; CIRION, SWITCH,
VS-IX, SEABORN, SEMPRE e TUDDO deixam de anunciar o prefixo; a COMPUTIZE anuncia (permit node 300).

## Verificação física pós-escrita (somente `display`)

PASS só com tudo: peer do cliente Established, **sem flap** (`BGP Peer Up count` igual ao pré) e
mesmo "Received total routes"; cada prefixo elegível recebido com caminho best/select do **próprio
peer**, LP do contrato, RT 660 e sem 140; prefixos fora da lista inalterados; e anúncio ao peer de
mitigação **ausente no pré** e presente agora (causalidade, M3).

- **FAIL**: somente evidência positiva contrária (best de outro caminho, LP errada, RT 140
  presente, peer caído, flap, contagem diferente).
- **INCONCLUSIVE**: timeout, parsing ambíguo, peer de mitigação ambíguo/não descoberto, "ainda
  não anunciado" ao esgotar o orçamento, anúncio já existente no pré (sessão MITIGACAO paralela:
  73S, CLICKING) ou pré indisponível, nenhum prefixo elegível recebido.
- **Orçamento**: 90 s no total, tentativa a cada 5 s (maior que o MRAI de eBGP de 30 s); conferido
  antes de cada leitura, e cada leitura é limitada ao que resta do orçamento.
- **Limite de 16 prefixos elegíveis** (B3): acima disso o resultado é INCONCLUSIVE e o perfil nunca
  chega a PASS. Não aumentar sem medir (cada prefixo é um `display` repetido a cada tentativa).
- **Porta obrigatória** (B2): `HuaweiMitigationExecutor` não é construído sem
  `readMitigationDisplays`, e `MitigationLiveExecutorPort` exige `captureMitigationEvidence` e
  `verifyMitigationPhysical`. Sem prova física nunca há `VERIFIED`.

### Impacto no AUTO (M1, não resolvido)

A verificação roda **dentro** de `commands.execute`, sob o lock da policy, e não fora do tick. Mover
para fora exigiria um estado intermediário no ciclo de vida (journal/ownership) e foi considerado
invasivo. Impacto: pior caso de até ~90 s (mais a última leitura) por ativação AUTO, durante os
quais o escopo fica `ACTIVATING`. **Não foi medido o efeito no FAST** (cadência 5 s, limite de
continuidade 15 s). Por isso o AUTO (E1) continua condicionado a essa medição; o E0 (manual) não é
afetado. A captura pré-escrita roda em paralelo ao preflight.

## Procedimento quando o status é `ACTIVATED_UNVERIFIED_PHYSICAL`

Publicado como `MITIGATION_FAILED` com `failureKind: 'UNVERIFIED_PHYSICAL'` e o texto "escrita
aplicada; verificação física não comprovada; retirada só por CLI + reconciliação" (o workflow n8n
RC7.1.2 só entrega tipos conhecidos e não foi alterado; ele mostra o texto "FALHA / ESTADO INCERTO").
Status interno e journal mantêm `ACTIVATED_UNVERIFIED_PHYSICAL`.

1. Não há rollback automático. O escopo fica `UNCERTAIN` (quarentena): o REMOVE pela API retorna
   `MANUAL_RECONCILIATION_REQUIRED`.
2. Se o único check em não-PASS for `advertised` ("ainda não anunciado"), aguardar e repetir
   `display bgp routing-table peer <peer de mitigação> advertised-routes` antes de decidir.
3. Retirada por CLI: `undo route-policy <P> node 1` e `undo route-policy <P> node 2`, `commit`.
4. Reconciliar até NORMAL (preview + apply local). **Promoção a MITIGATED (M4)**: o APPLY LOCAL só
   promove se a verificação física for **reexecutada** (modo `reverify`, sem estado pré: não
   compara flap/contagem nem causalidade) e der PASS. Sem verificador, ou com FAIL/INCONCLUSIVE, o
   runtime permanece `RECONCILIATION_REQUIRED`. O texto da policy sozinho não promove.

## Matriz de elegibilidade (config real; ip-prefix sintéticos)

38 policies IPv4 de import: **21 elegíveis**, **1 sombreada no export (UAY)**, **16 recusadas** pelo
contrato. Fixada em `mitigation-export-shadow.test.ts`. As definições de ip-prefix são sintéticas
(a captura não as traz); a única sobreposição entre listas é por nome igual.

## Pendências na janela (E0)

Confirmar no equipamento: formato real de `advertised-routes` da COMPUTIZE (a fixture é sintética
nesse ponto), `BGP Peer Up count`, tempo real até o anúncio, formato do `display ip
extcommunity-filter`, e o efeito iBGP (SWITCH/VS-IX) no tráfego interno.
