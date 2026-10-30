# AGLINK — verificação final do plano BGP

Branch isolada `fix/aglink-bgp-semantics`, sobre `cacfdbf`.
FAST, lifecycle, flags, thresholds e arquitetura não foram alterados.
Produção exclusivamente por leitura; nenhuma publicação ou escrita Huawei.

## Diagnóstico

O operador é trânsito: o objetivo é selecionar as rotas recebidas da AGLINK e
controlar sua **exportação externa**, anunciando-as pelas sessões de mitigação.
Não é uma alteração do next-hop interno para o cliente.

Equipamento confirmado: NetEngine 8000 F1A-8H20Q, VRP 8.220,
`V800R022C00SPC600`. O peer `10.200.201.2` recebe exatamente:
`167.250.126.0/23`, `167.250.126.0/24`, `167.250.127.0/24`.
Todos estão best/select via Eth-Trunk1.3058, AS-path `273811 273811`, MED 0,
localpref 1100, RTs 268568:140 e 268568:330. Os /24 têm alternativas com LP 800 e 50.

1. **Sim**, os três prefixos casam no PREFIX8to24 observado: endereço wildcard
   0.0.0.0, sem `match-network`, comprimentos de 8 a 24. Isso não significa somente 0/8.
2. **Sim**, permit no node 2 encerra a avaliação; node 10 não é executado.
   `additive` preserva atributos recebidos, não executa nodes seguintes.
3. O RT 140 aplicado pelo node 10 deixa de ser acrescentado. Com `additive`, porém,
   um RT 140 recebido do peer seria preservado. Não devemos depender dessa ausência.
4. O plano antigo também deixa de aplicar LP 1100. Sem override global observado,
   o default é 100; os /24 poderiam perder a seleção para a alternativa LP 800,
   impedindo o anúncio da rota marcada. Isso afeta o objetivo de exportação.
5. Preservar RT 140 durante a mitigação seria incorreto: CIRION continua permitindo
   RT 140 e COMPUTIZE-DDoS o rejeita antes da regra que aceita RT 660.

