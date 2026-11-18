# Auditoria — Diagnóstico VSI/VPLS/MPLS no GMJ-NetVision

Data: 2026-11-09 · Escopo: IMPLANTAR (produção) + repositório · Modo: **somente leitura**

## 0. Resumo executivo

1. **O NetVision já tem um diagnóstico VSI em produção** (`VSI_DIAGNOSTIC_ENABLED=true`, release `6ad9265`, linha AUTO-ALL), com aprovação one-shot, perfil de acesso por host, SSH com host key fixada, allowlist exata de comandos e fixtures reais. A premissa "só existem as 4 rotas SNMP" estava incompleta; a implementação foi feita como **extensão**, não como aplicação paralela.
2. O diagnóstico existente é **homologado apenas para S6730 (V200R021/R022) e S6750 YunShan (V600R024)** e exige **exatamente 1 AC** por VSI. Isso o torna inutilizável para o cenário A (2 ACs) e para NE8000/NE40E.
3. **NE8000/NE40E não têm dados MPLS persistidos** (`MplsDeviceState.supported=false`): a coleta SNMP VPLS não funciona nesses modelos. As VSIs `L2-PPPOE-3901` e a do cenário B **não existem no banco**. SSH é a única fonte.
4. **Não há captura real de NE8000/NE40E no repositório.** Toda a lógica específica desses modelos está marcada `CANDIDATE` (não executa fora do modo de homologação).
5. Nada foi alterado em produção, nos roteadores, no banco, no AUTO-ALL, FAST, lease, journal, flags, allowlist ou n8n (verificado por `git diff` — §6).

## 1. O que já existe

### 1.1 Servidor IMPLANTAR (read-only)

| Item | Achado |
|---|---|
| Acesso | SSH por chave funcionou (`-p 2222`); a senha informada não foi necessária para o SSH. `sudo` foi usado só para ler variáveis do processo da API e o JSON de perfis (sem imprimir segredos) |
| API produção | `netvision-api` (root) → `/opt/netvision-auto-activate/releases/6ad9265…/apps/api`; flags `MITIGATION_MODE=AUTO`, `MITIGATION_LIVE_WRITE_ENABLED=false`, `MITIGATION_AUTO_EXECUTION_ENABLED=0`, `MITIGATION_AUTO_LIFECYCLE_ENABLED=0` (AUTO-ALL em HOLD) |
| MCP | `netvision-mcp` em `127.0.0.1:3335`, release `/opt/netvision-mcp/releases/mcp-5874fe0`; autentica na API com usuário/senha de serviço (`NETVISION_MCP_USERNAME/PASSWORD`) e usa cookie de sessão; `Requires=netvision-api` (reiniciar a API reinicia o MCP) |
| Banco | PostgreSQL 18 local; 1.123 VSIs, 1.280 ACs, 1.405 PWs, 1.715 eventos; coleta de hoje (`lastSeenAt` 2026-11-09 12:41) |
| Inventário Huawei | 8 modelos: S6730 (2), S6750/S6750-H (2), **NE8000 F1A (1: `NE8-IXBR`)**, **NE40 (1: `BHE-VTA-NE40-BRAS-01`)**, MA5800-X15, + 12 hosts sem vendor/modelo preenchido (os `*-MPLS-01` S6730/6720) |
| NE8-IXBR | SSH habilitado, `sshContextCommand = switch virtual-system IMPLANTAR-IXBR` (virtual-system), BGP monitorado |
| BHE-VTA-NE40-BRAS-01 | **SSH desabilitado** no inventário (apenas SNMP) |
| MPLS por host | 16 hosts com `MplsDeviceState`; os 12 S67xx têm VSI/AC/PW suportados; **NE8-IXBR, BHE-VTA-NE40-BRAS-01 e BHE-VTA-F1A-BGP-01: `supported=false`** |
| Perfis do diagnóstico legado | `/etc/netvision/vsi-diagnostic-profiles.json` (0600 root): 4 hosts (3 `VRP_V200`, 1 `YUNSHAN_V600`), operações `VERSION,LSR,LOOPBACKS,VSI,INTERFACE,PING`, validade até 2027-01-23. **Nenhum NE8000/NE40E** |
| Aprovações | `/etc/netvision/vsi-diagnostic-approvals/` (one-shot por arquivo `.consumed`) |
| Capacidade | Disco `/` 88% (8,7 GB livres), 23 diretórios de worktree/release em `/opt` |

