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
 * RBAC de escrita (backend): papel da sessao + lista de perfis com escrita manual + origem do canal n8n.
 * O executor aqui e o MOCK (nenhum equipamento): o que se prova e quem CHEGA ao executor.
 */
const TOKEN = 'token-inbound-de-teste';
const user = (role: AuthUser['role']) =>
  ({ id: 'u-' + role, username: role.toLowerCase(), role }) as unknown as AuthUser;

async function build(
  options: { policy?: boolean; allowedSourceIps?: string[]; role?: AuthUser['role'] | null } = {},
) {
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
  const allowed = await mk('PL-A', 'if-a', '10.0.0.1');
  const other = await mk('PL-B', 'if-b', '10.0.0.2');
  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id) =>
        ({
          id,
          hostname: 'BHE-VTA-F1A-BGP-01',
          displayName: 'BHE-VTA-F1A-BGP-01',
        }) as unknown as HostRecord,
    },
    executor,
    ...(options.policy === false ? {} : { manualProfilePolicy: { allowedProfileIds: [allowed] } }),
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  });
  const app = Fastify();
  registerN8nRoutes(app, {
    commands,
    commandToken: TOKEN,
    ...(options.allowedSourceIps ? { allowedSourceIps: options.allowedSourceIps } : {}),
  });
  registerMitigationRoutes(app, {
    service: {} as never,
    commands,
    currentUser: async () => (options.role === null ? null : user(options.role ?? 'OPERATOR')),
  });
  app.setErrorHandler((error, _r, reply) =>
    error instanceof ZodError
      ? reply.code(400).send({ ok: false })
      : reply.code(500).send({ ok: false }),
  );
  await app.ready();
  return { app, allowed, other, executor };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});
const panel = (a: FastifyInstance, id: string, action: string, requestId: string) =>
  a.inject({
    method: 'POST',
    url: `/api/bgp/mitigation/profiles/${id}/command`,
    payload: { requestId, action },
  });
const n8n = (a: FastifyInstance, body: unknown, remoteAddress?: string) =>
  a.inject({
    method: 'POST',
    url: '/api/integrations/n8n/mitigation-command',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
    ...(remoteAddress ? { remoteAddress } : {}),
  });

describe('RBAC do painel / API administrativa', () => {
  it('VIEWER nao executa ACTIVATE nem REMOVE (403), mas consulta STATUS', async () => {
    const t = await build({ role: 'VIEWER' });
    app = t.app;
    for (const action of ['ACTIVATE', 'REMOVE']) {
      const r = await panel(t.app, t.allowed, action, `v-${action}`);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: 'OPERATOR_REQUIRED' });
    }
    const status = await panel(t.app, t.allowed, 'STATUS', 'v-status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ action: 'STATUS', ok: true });
  });

  it('sem sessao: 401 em qualquer acao', async () => {
    const t = await build({ role: null });
    app = t.app;
    expect((await panel(t.app, t.allowed, 'ACTIVATE', 'x')).statusCode).toBe(401);
    expect((await panel(t.app, t.allowed, 'STATUS', 'y')).statusCode).toBe(401);
  });

  it('OPERATOR/ADMIN alcancam o servico; perfil fora da lista e recusado ANTES de qualquer escrita (PROFILE_NOT_ALLOWED)', async () => {
    const t = await build({ role: 'OPERATOR' });
    app = t.app;
    const ok = await panel(t.app, t.allowed, 'SIMULATE_ACTIVATE', 'op-sim');
    expect(ok.statusCode).toBe(200);
    const denied = await panel(t.app, t.other, 'ACTIVATE', 'op-act-other');
    expect(denied.json()).toMatchObject({
      ok: false,
      status: 'PROFILE_NOT_ALLOWED',
      verified: false,
    });
    const deniedRemove = await panel(t.app, t.other, 'REMOVE', 'op-rm-other');
    expect(deniedRemove.json()).toMatchObject({ status: 'PROFILE_NOT_ALLOWED' });
  });

  it('acesso de EMERGENCIA: so ADMIN retira um perfil fora da lista; ACTIVATE fora da lista segue proibido ate para ADMIN', async () => {
    const t = await build({ role: 'ADMIN' });
    app = t.app;
    const activate = await panel(t.app, t.other, 'ACTIVATE', 'adm-act-other');
    expect(activate.json()).toMatchObject({ status: 'PROFILE_NOT_ALLOWED' });
    const remove = await panel(t.app, t.other, 'REMOVE', 'adm-rm-other');
    expect(remove.json().status).not.toBe('PROFILE_NOT_ALLOWED');
  });

  it('o canal n8n tambem respeita a lista de perfis e NUNCA ganha o bypass de emergencia (token nao e ADMIN)', async () => {
    const t = await build();
    app = t.app;
    const denied = await n8n(t.app, { requestId: 'n-1', action: 'ACTIVATE', profileId: t.other });
    expect(denied.json()).toMatchObject({ ok: false, status: 'PROFILE_NOT_ALLOWED' });
    const removeDenied = await n8n(t.app, {
      requestId: 'n-2',
      action: 'REMOVE',
      profileId: t.other,
    });
    expect(removeDenied.json()).toMatchObject({ status: 'PROFILE_NOT_ALLOWED' });
    const allowed = await n8n(t.app, {
      requestId: 'n-3',
      action: 'SIMULATE_ACTIVATE',
      profileId: t.allowed,
    });
    expect(allowed.json()).toMatchObject({ ok: true });
  });

  it('sem lista (HOLD, escrita fisica desligada) o comportamento anterior e preservado', async () => {
    const t = await build({ policy: false, role: 'OPERATOR' });
    app = t.app;
    const r = await panel(t.app, t.other, 'SIMULATE_ACTIVATE', 'no-policy');
    expect(r.json()).toMatchObject({ ok: true });
  });
});

