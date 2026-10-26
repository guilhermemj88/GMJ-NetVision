import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerVsiDiagnosticRoutes, vsiDiagnosticEnabled } from '../../vsi-diagnostic-routes';
import { VsiDiagnosticApprovalStore } from './vsi-diagnostic-approval';

const operator = { id: 'gate-operator', username: 'gate-operator', role: 'OPERATOR' as const };
const admin = { id: 'gate-admin', username: 'gate-admin', role: 'ADMIN' as const };

function buildService(calls: string[]) {
  return {
    start: async (...args: unknown[]) => {
      calls.push(`start:${String(args[3] ?? 'none')}`);
      return { diagnosticId: 'should-not-run' };
    },
    get: async () => {
      calls.push('get');
      return {};
    },
    cancel: async () => {
      calls.push('cancel');
      return {};
    },
  };
}

describe('gate de ativacao do diagnostico VSI', () => {
  let dir: string;
  let store: VsiDiagnosticApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vsi-gate-'));
    store = new VsiDiagnosticApprovalStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function withGate(value: string | undefined) {
    const previous = process.env.VSI_DIAGNOSTIC_ENABLED;
    if (value === undefined) delete process.env.VSI_DIAGNOSTIC_ENABLED;
    else process.env.VSI_DIAGNOSTIC_ENABLED = value;
    return () => {
      if (previous === undefined) delete process.env.VSI_DIAGNOSTIC_ENABLED;
      else process.env.VSI_DIAGNOSTIC_ENABLED = previous;
    };
  }

  it('e desabilitado por padrao', () => {
    expect(vsiDiagnosticEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('trata valores ambiguos como desabilitado', () => {
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: '' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('habilita somente com true explicito', () => {
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: ' TRUE ' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('com gate desligado responde 503 nas 4 rotas e NUNCA chama o service (zero SSH)', async () => {
    const restore = withGate(undefined);
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(
      app as never,
      buildService(calls) as never,
      async () => operator as never,
      store,
    );
    const urls: Array<[string, string]> = [
      ['POST', '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose'],
      ['POST', '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostic-approvals'],
      ['GET', '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostics/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostics/00000000-0000-4000-8000-000000000000/cancel'],
    ];
    for (const [method, url] of urls) {
      const response = await app.inject({ method: method as never, url, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).enabled).toBe(false);
    }
    expect(calls).toEqual([]);
    await app.close();
    restore();
  });

  it('com gate ligado exige aprovacao one-shot', async () => {
    const restore = withGate('true');
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(app as never, buildService(calls) as never, async () => operator as never, store);

    const semAprovacao = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose',
      payload: {},
    });
    expect(semAprovacao.statusCode).toBe(202);
    expect(calls).toEqual(['start:none']);

    calls.length = 0;
    const comAprovacao = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose',
      payload: { approvalId: 'abc-123' },
    });
    expect(comAprovacao.statusCode).toBe(202);
    expect(calls).toEqual(['start:abc-123']);
    await app.close();
    restore();
  });

  it('somente ADMIN cria aprovacao', async () => {
    const restore = withGate('true');
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(app as never, buildService(calls) as never, async () => operator as never, store);
    const negado = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostic-approvals',
      payload: {},
    });
    expect(negado.statusCode).toBe(403);
    await app.close();

    const appAdmin = Fastify();
    registerVsiDiagnosticRoutes(appAdmin as never, buildService(calls) as never, async () => admin as never, store);
    const criado = await appAdmin.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostic-approvals',
      payload: { ttlSeconds: 120 },
    });
    expect(criado.statusCode).toBe(201);
    const body = JSON.parse(criado.body);
    expect(body.hostId).toBe('host-x');
    expect(body.vsiId).toBe('vsi-y');
    expect(body.createdBy).toBe('gate-admin');
    expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(120_000);
    expect(calls).toEqual([]);
    await appAdmin.close();
    restore();
  });

  it('rota de status responde nos dois estados e exige sessao', async () => {
    const restore = withGate(undefined);
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(app as never, buildService(calls) as never, async () => null, store);
    const semSessao = await app.inject({ method: 'GET', url: '/api/diagnostics/status' });
    expect(semSessao.statusCode).toBe(401);
    await app.close();

    const appOperador = Fastify();
    registerVsiDiagnosticRoutes(
      appOperador as never,
      buildService(calls) as never,
      async () => operator as never,
      store,
    );
    const desligado = await appOperador.inject({ method: 'GET', url: '/api/diagnostics/status' });
    expect(desligado.statusCode).toBe(200);
    expect(JSON.parse(desligado.body).diagnosticEnabled).toBe(false);
    await appOperador.close();

    process.env.VSI_DIAGNOSTIC_ENABLED = 'true';
    const appLigado = Fastify();
    registerVsiDiagnosticRoutes(
      appLigado as never,
      buildService(calls) as never,
      async () => operator as never,
      store,
    );
    const ligado = await appLigado.inject({ method: 'GET', url: '/api/diagnostics/status' });
    expect(JSON.parse(ligado.body).diagnosticEnabled).toBe(true);
    await appLigado.close();
    expect(calls).toEqual([]);
    restore();
  });

  it('com gate desligado a criacao de aprovacao e o diagnostico ficam bloqueados', async () => {
    const restore = withGate('false');
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(
      app as never,
      buildService(calls) as never,
      async () => admin as never,
      store,
    );
    const aprovacao = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostic-approvals',
      payload: {},
    });
    expect(aprovacao.statusCode).toBe(503);
    const diagnostico = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose',
      payload: { approvalId: '11111111-2222-4333-8444-555555555555' },
    });
    expect(diagnostico.statusCode).toBe(503);
    expect(calls).toEqual([]);
    await app.close();
    restore();
  });

  it('exige sessao em todas as rotas com gate ligado', async () => {
    const restore = withGate('true');
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(app as never, buildService(calls) as never, async () => null, store);
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnostic-approvals',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
    restore();
  });
});