### 1.2 Código (base `6ad9265`)

- **SNMP/DB (as 4 rotas)**: `mpls-routes.ts`, `huawei-vpls-snmp.ts`, `prisma-mpls-repository.ts`; modelos `MplsVsi/MplsAc/MplsPw/MplsStateEvent/MplsDeviceState`. Os ACs vêm de ifIndex → `Interface`; **não** há VLAN/QinQ/encapsulamento do AC, **nem MAC**.
- **Diagnóstico VSI legado** (`vsi-diagnostic-*.ts`, ~2.500 linhas + fixtures reais BHE-VTA): VERSION, `display mpls ldp`, `display ip interface brief`, `display vsi name X verbose`, `display interface X`, `display eth-trunk N`, `ping -a`. Fluxo: ADMIN cria aprovação one-shot → OPERATOR/ADMIN executa → job com cancelamento, concorrência 1, fila 5, 90 s.
- **SSH reutilizável**: `SshClientImpl` com modo `diagnostic` (fingerprint fixada, `allowedCommands` exatos, saída ≤128 KiB, prompt confirmado, paginação temporária confirmada). `HostRepository.getDecryptedSshCredentials` (cofre).
- **MCP** (`tools/mcp-netvision`): ~30 ferramentas (repo, build, serviços, hosts, interfaces, LLDP, BGP); **nenhuma de VSI/MPLS**.
- **Guard da mitigação** (`read-only-command-guard.ts`): allowlist **não** inclui `display vsi`, `display mpls`, `display mac-address`; não deve ser alterado.

## 2. O que falta (lacunas confirmadas)

| # | Lacuna | Evidência |
|---|---|---|
| G1 | Nenhuma ferramenta MCP de VSI | `server.ts` |
| G2 | Lista de ACs ignorada: o legado falha com `AC_NOT_PROVEN` se `attachments.length !== 1` | `vsi-diagnostic-ssh.ts` (`interfaceAfterVsi`) |
| G3 | Plataforma fixa a 2 versões de switch (`UNHOMOLOGATED_PLATFORM`); NE8000/NE40E não suportados | idem |
| G4 | Sem leitura de configuração de interface (Dot1Q/QinQ/stacking/mapping/rewrite/`l2 binding vsi`) | `vsi-diagnostic-policy.ts` |
| G5 | Sem consulta de MAC por VSI | idem |
| G6 | Sem comparação das duas pontas (existe só a sonda recíproca de ping) | — |
| G7 | NE8000/NE40E sem coleta SNMP VPLS e sem capturas reais | banco + fixtures |
| G8 | Perfil legado: `operations` ≤ 8 e enum fechado; `platform` ∈ {VRP_V200, YUNSHAN_V600} | `vsi-diagnostic-ssh.ts` |
| G9 | `SshClientImpl` só aceita **um** comando condicional pós-VSI (`display interface`) | `ssh-client-impl.ts` |

## 3. O que pode ser reutilizado (e foi)

`SshClientImpl` (modo diagnóstico), cofre de credenciais, `VsiDiagnosticApprovalStore`, `isCompleteObservation`, `safeVsiOutput`, `diagnosticSessionPreparation`, `MplsRepository.listVsis`, `interfaceName()` da política legada, autenticação por cookie/`AuthUser`, padrão de feature flag e de rota. **Nenhum cliente SSH, inventário ou banco paralelo foi criado.**

## 4. Riscos e dependências

