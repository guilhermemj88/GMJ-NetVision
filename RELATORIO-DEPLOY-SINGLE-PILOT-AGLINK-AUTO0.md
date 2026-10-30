# IMPLANTAR — publicação single-pilot AGLINK AUTO=0

> Histórico da tentativa anterior. A retomada autorizada publicou a API 4637696 com AUTO=0; consulte o [relatório atual](RELATORIO-RETOMADA-DEPLOY-AGLINK-AUTO0.md). O resultado abaixo foi preservado como evidência histórica.

**30/10/2026, America/Sao_Paulo. Resultado: NO-GO; rollback autorizado concluído.**

A API 4637696 iniciou com o bundle aprovado e flags desligadas. O gate obrigatório
do catálogo falhou: `physicalTemplatePort.createMany()` encontrou unicidade em
`(templateId, side, sortOrder)`. Como esta missão proíbe corrigir código/pacote
ou banco, foi executado o rollback autorizado para **e78638a**. A API candidata
não permanece publicada. Os serviços de rede foram preservados; a pendência
do catálogo não está resolvida.

## Versões, integridade e configuração

| Item                          | Resultado                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API anterior e final          | `e78638af51762db93f52f61195ca57d8c72d988e`                                                                                |
| API tentada                   | `463769620a2f39f9803b60a43314851fe3a77e0e`                                                                                |
| SHA256 pacote aprovado        | `f47210e4d018d954f1723d31e29a050995169d5e9dd57ce35ad7a01e68172afe`                                                        |
| SHA256 bundle tentado         | `5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`                                                        |
| SHA256 bundle final executado | `c8a71fbf1537199ce689627ce5774f8306261fb27f7c3ac1b2e423a515fa1c9c`                                                        |
| Instalação e rollback         | 10.070 arquivos do pacote e 10.068 arquivos da release anterior conferidos                                                |
| Dependências                  | Node v24.19.0, Prisma 6.19.3, bibliotecas OpenSSL 3 vinculadas                                                            |
| Backup                        | 50 arquivos/configuração/runtime cifrados; recuperação em memória validada em Linux e Windows; chaves separadas/restritas |
| Espaço livre final            | 5,71 GiB; reserva mínima de 5 GiB preservada                                                                              |

Não houve recompilação, alteração ou substituição do pacote. A release candidata
permanece instalada, **inativa**, em `/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e`.
A e78638a foi preservada integralmente. Backup operacional Linux:
`/var/backups/netvision-single-pilot-auto0-4637696-20261030/operational-config.aesgcm`.

## Restart, rollback e serviços

Houve **um restart planejado da API e um restart autorizado de rollback**.
O MCP reiniciou indiretamente em ambos, sem alterar `Requires`, usar
`ignore-dependencies` ou reiniciar serviços adicionais. `systemd-analyze verify`
passou antes das duas trocas. Os drop-ins passaram de 23 para 24 e voltaram a 23;
somente o novo drop-in e o novo EnvironmentFile foram removidos no rollback.
Todos os arquivos anteriores de configuração foram conferidos e preservados.

| Serviço       | PID anterior | PID candidato | PID final | Health final                          |
| ------------- | ------------ | ------------- | --------- | ------------------------------------- |
| API           | 3418797      | 3432230       | 3433280   | 200                                   |
| MCP           | 3418799      | 3432233       | 3433281   | 200; ferramentas de leitura respondem |
| WEB           | 2976909      | 2976909       | 2976909   | 200                                   |
| FAST Observer | 2594846      | 2594846       | 2594846   | 200; healthy                          |

API/MCP anteriores iniciados em 29/10 às 17:42:19; candidatos em 30/10 às
13:24:14; restauração em 30/10 às **13:31:09**, horários de Brasília.
Observação final: **13:36:16**, sem loop de restart. API/MCP `NRestarts=0`;
Observer manteve seu contador histórico 1. Somente API/MCP mudaram PID/timestamp
no inventário de serviços. A API final responde `demoMode=false`, `snmpPolling=true`.
WEB e seu BUILD_ID `NSfXEDCQk4S1AmACLROnj` foram preservados.

## Flags e verificações autenticadas

O processo candidato e o processo restaurado carregaram:

