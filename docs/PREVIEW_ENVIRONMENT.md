# Ambiente de PREVIEW do GMJ-NetVision

Este documento descreve o ambiente de **Web preview isolada** que roda ao lado da
produção, em outra porta, outro worktree e outra branch — consumindo a **mesma
API real** e o **mesmo PostgreSQL**.

> ⚠️ **Os dados exibidos no preview são os dados REAIS de produção.**
> O preview **não** é sandbox e **não** é um banco separado. Qualquer ação de
> escrita feita nele (excluir host, editar mapa, reconciliar portas, desabilitar
> sessão BGP, alterar usuários…) altera o ambiente de verdade.

## Topologia

```text
                    API REAL :3333
                    PostgreSQL real
                          |
               +----------+----------+
               |                     |
        Web produção             Web preview
           :3000                    :3001
       main (2bdc4f7)      preview/deepseek-ui
  /opt/GMJ-NetVision    /opt/GMJ-NetVision-preview
```

| | Produção | Preview |
| --- | --- | --- |
| Diretório | `/opt/GMJ-NetVision` | `/opt/GMJ-NetVision-preview` |
| Branch | `main` | `preview/deepseek-ui` |
| Web | `0.0.0.0:3000` | `0.0.0.0:3001` |
| API | `127.0.0.1:3333` (compartilhada) | `127.0.0.1:3333` (a **mesma**) |
| Serviço systemd | `netvision-web.service` | `netvision-web-preview.service` |
| Flag de build | (ausente) | `NEXT_PUBLIC_PREVIEW_MODE=true` |

O preview **não** sobe API própria, **não** inicia poller e **não** tem banco
próprio: o browser fala same-origin com o Web de preview e o Next reescreve
`/api/*` para `http://127.0.0.1:3333/api/*`.

## Identificação visual

Com `NEXT_PUBLIC_PREVIEW_MODE=true` o layout raiz monta um wrapper
(`.nv-preview-root`) e uma barra fixa:

> `PREVIEW · INTERFACE EXPERIMENTAL · DADOS DE PRODUÇÃO`

Com a flag ausente ou diferente de `"true"`, o wrapper e a barra não existem na
árvore renderizada: **a produção fica visualmente idêntica**. O layout resolve a
flag no servidor e passa o resultado como prop para o componente de cliente, de
modo que servidor e cliente sempre concordam.

## Operação

### Atualizar o preview

```bash
cd /opt/GMJ-NetVision-preview
sudo bash deploy/update-preview.sh
```

O script (executar como root; os passos de systemd exigem privilégio):

1. valida Linux, diretório, branch `preview/deepseek-ui` e worktree limpo;
2. confere produção `:3000` e API `:3333` **antes** de qualquer mudança;
3. busca somente a branch `preview/deepseek-ui` e aplica **fast-forward only**;
4. instala dependências pelo lockfile (`npm ci`);
5. roda lint, typecheck e testes **apenas de `@gmj/web` e `@gmj/shared`**;
6. builda a Web com `NEXT_PUBLIC_PREVIEW_MODE=true`, `NEXT_PUBLIC_API_URL=` e
   `API_INTERNAL_URL=http://127.0.0.1:3333`;
7. prepara o standalone (copia `public/` e `.next/static/`, valida um asset e
   exige o banner no HTML gerado);
8. instala **somente** `netvision-web-preview.service` e faz `daemon-reload`;
9. reinicia **somente** o preview;
10. valida `:3001` (páginas + asset), confirma o banner e revalida `:3000` e
    `:3333`, abortando se a produção parar de responder.

O script **nunca** usa `git reset --hard`, `git clean`, migration, `prisma
generate`, restart da API ou restart do Web de produção.

### Verificar status

```bash
systemctl is-active netvision-api netvision-web netvision-web-preview
curl -fsS http://127.0.0.1:3333/health
curl -fsSI http://127.0.0.1:3000/
curl -fsSI http://127.0.0.1:3001/
ss -ltnp | grep -E ':(3000|3001|3333)\b'
```

### Ver logs

```bash
journalctl -u netvision-web-preview -n 100 --no-pager
journalctl -u netvision-web-preview -f
```

### Parar / iniciar / reiniciar **somente** o preview

```bash
sudo systemctl stop    netvision-web-preview
sudo systemctl start   netvision-web-preview
sudo systemctl restart netvision-web-preview
```

Esses comandos **não** afetam `netvision-web` nem `netvision-api`: a unit do
preview não declara `After`/`Requires` em nenhum dos dois.

## Provar que a produção continua independente

```bash
# a produção nunca é reiniciada pelo preview
systemctl show -p ActiveEnterTimestamp -p NRestarts netvision-web netvision-api

# existe só uma API e nenhum segundo poller (o poller roda dentro da API)
ps -eo pid,user,comm,args --no-headers | grep -E 'dist/server\.cjs|next-server'

# o banner só existe no preview
curl -fsS http://127.0.0.1:3000/ | grep -c nv-preview-banner   # 0
curl -fsS http://127.0.0.1:3001/ | grep -c nv-preview-banner   # 1

# os dois worktrees e suas branches
sudo git -C /opt/GMJ-NetVision worktree list
```

## Regras obrigatórias

- **Nunca** usar `deploy/update.sh` (produção) para o preview, e **nunca** usar
  `deploy/update-preview.sh` para a produção.
- **Nunca** aplicar migration (`prisma migrate`) nem `prisma generate` pelo
  preview: o banco é o de produção e o preview não deve tocar no schema.
- **Nunca** reiniciar `netvision-api` nem `netvision-web` ao mexer no preview.
- **Nunca** alterar o `.env` de produção. A unit do preview, por decisão de
  projeto, **não** usa `EnvironmentFile`: ela não precisa de segredo nenhum e
  reafirma em runtime `NEXT_PUBLIC_PREVIEW_MODE=true`, `NEXT_PUBLIC_API_URL=`
  (same-origin) e `API_INTERNAL_URL=http://127.0.0.1:3333`, para que nenhum
  `NEXT_PUBLIC_API_URL` herdado desvie o preview da API interna.
- As ações de escrita no preview atingem dados reais: use-o com o mesmo cuidado
  da produção.

## Limitações conhecidas deste servidor

- **Credencial de deploy SSH.** O `origin` do repositório no servidor é SSH e a
  chave de deploy de `root` (`/root/.ssh/id_ed25519`) é protegida por
  passphrase, sem agent disponível. Um `git fetch/pull` não interativo falha com
  `Permission denied (publickey)`. Como o repositório é público, o
  `update-preview.sh` cai automaticamente para leitura **HTTPS anônima** da
  mesma branch, escrevendo no mesmo ref de rastreamento
  (`refs/remotes/origin/<branch>`) e **sem alterar configuração de remote** em
  nenhum repositório. Vale corrigir a credencial (deploy key sem passphrase ou
  token) para que o deploy da produção também funcione de forma não interativa.
- **Exposição externa da porta 3001.** O serviço responde em
  `127.0.0.1:3001` e está ligado em `0.0.0.0:3001`, mas a porta **não** está
  acessível externamente: no host não há regra de firewall (`ufw` inativo,
  `iptables` sem regras) e a liberação é feita na camada de rede/provedor, que
  hoje expõe 2222, 3000 e 3333 e bloqueia 80 e 3001. Abrir a 3001 (NAT do
  provedor, proxy reverso ou TLS) exige decisão explícita de rede e **não** é
  feito por este deploy.
- **Ownership do worktree.** O worktree de preview é criado e atualizado como
  root (o `/opt` e o repositório de produção são de root), então a inspeção com
  git a partir do usuário comum exige `sudo`.
