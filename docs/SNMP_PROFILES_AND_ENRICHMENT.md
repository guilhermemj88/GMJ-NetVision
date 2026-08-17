# Perfis SNMP e enriquecimento de interfaces

## Fluxo de coleta

O IF-MIB continua sendo a autoridade para `ifIndex`, nome, descrição, estado,
velocidade e contadores. Um novo discovery faz `upsert` por `(deviceId,
ifIndex)`: o ID da interface, links e histórico são preservados, textos UTF-8
válidos corrigem valores antigos e valores vazios não apagam dados úteis.

Em Huawei VRP, SSH é apenas enriquecimento. A mesma sessão executa:

```text
screen-length 0 temporary
display interface description
```

Os nomes são normalizados para tolerar espaços, pontuação e abreviações como
`XGigabitEthernet`/`XGE`, `GigabitEthernet`/`GE` e `Eth-Trunk 1`/`Eth-Trunk1`.
Uma linha SSH sem correspondência inequívoca no inventário SNMP é descartada;
ela nunca cria uma interface sem `ifIndex` confiável.

## Potência óptica Huawei

A coleta periódica tenta primeiro a `HUAWEI-ENTITY-EXTENT-MIB`:

| Dado | OID | Unidade original |
| --- | --- | --- |
| `entPhysicalName` | `1.3.6.1.2.1.47.1.1.1.1.7` | texto |
| RX | `1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8` | µW |
| TX | `1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9` | µW |

O índice da entidade é correlacionado pelo nome normalizado da interface. A
conversão é `dBm = 10 × log10(µW / 1000)`. Valores não numéricos, não positivos
ou fora de `-60..20 dBm` são ignorados.

Somente portas sem uma leitura SNMP atual usam o fallback SSH:

```text
screen-length 0 temporary
display transceiver verbose
```

O fallback é por interface e reconhece variações de `Rx Power`, `RX Power`,
`Current RX Power`, `RxPower` e os equivalentes TX. Uma leitura SNMP válida não
é substituída por SSH. `OPTICAL_POLL_INTERVAL_SECONDS` controla o intervalo,
com padrão de 300 segundos e mínimo de 60; falhas de DDM ou SSH não interrompem
o polling de tráfego.

## Catálogo de perfis

Os perfis ficam em `apps/api/src/infrastructure/snmp/profiles`. A escolha usa
`model`, `sysDescr`, `sysObjectID` e `vendor`, nesta ordem de especificidade:

```text
modelo/família -> fabricante -> generic
```

O perfil `huawei-ne8000` declara dois candidatos oficiais para CPU:

1. `hwEntityCpuUsage` — `1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5`, da
   `HUAWEI-ENTITY-EXTENT-MIB`. A instância é escolhida pela entidade principal
   (`MPU`, `SRU`, control board ou system), nunca pela primeira linha.
2. `hwAvgDuty1min` — `1.3.6.1.4.1.2011.6.3.4.1.3`, da
   `HUAWEI-DEVICE-MIB`. Por ser indexado por frame/slot/CPU, só é aceito quando
   há uma única linha válida e inequívoca.

Ambos são gauges percentuais validados em `0..100`. O segundo candidato só é
tentado quando o primeiro não responde ou é inválido/ambíguo. O candidato que
funciona é mantido em cache no processo. A documentação oficial usada está nos
campos `sourceUrl` do perfil.

Para adicionar um equipamento, crie `profiles/<vendor>/<model>.ts`, declare
padrões de identidade, candidatos, escala, faixa plausível, estratégia de
seleção e URL da MIB oficial, e registre o perfil no catálogo. Não é necessário
alterar o poller. O backend nunca pesquisa OIDs na internet em runtime.

Após um poll, `GET /api/hosts/:hostId/snmp-profile` mostra o perfil, tentativas,
status e OID selecionado sem expor community ou outra credencial. Isso serve de
base para descoberta assistida e validação em equipamento real.

## Erros e descartes

`ifInErrors`, `ifOutErrors`, `ifInDiscards` e `ifOutDiscards` continuam salvos
como totais acumulados. Colunas aditivas armazenam o delta de cada intervalo;
UI e gráficos usam esses deltas. A primeira amostra vale zero, reset usa o novo
valor como nova contagem e um wrap plausível de `Counter32` é calculado sem
produzir valores negativos.

## Smart guides do mapa

No modo de edição, o centro do node arrastado é comparado aos centros dos
outros nodes. Dentro de uma tolerância visual de 8 px (ajustada pelo zoom), o
melhor candidato recebe destaque e aparece uma guia horizontal e/ou vertical.
A posição só é persistida no `drag stop`; guias e snap desaparecem ao sair da
tolerância ou terminar o arraste. Fora do modo de edição o cálculo é desativado.
