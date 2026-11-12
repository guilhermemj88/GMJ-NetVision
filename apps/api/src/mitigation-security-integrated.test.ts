import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { registerN8nRoutes } from './n8n-routes';
import { registerMitigationRoutes } from './mitigation-routes';
import { InMemoryMitigationRepository } from './infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { MitigationCommandService } from './infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from './infrastructure/bgp/mitigation/mitigation-executor';
import { manualProfilePolicyFromEnv } from './infrastructure/bgp/mitigation/mitigation-manual-policy';

/**
 * Release integrada (702157b + RBAC): a superficie de escrita/administracao inteira, por papel, com o perfil AGLINK como
 * UNICO autorizado. Executor MOCK: o que se prova e quem CHEGA a ele. Nenhum equipamento.
 */
const TOKEN = 'token-inbound-de-teste';
const REF = '0123456789abcdef';
const AGLINK_ID = 'cmuoavm4e00bysslhqd0h3q7u';
const user = (role: AuthUser['role']) =>
  ({ id: 'u-' + role, username: role.toLowerCase(), role }) as unknown as AuthUser;

async function build(role: AuthUser['role'] | null) {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  executor.seedPolicy('PL-A', [11]);
  executor.seedPolicy('PL-B', [11]);
  const mk = async (policyName: string, interfaceId: string, peer: string) => {
    const p = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName,
      interfaceId,
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
    });
    await repository.replaceProfilePeers(p.id, [{ peerAddress: peer, primary: true }]);
    await repository.upsertRuntime(p.id, {
      state: 'NORMAL',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });
    return p.id;
  };
  const aglink = await mk('PL-A', 'if-a', '10.0.0.1');
  const other = await mk('PL-B', 'if-b', '10.0.0.2');
  // exatamente como em producao: a lista vem de MITIGATION_MANUAL_ALLOWED_PROFILE_IDS
  const policy = manualProfilePolicyFromEnv({ MITIGATION_MANUAL_ALLOWED_PROFILE_IDS: aglink }, true);
  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id) =>
        ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
    },
    executor,
    ...(policy ? { manualProfilePolicy: policy } : {}),
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  });
  const calls: string[] = [];
  const app = Fastify();
  registerN8nRoutes(app, { commands, commandToken: TOKEN, requireRemoveRef: true });
  registerMitigationRoutes(app, {
    service: {
      discover: async () => {
        calls.push('discover');
        return { ok: true };
      },
      setPeerMitigationExclusion: async () => {
        calls.push('peer-exclusion');
        return { ok: true };
      },
    } as never,
    commands,
    peers: {
      getPeerDetail: async () => ({
        id: 'peer-1',
        deviceId: 'device-1',
        peerAddress: '10.0.0.1',
        addressFamily: 'IPV4',
        interface: { id: 'if-a' },
      }),
    } as never,
    reconciler: {
      preview: async () => {
        calls.push('reconcile-preview');
        return { previewId: '00000000-0000-4000-8000-000000000001' };
      },
      applyLocal: async () => {
        calls.push('reconcile-apply');
        return { state: 'NORMAL' };
      },
    } as never,
    currentUser: async () => (role === null ? null : user(role)),
  });
  app.setErrorHandler((error, _r, reply) =>
    error instanceof ZodError ? reply.code(400).send({ ok: false }) : reply.code(500).send({ ok: false }),
  );
  await app.ready();
  return { app, aglink, other, executor, calls };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});
const post = (a: FastifyInstance, url: string, payload: unknown) => a.inject({ method: 'POST', url, payload: payload as object });
const RECONCILE = { deviceId: 'device-1', policyName: 'PL-A' };
const APPLY = { ...RECONCILE, previewId: '00000000-0000-4000-8000-000000000001' };

