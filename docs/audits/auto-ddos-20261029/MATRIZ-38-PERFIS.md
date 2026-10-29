# Matriz dos 38 perfis — IMPLANTAR

Inventario read-only: 2026-10-29T11:40:10Z; FAST: 2026-10-29T12:03:52Z. Nenhum modo ou threshold alterado.

**Todos permanecem NO-GO operacional nesta missao.** Candidato significa somente prioridade de homologacao, sem autorizacao de escrita. CSV acompanha banda/threshold em bps, samples, RT, nodes, peers, direcoes, velocidade fisica, timestamps e historico por perfil. O estado NORMAL e de runtime; nao e readback Huawei novo. Estados BGP sao persistidos em banco, nao uma leitura CLI nova. PLAYCONNECT IPv4 tem um peer ACTIVE e outro ESTABLISHED; requer verificacao adicional antes do piloto.

| Policy                   | Interface       | Familia | Modo       | Direcao/origem  | Banda Gbps | Escopo | Classificacao           |
| ------------------------ | --------------- | ------- | ---------- | --------------- | ---------: | -----: | ----------------------- |
| PL-73S_IPv4-IN           | Eth-Trunk1.3534 | IPV4    | AUTO       | TX/ENV          |         40 |      1 | CANDIDATO A HOMOLOGACAO |
| PL-73S_IPv6-IN           | Eth-Trunk1.3534 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         40 |      1 | MANTER ALERT_ONLY       |
| PL-AGLINK_IPv4-IN        | Eth-Trunk1.3058 | IPV4    | AUTO       | TX/ENV          |         10 |      1 | CANDIDATO A HOMOLOGACAO |
| PL-BHNET_IPv4-IN         | Eth-Trunk1.3043 | IPV4    | AUTO       | TX/ENV          |         10 |      2 | AUTO BLOQUEADO          |
| PL-BHNET_IPv4-IN         | Eth-Trunk1.3044 | IPV4    | AUTO       | TX/ENV          |         10 |      2 | AUTO BLOQUEADO          |
| PL-BHNET_IPv6-IN         | Eth-Trunk1.3043 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-BHNET_IPv6-IN         | Eth-Trunk1.3044 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-CLICKING-V4-IN        | Eth-Trunk1.3528 | IPV4    | AUTO       | TX/INTERFACE    |         20 |      1 | CANDIDATO A HOMOLOGACAO |
| PL-CLICKING-V6-IN        | Eth-Trunk1.3528 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         20 |      1 | MANTER ALERT_ONLY       |
| PL-FIRE-TELECOM_IPv4-IN  | Eth-Trunk1.501  | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-FIRE-TELECOM_IPv4-IN  | Eth-Trunk1.502  | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-FLASH-TELECOM_IPv4-IN | Eth-Trunk1.3065 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-FLASH-TELECOM_IPv4-IN | Eth-Trunk1.3066 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      2 | AUTO BLOQUEADO          |
| PL-FLASH-TELECOM_IPv6-IN | Eth-Trunk1.3065 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-FLASH-TELECOM_IPv6-IN | Eth-Trunk1.3066 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      2 | MANTER ALERT_ONLY       |
| PL-GMTELECOM_IPv4-IN     | Eth-Trunk1.3042 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      1 | MANTER ALERT_ONLY       |
| PL-HORIZONTES_IPv4-IN    | Eth-Trunk1.3011 | IPV4    | AUTO       | TX/INTERFACE    |         40 |      2 | AUTO BLOQUEADO          |
| PL-HORIZONTES_IPv4-IN    | Eth-Trunk1.3013 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         40 |      2 | MANTER ALERT_ONLY       |
| PL-HORIZONTES_IPv6-IN    | Eth-Trunk1.3011 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         40 |      2 | MANTER ALERT_ONLY       |
| PL-HORIZONTES_IPv6-IN    | Eth-Trunk1.3013 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         40 |      2 | MANTER ALERT_ONLY       |
| PL-JUSTNET-IPv4-IN       | Eth-Trunk1.2518 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      4 | MANTER ALERT_ONLY       |
| PL-JUSTNET-IPv4-IN       | Eth-Trunk1.2519 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      4 | AUTO BLOQUEADO          |
| PL-JUSTNET-IPv4-IN       | Eth-Trunk1.3962 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      4 | AUTO BLOQUEADO          |
| PL-JUSTNET-IPv4-IN       | Eth-Trunk1.3973 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      4 | MANTER ALERT_ONLY       |
| PL-JUSTNET-IPv6-IN       | Eth-Trunk1.2519 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      3 | MANTER ALERT_ONLY       |
| PL-JUSTNET-IPv6-IN       | Eth-Trunk1.3962 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      3 | MANTER ALERT_ONLY       |
| PL-JUSTNET-IPv6-IN       | Eth-Trunk1.3973 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      3 | MANTER ALERT_ONLY       |
| PL-LIVINET_IPv4-IN       | Eth-Trunk1.3031 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      1 | MANTER ALERT_ONLY       |
| PL-PLAYCONNECT_IPv4-IN   | Eth-Trunk1.3024 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      1 | CANDIDATO A HOMOLOGACAO |
| PL-PLAYCONNECT_IPv6-IN   | Eth-Trunk1.3024 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      1 | MANTER ALERT_ONLY       |
| PL-RNJ_IPv4-IN           | Eth-Trunk1.3026 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      2 | AUTO BLOQUEADO          |
| PL-RNJ_IPv4-IN           | Eth-Trunk1.3030 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-RNJ_IPv6-IN           | Eth-Trunk1.3026 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      2 | MANTER ALERT_ONLY       |
| PL-RNJ_IPv6-IN           | Eth-Trunk1.3030 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      2 | MANTER ALERT_ONLY       |
| PL-SUPERNET-IPv4-IN      | Eth-Trunk1.3078 | IPV4    | AUTO       | TX/INTERFACE    |         10 |      1 | CANDIDATO A HOMOLOGACAO |
| PL-SUPERNET-IPv6-IN      | Eth-Trunk1.3078 | IPV6    | ALERT_ONLY | TX/INTERFACE    |         10 |      1 | MANTER ALERT_ONLY       |
| PL-WF_Bonsucesso_IPv6-IN | Eth-Trunk1.1052 | IPV6    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      1 | MANTER ALERT_ONLY       |
| PL-WFREDES-V4-IN         | Eth-Trunk1.1052 | IPV4    | ALERT_ONLY | UNKNOWN/UNKNOWN |         10 |      1 | MANTER ALERT_ONLY       |

## Impedimentos comuns

- Validar no equipamento o par, RT, familia, escopo e exclusividade do perfil piloto.
- Comprovar o trafego oferecido por uma fonte independente que permaneça observavel durante o desvio BGP; TX baixo no cliente nao basta.
- Aprovar migration aditiva, release e restart API-only em janela propria.
- Mesclar e homologar o patch outbound no export real RC7.1.1, preservando credenciais e demais redes.
- Autorizar explicitamente um unico perfil IPv4, device e janelas/limites; demais perfis continuam fora da allowlist.

Resumo: {"CANDIDATO A HOMOLOGACAO": 5, "MANTER ALERT_ONLY": 26, "AUTO BLOQUEADO": 7}. Nenhum candidato esta apto para ativacao imediata.
