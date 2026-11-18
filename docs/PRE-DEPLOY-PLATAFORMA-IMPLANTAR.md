# Checklist pré-deploy — plataforma dos equipamentos autorizados

Documento da **P4-a (3ª auditoria)**. A política fail-closed (M1/M2/P4) exige fabricante e
modelo que identifiquem Huawei VRP antes de qualquer comando Huawei. Este checklist
responde, **sem tocar em cadastro e sem abrir sessão em equipamento**, quem mantém e quem
perde autorização com a release nova — e é a evidência que a aprovação de deploy precisa
apresentar.

## Regra de ouro

Nada aqui corrige dados. Divergência de cadastro é corrigida **manualmente e de forma
consciente** pelo operador. O script só lê.

## 1. Executar o pré-flight (somente leitura)

No host da aplicação, com a release nova instalada e **antes** de reiniciar o serviço:

```bash
cd /opt/GMJ-NetVision
npm run platform:preflight            # tabela legível
npm run platform:preflight -- --json  # saída para anexar ao ticket
```

O comando faz apenas `findMany`/`groupBy` nas tabelas `Device`, `BgpPeer` e
`BgpMitigationProfile`, mais a leitura de `MITIGATION_ALLOWED_DEVICE_IDS` do ambiente.
Não escreve, não abre SSH, não liga/desliga AUTO-ALL.

Códigos de saída:

| Código | Significado | Ação |
| --- | --- | --- |
| `0` | ninguém perde autorização | pode prosseguir |
| `1` | há dispositivo com `PERDE` preenchido | **revisar antes de publicar** |
| `2` | falha ao ler o banco | investigar; não publicar |

## 2. Colunas do relatório

| Coluna | O que significa |
| --- | --- |
| `HOST` | `hostname` do cadastro |
| `PLATAFORMA` | `HUAWEI_VRP`, `JUNIPER_JUNOS` ou `UNSUPPORTED` (classificação de `bgp-vendor`) |
| `CONTEXTOS` | `AUTO` (AUTO-ALL: allowlist, profiles ou piloto F1A) e/ou `BGP_ADMIN` |
| `PERDE` | contextos que deixam de funcionar com a política nova |
| `MOTIVO` | por que: fabricante ausente, contraditório, OLT, Juniper, não suportado |

`AUTO` inclui **o alvo do piloto AUTO-ALL (F1A)** mesmo que ele não tenha profile
persistido — o piloto é identificado pela constante do worker (`SINGLE_AUTO_PILOT`).

## 3. Checklist de aceite

Marcar cada item; qualquer "não" bloqueia a publicação.

- [ ] `npm run platform:preflight` executado no ambiente da IMPLANTAR, com a release nova
      instalada e antes do restart.
- [ ] Saída (tabela ou `--json`) anexada ao registro da publicação.
- [ ] Código de saída `0`, **ou** cada linha com `PERDE` teve decisão registrada:
      cadastro corrigido manualmente, ou autorização aceita como perdida.
- [ ] Nenhuma alteração de cadastro foi feita pelo script (conferir `git status` do
      repositório e ausência de escrita no banco).
- [ ] `MITIGATION_ALLOWED_DEVICE_IDS` conferido — o conteúdo da variável é o que define
      hoje a leitura/escrita real de mitigação.
- [ ] Piloto F1A aparece no relatório como `AUTO` (prova de que não foi omitido).
- [ ] Juniper aparece como `JUNIPER_JUNOS` (somente leitura) e **sem** `AUTO` autorizado
      depois da política.
- [ ] Nenhum equipamento com fabricante/modelo contraditório (ex.: `Huawei` + `MX204`)
      ficou marcado como `HUAWEI_VRP`.

## 4. O que o pré-flight NÃO faz

- Não corrige `vendor`/`model`.
- Não altera allowlist (`MITIGATION_ALLOWED_DEVICE_IDS`) nem perfis de mitigação.
- Não executa comando em equipamento.
- Não liga, desliga ou reconfigura o AUTO-ALL.
- Não substitui o teste funcional da release.

## 5. Relação com o opt-in do fallback CLI (A1-e)

Equipamento protegido pelo AUTO-ALL (allowlist, profile `AUTO` ou F1A) **não aceita**
habilitação do fallback CLI MPLS: a rota `PUT /api/hosts/:hostId/mpls/ssh-fallback`
responde `409 AUTO_ALL_PROTECTED_DEVICE` e registra a tentativa em
`MplsSshFallbackAudit`. Se o pré-flight mostrar que um equipamento do AUTO-ALL vai perder
autorização, a decisão sobre o fallback CLI é posterior e separada — e continua exigindo
política explícita.
