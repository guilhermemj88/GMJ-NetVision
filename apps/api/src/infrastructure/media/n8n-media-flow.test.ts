import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CredentialVault } from '../../application/credential-vault';
import { registerN8nRoutes } from '../../n8n-routes';
import { MitigationCommandService } from '../bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from '../bgp/mitigation/mitigation-executor';
import { InMemoryMitigationRepository } from '../bgp/mitigation/in-memory-mitigation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { createMediaSecretBox } from './media-secret-box';
import { MediaIntegrationService } from './media-integration-service';
import {
  N8nMediaTransport,
  WebhookDeliveryError,
  type WebhookDeliverySender,
} from './n8n-media-transport';

const KEY = Buffer.alloc(32, 3).toString('base64');
const NOW = new Date('2026-09-29T14:03:00.000Z');

interface FlowHarness {
  media: MediaIntegrationService;
  repository: InMemoryMediaRepository;
  commands: MitigationCommandService;
  profileId: string;
  sent: { url: string; headers: Record<string, string>; event: string }[];
}

async function buildFlow(options: {
  sender?: WebhookDeliverySender;
  env?: Partial<{ outboundUrl: string | null; outboundToken: string | null; inboundToken: string | null }>;
} = {}): Promise<FlowHarness> {
  const repository = new InMemoryMediaRepository();
  const media = new MediaIntegrationService({
    repository,
    secretBox: createMediaSecretBox(new CredentialVault(KEY)),
    repositoryKind: 'DATABASE',
    migrationReady: async () => true,
    env: {
      outboundUrl: options.env?.outboundUrl ?? null,
      outboundToken: options.env?.outboundToken ?? null,
      inboundToken: options.env?.inboundToken ?? null,
    },
    now: () => NOW,
    logger: () => undefined,
  });
  const sent: { url: string; headers: Record<string, string>; event: string }[] = [];
  const sender: WebhookDeliverySender =
    options.sender ??
    (async (url, payload, headers) => {
      sent.push({ url, headers, event: payload.event });
      return { httpStatus: 200, latencyMs: 182 };
    });
  const transport = new N8nMediaTransport({ media, send: sender, now: () => NOW });
  media.attachTransport(transport);

  const mitigationRepository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  executor.seedPolicy('PL-HORIZONTES_IPv4-IN', [11]);
  const profile = await mitigationRepository.upsertProfile({
    deviceId: 'device-1',
    policyName: 'PL-HORIZONTES_IPv4-IN',
    interfaceId: 'if-3011',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
  });
  await mitigationRepository.upsertRuntime(profile.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

  const commands = new MitigationCommandService({
    repository: mitigationRepository,
    hosts: { getHost: async () => null },
    executor,
    notifications: transport,
    now: () => NOW,
  });

  return { media, repository, commands, profileId: profile.id, sent };
}

describe('OUTBOUND — NetVision → n8n', () => {
  it('usa a configuração persistida e envia o token em header', async () => {
    const flow = await buildFlow();
    const dto = await flow.media.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
      outboundToken: 'token-persistido',
    });

    const result = await flow.commands.execute({
      requestId: 'evt-1',
      action: 'ACTIVATE',
      profileId: flow.profileId,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    expect(flow.sent).toHaveLength(1);
    expect(flow.sent[0]?.headers['X-NetVision-Token']).toBe('token-persistido');
    expect(flow.sent[0]?.event).toBe('MITIGATION_VERIFIED');

    const logs = await flow.media.listLogs({ direction: 'OUTBOUND' });
    expect(logs[0]).toMatchObject({
      event: 'MITIGATION_VERIFIED',
      status: 'SUCCESS',
      httpStatus: 200,
      latencyMs: 182,
      destination: 'https://n8n.exemplo.com',
      profileId: flow.profileId,
    });
    const refreshed = await flow.media.get(dto.id);
    expect(refreshed?.lastOutboundEvent).toBe('MITIGATION_VERIFIED');
    expect(refreshed?.status).toBe('LAST_DELIVERY_OK');
  });

  it('cai para o ENV quando não há configuração persistida', async () => {
    const flow = await buildFlow({
      env: { outboundUrl: 'https://env.exemplo.com/webhook', outboundToken: 'token-env' },
    });
    const result = await flow.commands.execute({
      requestId: 'evt-2',
      action: 'SIMULATE_ACTIVATE',
      profileId: flow.profileId,
    });
    expect(result.ok).toBe(true);
    expect(flow.sent[0]?.url).toBe('https://env.exemplo.com/webhook');
    expect(flow.sent[0]?.headers['X-NetVision-Token']).toBe('token-env');
  });

  it('falha de webhook NÃO transforma mitigação bem-sucedida em falha', async () => {
    const flow = await buildFlow({
      sender: async () => {
        throw new WebhookDeliveryError('HTTP 401', 401, 90, 'Webhook respondeu HTTP 401');
      },
    });
    await flow.media.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
    });

    const result = await flow.commands.execute({
      requestId: 'evt-3',
      action: 'ACTIVATE',
      profileId: flow.profileId,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ACTIVATED_VERIFIED');

    const logs = await flow.media.listLogs({ direction: 'OUTBOUND' });
    expect(logs[0]).toMatchObject({ status: 'FAILED', httpStatus: 401, safeError: 'Webhook respondeu HTTP 401' });
  });

  it('sem webhook configurado o motor segue normalmente (best effort)', async () => {
    const flow = await buildFlow();
    const result = await flow.commands.execute({
      requestId: 'evt-4',
      action: 'ACTIVATE',
      profileId: flow.profileId,
    });
    expect(result.ok).toBe(true);
    expect(flow.sent).toHaveLength(0);
    const logs = await flow.media.listLogs({ direction: 'OUTBOUND' });
    expect(logs[0]).toMatchObject({ status: 'SKIPPED', safeError: 'Webhook não configurado' });
  });
});

describe('INBOUND — n8n → NetVision', () => {
  async function buildInbound(flow: FlowHarness) {
    const app = Fastify();
    registerN8nRoutes(app, {
      commands: flow.commands,
      commandToken: 'token-env-legado',
      resolveCommandToken: async () => (await flow.media.resolveInboundToken()).token,
      onCommandResult: (log) =>
        flow.media.recordInboundDelivery({
          integrationId: null,
          requestId: log.requestId,
          action: log.action,
          profileId: log.profileId,
          status: log.status,
          httpStatus: log.httpStatus,
          ok: log.ok,
          idempotent: log.idempotent,
          safeError: log.safeError,
        }),
    });
    await app.ready();
    return app;
  }

  it('usa o token ENV como fallback quando não há inbound persistido', async () => {
    const flow = await buildFlow();
    const app = await buildInbound(flow);
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: 'Bearer token-env-legado' },
      payload: { requestId: 'in-1', action: 'STATUS', profileId: flow.profileId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });

  it('token persistido vence o ENV e a rotação invalida o anterior', async () => {
    const flow = await buildFlow();
    const dto = await flow.media.create({ name: 'n8n', purpose: 'BGP_MITIGATION' });
    const rotated = await flow.media.rotateInboundToken(dto.id);
    const app = await buildInbound(flow);

    const withPersisted = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${rotated.token}` },
      payload: { requestId: 'in-2', action: 'STATUS', profileId: flow.profileId },
    });
    expect(withPersisted.statusCode).toBe(200);

    const withEnv = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: 'Bearer token-env-legado' },
      payload: { requestId: 'in-3', action: 'STATUS', profileId: flow.profileId },
    });
    expect(withEnv.statusCode).toBe(401);

    const second = await flow.media.rotateInboundToken(dto.id);
    const withOld = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${rotated.token}` },
      payload: { requestId: 'in-4', action: 'STATUS', profileId: flow.profileId },
    });
    expect(withOld.statusCode).toBe(401);
    const withNew = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${second.token}` },
      payload: { requestId: 'in-5', action: 'STATUS', profileId: flow.profileId },
    });
    expect(withNew.statusCode).toBe(200);
    await app.close();
  });

  it('registra o comando recebido sem nunca guardar o bearer', async () => {
    const flow = await buildFlow();
    const dto = await flow.media.create({ name: 'n8n', purpose: 'BGP_MITIGATION' });
    const rotated = await flow.media.rotateInboundToken(dto.id);
    const app = await buildInbound(flow);

    await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${rotated.token}` },
      payload: { requestId: 'in-log', action: 'REMOVE', profileId: flow.profileId },
    });
    await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: 'Bearer token-errado' },
      payload: { requestId: 'in-bad', action: 'REMOVE', profileId: flow.profileId },
    });

    const logs = await flow.media.listLogs({ direction: 'INBOUND', limit: 10 });
    expect(logs).toHaveLength(2);
    expect(logs[0]?.action).toBe('REMOVE');
    expect(JSON.stringify(logs)).not.toContain(rotated.token);
    expect(JSON.stringify(logs)).not.toContain('token-errado');
    expect(logs.some((log) => log.status === 'FAILED')).toBe(true);
    await app.close();
  });

  it('rejeita payload fora do contrato (sem cli/policy/node)', async () => {
    const flow = await buildFlow();
    const dto = await flow.media.create({ name: 'n8n', purpose: 'BGP_MITIGATION' });
    const rotated = await flow.media.rotateInboundToken(dto.id);
    const app = await buildInbound(flow);
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${rotated.token}` },
      payload: {
        requestId: 'in-cli',
        action: 'ACTIVATE',
        profileId: flow.profileId,
        cli: 'system-view',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
