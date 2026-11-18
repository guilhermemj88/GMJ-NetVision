import Fastify from 'fastify';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser, VsiDiagnosticResult } from '@gmj/shared';
import { VsiMcpTools } from './infrastructure/mpls/vsi-mcp/tools';
import { CDB, CDB_RECORDINGS, CDB_VSI, cdbHost, cdbInventory, replayCollector } from './infrastructure/mpls/vsi-service/__fixtures__/replay';
import { VsiServiceDiagnosticService } from './infrastructure/mpls/vsi-service/service';
import { VsiServiceResultArchive } from './infrastructure/mpls/vsi-service/archive';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerVsiServiceDiagnosticRoutes } from './vsi-service-diagnostic-routes';

const user = (role: AuthUser['role']): AuthUser => ({ id: 'u', username: role.toLowerCase(), role }) as AuthUser;
const AT = '2026-11-16T14:00:00.000Z';
const A = '11111111-1111-4111-8111-111111111111';
const URL = '/api/vsi-service-diagnostics';
const body = { vsiName: CDB_VSI, includeMac: false, homologation: true, endpoints: [{ hostId: CDB.likee, approvalId: A, carrierInterfaces: ['Eth-Trunk17'], eTrunkIds: [4] }, { hostId: CDB.vta }] };

const LEGACY: VsiDiagnosticResult = {
  diagnosticId: '55555555-5555-4555-8555-555555555555', hostId: 'h-a', vsiId: 'v1', vsiName: 'VSI-LEGADO',
  operator: { id: 'u', username: 'admin', role: 'ADMIN' }, state: 'COMPLETED', stage: 'DONE', startedAt: AT, completedAt: AT,
  overallStatus: 'OK', summary: 'Sem falhas.', underlayClassification: 'UNDERLAY_REACHABLE',
  local: { hostId: 'h-a', name: 'PE-A', vsiId: 'v1', vsiName: 'VSI-LEGADO', loopback: null, association: 'LOCAL' },
  remotes: [], checks: [],
  evidence: [{ id: 'ev-1', hostId: 'h-a', source: 'LIVE_SSH', observedAt: null, collectedAt: AT, command: 'ping -a 10.0.0.1 -c 3 10.0.0.2', output: '3 packet(s) received' }],
  probes: [{ sourceHostId: 'h-a', destinationHostId: 'h-b', source: '10.0.0.1', destination: '10.0.0.2', routingContext: 'GLOBAL', lossPercent: 0, rttMs: { min: 1, avg: 2, max: 3 }, hops: [], status: 'OK', transmitted: 3, received: 3 }],
  warnings: [], nextTests: [],
};

async function app(current: AuthUser | null, flags: { service?: boolean; mcp?: boolean; archiveDir?: string } = {}) {
  const enabled = flags.service ?? true;
  const { collector, sessions } = replayCollector(CDB_RECORDINGS, { family: 'S6730_V200', completedAt: AT });
  const deps = { hosts: { getHost: async (id: string) => cdbHost(id) }, mpls: { listVsis: async (id: string) => cdbInventory(id) } };
  const tools = new VsiMcpTools({ ...deps, live: collector, consumeApproval: vi.fn(), audit: vi.fn(), now: () => new Date(AT) });
  const service = (flags.mcp ?? true) ? new VsiServiceDiagnosticService({ ...deps, tools, engineVersion: 'test', now: () => new Date(AT) }) : null;
  const legacyGet = vi.fn((id: string) => {
    if (id !== LEGACY.diagnosticId) throw Object.assign(new Error('nao encontrado'), { statusCode: 404 });
    return LEGACY;
  });
  const server = Fastify();
  server.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError ? reply.code(400).send({ message: 'Invalid request' }) : reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: String(error) }),
  );
  registerVsiServiceDiagnosticRoutes(server, service, { get: legacyGet }, async () => current, { VSI_SERVICE_DIAGNOSTIC_ENABLED: enabled ? 'true' : 'false' }, flags.archiveDir ? new VsiServiceResultArchive(flags.archiveDir) : null);
  await server.ready();
  return { server, sessions, legacyGet };
}

