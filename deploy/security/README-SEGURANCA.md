# Seguranca permanente da API NetVision (RBAC + firewall + transporte)

Nada aqui e aplicado por deploy automatico. Ordem de adocao (cada passo com autorizacao explicita):

1. **Release com RBAC** (`feature/auto-all-rbac-firewall`): ACTIVATE/REMOVE exigem ADMIN/OPERATOR; VIEWER so STATUS/SIMULATE;
   `policies/reconcile/apply` so ADMIN; `MITIGATION_MANUAL_ALLOWED_PROFILE_IDS=<perfil AGLINK>` restringe a escrita manual
   (painel, API e n8n); o processo **nao sobe** com `MITIGATION_LIVE_WRITE_ENABLED=true` sem essa lista. Acesso de emergencia:
   sessao ADMIN pode RETIRAR qualquer perfil (nunca ativar fora da lista); CLI local `e0-command.sh` usa a sessao ADMIN existente.
2. **Origem do n8n** (opcional, defesa em profundidade): `NETVISION_N8N_ALLOWED_SOURCE_IPS=179.189.80.25` (endereco do socket,
   nunca X-Forwarded-For). O IP **nao autentica**: token e `mitigationRef` continuam obrigatorios.
3. **Firewall permanente**: `netvision-firewall.sh` + `netvision-firewall.service` (`/etc/netvision/firewall.env` com
   `N8N_EGRESS=179.189.80.25` e `PANEL_CIDRS=<redes dos operadores>`). :3333 so n8n+loopback; :3000 so loopback; :80 so PANEL_CIDRS;
   SSH e demais portas nao sao tocados. Teste: `bash test-netvision-firewall.sh` (firewall simulado, 24 verificacoes).
   Reversao imediata: `netvision-firewall.sh remove`. Prova externa depois de aplicar: de fora :3333/:3000 = 000; do n8n /health = 200.
4. **Transporte n8n -> NetVision** (hoje HTTP puro com bearer): `nginx-n8n-tls.conf` (TLS 1.2/1.3 na :8443; expoe so os 3 caminhos do n8n: comando, cancelamento de escopo e grafico assinado `/media/snapshot/<token>.png`; `allow` so do n8n). Exige publicar no n8n uma versao com a URL `https://45.163.144.8:8443/...` e confianca no
   certificado (CA/pino): e uma mudanca de workflow (RC7.1.5), a fazer em janela propria. Alternativa equivalente: tunel
   IPsec/WireGuard entre o servidor do n8n e o NetVision.
5. Pendencias de segredo: rotacionar a chave da API do n8n; trocar o usuario de servico do MCP (hoje ADMIN) por um VIEWER
   de leitura e manter o ADMIN so para o CLI de emergencia.

6. **Achados do laboratorio isolado (firewall + TLS, 27 verificacoes)**: (a) sem a tabela `filter` do ip6tables o `apply` desfazia tambem o IPv4 — corrigido (so aceita sem IPv6 se o host nao tem IPv6 global); (b) o RC7.1.4 usa DOIS endpoints de escrita e baixa o grafico por GET assinado, entao o terminador TLS expoe os tres e `SNAPSHOT_PUBLIC_API_URL` precisa passar a `https://<servidor>:8443` junto com a RC7.1.5; (c) certificado autoassinado: o n8n recusa (curl 60) ate confiar/fixar o certificado — exige acesso ao host do n8n (`NODE_EXTRA_CA_CERTS`) ou CA publica/tunel.
