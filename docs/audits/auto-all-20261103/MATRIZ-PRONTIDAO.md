# Matriz individual — AUTO-ALL / IMPLANTAR / 03-11-2026

> **Matriz histórica do código publicado e contrato anterior.** Os marcadores P e a antiga exigência de LP/lista não são requisitos do contrato final. Consulte a [reavaliação dos 39 perfis](MATRIZ-CONTRATO-FINAL.md) e o [adendo corrigido](ADENDO-CONTRATO-RT660-EXCLUSIVO.md). Nenhuma liberação operacional foi concedida.

Fonte: banco produtivo em READ ONLY, configurações `display` e avaliação offline do código 908e7b4. Nenhum caso é homologação física. Todos os perfis usam o mesmo NE8000 F1A-8H20Q / VRP8.220 / SPC600 / SPH152.

39 perfis, 23 IPv4 e 16 IPv6; 12 AUTO e 27 ALERT_ONLY; 0 elegíveis E2E agora. IN=checks do executor offline assumindo snapshot fresco; isso não valida cache, transporte de escrita, exportação ou mitigadora.

D=sem direção; P=prefix-list/baseline canônico não derivável; S=policy compartilhada; V6=fora do piloto autorizado; SNAP=snapshot ausente no motor; RT=RT660 preexistente; AGL=conflito de exportação/additive + prontidão externa + nenhuma homologação física. Todos ainda sujeitos às flags globais desligadas e ao pin AGLINK.

