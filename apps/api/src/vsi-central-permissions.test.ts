import dgram from 'node:dgram';
import net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';

/**
 * Matriz de permissoes da central de Diagnostico VSI/VPLS, com o APP COMPLETO (autenticacao real, repositorios demo
 * sinteticos). Sem banco real, sem credenciais reais, sem equipamento: nenhuma leitura pode abrir socket (SSH/SNMP).
 */
const golden = () =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'web', 'src', 'components', 'diagnostics', 'service', 'fixtures', 'engine-replay-3072-vta-mcp.json'), 'utf8'));
const HOST_NAME_IN_RESULTS = 'BHE-VTA-6730-MPLS-01';
const RUN_ID = 'homolog-3072';

type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ENV_KEYS = ['VSI_DIAGNOSTIC_ENABLED', 'VSI_MCP_ENABLED', 'VSI_SERVICE_DIAGNOSTIC_ENABLED', 'VSI_SERVICE_RESULTS_DIR', 'VSI_MCP_SERVICE_ACCOUNTS'] as const;

function sessionCookie(headers: unknown): string {
  const raw = (headers as Record<string, unknown>)['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return String(list.find((v) => typeof v === 'string' && v.startsWith('netvision_session=')) ?? '').split(';')[0] ?? '';
}

interface Setup {
  app: FastifyInstance;
  cookie: Record<Role, string>;
  sockets: { tcp: number; udp: number };
}

let saved: Record<string, string | undefined>;
let dir: string;
let open: FastifyInstance[] = [];
let spies: Array<{ mockRestore(): void }> = [];

async function setup(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<Setup> {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env, { VSI_SERVICE_RESULTS_DIR: dir });
  const app = await buildApp({ requireAuth: true });
  open.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'admin', password: 'admin' } });
  expect(login.statusCode).toBe(200);
  const admin = sessionCookie(login.headers);
  const cookie = { ADMIN: admin } as Record<Role, string>;
  for (const role of ['OPERATOR', 'VIEWER'] as const) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: `sint-${role.toLowerCase()}`, email: `${role.toLowerCase()}@sintetico.local`, name: `Sintetico ${role}`, password: 'sintetica-123', role },
    });
    expect(created.statusCode, `criar ${role}`).toBe(201);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: `sint-${role.toLowerCase()}`, password: 'sintetica-123' } });
    expect(l.statusCode).toBe(200);
    cookie[role] = sessionCookie(l.headers);
  }
  // a partir daqui, qualquer abertura de socket (SSH/SNMP/descoberta) e contada: leituras nao podem abrir nenhum
  const sockets = { tcp: 0, udp: 0 };
  spies.push(
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
      sockets.tcp += 1;
      throw new Error('conexao TCP bloqueada no teste');
    }),
    vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(() => {
      sockets.udp += 1;
      throw new Error('envio UDP bloqueado no teste');
    }),
  );
  return { app, cookie, sockets };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'vsi-central-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...golden(), runId: RUN_ID, completedAt: '2026-11-17T00:15:30.000Z' }));
});
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  for (const app of open) await app.close();
  open = [];
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const get = (s: Setup, url: string, who: Role | null) =>
  s.app.inject({ method: 'GET', url, ...(who ? { headers: { cookie: s.cookie[who] } } : {}) });