describe('vsi-service-diagnostics routes', () => {
  it('desligado por padrao: tudo responde 503 e nenhuma coleta acontece', async () => {
    const { server, sessions, legacyGet } = await app(user('ADMIN'), { service: false });
    expect((await server.inject({ method: 'GET', url: `${URL}/status` })).json()).toEqual({ enabled: false, resultsAccess: true, engineAvailable: false, legacyAvailable: false, archiveAvailable: false });
    expect((await server.inject({ method: 'GET', url: URL })).statusCode).toBe(503);
    expect((await server.inject({ method: 'POST', url: URL, payload: body })).statusCode).toBe(503);
    expect((await server.inject({ method: 'GET', url: `${URL}/${A}` })).statusCode).toBe(503);
    expect((await server.inject({ method: 'GET', url: `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}` })).statusCode).toBe(503);
    expect(sessions).toEqual([]);
    expect(legacyGet).not.toHaveBeenCalled();
  });

  it('desligado e sem sessao: 401 (o estado do recurso nao e revelado a quem nao esta logado)', async () => {
    const { server } = await app(null, { service: false });
    for (const [method, url] of [['GET', `${URL}/status`], ['GET', URL], ['POST', URL], ['GET', `${URL}/${A}`], ['GET', `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}`]] as const)
      expect((await server.inject({ method, url, payload: body })).statusCode, `${method} ${url}`).toBe(401);
  });

  it('sem sessao => 401 em todas', async () => {
    const { server, sessions } = await app(null);
    for (const [method, url] of [['GET', `${URL}/status`], ['POST', URL], ['GET', `${URL}/${A}`], ['GET', `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}`]] as const)
      expect((await server.inject({ method, url, payload: body })).statusCode, url).toBe(401);
    expect(sessions).toEqual([]);
  });

  it('VIEWER nao executa; sem o motor VSI/MCP a execucao responde 503', async () => {
    const viewer = await app(user('VIEWER'));
    expect((await viewer.server.inject({ method: 'POST', url: URL, payload: body })).statusCode).toBe(403);
    expect(viewer.sessions).toEqual([]);
    const noEngine = await app(user('ADMIN'), { mcp: false });
    expect((await noEngine.server.inject({ method: 'POST', url: URL, payload: body })).statusCode).toBe(503);
    expect((await noEngine.server.inject({ method: 'GET', url: `${URL}/status` })).json()).toMatchObject({ enabled: true, engineAvailable: false });
  });

  it('pedido com campo desconhecido, comando livre ou PE demais e recusado antes de qualquer coleta', async () => {
    const { server, sessions } = await app(user('ADMIN'));
    const bad = [
      { ...body, command: 'display current-configuration' },
      { ...body, endpoints: [{ hostId: CDB.likee, approvalId: A, command: 'reset' }] },
      { ...body, endpoints: [{ hostId: CDB.likee, carrierInterfaces: ['Eth-Trunk17; reboot'] }] },
      { ...body, endpoints: Array.from({ length: 7 }, (_, i) => ({ hostId: `h-${i}` })) },
      { ...body, vsiName: 'x; display' },
      { ...body, endpoints: [] },
    ];
    for (const payload of bad) expect((await server.inject({ method: 'POST', url: URL, payload })).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    expect(sessions).toEqual([]);
  });

  it('executa, devolve VsiServiceDiagnosis e o mesmo resultado fica disponivel pelo runId', async () => {
    const { server, sessions } = await app(user('OPERATOR'));
    const res = await server.inject({ method: 'POST', url: URL, payload: { ...body, homologation: false } });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ schemaVersion: 1, engine: 'VSI_MCP', origin: 'ENGINE_RUN', vsiName: CDB_VSI, operator: { username: 'operator', role: 'OPERATOR' } });
    expect(d.endpoints.map((e: { hostName: string; collection: string }) => [e.hostName, e.collection])).toEqual([
      ['BHE-LIKEE-6730-MPLS-01', 'PARTIAL'],
      ['BHE-VTA-6730-MPLS-01', 'NOT_READ'],
      ['BHE-MQT-6730-MPLS-01', 'NOT_READ'],
    ]);
    expect(sessions.map((s) => s.hostId)).toEqual([CDB.likee]);
    expect((await server.inject({ method: 'GET', url: `${URL}/${d.runId}` })).json()).toEqual(d);
    expect((await server.inject({ method: 'GET', url: `${URL}/66666666-6666-4666-8666-666666666666` })).statusCode).toBe(404);
    // o id deixou de ser so UUID (resultados de arquivo tem id proprio), mas continua restrito a um formato fechado
    expect((await server.inject({ method: 'GET', url: `${URL}/nao-existe` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: `${URL}/id%20com%20espaco` })).statusCode).toBe(400);
  });

  it('homologation=true exige ADMIN (regra do motor preservada)', async () => {
    const { server, sessions } = await app(user('OPERATOR'));
    expect((await server.inject({ method: 'POST', url: URL, payload: body })).statusCode).toBe(403);
    expect(sessions).toEqual([]);
  });

  it('legado: converte o job sem perder evidencia nem conectividade', async () => {
    const { server } = await app(user('OPERATOR'));
    const res = await server.inject({ method: 'GET', url: `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}` });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ engine: 'LEGACY', origin: 'LEGACY_JOB', runId: LEGACY.diagnosticId, verdict: { status: 'OK' } });
    expect(d.evidence[0]).toMatchObject({ id: 'ev-1', command: 'ping -a 10.0.0.1 -c 3 10.0.0.2', output: '3 packet(s) received' });
    expect(d.connectivity).toMatchObject({ evaluated: true, underlayClassification: 'UNDERLAY_REACHABLE', probes: [{ lossPercent: 0, rttMs: { min: 1, avg: 2, max: 3 }, transmitted: 3, received: 3, status: 'OK' }] });
  });

  describe('resultados guardados: listar e abrir e SOMENTE LEITURA', () => {
    const golden = JSON.parse(readFileSync(join(__dirname, '..', '..', 'web', 'src', 'components', 'diagnostics', 'service', 'fixtures', 'engine-replay-3072-vta-mcp.json'), 'utf8'));
    const archiveDir = () => {
      const dir = mkdtempSync(join(tmpdir(), 'vsi-archive-'));
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...golden, runId: 'homolog-3072', completedAt: '2026-11-17T00:15:30.000Z' }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...golden, runId: 'outra-vsi', vsiName: 'VSI-OUTRA', completedAt: '2026-11-10T00:00:00.000Z' }));
      writeFileSync(join(dir, 'lixo.json'), '{ nao e json');
      writeFileSync(join(dir, 'outro-formato.json'), JSON.stringify({ schemaVersion: 2, runId: 'x' }));
      writeFileSync(join(dir, 'manifest.txt'), 'ignorado');
      try {
        symlinkSync(join(dir, 'a.json'), join(dir, 'link.json'));
      } catch {
        // sem permissao para symlink neste sistema: o caso fica coberto onde houver
      }
      return dir;
    };

    it('lista memoria + arquivo, filtra por VSI, ignora arquivo invalido e nao abre nenhuma sessao', async () => {
      const { server, sessions } = await app(user('OPERATOR'), { archiveDir: archiveDir() });
      expect((await server.inject({ method: 'GET', url: `${URL}/status` })).json()).toMatchObject({ enabled: true, archiveAvailable: true });
      const all = (await server.inject({ method: 'GET', url: URL })).json().runs;
      expect(all.map((r: { runId: string }) => r.runId)).toEqual(['homolog-3072', 'outra-vsi']);
      expect(all[0]).toMatchObject({ vsiName: CDB_VSI, storedIn: 'ARCHIVE', origin: 'REPLAY', label: 'Replay em DEV', verdict: 'INCONCLUSIVE' });
      expect(all[0].endpoints[0]).toMatchObject({ hostName: 'BHE-VTA-6730-MPLS-01', collection: 'READ', accessRole: 'STANDBY_EXPECTED' });
      const one = (await server.inject({ method: 'GET', url: `${URL}?vsiName=${encodeURIComponent(CDB_VSI)}` })).json().runs;
      expect(one.map((r: { runId: string }) => r.runId)).toEqual(['homolog-3072']);
      expect(sessions).toEqual([]);
    });

    it('abre o resultado do arquivo por inteiro; id inexistente => 404; id malformado => 400; nada e executado', async () => {
      const { server, sessions } = await app(user('OPERATOR'), { archiveDir: archiveDir(), mcp: false });
      const got = await server.inject({ method: 'GET', url: `${URL}/homolog-3072` });
      expect(got.statusCode).toBe(200);
      expect(got.json()).toMatchObject({ runId: 'homolog-3072', vsiName: CDB_VSI, schemaVersion: 1 });
      expect(got.json().evidence.length).toBeGreaterThan(0);
      expect((await server.inject({ method: 'GET', url: `${URL}/nao-existe` })).statusCode).toBe(404);
      expect((await server.inject({ method: 'GET', url: `${URL}/..%2F..%2Fetc%2Fpasswd` })).statusCode).toBe(400);
      expect(sessions).toEqual([]);
    });

    it('execucao em memoria aparece na lista como MEMORY; sem sessao a lista responde 401', async () => {
      const { server } = await app(user('ADMIN'));
      const d = (await server.inject({ method: 'POST', url: URL, payload: body })).json();
      const runs = (await server.inject({ method: 'GET', url: URL })).json().runs;
      expect(runs).toEqual([expect.objectContaining({ runId: d.runId, storedIn: 'MEMORY', origin: 'ENGINE_RUN' })]);
      expect((await (await app(null)).server.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    });
  });
});

