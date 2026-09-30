import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { registerN8nRoutes } from './n8n-routes';
import { InMemoryMitigationRepository } from './infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { MitigationCommandService } from './infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from './infrastructure/bgp/mitigation/mitigation-executor';

const TOKEN = 'token-inbound-de-teste';
const POLICY = 'PL-HORIZONTES_IPv4-IN';

async function buildHarness(options: { token?: string | null; shared?: boolean } = {}) {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  executor.seedPolicy(POLICY, [11]);

  const profile = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: POLICY,
    interfaceId: 'if-3011',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
  });
  await repository.replaceProfilePeers(profile.id, [{ peerAddress: '10.200.200.106', primary: true }]);
  await repository.upsertRuntime(profile.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

  // outro target com a MESMA policy (sharedPolicy = aviso)
  if (options.shared) {
    const other = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-3013',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
    });
    await repository.replaceProfilePeers(other.id, [{ peerAddress: '10.200.200.10' }]);
    await repository.upsertRuntime(other.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });
  }

  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id) =>
        ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
    },
    executor,
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  });

  const app = Fastify();
  registerN8nRoutes(app, {
    commands,
    commandToken: options.token === undefined ? TOKEN : options.token,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false });
    return reply.code(500).send({ ok: false });
  });
  await app.ready();
  return { app, repository, executor, profileId: profile.id };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});

