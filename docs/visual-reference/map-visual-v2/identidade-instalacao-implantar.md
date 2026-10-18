# Identidade da instalação — IMPLANTAR com Mitigação DDoS permanente

Regra do produto: a instalação **IMPLANTAR** disponibiliza **permanentemente**
`BGP → Mitigação DDoS` aos usuários autorizados; as demais instalações não
expõem o módulo (salvo opt-in explícito).

## Por que isto existe

O release da Fase N foi construído numa worktree sem `.env`. A disponibilidade
do módulo dependia só de `NEXT_PUBLIC_DDOS_MITIGATION_UI=true`, que **não foi
inlinada** no bundle — resultado: a aba desapareceu da produção da IMPLANTAR
apesar de o `.env` estar correto. A decisão passou a depender da **identidade da
instalação**, que não se perde no build.

## Identidade

Ordem de precedência (`packages/shared/src/installation-identity.ts`):

1. `NETVISION_INSTALLATION_ID` — identidade configurada (`implantar`);
2. `hostname` do servidor, normalizado (minúsculo, sem domínio) —
   `netvision-implantar`;
3. desconhecida.

Nenhuma comparação é feita por prefixo: `netvision-implantar-2`, `implantar` ou
`netvision-implantarx` **não** são reconhecidos como IMPLANTAR.

## Disponibilidade do módulo

`resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', { hostname, installationId, flag })`

| Situação | Resultado | `reason` |
| --- | --- | --- |
| IMPLANTAR (id ou hostname) | habilitado | `installation-implantar` |
| IMPLANTAR com flag `false`/ausente | habilitado | `installation-implantar` |
| outra instalação + flag `true` | habilitado | `explicit-flag` |
| outra instalação | desabilitado | `installation-not-implantar` |

## Onde a decisão é aplicada

- **Build** (`apps/web/next.config.ts`): injeta `NEXT_PUBLIC_INSTALLATION_HOSTNAME`,
  `NEXT_PUBLIC_INSTALLATION_ID` e o valor efetivo de
  `NEXT_PUBLIC_DDOS_MITIGATION_UI` a partir da mesma função compartilhada.
- **Cliente** (`apps/web/src/lib/feature-flags.ts`): lê os valores inlinados —
  evita “piscar” e funciona sem rede.
- **Runtime** (`GET /installation`, rota própria do Web, fora do proxy `/api/*`):
  devolve `installation.id/source/hostname` e
  `modules.ddosMitigation.enabled/reason`. Corrige o caso de build feito em
  outra máquina.
- **UI** (`apps/web/src/components/bgp/bgp-workspace.tsx` via
  `use-ddos-mitigation-ui.ts`): runtime confirmado vence o build; falha de rede
  mantém o build; payload inválido nunca liga o módulo.

## Segurança

A identidade decide apenas **disponibilidade de interface**. O hostname não é
mecanismo de autorização: as rotas de mitigação da API continuam exigindo sessão
autenticada e o RBAC existente (hook global de autenticação + `requireUser` nas
escritas). Nenhuma política BGP, FlowSpec, blackhole ou motor de mitigação foi
alterado; nada de banco/migration.

## Testes de proteção contra regressão

- `packages/shared/src/installation-identity.test.ts` — tabela completa de
  identidade/disponibilidade, inclusive “IMPLANTAR sem a flag”.
- `apps/web/src/lib/feature-flags.test.ts` — o cenário exato da regressão
  (hostname `netvision-implantar`, flag ausente) tem de continuar habilitado.
- `apps/web/src/app/installation/route.test.ts` — payload da rota, sem segredos.
- `apps/web/src/lib/use-ddos-mitigation-ui.test.ts` — combinação build × runtime.
- `apps/web/src/components/bgp/bgp-workspace.test.tsx` — a aba aparece na
  IMPLANTAR sem flag e continua oculta em outra instalação.

## Operação

- `GET /installation` é o primeiro lugar a conferir em caso de dúvida sobre a
  identidade da instalação (não exige sessão e não expõe segredos).
- Trocar o hostname da IMPLANTAR exige atualizar `IMPLANTAR_HOSTNAME` **ou**
  definir `NETVISION_INSTALLATION_ID=implantar` no `.env`.