describe('resultados detalhados restritos a OPERATOR e ADMIN (VIEWER, sem sessao e cookie invalido nao leem nada)', () => {
  const golden = JSON.parse(readFileSync(join(__dirname, '..', '..', 'web', 'src', 'components', 'diagnostics', 'service', 'fixtures', 'engine-replay-3072-vta-mcp.json'), 'utf8'));
  const withArchive = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsi-restrito-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...golden, runId: 'replay-restrito', completedAt: '2026-11-17T00:15:30.000Z' }));
    return dir;
  };
  const SECRET_NAME = 'BHE-VTA-6730-MPLS-01';
  const ROUTES: Array<['GET' | 'HEAD', string]> = [
    ['GET', URL],
    ['GET', `${URL}?vsiName=${encodeURIComponent(CDB_VSI)}`],
    ['GET', `${URL}/replay-restrito`],
    ['GET', `${URL}/nao-existe`],
    ['GET', `${URL}/id%20invalido`],
    ['GET', `${URL}/..%2F..%2Fetc%2Fpasswd`],
    ['GET', `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}`],
    ['GET', `${URL}/legacy/h-a/v1/nao-e-uuid`],
    ['HEAD', URL],
    ['HEAD', `${URL}/replay-restrito`],
  ];

  it('VIEWER: 403 em TODAS as rotas restritas (inclusive por identificador, inexistente ou malformado), sem nome nem conteudo, sem sessao aberta', async () => {
    const { server, sessions, legacyGet } = await app(user('VIEWER'), { archiveDir: withArchive() });
    for (const [method, url] of ROUTES) {
      const res = await server.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.body, url).not.toContain(SECRET_NAME);
      expect(res.body, url).not.toContain('replay-restrito');
      if (method === 'GET') expect(res.json(), url).toMatchObject({ code: 'RESULTS_RESTRICTED' });
    }
    expect(legacyGet).not.toHaveBeenCalled(); // nem chega a consultar o job legado
    expect(sessions).toEqual([]);
  });

  it('o 403 do VIEWER nao distingue existente de inexistente (nenhum oraculo de existencia por identificador)', async () => {
    const { server } = await app(user('VIEWER'), { archiveDir: withArchive() });
    const a = await server.inject({ method: 'GET', url: `${URL}/replay-restrito` });
    const b = await server.inject({ method: 'GET', url: `${URL}/nao-existe` });
    const c = await server.inject({ method: 'GET', url: `${URL}/id%20invalido` });
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([403, 403, 403]);
    expect(a.body).toBe(b.body);
    expect(b.body).toBe(c.body);
  });

  it('sem sessao: 401 em todas, sem nome nem conteudo', async () => {
    const { server } = await app(null, { archiveDir: withArchive() });
    for (const [method, url] of ROUTES) {
      const res = await server.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.body).not.toContain(SECRET_NAME);
    }
  });

  it('OPERATOR e ADMIN leem (lista, abrir por id, legado convertido); inexistente 404; malformado 400', async () => {
    for (const role of ['OPERATOR', 'ADMIN'] as const) {
      const { server, sessions } = await app(user(role), { archiveDir: withArchive() });
      expect((await server.inject({ method: 'GET', url: URL })).json().runs.length).toBe(1);
      expect((await server.inject({ method: 'GET', url: `${URL}/replay-restrito` })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: `${URL}/legacy/h-a/v1/${LEGACY.diagnosticId}` })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: `${URL}/nao-existe` })).statusCode).toBe(404);
      expect((await server.inject({ method: 'GET', url: `${URL}/id%20invalido` })).statusCode).toBe(400);
      expect(sessions).toEqual([]);
    }
  });

  it('flag desligada: sem sessao 401; VIEWER 403 (nao revela o estado); OPERATOR/ADMIN 503', async () => {
    expect((await (await app(null, { service: false })).server.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    expect((await (await app(user('VIEWER'), { service: false })).server.inject({ method: 'GET', url: URL })).statusCode).toBe(403);
    for (const role of ['OPERATOR', 'ADMIN'] as const) expect((await (await app(user(role), { service: false })).server.inject({ method: 'GET', url: `${URL}/qualquer` })).statusCode).toBe(503);
  });

  it('status: qualquer sessao le, mas informa resultsAccess so para OPERATOR/ADMIN (a tela reflete o estado)', async () => {
    for (const [role, expected] of [['VIEWER', false], ['OPERATOR', true], ['ADMIN', true]] as const) {
      const body = (await (await app(user(role))).server.inject({ method: 'GET', url: `${URL}/status` })).json();
      expect(body.resultsAccess, role).toBe(expected);
      expect(JSON.stringify(body)).not.toContain(SECRET_NAME);
    }
  });

  it('papel desconhecido ou ausente nunca passa (lista de permitidos, nao de bloqueados)', async () => {
    for (const role of ['GUEST', '', 'admin', 'Operator'] as const) {
      const { server } = await app({ id: 'u', username: 'x', role } as unknown as AuthUser);
      expect((await server.inject({ method: 'GET', url: URL })).statusCode, `role=${role}`).toBe(403);
    }
  });

  it('variacoes de caminho nao contornam: barra final, barra dupla, ponto-e-virgula, caixa e query extra nao viram rota liberada', async () => {
    const { server } = await app(user('VIEWER'), { archiveDir: withArchive() });
    for (const url of [`${URL}/`, `${URL}//replay-restrito`, `${URL};x=1`, URL.toUpperCase(), `${URL}/replay-restrito?x=1`, `${URL}/status/../replay-restrito`]) {
      const res = await server.inject({ method: 'GET', url });
      expect([403, 404, 400], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain(SECRET_NAME);
    }
  });
});