Semântica conferida no modelo primário do fabricante para a mesma plataforma/versão:
[Huawei routing-policy 8.22 F1A](https://github.com/Huawei/yang/blob/master/network-router/8.22.0/ne8000-f1a/huawei-routing-policy.yang)
(prefix matching, término de node e operação add/replace) e
[Huawei BGP multiprotocol 8.22 F1A](https://github.com/Huawei/yang/blob/master/network-router/8.22.0/ne8000-f1a/huawei-bgp-common-multiprotocol.yang)
(default-local-preference 100). A definição/atributos/configuração correntes foram
lidos do equipamento; a transição abaixo é resultado esperado, não escrita real.

## Correção mínima somente para PL-AGLINK_IPv4-IN

Node 1 continua deny BOGONS. O node temporário 2 passa a ser:

```text
route-policy PL-AGLINK_IPv4-IN permit node 2
 if-match ip-prefix AGLINK-BLOCO-TODO-23
 apply local-preference 1100
 apply extcommunity rt 268568:660
```

A ausência de `additive` é deliberada: durante mitigação, RT **660 somente**,
inclusive se o peer enviar RT 140. RT 330 também é substituído nesse intervalo.
Não se copia RT 140 nem se usa goto. A prefix-list existente do cliente restringe
o /23 e seus /24; evita ampliar a aceitação a qualquer prefixo público do peer.
Nodes 10/1000 e prefix-lists existentes permanecem intactos; não se cria lista nova.

Preflight/readback conferem baseline LP 1100/RT 140, escopo exato da prefix-list,
LP 1100 e RT 660 exclusivo no node temporário. Preview e escrita usam o mesmo plano.
Reconciliação e leitura de discovery reconhecem a lista específica sem confundir
node 10 com ownership de mitigação. REMOVE humano continua removendo apenas 1/2;
não é verificado se o baseline divergir. Demais policies mantêm o plano anterior.

| Prefixo          | Antes: RTs / LP | Durante corrigido: RTs / LP | Após REMOVE e reconvergência: RTs / LP |
| ---------------- | --------------- | --------------------------- | -------------------------------------- |
| 167.250.126.0/23 | 140,330 / 1100  | 660 / 1100                  | 140,330 / 1100                         |
| 167.250.126.0/24 | 140,330 / 1100  | 660 / 1100                  | 140,330 / 1100                         |
| 167.250.127.0/24 | 140,330 / 1100  | 660 / 1100                  | 140,330 / 1100                         |

RTs na tabela usam ASN 268568. O retorno presume os mesmos anúncios originais do
cliente; a policy não altera o UPDATE original. O comando `received-routes
original-attributes` não é suportado nesta versão; RT 330 na entrada é inferido
do estado atual e do node 10, que acrescenta somente 140. O plano corrigido não
depende dessa inferência para garantir RT 660 exclusivo durante a mitigação.

## Exportação externa: configuração capturada e testes estáticos

Os resultados abaixo valem para **os três prefixos**. As policies de clientes e
distribuição interna não fazem parte da alegação de exclusividade externa.

| Saída                          | Antes / após retirada | Durante RT 660 exclusivo |
| ------------------------------ | --------------------- | ------------------------ |
| SEMPRE normal — 138.99.240.117 | permite node 90       | rejeita node 5           |
| SEABORN — 198.18.1.152         | permite node 90       | rejeita node 5           |
| SEABORN-BH — 198.18.36.26      | permite node 90       | rejeita node 5           |
| CIRION — 200.194.223.85        | permite node 90       | rejeita node 100         |
| IP-TUDDO — 172.30.251.33       | permite node 90       | rejeita node 100         |
| VS-IX — 45.163.144.6           | permite node 36       | rejeita node 6000        |
| SEMPRE-DDoS — 138.99.240.141   | rejeita node 100      | permite node 50          |
| COMPUTIZE-DDoS — 198.19.4.145  | rejeita node 90       | permite node 300         |

Evidência sanitizada das regras/definições e vínculos:
[aglink-bgp-export.json](evidence/aglink-bgp-export.json). Avaliação usa essas regras
capturadas, não uma hipótese de prefixo amplo ou um workflow novo.

## Validação e decisão

Testes novos verificam primeiro node, os três prefixos, LP/seleção, substituição
de RT recebido, exportação normal versus mitigação, rejeição de prefixo estranho,
readback incompleto/atributos divergentes, preview, classificação de discovery e
restauração após REMOVE humano. A integração FAST/ACTIVATE/HTTP/restart/REMOVE e
as regressões manuais existentes são reexecutadas. Contagens finais, commit e
hashes do novo pacote são registrados na evidência de entrega.

Resultado final: **2.639 aprovados, 33 ignorados, zero falhas** na suíte API;
20 testes novos relacionados ao plano BGP (15 de importação/readback, quatro
de exportação capturada e um de discovery). Typecheck, build API, ESLint e
Prettier dos arquivos alterados aprovados. O PostgreSQL usado foi descartável
local, sem alteração de banco produtivo. As duas falhas iniciais de laboratório
eram indisponibilidade da porta local após restart do container; corrigida a
publicação fixa da porta, a suíte completa passou. A geração Prisma concorrente
no Windows também foi serializada; não foi alterada a implementação para esses erros.

Os modelos de teste não são homologação física. Não houve ACTIVATE/REMOVE, anúncio
novo, soft reset, refresh BGP, deploy, migration ou restart em produção. A tentativa
de filtrar RIB por prefix-list não forneceu leitura utilizável e não é evidência
de correspondência física. Após futura operação autorizada, conferir best-route,
RT 660 exclusivo e anúncios nos dois peers DDoS; após REMOVE, conferir RTs originais
e anúncios normais após reconvergência. Readback de policy não prova entrega do
tráfego pelo provedor de mitigação.

**NO-GO para o plano BGP antigo. GO técnico para o plano BGP corrigido**, condicionado
ao pacote/testes registrados; não equivale a autorização de deploy ou homologação
real de transporte/limpeza de tráfego. Não há mudança do motor nem nova fase.