describe('papel x superficie administrativa (reconciliacao, descoberta, exclusao de peer, ACTIVATE/REMOVE)', () => {
  for (const role of ['VIEWER', 'OPERATOR'] as const) {
    it(`${role}: NAO libera/ajusta posse e quarentena (reconcile/apply = 403) e nada chega ao reconciliador`, async () => {
      const t = await build(role);
      app = t.app;
      const r = await post(t.app, '/api/bgp/mitigation/policies/reconcile/apply', APPLY);
      expect(r.statusCode).toBe(403);
      expect(t.calls).not.toContain('reconcile-apply');
    });
  }

  it('ADMIN: unico papel que aplica a reconciliacao', async () => {
    const t = await build('ADMIN');
    app = t.app;
    const r = await post(t.app, '/api/bgp/mitigation/policies/reconcile/apply', APPLY);
    expect(r.statusCode).toBe(200);
    expect(t.calls).toContain('reconcile-apply');
  });

  it('VIEWER: sem escrita em NENHUMA rota (discover, exclusao de peer, ACTIVATE, REMOVE) e sem sessao = 401', async () => {
    const t = await build('VIEWER');
    app = t.app;
    expect((await post(t.app, '/api/bgp/mitigation/discover', { deviceId: 'device-1' })).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'PATCH', url: '/api/bgp/peers/peer-1/mitigation-exclusion', payload: { excluded: true } })).statusCode,
    ).toBe(403);
    for (const action of ['ACTIVATE', 'REMOVE']) {
      const r = await post(t.app, `/api/bgp/mitigation/profiles/${t.aglink}/command`, { requestId: 'v-' + action, action });
      expect(r.statusCode).toBe(403);
    }
    expect(t.calls).toEqual([]);

    const anon = await build(null);
    await app.close();
    app = anon.app;
    expect((await post(anon.app, '/api/bgp/mitigation/policies/reconcile/apply', APPLY)).statusCode).toBe(401);
    expect((await post(anon.app, `/api/bgp/mitigation/profiles/${anon.aglink}/command`, { requestId: 'a', action: 'REMOVE' })).statusCode).toBe(401);
  });

  it('OPERATOR: descobre e edita exclusao (escrita local), mas ACTIVATE/REMOVE continuam presos a lista de perfis', async () => {
    const t = await build('OPERATOR');
    app = t.app;
    expect((await post(t.app, '/api/bgp/mitigation/discover', { deviceId: 'device-1' })).statusCode).toBe(200);
    const r = await post(t.app, `/api/bgp/mitigation/profiles/${t.other}/command`, { requestId: 'o-act', action: 'ACTIVATE' });
    expect(r.json()).toMatchObject({ ok: false, status: 'PROFILE_NOT_ALLOWED' });
  });
});

describe('token do n8n: canal restrito, sem privilegio administrativo', () => {
  it('o bearer do n8n NAO e sessao: rotas administrativas e de painel respondem 401 mesmo com o token valido', async () => {
    const t = await build(null);
    app = t.app;
    const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    for (const url of [
      '/api/bgp/mitigation/policies/reconcile/apply',
      '/api/bgp/mitigation/policies/reconcile/preview',
      '/api/bgp/mitigation/discover',
      `/api/bgp/mitigation/profiles/${t.aglink}/command`,
    ]) {
      const r = await t.app.inject({ method: 'POST', url, headers: h, payload: JSON.stringify(url.includes('reconcile/apply') ? APPLY : RECONCILE) });
      expect([401, 403]).toContain(r.statusCode);
    }
    expect(t.calls).toEqual([]);
  });

  it('o canal n8n so alcanca o perfil AGLINK e exige a referencia da mitigacao para REMOVE (sem referencia: recusado sem escrita)', async () => {
    const t = await build('VIEWER');
    app = t.app;
    const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const call = (body: unknown) =>
      t.app.inject({ method: 'POST', url: '/api/integrations/n8n/mitigation-command', headers: h, payload: JSON.stringify(body) });
    expect((await call({ requestId: 'n-other', action: 'REMOVE', profileId: t.other, mitigationRef: REF })).json()).toMatchObject({
      status: 'PROFILE_NOT_ALLOWED',
    });
    const noRef = await call({ requestId: 'n-noref', action: 'REMOVE', profileId: t.aglink });
    expect(noRef.json()).toMatchObject({ ok: false, status: 'MITIGATION_REFERENCE_REQUIRED' });
    const noToken = await t.app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ requestId: 'n-none', action: 'REMOVE', profileId: t.aglink, mitigationRef: REF }),
    });
    expect(noToken.statusCode).toBe(401);
  });
});

describe('AGLINK como unico perfil do piloto (configuracao real)', () => {
  it('o id real do AGLINK e a unica entrada da lista; a lista e obrigatoria com escrita fisica ligada e vazia/lixo recusa o boot', () => {
    const p = manualProfilePolicyFromEnv({ MITIGATION_MANUAL_ALLOWED_PROFILE_IDS: AGLINK_ID }, true);
    expect([...(p?.allowedProfileIds ?? [])]).toEqual([AGLINK_ID]);
    expect(() => manualProfilePolicyFromEnv({}, true)).toThrow();
    expect(() => manualProfilePolicyFromEnv({ MITIGATION_MANUAL_ALLOWED_PROFILE_IDS: '' }, true)).toThrow();
  });
});
