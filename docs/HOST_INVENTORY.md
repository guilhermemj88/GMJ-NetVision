# Inventário de hosts, fontes e descoberta assistida

## Modelo

`HostRecord` especializa o `Device` global. Um host pode existir sem mapa e pode participar de vários mapas. `MapNode` continua contendo apenas `deviceId`, posição, lock e origem da posição. Importar um host nunca cria `MapNode`.

As fontes são complementares e independentes:

- Zabbix: status, métricas, histórico e referências de itens;
- SNMP: LLDP e, quando houver transporte configurado, IF-MIB;
- SSH: fallback/complemento de LLDP e dados específicos do fabricante.

O schema persiste `useZabbix`, `sshEnabled` e `snmpEnabled` separadamente, além do estado e dos timestamps seguros de cada fonte. A migration inicial está em `apps/api/prisma/migrations/20260814150000_initial_inventory/migration.sql`.

## Segurança

`CredentialVault` usa AES-256-GCM com IV aleatório. A chave deve ser uma string base64 que decodifique exatamente 32 bytes. A API rejeita novos segredos se `CREDENTIAL_ENCRYPTION_KEY` estiver ausente. Senha SSH, community, senhas SNMPv3 e token Zabbix não aparecem em DTOs, query strings ou erros públicos.

Os objetos de leitura expõem somente `credentialConfigured: boolean`. Em produção, a chave deve vir de um secret manager, a API deve usar TLS e os logs devem ter redaction adicional na camada de observabilidade.

## Importação Zabbix

1. `POST /api/hosts/import/zabbix/preview` consulta a versão, `host.get` e `item.get`.
2. O backend marca correspondências por Zabbix hostid, hostname e IP.
3. O frontend permite pesquisa, filtro, seleção individual e seleção de todos os resultados visíveis.
4. `POST /api/hosts/import/zabbix` recebe `previewId` e apenas os `hostIds` escolhidos.
5. Os Devices são criados sem mapa; interfaces são agrupadas por ifIndex e mantêm referências dos itens.

O modo de autenticação padrão é `AUTH_FIELD`, compatível com Zabbix 6.0.33:

```json
{
  "jsonrpc": "2.0",
  "method": "host.get",
  "params": {},
  "auth": "TOKEN",
  "id": 1
}
```

`apiinfo.version` é a exceção e não recebe autenticação.

## Descoberta incremental

`preview` consulta o seed escolhido, normaliza LLDP, correlaciona inventário/Zabbix e classifica cada vizinho. Ele não altera hosts, nodes, links ou o timestamp da última descoberta.

No `apply`, cada vizinho recebe uma ação explícita:

- `LINK_ONLY`: host e node já presentes; cria somente o link ausente;
- `ADD`: usa host existente ou candidato Zabbix, adiciona node se necessário e cria link;
- `ADD_UNMONITORED`: cria host de origem `DISCOVERY`, node e link;
- `IGNORE`: não altera nada.

Matches ambíguos permanecem ignorados até o operador selecionar um Device. O fluxo não dispara descoberta recursiva.

## Limitações atuais

- O servidor em execução ainda usa `DemoMapRepository` em memória; o schema e a migration PostgreSQL estão prontos, mas falta ligar um repositório Prisma transacional às mesmas portas.
- SNMP e SSH têm adapters e drivers, porém os transportes de sessão concretos não estão configurados nesta versão. Em demo, os botões de teste e LLDP usam implementações demonstrativas.
- A correlação Zabbix cobre os padrões `net.if.*` solicitados; templates customizados podem exigir novas regras.
- Não há RBAC/auditoria de operador nesta versão.