describe('leitura da central: sem sessao nada e exposto; com sessao, VIEWER/OPERATOR/ADMIN leem', () => {
  it('inventario/estado: 200 para os tres papeis; resultados detalhados: 200 so OPERATOR/ADMIN, 403 VIEWER, 401 sem sessao (sem nome real no corpo)', async () => {
    const s = await setup({ VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true', VSI_MCP_ENABLED: 'false', VSI_DIAGNOSTIC_ENABLED: 'false' });
    const hosts = (await get(s, '/api/hosts', 'ADMIN')).json() as Array<{ id: string; name: string }>;
    expect(hosts.length).toBeGreaterThan(0);
    const urls = [
      '/api/hosts',
      `/api/hosts/${hosts[0]!.id}/mpls`,
      '/api/diagnostics/status',
      '/api/vsi-mcp/status',
      '/api/vsi-service-diagnostics/status',
      '/api/vsi-service-diagnostics',
      `/api/vsi-service-diagnostics/${RUN_ID}`,
    ];
    const restricted = new Set(['/api/vsi-service-diagnostics', `/api/vsi-service-diagnostics/${RUN_ID}`]);
    for (const url of urls) {
      const anon = await get(s, url, null);
      expect(anon.statusCode, `${url} sem sessao`).toBe(401);
      expect(anon.body, url).not.toContain(HOST_NAME_IN_RESULTS);
      for (const host of hosts) expect(anon.body, url).not.toContain(host.name);
      for (const role of ['VIEWER', 'OPERATOR', 'ADMIN'] as const) {
        const res = await get(s, url, role);
        expect(res.statusCode, `${url} como ${role}`).toBe(restricted.has(url) && role === 'VIEWER' ? 403 : 200);
        // VIEWER nunca recebe nome de equipamento do RESULTADO nem o runId
        if (restricted.has(url) && role === 'VIEWER') {
          expect(res.body, `${url} VIEWER`).not.toContain(HOST_NAME_IN_RESULTS);
          expect(res.body, `${url} VIEWER`).not.toContain(RUN_ID);
        }
      }
    }
    // o corpo para OPERATOR/ADMIN traz os nomes reais; VIEWER e anonimo nunca
    for (const role of ['OPERATOR', 'ADMIN'] as const) expect((await get(s, '/api/vsi-service-diagnostics', role)).body).toContain(HOST_NAME_IN_RESULTS);
    // o status informa ao VIEWER (sem nomes) que nao tem acesso aos resultados
    expect((await get(s, '/api/vsi-service-diagnostics/status', 'VIEWER')).json()).toMatchObject({ enabled: true, resultsAccess: false });
    expect((await get(s, '/api/vsi-service-diagnostics/status', 'OPERATOR')).json()).toMatchObject({ enabled: true, resultsAccess: true });
    expect(s.sockets).toEqual({ tcp: 0, udp: 0 });
  });

  it('com a flag de visualizacao desligada: sem sessao 401; VIEWER 403 (estado nao revelado); OPERATOR/ADMIN 503 na lista', async () => {
    const s = await setup({ VSI_SERVICE_DIAGNOSTIC_ENABLED: 'false' });
    expect((await get(s, '/api/vsi-service-diagnostics', null)).statusCode).toBe(401);
    expect((await get(s, '/api/vsi-service-diagnostics/status', null)).statusCode).toBe(401);
    expect((await get(s, '/api/vsi-service-diagnostics', 'VIEWER')).statusCode).toBe(403);
    for (const role of ['OPERATOR', 'ADMIN'] as const) expect((await get(s, '/api/vsi-service-diagnostics', role)).statusCode).toBe(503);
    for (const role of ['VIEWER', 'OPERATOR', 'ADMIN'] as const) expect((await get(s, '/api/vsi-service-diagnostics/status', role)).json()).toMatchObject({ enabled: false });
  });

  it('cookie de sessao de VIEWER nao abre resultado por identificador, nem por variacao de URL, nem por HEAD', async () => {
    const s = await setup({ VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    for (const url of [`/api/vsi-service-diagnostics/${RUN_ID}`, `/api/vsi-service-diagnostics/${RUN_ID}?x=1`, `/api/vsi-service-diagnostics/${RUN_ID}/`, `/api/vsi-service-diagnostics//${RUN_ID}`, `/api/vsi-service-diagnostics/legacy/h/v/00000000-0000-4000-8000-000000000000`]) {
      const res = await s.app.inject({ method: 'GET', url, headers: { cookie: s.cookie.VIEWER } });
      expect([403, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain(HOST_NAME_IN_RESULTS);
    }
    const head = await s.app.inject({ method: 'HEAD', url: `/api/vsi-service-diagnostics/${RUN_ID}`, headers: { cookie: s.cookie.VIEWER } });
    expect(head.statusCode).toBe(403);
    expect(s.sockets).toEqual({ tcp: 0, udp: 0 });
  });

  it('o detector de sockets funciona: uma tentativa de conexao TCP/UDP seria contada (validade da evidencia de "zero")', async () => {
    const s = await setup({ VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    expect(() => new net.Socket().connect(22, '127.0.0.1')).toThrow('bloqueada');
    expect(() => dgram.createSocket('udp4').send(Buffer.from('x'), 161, '127.0.0.1')).toThrow('bloqueado');
    expect(s.sockets).toEqual({ tcp: 1, udp: 1 });
  });

  it('cookie invalido/forjado nao abre nada', async () => {
    const s = await setup({ VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    for (const url of ['/api/hosts', '/api/vsi-service-diagnostics', '/api/diagnostics/status']) {
      const res = await s.app.inject({ method: 'GET', url, headers: { cookie: 'netvision_session=forjado' } });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('estados do legado e do MCP sao independentes na API (as 4 combinacoes)', () => {
  for (const legacy of [true, false]) {
    for (const mcp of [true, false]) {
      it(`legado=${legacy} MCP=${mcp}: /api/diagnostics/status reflete so o legado e /api/vsi-mcp/status so o MCP`, async () => {
        const s = await setup({
          VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true',
          VSI_DIAGNOSTIC_ENABLED: String(legacy),
          VSI_MCP_ENABLED: String(mcp),
          // sem arquivo de acesso: o MCP ligado nao tem como operar; o teste so le o estado
        });
        const legacyStatus = (await get(s, '/api/diagnostics/status', 'VIEWER')).json();
        expect(legacyStatus.diagnosticEnabled).toBe(legacy);
        const mcpStatus = (await get(s, '/api/vsi-mcp/status', 'VIEWER')).json();
        expect(mcpStatus.enabled).toBe(mcp);
        expect(s.sockets).toEqual({ tcp: 0, udp: 0 });
      });
    }
  }
});

describe('acoes do legado preservadas: permissoes existentes intactas (nada novo, nada removido)', () => {
  it('legado ligado: criar aprovacao = ADMIN; VIEWER/OPERATOR 403; sem sessao 401; diagnosticar com VIEWER 403 antes de qualquer SSH', async () => {
    const s = await setup({ VSI_DIAGNOSTIC_ENABLED: 'true', VSI_MCP_ENABLED: 'false', VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    const approval = '/api/hosts/h1/mpls/vsis/v1/diagnostic-approvals';
    const diagnose = '/api/hosts/h1/mpls/vsis/v1/diagnose';
    expect((await s.app.inject({ method: 'POST', url: approval, payload: {} })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: approval, payload: {}, headers: { cookie: s.cookie.VIEWER } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'POST', url: approval, payload: {}, headers: { cookie: s.cookie.OPERATOR } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'POST', url: diagnose, payload: {} })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: diagnose, payload: {}, headers: { cookie: s.cookie.VIEWER } })).statusCode).toBe(403);
    expect(s.sockets).toEqual({ tcp: 0, udp: 0 });
  });

  it('legado desligado: acoes respondem 503 mesmo com MCP ligado; o MCP nunca religa o legado', async () => {
    const s = await setup({ VSI_DIAGNOSTIC_ENABLED: 'false', VSI_MCP_ENABLED: 'true', VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    expect((await s.app.inject({ method: 'POST', url: '/api/hosts/h1/mpls/vsis/v1/diagnose', payload: {}, headers: { cookie: s.cookie.ADMIN } })).statusCode).toBe(503);
    expect((await get(s, '/api/diagnostics/status', 'ADMIN')).json().diagnosticEnabled).toBe(false);
  });

  it('MCP desligado: as ferramentas MCP e a aprovacao MCP respondem 503 e o legado segue operando (aprovacao legada ADMIN = 201)', async () => {
    const s = await setup({ VSI_DIAGNOSTIC_ENABLED: 'true', VSI_MCP_ENABLED: 'false', VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' });
    expect((await s.app.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: {}, headers: { cookie: s.cookie.ADMIN } })).statusCode).toBe(503);
    expect((await s.app.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h1' }, headers: { cookie: s.cookie.ADMIN } })).statusCode).toBe(503);
    const legacyApproval = await s.app.inject({ method: 'POST', url: '/api/hosts/h1/mpls/vsis/v1/diagnostic-approvals', payload: {}, headers: { cookie: s.cookie.ADMIN } });
    expect(legacyApproval.statusCode).toBe(201);
    expect(s.sockets).toEqual({ tcp: 0, udp: 0 });
  });
});
