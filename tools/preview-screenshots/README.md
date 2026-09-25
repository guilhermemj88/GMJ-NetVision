# Screenshots do preview (driver CDP)

Ferramenta de apoio para a fase de redesign: tira screenshots das telas do
NetVision (autenticadas ou não) sem adicionar dependências ao projeto.

Usa o **Chrome DevTools Protocol** por WebSocket nativo do Node 20+ e o Edge/Chrome
em modo headless. Nada é instalado no repositório.

## Como funciona

1. abre o Edge headless com `--remote-debugging-port=9222`;
2. conecta no target da página e faz o login **pela própria página**
   (`fetch('/api/auth/login')` same-origin), para que o cookie `httpOnly` seja
   gravado pelo browser;
3. navega até a URL pedida, espera e opcionalmente executa um `--eval` (por
   exemplo, clicar num preset antes de capturar);
4. salva o PNG e imprime os erros de console e as respostas HTTP ≥ 400 — útil
   para descobrir bloqueios de asset sem abrir o devtools.

## Uso

```bash
# 1. Edge headless com debug
msedge --headless=new --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tmp/nv-edge about:blank &

# 2. captura
node tools/preview-screenshots/nv-shot.mjs \
  --url http://localhost:3000/ \
  --out /tmp/shots/mapa.png \
  --login-user admin --login-pass admin \
  --width 1920 --height 1080 --wait 9000

# 3. com interação antes da captura
node tools/preview-screenshots/nv-shot.mjs \
  --url http://localhost:3000/ --out /tmp/shots/topologia.png \
  --login-user admin --login-pass admin --wait 7000 \
  --eval "(() => { const b=[...document.querySelectorAll('.map-rail button')].find(x=>x.textContent.trim()==='Topologia'); b?.click(); return !!b; })()"
```

Opções: `--url --out --width --height --wait --eval --eval-wait --login-user
--login-pass --port`.

## Armadilhas conhecidas

- **Use `localhost`, não `127.0.0.1`, no `next dev`.** O Next 16 bloqueia
  requisições "cross-origin" a recursos de dev quando o host não é o esperado
  (`Blocked cross-origin request to Next.js dev resource ... from "127.0.0.1"`),
  o que derruba os chunks JS e deixa a página presa no HTML pré-renderizado
  ("Verificando sessão"). Em build de produção isso não acontece.
- O login cria uma sessão real na API. Em produção **não** faça login nem ações
  de escrita só para capturar tela sem autorização explícita.
- O preview em `:3001` não é exposto externamente; para capturar do lado de fora
  use um túnel SSH (`plink -L 3301:127.0.0.1:3001`) e aponte o driver para
  `http://127.0.0.1:3301/` (é build de produção, então o bloqueio acima não se
  aplica).
