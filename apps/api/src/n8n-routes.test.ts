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

function postCancel(
  target: FastifyInstance,
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  return target.inject({
    method: 'POST',
    url: '/api/integrations/n8n/mitigation-scope-cancel',
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
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
    expect(remove.json().status).toBe('WOULD_REMOVE');
    // Simulacao nao escreve: so a leitura read-only do baseline e permitida.
    expect(harness.executor.calls.filter((call) => !call.startsWith('display '))).toEqual([]);
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

  it('retirada em policy compartilhada: sem token bloqueia e devolve a lista + confirmacao', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;
    await post(harness.app, { requestId: 'sh-a', action: 'ACTIVATE', profileId: harness.profileId });

    const blocked = await post(harness.app, {
      requestId: 'sh-r',
      action: 'REMOVE',
      profileId: harness.profileId,
    });
    const body = blocked.json();

    expect(body.ok).toBe(false);
    expect(body.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(body.removalScope).toMatchObject({ policy: POLICY });
    const confirm = body.scopeConfirmation as { required: boolean; token: string; expiresAt: string };
    expect(confirm.required).toBe(true);
    expect(confirm.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(Number.isFinite(Date.parse(confirm.expiresAt))).toBe(true);
  });

  it('o booleano acknowledgeScopeRemoval NAO e aceito no inbound (so token)', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;

    const response = await post(harness.app, {
      requestId: 'sh-bool',
      action: 'REMOVE',
      profileId: harness.profileId,
      acknowledgeScopeRemoval: true,
    });

    // Schema estrito: o canal do Telegram nunca confirma por booleano.
    expect(response.statusCode).toBe(400);
  });

  it('confirmacao com token executa a retirada e nao vaza o token no log', async () => {
    const logs: Record<string, unknown>[] = [];
    const repository = new InMemoryMitigationRepository();
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [11]);
    const main = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-3011',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
    });
    await repository.replaceProfilePeers(main.id, [{ peerAddress: '10.200.200.222', primary: true }]);
    await repository.upsertRuntime(main.id, {
      state: 'MITIGATED',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });
    const sibling = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-3013',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
    });
    await repository.replaceProfilePeers(sibling.id, [{ peerAddress: '10.200.200.226', primary: true }]);
    await repository.upsertRuntime(sibling.id, {
      state: 'MITIGATED',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });

    const commands = new MitigationCommandService({
      repository,
      hosts: {
        getHost: async (id) =>
          ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
      },
      executor,
      now: () => new Date('2026-01-01T12:00:00.000Z'),
    });
    const internal = Fastify();
    registerN8nRoutes(internal, {
      commands,
      commandToken: TOKEN,
      onCommandResult: (log) => {
        logs.push(log as unknown as Record<string, unknown>);
      },
    });
    app = internal;
    await internal.ready();

    // Ativacao simulada do par no "equipamento".
    await commands.execute({ requestId: 'seed', action: 'ACTIVATE', profileId: main.id });

    const blocked = await post(internal, { requestId: 'r-1', action: 'REMOVE', profileId: main.id });
    const token = (blocked.json().scopeConfirmation as { token: string }).token;

    const confirmed = await post(internal, {
      requestId: 'r-2',
      action: 'REMOVE',
      profileId: main.id,
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:1',
    });
    const body = confirmed.json();

    expect(confirmed.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('REMOVED_VERIFIED');
    expect(body.scopeConfirmation).toMatchObject({ required: true, confirmedBy: 'telegram:1' });
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('callback do Telegram confirma apenas com o token (sem profileId)', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;
    await post(harness.app, { requestId: 'cb-a', action: 'ACTIVATE', profileId: harness.profileId });

    const blocked = await post(harness.app, { requestId: 'cb-1', action: 'REMOVE', profileId: harness.profileId });
    const token = (blocked.json().scopeConfirmation as { token: string }).token;

    // O botao do Telegram carrega SO o token: o NetVision resolve o perfil.
    const confirmed = await post(harness.app, {
      requestId: 'cb-2',
      action: 'REMOVE',
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:99',
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe('REMOVED_VERIFIED');
    expect(confirmed.json().profileId).toBe(harness.profileId);
  });

  it('confirmacao emitida em um grupo nao vale em outro chat', async () => {    const harness = await buildHarness({ shared: true });
    app = harness.app;
    await post(harness.app, { requestId: 'cg-a', action: 'ACTIVATE', profileId: harness.profileId });

    const blocked = await post(harness.app, {
      requestId: 'cg-1',
      action: 'REMOVE',
      profileId: harness.profileId,
      confirmedBy: 'telegram:99',
      chatId: '-100200',
    });
    const token = (blocked.json().scopeConfirmation as { token: string }).token;
    const callsBefore = harness.executor.calls.length;

    // Botao encaminhado para outro grupo: recusado sem tocar no equipamento.
    const outroGrupo = await post(harness.app, {
      requestId: 'cg-2',
      action: 'REMOVE',
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:99',
      chatId: '-999',
    });
    expect(outroGrupo.json().status).toBe('SCOPE_CONFIRMATION_CHAT_MISMATCH');
    expect(harness.executor.calls.length).toBe(callsBefore);

    const mesmoGrupo = await post(harness.app, {
      requestId: 'cg-3',
      action: 'REMOVE',
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:99',
      chatId: '-100200',
    });
    expect(mesmoGrupo.json().status).toBe('REMOVED_VERIFIED');
  });

  it('cancelamento revoga o token e um rmx antigo nao executa nada', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;
    await post(harness.app, { requestId: 'rv-a', action: 'ACTIVATE', profileId: harness.profileId });

    const blocked = await post(harness.app, {
      requestId: 'rv-1',
      action: 'REMOVE',
      profileId: harness.profileId,
      confirmedBy: 'telegram:42',
      chatId: '-100200',
    });
    const token = (blocked.json().scopeConfirmation as { token: string }).token;
    const callsBefore = harness.executor.calls.length;

    const revoked = await postCancel(harness.app, {
      requestId: 'rv-2',
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:42',
      chatId: '-100200',
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ ok: true, status: 'SCOPE_CONFIRMATION_REVOKED' });

    // Replay do botao antigo: token nao existe mais e nada chega ao executor.
    const after = await post(harness.app, {
      requestId: 'rv-3',
      action: 'REMOVE',
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:42',
      chatId: '-100200',
    });
    expect(after.json().status).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(harness.executor.calls.length).toBe(callsBefore);
  });

  it('cancelamento exige bearer e recusa campos extras', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;

    const semToken = await postCancel(
      harness.app,
      { requestId: 'rv-4', scopeConfirmationToken: 'token-qualquer-123456' },
      null,
    );
    expect(semToken.statusCode).toBe(401);

    const extra = await postCancel(harness.app, {
      requestId: 'rv-5',
      scopeConfirmationToken: 'token-qualquer-123456',
      force: true,
    });
    expect(extra.statusCode).toBe(400);

    const invalido = await postCancel(harness.app, { requestId: 'rv-6', scopeConfirmationToken: 'curto' });
    expect(invalido.statusCode).toBe(400);
  });

  it('token desconhecido sem profileId devolve TOKEN_UNKNOWN sem tocar o executor', async () => {    const harness = await buildHarness({ shared: true });
    app = harness.app;

    const response = await post(harness.app, {
      requestId: 'cb-x',
      action: 'REMOVE',
      scopeConfirmationToken: 'token-que-nao-existe-123456',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(harness.executor.calls).toEqual([]);
  });

  it('sem profileId e sem token o payload e invalido', async () => {
    const harness = await buildHarness({ shared: true });
    app = harness.app;

    const response = await post(harness.app, { requestId: 'cb-y', action: 'REMOVE' });
    expect(response.statusCode).toBe(400);
  });

  it('sharedPolicy NAO bloqueia execucao e vem marcada na resposta', async () => {    const harness = await buildHarness({ shared: true });
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
