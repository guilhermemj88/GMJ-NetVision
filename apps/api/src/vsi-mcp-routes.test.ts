import Fastify from 'fastify';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from './infrastructure/mpls/vsi-diagnostic-approval';
import { VsiMcpTools } from './infrastructure/mpls/vsi-mcp/tools';
import { registerVsiMcpRoutes } from './vsi-mcp-routes';
import { approvalScope } from './infrastructure/mpls/vsi-mcp/contracts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const user = (role: AuthUser['role']): AuthUser => ({ id: 'u', username: role.toLowerCase(), role }) as AuthUser;

async function app(current: AuthUser | null, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'vsi-mcp-'));
  dirs.push(dir);
  const approvals = new VsiDiagnosticApprovalStore(dir);
  const consumed: unknown[] = [];
  const tools = new VsiMcpTools({
    hosts: { getHost: async (id) => (id === 'h-a' ? ({ id, name: 'PE-A' } as never) : null) },
    mpls: { listVsis: async () => [] },
    live: null,
    consumeApproval: (...a) => void consumed.push(a),
    audit: () => {},
  });
  const server = Fastify();
  server.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError ? reply.code(400).send({ message: 'Invalid request' }) : reply.code(500).send({ message: String(error) }),
  );
  registerVsiMcpRoutes(server, enabled ? tools : null, async () => current, approvals, { VSI_MCP_ENABLED: enabled ? 'true' : 'false' });
  await server.ready();
  return { server, dir, consumed };
}

describe('vsi-mcp routes', () => {
  it('desligado por padrao: ferramentas e aprovacoes respondem 503; status informa enabled=false', async () => {
    const { server } = await app(user('ADMIN'), false);
    expect((await server.inject({ method: 'GET', url: '/api/vsi-mcp/status' })).json()).toMatchObject({ enabled: false });
    expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: { hostId: 'h-a' } })).statusCode).toBe(503);
    expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a', vsiName: 'X' } })).statusCode).toBe(503);
  });

  it('sem sessao => 401 em todas', async () => {
    const { server } = await app(null);
    for (const [method, url] of [['GET', '/api/vsi-mcp/status'], ['POST', '/api/vsi-mcp/approvals'], ['POST', '/api/vsi-mcp/tools/list_vsi']] as const)
      expect((await server.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
  });

  it('aprovacao: somente ADMIN; escopo vsi-name:<VSI>; one-shot em arquivo 0600', async () => {
    const op = await app(user('OPERATOR'));
    expect((await op.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a', vsiName: 'X' } })).statusCode).toBe(403);

    const admin = await app(user('ADMIN'));
    const res = await admin.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a', vsiName: 'L2-X', ttlSeconds: 60 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ hostId: 'h-a', vsiId: approvalScope('L2-X'), createdBy: 'admin' });
    expect(readdirSync(admin.dir).some((f) => f.endsWith('.json'))).toBe(true);
  });

  it('aprovacao rejeita VSI com metacaractere e campos extras', async () => {
    const { server } = await app(user('ADMIN'));
    for (const payload of [{ hostId: 'h-a', vsiName: 'X; reboot' }, { hostId: 'h-a', vsiName: 'X', command: 'reboot' }])
      expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload })).statusCode).toBe(400);
  });

  it('ferramenta desconhecida => 400; campo "command" => 400', async () => {
    const { server } = await app(user('ADMIN'));
    expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/run_command', payload: {} })).statusCode).toBe(400);
    const r = await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/get_vsi_details', payload: { hostId: 'h-a', vsiName: 'X', command: 'reboot' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('INVALID_INPUT');
  });

  it('VIEWER le dados persistidos; nao executa ao vivo', async () => {
    const { server, consumed } = await app(user('VIEWER'));
    expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: { hostId: 'h-a' } })).statusCode).toBe(200);
    const live = await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/diagnose_vsi', payload: { hostId: 'h-a', vsiName: 'X', approvalId: '11111111-1111-4111-8111-111111111111' } });
    expect(live.statusCode).toBe(403);
    expect(consumed).toHaveLength(0);
  });

  it('query string nao e aceita', async () => {
    const { server } = await app(user('ADMIN'));
    expect((await server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi?cmd=reboot', payload: { hostId: 'h-a' } })).statusCode).toBe(400);
  });
});

describe('escopo da aprovacao de descoberta (approve.sh sem nome de VSI)', () => {
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsi-scope-'));
    dirs.push(dir);
    return new VsiDiagnosticApprovalStore(dir);
  };
  const HOST = 'host-1';

  it('so autoriza a descoberta NESTE host: outro host, escopo de VSI, reuso e expiracao sao recusados', () => {
    const s = store();
    const make = (now?: number) =>
      s.create({ hostId: HOST, vsiId: approvalScope(), createdBy: 'admin', ttlSeconds: 600, ...(now ? { now } : {}) });

    const a = make();
    expect(a.vsiId).toBe('vsi-host:discovery');
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(600_000);
    expect(() => s.consume(a.approvalId, 'outro-host', approvalScope())).toThrow(/nao autoriza/i);
    expect(() => s.consume(a.approvalId, HOST, approvalScope('L2-X'))).toThrow(/nao autoriza/i);
    // As tentativas recusadas NAO consomem: a aprovacao continua valida para o uso correto...
    expect(s.consume(a.approvalId, HOST, approvalScope()).approvalId).toBe(a.approvalId);
    // ...mas uma unica vez.
    expect(() => s.consume(a.approvalId, HOST, approvalScope())).toThrow(/ja utilizada/i);

    const old = make(Date.now() - 3_600_000);
    expect(() => s.consume(old.approvalId, HOST, approvalScope())).toThrow(/expirada/i);
  });

  it('aprovacao de uma VSI nao serve para a descoberta e vice-versa', () => {
    const s = store();
    const vsi = s.create({ hostId: HOST, vsiId: approvalScope('L2-X'), createdBy: 'admin' });
    expect(() => s.consume(vsi.approvalId, HOST, approvalScope())).toThrow(/nao autoriza/i);
  });
});