function post(
  target: FastifyInstance,
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  return target.inject({
    method: 'POST',
    url: '/api/integrations/n8n/mitigation-command',
    payload: body as object,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as never;
}

describe('canal IN (n8n -> NetVision)', () => {
  it('exige token: sem header e com token invalido responde 401', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const semToken = await post(harness.app, { requestId: 'r1', action: 'STATUS', profileId: harness.profileId }, null);
    const tokenErrado = await post(harness.app, { requestId: 'r1', action: 'STATUS', profileId: harness.profileId }, 'outro');

    expect(semToken.statusCode).toBe(401);
    expect(tokenErrado.statusCode).toBe(401);
    expect(JSON.stringify(tokenErrado.json())).not.toContain(TOKEN);
  });

  it('sem token configurado responde 503 (nao aceita nada)', async () => {
    const harness = await buildHarness({ token: null });
    app = harness.app;

    const response = await post(harness.app, { requestId: 'r1', action: 'STATUS', profileId: harness.profileId });

    expect(response.statusCode).toBe(503);
  });

  it('schema estrito: rejeita CLI, policy, node, rt, host e ssh', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const proibidos = [
      { commands: ['system-view'] },
      { cli: 'system-view' },
      { policy: 'PL-OUTRA-IN' },
      { node: 3 },
      { rt: '1:2' },
      { deviceHost: '10.0.0.1' },
      { ssh: { host: '10.0.0.1' } },
    ];
    for (const extra of proibidos) {
      const response = await post(harness.app, {
        requestId: 'r1',
        action: 'STATUS',
        profileId: harness.profileId,
        ...extra,
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('acao invalida e requestId ausente sao rejeitados', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const acao = await post(harness.app, { requestId: 'r1', action: 'DROP', profileId: harness.profileId });
    const semId = await post(harness.app, { action: 'STATUS', profileId: harness.profileId });

    expect(acao.statusCode).toBe(400);
    expect(semId.statusCode).toBe(400);
  });

  it('profile inexistente devolve erro seguro', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const response = await post(harness.app, { requestId: 'r1', action: 'STATUS', profileId: 'nao-existe' });
    const body = response.json();

    expect(body.ok).toBe(false);
    expect(body.status).toBe('PROFILE_NOT_FOUND');
    expect(String(body.safeError)).not.toContain(TOKEN);
  });

  it('STATUS e read-only (nao toca no executor)', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const response = await post(harness.app, { requestId: 'r1', action: 'STATUS', profileId: harness.profileId });
    const body = response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('NORMAL');
    expect(body.policy).toBe(POLICY);
    expect(harness.executor.calls).toEqual([]);
  });

  it('SIMULATE_ACTIVATE e SIMULATE_REMOVE devolvem preview sem executar', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const activ = await post(harness.app, { requestId: 's1', action: 'SIMULATE_ACTIVATE', profileId: harness.profileId });
    const remove = await post(harness.app, { requestId: 's2', action: 'SIMULATE_REMOVE', profileId: harness.profileId });

    expect(activ.json().status).toBe('WOULD_ACTIVATE');
    expect(activ.json().commandPreview).toEqual([
      'system-view',
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'commit',
    ]);
    expect(remove.json().status).toBe('WOULD_REMOVE');
    expect(harness.executor.calls).toEqual([]);
  });

  it('ACTIVATE executa e confirma por read-back', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const response = await post(harness.app, { requestId: 'a1', action: 'ACTIVATE', profileId: harness.profileId });
    const body = response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('ACTIVATED_VERIFIED');
    expect(body.verified).toBe(true);
    expect(body.node).toBe(2);
    expect(body.bogonNode).toBe(1);
    expect(body.mitigationNode).toBe(2);
    expect(body.verification).toMatchObject({ command: `display route-policy ${POLICY}` });
    // executou de verdade (no mock) e fez read-back
    expect(harness.executor.calls).toContain('commit');
    expect(harness.executor.calls).toContain(`display route-policy ${POLICY}`);
    expect((await harness.repository.getRuntime(harness.profileId))?.state).toBe('MITIGATED');
  });

  it('REMOVE executa e confirma por read-back', async () => {
    const harness = await buildHarness();
    app = harness.app;
    await post(harness.app, { requestId: 'a1', action: 'ACTIVATE', profileId: harness.profileId });

    const response = await post(harness.app, { requestId: 'r1', action: 'REMOVE', profileId: harness.profileId });
    const body = response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('REMOVED_VERIFIED');
    expect(body.verified).toBe(true);
    expect((await harness.repository.getRuntime(harness.profileId))?.state).toBe('NORMAL');
  });

  it('requestId duplicado nao executa duas vezes e devolve o primeiro resultado', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const primeira = await post(harness.app, { requestId: 'dup-1', action: 'ACTIVATE', profileId: harness.profileId });
    const chamadasDepoisDaPrimeira = harness.executor.calls.length;
    const segunda = await post(harness.app, { requestId: 'dup-1', action: 'ACTIVATE', profileId: harness.profileId });

    expect(primeira.json().idempotent).toBe(false);
    expect(segunda.json().idempotent).toBe(true);
    expect(segunda.json().status).toBe(primeira.json().status);
    expect(harness.executor.calls.length).toBe(chamadasDepoisDaPrimeira);
  });

  it('sharedPolicy NAO bloqueia execucao e vem marcada na resposta', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;

    const response = await post(harness.app, { requestId: 'sh-1', action: 'ACTIVATE', profileId: harness.profileId });
    const body = response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('ACTIVATED_VERIFIED');
    expect(body.sharedPolicy).toBe(true);
    const targets = body.sharedPolicyTargets as { interfaceId: string; peerAddress: string }[];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ interfaceId: 'if-3013', peerAddress: '10.200.200.10' });
  });

  it('resposta estruturada traz todos os campos do contrato', async () => {
    const harness = await buildHarness();
    app = harness.app;

    const response = await post(harness.app, { requestId: 'c-1', action: 'REMOVE', profileId: harness.profileId });
    const body = response.json();

    expect(Object.keys(body).sort()).toEqual(
      [
        'action',
        'addressFamily',
        'affectedPeers',
        'bogonNode',
        'commandPreview',
        'customer',
        'device',
        'executedAt',
        'idempotent',
        'interface',
        'interfaceId',
        'mitigationNode',
        'node',
        'notification',
        'ok',
        'policy',
        'profileId',
        'requestId',
        'rt',
        'sharedPolicy',
        'sharedPolicyTargets',
        'status',
        'verification',
        'verified',
      ].sort(),
    );
  });
});