```text
NETVISION_INSTALLATION_ID=IMPLANTAR
MITIGATION_AUTO_PERSISTENCE_ENABLED=0
MITIGATION_AUTO_LIFECYCLE_ENABLED=0
MITIGATION_AUTO_EXECUTION_ENABLED=0
MITIGATION_AUTO_REMOVE_ENABLED=0
MITIGATION_AUTO_DESCRIPTION_ENABLED=0
MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS=
MITIGATION_AUTO_MAX_ACTIVE=1
```

MODE=AUTO, EXECUTOR=HUAWEI, LIVE_WRITE=true e allowlist de dispositivo anterior
preservados para as operações manuais. Nenhuma autorização de perfil foi adicionada.
O GET autenticado `/api/bgp/mitigation/auto/lifecycle` retornou 200 nas duas versões,
com os quatro enabled=false, allowedProfiles=[], maxActive=1 e MANUAL_ONLY.
Foram usadas sessões próprias autorizadas, encerradas por logout, sem extrair
sessões de terceiros. O banner antigo da WEB não foi usado como evidência.

## Dados, catálogo, Huawei e n8n

- **39 perfis preservados:** 12 AUTO e 27 ALERT_ONLY; modos, bandas, thresholds,
  demais parâmetros e identidades inalterados. WF-REDES permanece registrado e o
  runtime DISABLED `cmuoavmgi00e7sslhgh7quv0f` permaneceu DISABLED.
- O startup restaurado da e78638a atualizou somente `updatedAt` em 38 perfis pela
  reidratação normal; não houve alteração manual de dados/configuração.
- Mesmos IDs, conteúdo estrutural e contagens nas seis tabelas de catálogo:
  134 equipment templates, 161 slots, 1.624 template ports, 35 module templates,
  412 module ports e 218 vínculos slot/module. Nenhum dos 13 templates extras
  foi removido; nenhum template foi limpo manualmente.
- A candidata carregou YAML correto com 121 entradas, mas sua sincronização
  transacional falhou em `(templateId, side, sortOrder)`. A configuração persistida
  ficou intacta. A e78638a restaurada mantém a limitação anterior: fallback builtin
  de 42 entradas e erro de unicidade em `PhysicalEquipmentTemplate(name)`.
  **Health 200 não significa que o bootstrap do catálogo tenha sido aprovado.**
- Reidratação dos snapshots: um dispositivo, um sucesso, zero falhas nas duas versões.
- Leitura Huawei antes/depois: mesma policy AGLINK, nodes **10 e 1000 somente**,
  mesmas prefix-lists/RT e vínculo do peer. Sem ACTIVATE/REMOVE, alteração BGP,
  refresh, nodes 1/2 ou homologação física. Nenhuma operação física incerta foi
  observada antes do rollback.
- Histórico idêntico: 4 ACTIVATE, 4 REMOVE e 3 SIMULATION; nenhum evento adicional.
- PostgreSQL saudável; histórico/checksums de migrations idênticos e tabela durável
  ausente. Nenhuma migration, DDL, restauração de banco ou SQL mutante foi executado.
- n8n RC7.1.2 preservado: activeVersion `6a97fe4a-31ea-49e6-b892-1ac55f85d115`,
  estrutura publicada/configuração/container/restarts inalterados, health 200.
  Nenhuma credencial foi alterada e nenhum teste Telegram foi enviado.
- VNT/Fibinet, GMJ-FLOW, GMJ-SENTINELA e integrações fora do escopo não foram alterados.

## Divergências e decisão

O primeiro envio do verificador excedeu o limite de argumento remoto antes de
criar arquivos ou solicitar restart. A leitura confirmou PIDs/configuração
inalterados; foi reduzido somente o payload da ferramenta de orquestração.
Isso não alterou o pacote e não gerou restart adicional de tentativa.

O bloqueio funcional é o erro real do catálogo na API candidata. Não houve tentativa
de compensá-lo por edição de banco, limpeza de templates, novo build ou nova API.
O rollback foi precedido de leitura Huawei, ausência de locks/operações incertas,
histórico preservado, backup recuperável e conferência da release e78638a.

**NO-GO para aceitar esta publicação e avançar para a migration durável.**
É necessária correção isolada do conflito de ordenação das portas, novo pacote
validado e nova autorização de publicação. Não foi iniciada essa correção nesta
missão. AUTO permanece desligado e nenhuma migration está autorizada por este relatório.

Evidências sanitizadas: [deploy-single-pilot-auto0.json](docs/evidence/deploy-single-pilot-auto0.json).