| Perfil ID                   | Cliente / interface                        | Família / modo    | Banda → limiar Gbps | Direção/fonte                | IN    | Bloqueios adicionais |
| --------------------------- | ------------------------------------------ | ----------------- | ------------------- | ---------------------------- | ----- | -------------------- |
| `cmuoavm2o00btsslh2qc6qbpg` | 73S TELECOM IP / Eth-Trunk1.3534           | IPV4 / AUTO       | 40 → 36             | tx / FAST_OBSERVER           | BLOCK | P                    |
| `cmuq7a6er002zssghj6f9j69v` | 73S TELECOM IP / Eth-Trunk1.3534           | IPV6 / ALERT_ONLY | 40 → 36             | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, V6             |
| `cmuoavm4e00bysslhqd0h3q7u` | AGLINK-IPV4 / Eth-Trunk1.3058              | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | PASS* | AGL                  |
| `cmuoavm4x00c3sslhworjdb9i` | BHNET-CEASA / Eth-Trunk1.3043              | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuoavm5i00c8sslhed09lt8p` | BHNET-RBN / Eth-Trunk1.3044                | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuq7a6ia003jssghgzz5ali0` | BHNET-CEASA / Eth-Trunk1.3043              | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmuq7a6j4003ossghmi7eksq0` | BHNET-RBN / Eth-Trunk1.3044                | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmuoavm6600cdsslhhw427w4r` | CLICKING-TELECOM / Eth-Trunk1.3528         | IPV4 / AUTO       | 20 → 18             | tx / FAST_OBSERVER           | BLOCK | P, RT                |
| `cmuq7a6kk003yssghxtnm6s9z` | CLICKING-TELECOM / Eth-Trunk1.3528         | IPV6 / ALERT_ONLY | 20 → 18             | tx / CONVENTIONAL_SNMP       | BLOCK | P, V6                |
| `cmvhe1ncq00bvl716tbn1xjb1` | FIRE-TELECOM-TELMIG / Eth-Trunk1.502       | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmvkhszgn00bvl74ti0nx65c8` | FIRE-TELECOM-TELMIG / Eth-Trunk1.501       | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmv2wtr8a700hsses6imwannv` | FAST TELECOM CONTAGEM / Eth-Trunk1.3065    | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmv2wtr97700mssesf05j8ebm` | FAST TELECOM / Eth-Trunk1.3066             | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmv2wtra0700rssesjkdkn8vo` | FAST TELECOM CONTAGEM / Eth-Trunk1.3065    | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmv2wtrau700yssestso3v22x` | FAST TELECOM / Eth-Trunk1.3066             | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, S, V6             |
| `cmuoavm8d00cisslhxzjwqygh` | GM_TELECOM_CEASA / Eth-Trunk1.3042         | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P                 |
| `cmuoavm8x00cnsslhxa6wtmar` | HORIZONTE_IP / Eth-Trunk1.3011             | IPV4 / AUTO       | 40 → 36             | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuoavm9d00cssslhprlon66g` | HORIZONTE_IP_02 / Eth-Trunk1.3013          | IPV4 / ALERT_ONLY | 40 → 36             | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmuovv7km0042ssae9vds4b4s` | HORIZONTE_IP / Eth-Trunk1.3011             | IPV6 / ALERT_ONLY | 40 → 36             | tx / CONVENTIONAL_SNMP       | BLOCK | P, S, V6             |
| `cmuovv7ln0047ssaebn5m16zn` | HORIZONTE_IP_02 / Eth-Trunk1.3013          | IPV6 / ALERT_ONLY | 40 → 36             | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmuoavmaz00cxsslhn2cuwcmx` | JUSTNET L2L LIVINET / Eth-Trunk1.3973      | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmuoavmc000d2sslhre9siv0f` | JUSTNET-MANTIQUEIRA / Eth-Trunk1.3962      | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuoavmcz00d7sslh1likgnvw` | 2519-JUSTNET-IP-AS262663 / Eth-Trunk1.2519 | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuoavmdj00dcsslhjbrxpv44` | 2518-JUSTNET-IP-AS271217 / Eth-Trunk1.2518 | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmuq7a6re005cssgh50tsji04` | JUSTNET L2L LIVINET / Eth-Trunk1.3973      | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmuq7a6s7005hssghnxttb6yi` | JUSTNET-MANTIQUEIRA / Eth-Trunk1.3962      | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, S, V6             |
| `cmuq7a6sv005mssghg7gxo53m` | 2519-JUSTNET-IP-AS262663 / Eth-Trunk1.2519 | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, S, V6             |
| `cmuoavmdy00dhsslh6ieobt62` | GM_TELECOM_CEASA / Eth-Trunk1.3031         | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P                 |
| `cmuoavmed00dmsslhi3dzev57` | PLAY CONNECT / Eth-Trunk1.3024             | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P                    |
| `cmuovv7pk0057ssaeu2vb1rrf` | PLAY CONNECT / Eth-Trunk1.3024             | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, V6                |
| `cmuoavmev00dssslh7vhu7oqu` | RNJ / Eth-Trunk1.3026                      | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P, S                 |
| `cmuoavmf800dxsslhb4eltgvq` | RNJ-02 / Eth-Trunk1.3030                   | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |
| `cmuovv7r5005mssaem9f2zfx1` | RNJ / Eth-Trunk1.3026                      | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, S, V6             |
| `cmuovv7rq005rssaeio7scfow` | RNJ-02 / Eth-Trunk1.3030                   | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, V6          |
| `cmuoavmfz00e2sslhbmo9ple7` | SUPERNET TELECOM / Eth-Trunk1.3078         | IPV4 / AUTO       | 10 → 9              | tx / FAST_OBSERVER           | BLOCK | P                    |
| `cmuq7a6yc006wssghdxic1itf` | SUPERNET TELECOM / Eth-Trunk1.3078         | IPV6 / ALERT_ONLY | 10 → 9              | tx / CONVENTIONAL_SNMP       | BLOCK | P, V6                |
| `cmuovv7sy0061ssaewrbbkgz5` | WF_Bonsucesso_02 / Eth-Trunk1.1052         | IPV6 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, V6             |
| `cmuoavmgi00e7sslhgh7quv0f` | WF_Bonsucesso_02 / Eth-Trunk1.1052         | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S, SNAP        |
| `cmvu0f0vd00axl7ylpkznwlc2` | WF-REDES-IPv4 / Eth-Trunk1.1056            | IPV4 / ALERT_ONLY | 10 → 9              | — / UNAVAILABLE_NO_DIRECTION | BLOCK | D, P, S              |

Os dados completos por perfil — prefixos/listas, RTs e cláusulas normais, LP, peers, frescor/cadência, estado e bloqueios — estão em [perfis.json](perfis.json) e [matriz-perfis.csv](matriz-perfis.csv).

Os prefixos listados são configuração Huawei observada, não uma nova autorização do operador. LIVINET depende de AS-path e não possui baseline permitido pelo mecanismo canônico atual. CLICKING tem node permanente 50 com RT660/LP4000 para PREFIX-DUALNET-V4; NORMAL no banco não autoriza assumir ausência física.

Todas as interfaces possuem amostras convencionais no recorte consultado. Ausência de direção não é ausência comprovada de SNMP. Há 12 interfaces coletadas no observer e 8 perfis IPv6 com direção herdada mas fora do roteamento FAST/piloto. Os 27 perfis em policies compartilhadas permanecem impróprios para inclusão direta na allowlist.