| Risco | Mitigação adotada / recomendação |
|---|---|
| Sintaxe VRP de NE8000 ≠ NE40E ≠ S67xx; sem captura real | Matriz de capacidades por família; células novas = `CANDIDATE` (só em modo homologação, ADMIN); `NOT_SUPPORTED` explícito |
| `display mac-address vsi <vsi>` e `display current-configuration interface <if>` ainda não observados em hardware | Mesma matriz; **procedimento de homologação** (docs/VSI_MCP_DIAGNOSTICS.md §6) |
| MCP concentra poder (`repo_write_file`, `prisma_migrate_deploy`, `apply_lldp_topology`…) — pré-existente | Novas ferramentas só consultam; **não** existe ferramenta para criar a aprovação one-shot (ato humano ADMIN) nem parâmetro de comando |
| Aprovação one-shot é consumida antes de validar perfil/SSH | Comportamento herdado; documentado. Falha de perfil/SSH exige nova aprovação |
| `netvision-mcp` depende de `netvision-api` | Publicação futura exige janela; **nenhum restart foi feito** |
| NE8-IXBR usa `virtual-system`; contexto no modo diagnóstico nunca foi exercitado ao vivo | Contexto suportado no coletor e em teste com cliente falso; validar na homologação |
| NE40 BRAS sem SSH no inventário | Habilitar SSH só com autorização; senão resultado `NOT_SUPPORTED/ERROR` |
| Disco 88% | Evitar novas releases sem limpeza (ver `RELATORIO-LIMPEZA-DISCO-IMPLANTAR.md`) |
| Senha de sudo informada em texto no chat | **Recomendo rotacionar**; o acesso por chave já bastava |

## 5. Arquitetura recomendada (implementada)

```
MCP (8 tools, finas) ──HTTP──▶ POST /api/vsi-mcp/tools/:tool   (flag VSI_MCP_ENABLED, default off)
                                   │ valida zod .strict() · papel · aprovação one-shot (escopo vsi-name:<VSI>)
                                   ▼
                         VsiMcpTools (serviço)
        ┌──────────────────────────┼───────────────────────────┐
   persistido (SNMP/DB)       coletor ao vivo              correlator
   MplsRepository.listVsis    SshVsiMcpLiveCollector       diagnoseEndpoint / compareEndpoints
                              ├ perfil próprio (VSI_MCP_ACCESS_FILE)
                              ├ matriz de capacidades por família
                              ├ command-policy (display-only, enum fechado)
                              └ SshClientImpl modo diagnóstico (host key fixada, allowlist exata)
```

- Sob demanda, **sem polling**; ≤2 sessões SSH simultâneas no processo, 1 por host, 12 s/comando, 45 s/sessão, 90 s/chamada.
- Sem migrations. Sem alteração do diagnóstico legado nem do seu arquivo de perfil.

## 6. Isolamento do AUTO-ALL (prova)

`git diff --name-status 6ad9265..HEAD` (branch `feature/vsi-mcp-diagnostics`): 15 arquivos **novos** + 2 **modificados** apenas com adições (`apps/api/src/routes.ts` +22, `tools/mcp-netvision/src/server.ts` +5). Nenhum caminho contendo `mitigation|fast|lease|outbox|journal|allowlist|n8n|flow|sentinela|worker|bgp`. O guard da mitigação não foi importado nem editado. Nada de GMJ-FLOW/GMJ-SENTINELA. Sem deploy, sem restart, sem escrita no banco, sem SSH aos roteadores nesta auditoria.

## 7. Limites desta auditoria (o que NÃO foi feito/provado)

- **Nenhum comando foi enviado a roteador** (a infra de perfis/aprovações é root-only e exige ato humano); portanto **nenhuma sintaxe de NE8000/NE40E foi validada em hardware**.
- Fixtures de NE8000/NE40E e dos cenários A/B são **sintéticas** (marcadas). A lógica foi testada contra o formato, não contra o equipamento.
- Os cenários A e B reproduzem os históricos como regressão **do correlator**; não é prova de causa das falhas originais.