describe('canal n8n: filtro de origem (socket) alem do token', () => {
  it('origem fora da lista => 403 SOURCE_NOT_ALLOWED, mesmo com token valido; X-Forwarded-For nao engana', async () => {
    const t = await build({ allowedSourceIps: ['179.189.80.25'] });
    app = t.app;
    const body = { requestId: 's-1', action: 'SIMULATE_ACTIVATE', profileId: t.allowed };
    const bad = await n8n(t.app, body, '203.0.113.9');
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ status: 'SOURCE_NOT_ALLOWED' });
    const spoof = await t.app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-forwarded-for': '179.189.80.25',
      },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.9',
    });
    expect(spoof.statusCode).toBe(403);
    const good = await n8n(t.app, { ...body, requestId: 's-2' }, '179.189.80.25');
    expect(good.statusCode).toBe(200);
    const mapped = await n8n(t.app, { ...body, requestId: 's-3' }, '::ffff:179.189.80.25');
    expect(mapped.statusCode).toBe(200);
  });

  it('a origem correta sem token continua 401 (o IP nunca autentica sozinho)', async () => {
    const t = await build({ allowedSourceIps: ['179.189.80.25'] });
    app = t.app;
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ requestId: 'z', action: 'STATUS', profileId: t.allowed }),
      remoteAddress: '179.189.80.25',
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('politica de escrita manual no boot (fail-closed)', () => {
  it('escrita fisica ligada exige a lista; desligada ela e opcional; formato invalido recusa', () => {
    expect(() => manualProfilePolicyFromEnv({}, true)).toThrow(
      'MITIGATION_MANUAL_ALLOWED_PROFILE_IDS_REQUIRED_WITH_LIVE_WRITE',
    );
    expect(manualProfilePolicyFromEnv({}, false)).toBeUndefined();
    expect(
      manualProfilePolicyFromEnv({ MITIGATION_MANUAL_ALLOWED_PROFILE_IDS: ' a1 , b2,a1' }, true),
    ).toEqual({ allowedProfileIds: ['a1', 'b2'] });
    expect(() =>
      manualProfilePolicyFromEnv({ MITIGATION_MANUAL_ALLOWED_PROFILE_IDS: 'ok,bad id;rm' }, false),
    ).toThrow('MITIGATION_MANUAL_ALLOWED_PROFILE_IDS_INVALID');
  });
});
