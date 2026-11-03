# Matriz — contrato final sem if-match no node 2

Leitura Huawei: 2026-11-03T19:56:22.692Z. 39 perfis / 24 policies. Ocupação é constatação de snapshot, não aptidão AUTO. Não houve alteração funcional ou física.

38 bloqueios antigos de derivação: 22 IPv4 e 16 IPv6. A exigência é obsoleta para o novo node 2; IPv6 permanece fora do contrato explícito IPv4. Nenhum cliente está bloqueado por ocupação 1/2 nesta captura. Todos continuam NO-GO para AUTO no código publicado.

| Cliente                  | Policy                   | Família | Bloqueio antigo de derivação | Nodes 1/2 | Perfis na policy |
| ------------------------ | ------------------------ | ------- | ---------------------------- | --------- | ---------------- |
| 73S TELECOM IP           | PL-73S_IPv4-IN           | IPV4    | Obsoleto                     | Livres    | 1                |
| 73S TELECOM IP           | PL-73S_IPv6-IN           | IPV6    | Obsoleto                     | Livres    | 1                |
| AGLINK-IPV4              | PL-AGLINK_IPv4-IN        | IPV4    | Não exigido                  | Livres    | 1                |
| BHNET-CEASA              | PL-BHNET_IPv4-IN         | IPV4    | Obsoleto                     | Livres    | 2                |
| BHNET-RBN                | PL-BHNET_IPv4-IN         | IPV4    | Obsoleto                     | Livres    | 2                |
| BHNET-CEASA              | PL-BHNET_IPv6-IN         | IPV6    | Obsoleto                     | Livres    | 2                |
| BHNET-RBN                | PL-BHNET_IPv6-IN         | IPV6    | Obsoleto                     | Livres    | 2                |
| CLICKING-TELECOM         | PL-CLICKING-V4-IN        | IPV4    | Obsoleto                     | Livres    | 1                |
| CLICKING-TELECOM         | PL-CLICKING-V6-IN        | IPV6    | Obsoleto                     | Livres    | 1                |
| FIRE-TELECOM-TELMIG      | PL-FIRE-TELECOM_IPv4-IN  | IPV4    | Obsoleto                     | Livres    | 2                |
| FIRE-TELECOM-TELMIG      | PL-FIRE-TELECOM_IPv4-IN  | IPV4    | Obsoleto                     | Livres    | 2                |
| FAST TELECOM CONTAGEM    | PL-FLASH-TELECOM_IPv4-IN | IPV4    | Obsoleto                     | Livres    | 2                |
| FAST TELECOM             | PL-FLASH-TELECOM_IPv4-IN | IPV4    | Obsoleto                     | Livres    | 2                |
| FAST TELECOM CONTAGEM    | PL-FLASH-TELECOM_IPv6-IN | IPV6    | Obsoleto                     | Livres    | 2                |
| FAST TELECOM             | PL-FLASH-TELECOM_IPv6-IN | IPV6    | Obsoleto                     | Livres    | 2                |
| GM_TELECOM_CEASA         | PL-GMTELECOM_IPv4-IN     | IPV4    | Obsoleto                     | Livres    | 1                |
| HORIZONTE_IP             | PL-HORIZONTES_IPv4-IN    | IPV4    | Obsoleto                     | Livres    | 2                |
| HORIZONTE_IP_02          | PL-HORIZONTES_IPv4-IN    | IPV4    | Obsoleto                     | Livres    | 2                |
| HORIZONTE_IP             | PL-HORIZONTES_IPv6-IN    | IPV6    | Obsoleto                     | Livres    | 2                |
| HORIZONTE_IP_02          | PL-HORIZONTES_IPv6-IN    | IPV6    | Obsoleto                     | Livres    | 2                |
| JUSTNET L2L LIVINET      | PL-JUSTNET-IPv4-IN       | IPV4    | Obsoleto                     | Livres    | 4                |
| JUSTNET-MANTIQUEIRA      | PL-JUSTNET-IPv4-IN       | IPV4    | Obsoleto                     | Livres    | 4                |
| 2519-JUSTNET-IP-AS262663 | PL-JUSTNET-IPv4-IN       | IPV4    | Obsoleto                     | Livres    | 4                |
| 2518-JUSTNET-IP-AS271217 | PL-JUSTNET-IPv4-IN       | IPV4    | Obsoleto                     | Livres    | 4                |
| JUSTNET L2L LIVINET      | PL-JUSTNET-IPv6-IN       | IPV6    | Obsoleto                     | Livres    | 3                |
| JUSTNET-MANTIQUEIRA      | PL-JUSTNET-IPv6-IN       | IPV6    | Obsoleto                     | Livres    | 3                |
| 2519-JUSTNET-IP-AS262663 | PL-JUSTNET-IPv6-IN       | IPV6    | Obsoleto                     | Livres    | 3                |
| GM_TELECOM_CEASA         | PL-LIVINET_IPv4-IN       | IPV4    | Obsoleto                     | Livres    | 1                |
| PLAY CONNECT             | PL-PLAYCONNECT_IPv4-IN   | IPV4    | Obsoleto                     | Livres    | 1                |
| PLAY CONNECT             | PL-PLAYCONNECT_IPv6-IN   | IPV6    | Obsoleto                     | Livres    | 1                |
| RNJ                      | PL-RNJ_IPv4-IN           | IPV4    | Obsoleto                     | Livres    | 2                |
| RNJ-02                   | PL-RNJ_IPv4-IN           | IPV4    | Obsoleto                     | Livres    | 2                |
| RNJ                      | PL-RNJ_IPv6-IN           | IPV6    | Obsoleto                     | Livres    | 2                |
| RNJ-02                   | PL-RNJ_IPv6-IN           | IPV6    | Obsoleto                     | Livres    | 2                |
| SUPERNET TELECOM         | PL-SUPERNET-IPv4-IN      | IPV4    | Obsoleto                     | Livres    | 1                |
| SUPERNET TELECOM         | PL-SUPERNET-IPv6-IN      | IPV6    | Obsoleto                     | Livres    | 1                |
| WF_Bonsucesso_02         | PL-WF_Bonsucesso_IPv6-IN | IPV6    | Obsoleto                     | Livres    | 1                |
| WF_Bonsucesso_02         | PL-WFREDES-V4-IN         | IPV4    | Obsoleto                     | Livres    | 2                |
| WF-REDES-IPv4            | PL-WFREDES-V4-IN         | IPV4    | Obsoleto                     | Livres    | 2                |

Restrições independentes, peers afetados, nodes permanentes e identificadores por perfil no [JSON](contrato-final-node2-sem-match.json) e no [CSV](matriz-contrato-final.csv).

Se node 1 ou 2 estiver ocupado por configuração sem ownership NetVision comprovado, a classificação exigida — NÃO APTO, com cliente/policy/nodes informados, sem sobrescrever/adotar/deslocar o par. Um par já gerenciado não autoriza segundo ACTIVATE. Runtime NORMAL não — prova de ausência física.

O node 11 HORIZONTES_IPv4-IN foi observado com RT660 nesta leitura, diferindo da anterior; node 50 CLICKING já continha RT660. Permanecem intocados e não são considerados propriedade do NetVision.
