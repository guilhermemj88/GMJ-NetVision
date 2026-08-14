# Arquitetura do GMJ NetVision

## Limites de responsabilidade

O `Map Engine` compõe nodes, posições, links e preferências visuais. Ele não executa SNMP, SSH nem chamadas Zabbix. Os engines de topologia e métricas fornecem dados normalizados ao mapa.

`TopologyDiscoveryAdapter` possui quatro operações: identificar equipamento, descobrir vizinhos, descobrir interfaces e obter identidade. `LldpSnmpDiscoveryAdapter` encapsula LLDP-MIB. `LldpSshDiscoveryAdapter` delega comandos e parsing a drivers específicos de sistema operacional.

`MetricSourceAdapter` fornece equipamentos, interfaces, métricas atuais e história. `DemoMetricAdapter` gera séries reproduzíveis; `ZabbixAdapter` é a primeira integração real.

## Fluxo de descoberta

```text
ação do operador
  -> DiscoveryService
     -> adapter SNMP
     -> se falhar/vazio: adapter SSH
  -> vizinhos normalizados
  -> correlação por identidade
  -> MATCHED | UNMATCHED | AMBIGUOUS
  -> painel de revisão
  -> aprovação explícita
  -> criação de Device/Interface/Link
```

O modo `AUTO` pode aceitar a posição do layout. O modo `HYBRID` preserva alterações manuais e nodes bloqueados. Descoberta nunca substitui silenciosamente uma associação ambígua.

## Fluxo de métricas

```text
Web -> API GMJ -> MetricSourceAdapter -> Zabbix API
```

O token fica apenas no processo da API. Nomes de item, IDs externos e particularidades do Zabbix são convertidos no backend para chaves canônicas como `interface.rx.bps` e `interface.errors.rx`.

## Persistência

O schema Prisma modela `Map`, `MapNode`, `Device`, `Interface`, `Link`, `DataSource`, credenciais, mappings e jobs/resultados de descoberta. As ligações físicas usam foreign keys para as duas interfaces.

O modo demo usa `DemoMapRepository`, isolado da camada HTTP. A troca por `PrismaMapRepository` não deve alterar rotas nem o domínio compartilhado.

## Credenciais

Campos não secretos (nome, versão, porta, usuário) podem ser indexados normalmente. Communities, senhas, auth/privacy secrets e tokens são serializados e protegidos por AES-256-GCM antes do banco. Em produção, a chave deve vir de KMS/Vault, com rotação e versionamento do envelope.

## Descoberta recursiva futura

O job deve usar uma fila breadth-first com `maxDepth`, `maxDevices`, ranges permitidos, timeout global e aprovação por lote. Cada identidade normalizada é visitada no máximo uma vez. Nenhum crawling recursivo agressivo é iniciado no MVP.
