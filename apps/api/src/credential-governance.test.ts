import Fastify from 'fastify';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from './infrastructure/mpls/vsi-diagnostic-approval';
import { VsiMcpTools } from './infrastructure/mpls/vsi-mcp/tools';
import { fakeCollector, host } from './infrastructure/mpls/vsi-mcp/__fixtures__/harness';
import { registerVsiMcpRoutes } from './vsi-mcp-routes';

/**
 * F-05: inventario FECHADO dos pontos que chamam `getDecryptedSshCredentials` (o cofre) fora do broker.
 * Um chamador novo faz este teste falhar: entrar na lista exige revisao consciente.
 * F-06: matriz de autorizacao que governa o MCP e a lacuna conhecida (papel da conta de servico nao e imposto).
 */
const SRC = resolve(__dirname);

function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'generated' || name === 'scripts' || name === '__fixtures__') continue;
      out.push(...sources(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('F-05: consumidores do cofre de credenciais SSH', () => {
  const CALL = /\.getDecryptedSshCredentials\s*\(/g;
  const calls = Object.fromEntries(
    sources()
      .map((f) => [rel(f), (readFileSync(f, 'utf8').match(CALL) ?? []).length] as const)
      .filter(([, n]) => n > 0),
  );

  it('os pontos de chamada sao exatamente estes; qualquer novo chamador reprova', () => {
    expect(calls).toEqual({
      // dentro do broker: unico caminho do motor VSI/MCP
      'infrastructure/mpls/vsi-mcp/ssh-credential-broker.ts': 1,
      // FORA do broker (nao migrados nesta etapa)
      'infrastructure/bgp/huawei-bgp-ssh.ts': 1, // BGP/mitigacao
      'infrastructure/bgp/juniper-junos-bgp-ssh.ts': 1, // BGP Juniper: descoberta e rotas anunciadas, SOMENTE LEITURA (5 comandos `show`)
      'infrastructure/mpls/huawei-vsi-ssh.ts': 1, // VSI/VPLS+VPWS/LDP Huawei, SOMENTE LEITURA (`display`, sempre atras de assertReadOnlyCommand)
      'infrastructure/mpls/vsi-diagnostic-ssh.ts': 2, // diagnostico VSI LEGADO (ativo em producao)
      'infrastructure/ssh/optical-threshold-service.ts': 1, // limiares opticos
      'infrastructure/ssh/ssh-interface-service.ts': 2, // leitura de interfaces
      'routes.ts': 1, // descoberta LLDP por SSH
      // delegacao do adaptador de demonstracao (sem cofre real)
      'infrastructure/persistence/demo-host-repository-adapter.ts': 1,
    });
  });

  it('o motor VSI/MCP nao esta entre os chamadores diretos (so o proprio broker)', () => {
    const vsi = Object.keys(calls).filter((f) => f.startsWith('infrastructure/mpls/vsi-mcp/') || f.startsWith('infrastructure/mpls/vsi-service/'));
    expect(vsi).toEqual(['infrastructure/mpls/vsi-mcp/ssh-credential-broker.ts']);
  });

  it('o cofre so e instanciado na composicao da API e no observador SNMP (nada no preview nem no motor VSI)', () => {
    const vault = sources().filter((f) => /new CredentialVault\(/.test(readFileSync(f, 'utf8'))).map(rel).sort();
    expect(vault).toEqual(['mitigation-fast-observer-main.ts', 'routes.ts']);
  });
});

describe('F-06: autorizacao do MCP (matriz por papel) e lacuna conhecida', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const user = (role: AuthUser['role']): AuthUser => ({ id: 'u', username: role.toLowerCase(), role }) as AuthUser;

  async function app(current: AuthUser | null) {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'));
    dirs.push(dir);
    const approvals = new VsiDiagnosticApprovalStore(dir);
    const { collector } = fakeCollector({});
    const consume = vi.fn();
    const tools = new VsiMcpTools({
      hosts: { getHost: async (id: string) => (id === 'h-a' ? host('h-a', 'PE-A') : null) },
      mpls: { listVsis: async () => [] },
      live: collector,
      consumeApproval: consume,
      audit: () => {},
    });
    const server = Fastify();
    server.setErrorHandler((error, _req, reply) =>
      error instanceof ZodError ? reply.code(400).send({ message: 'Invalid request' }) : reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: 'erro' }),
    );
    registerVsiMcpRoutes(server, tools, async () => current, approvals, { VSI_MCP_ENABLED: 'true' });
    await server.ready();
    return { server, consume };
  }

  const approve = (s: Awaited<ReturnType<typeof app>>['server']) => s.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a', vsiName: 'X' } });
  const live = (s: Awaited<ReturnType<typeof app>>['server'], extra: Record<string, unknown> = {}) =>
    s.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: { hostId: 'h-a', source: 'LIVE', probe: 'VERSION', approvalId: '11111111-1111-4111-8111-111111111111', ...extra } });

  it('matriz: criar aprovacao so ADMIN; executar ao vivo ADMIN/OPERATOR; homologacao so ADMIN; VIEWER e anonimo nada', async () => {
    const rows: Array<[string, AuthUser | null, number, number, number]> = [
      // papel, usuario, criar aprovacao, executar ao vivo, executar com homologation=true
      ['anonimo', null, 401, 401, 401],
      ['VIEWER', user('VIEWER'), 403, 403, 403],
      ['OPERATOR', user('OPERATOR'), 403, 200, 403],
      ['ADMIN', user('ADMIN'), 201, 200, 200],
    ];
    for (const [name, who, create, run, homolog] of rows) {
      const { server } = await app(who);
      expect((await approve(server)).statusCode, `criar aprovacao: ${name}`).toBe(create);
      expect((await live(server)).statusCode, `ao vivo: ${name}`).toBe(run);
      expect((await live(server, { homologation: true })).statusCode, `homologacao: ${name}`).toBe(homolog);
    }
  });

  it('o MCP NAO tem ferramenta nem chamada para criar aprovacao (ato humano de ADMIN)', () => {
    const mcpSrc = resolve(SRC, '..', '..', '..', 'tools', 'mcp-netvision', 'src');
    const files = readdirSync(mcpSrc).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(mcpSrc, f), 'utf8'), f).not.toMatch(/vsi-mcp\/approvals|diagnostic-approvals/);
  });

  it('LACUNA CONHECIDA (F-06): nada impoe o papel da conta de servico do MCP; se ela for ADMIN, a API aceita a criacao de aprovacao por ela', async () => {
    const { server } = await app(user('ADMIN')); // sessao de uma conta de servico configurada (erradamente) como ADMIN
    expect((await approve(server)).statusCode).toBe(201);
    // O que mitiga hoje: o servidor MCP nao expoe esse endpoint (teste acima). O que falta: validar o papel na subida do MCP
    // (/api/auth/me) e/ou lista de contas de servico sem direito de criar aprovacao. Ver o documento de correcoes.
  });
});
