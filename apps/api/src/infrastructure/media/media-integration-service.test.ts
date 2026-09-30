import { describe, expect, it } from 'vitest';
import { CredentialVault } from '../../application/credential-vault';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { createMediaSecretBox } from './media-secret-box';
import { MediaIntegrationService } from './media-integration-service';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
  type WebhookDeliverySender,
} from './n8n-media-transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-29T12:00:00.000Z');

function buildService(
  options: {
    env?: Partial<{ outboundUrl: string | null; outboundToken: string | null; inboundToken: string | null }>;
    repositoryKind?: 'DATABASE' | 'MEMORY';
    migrationReady?: boolean;
    secretBox?: ReturnType<typeof createMediaSecretBox>;
    sender?: WebhookDeliverySender;
  } = {},
) {
  const repository = new InMemoryMediaRepository();
  const vault = new CredentialVault(KEY);
  const service = new MediaIntegrationService({
    repository,
    secretBox: options.secretBox ?? createMediaSecretBox(vault),
    repositoryKind: options.repositoryKind ?? 'DATABASE',
    migrationReady: async () => options.migrationReady ?? true,
    env: {
      outboundUrl: options.env?.outboundUrl ?? null,
      outboundToken: options.env?.outboundToken ?? null,
      inboundToken: options.env?.inboundToken ?? null,
    },
    now: () => NOW,
    logger: () => undefined,
  });
  const transport = new N8nMediaTransport({
    media: service,
    send: options.sender ?? (async () => ({ httpStatus: 200, latencyMs: 42 })),
    now: () => NOW,
  });
  service.attachTransport(transport);
  return { service, repository, transport, vault };
}

describe('camada de MÍDIAS — persistência e segredos', () => {
  it('cria a integração e nunca devolve o token em texto claro', async () => {
    const { service, repository } = buildService();
    const dto = await service.create({
      name: 'n8n — Mitigação DDoS',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
      outboundToken: 'segredo-outbound-123',
      inboundEnabled: true,
    });

    expect(dto.outboundTokenConfigured).toBe(true);
    expect(dto.outboundUrl).toBe('https://n8n.exemplo.com/webhook/abc');
    expect(JSON.stringify(dto)).not.toContain('segredo-outbound-123');

    const stored = await repository.findByPurpose('BGP_MITIGATION');
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored?.outboundSecretEncrypted ?? new Uint8Array()).toString('utf8')).not.toContain(
      'segredo-outbound-123',
    );
    // Criptografia reversível: o transporte precisa recuperar o segredo.
    const box = createMediaSecretBox(new CredentialVault(KEY));
    expect(box.decrypt(stored?.outboundSecretEncrypted ?? null)).toBe('segredo-outbound-123');
  });

  it('edita a integração preservando o token quando ele não é informado', async () => {
    const { service, repository } = buildService();
    const created = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/a',
      outboundToken: 'token-1',
    });
    const updated = await service.update(created.id, { enabled: false, name: 'n8n NOC' });
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('n8n NOC');
    expect(updated.outboundTokenConfigured).toBe(true);
    expect((await repository.get(created.id))?.enabled).toBe(false);
  });

  it('alterna enabled e reporta DISABLED', async () => {
    const { service } = buildService();
    const created = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/x',
      enabled: false,
    });
    expect(created.status).toBe('DISABLED');
    const enabled = await service.update(created.id, { enabled: true });
    expect(enabled.status).toBe('NEVER_TESTED');
  });

  it('mostra NOT_CONFIGURED quando não existe banco nem ENV', async () => {
    const { service } = buildService();
    const overview = await service.overview();
    expect(overview.integration).toBeNull();
    const channel = await service.resolveOutbound();
    expect(channel.enabled).toBe(false);
    expect(channel.source).toBe('NONE');
  });

  it('importa a configuração legada do ENV sob demanda', async () => {
    const { service } = buildService({
      env: { outboundUrl: 'https://env/webhook', outboundToken: 'env-token' },
    });
    const dto = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      importFromEnv: true,
    });
    expect(dto.outboundUrl).toBe('https://env/webhook');
    expect(dto.outboundTokenConfigured).toBe(true);
    expect(dto.configSource).toBe('DATABASE');
  });

  it('avisa que a configuração é MEMÓRIA quando a migration não está aplicada', async () => {
    const { service } = buildService({ migrationReady: false });
    const dto = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/x',
    });
    expect(dto.configSource).toBe('MEMORY');
    const overview = await service.overview();
    expect(overview.migrationReady).toBe(false);
  });
});

describe('resolução de configuração (banco vence ENV)', () => {
  it('usa o banco quando existe configuração persistida', async () => {
    const { service } = buildService({ env: { outboundUrl: 'https://env/webhook' } });
    await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://banco/webhook',
      outboundToken: 'token-banco',
    });
    const channel = await service.resolveOutbound();
    expect(channel.source).toBe('DATABASE');
    expect(channel.url).toBe('https://banco/webhook');
    expect(channel.token).toBe('token-banco');
  });

  it('cai para o ENV quando não há configuração persistida', async () => {
    const { service } = buildService({
      env: { outboundUrl: 'https://env/webhook', outboundToken: 'env-token' },
    });
    const channel = await service.resolveOutbound();
    expect(channel.source).toBe('ENV');
    expect(channel.url).toBe('https://env/webhook');
    expect(channel.token).toBe('env-token');
  });

  it('cai para o ENV quando a integração persistida está desabilitada', async () => {
    const { service } = buildService({ env: { outboundUrl: 'https://env/webhook' } });
    await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://banco/webhook',
      enabled: false,
    });
    const channel = await service.resolveOutbound();
    expect(channel.source).toBe('ENV');
    expect(channel.url).toBe('https://env/webhook');
  });
});

describe('rotação do token de entrada', () => {
  it('o token anterior deixa de valer depois da rotação', async () => {
    const { service } = buildService();
    const created = await service.create({ name: 'n8n', purpose: 'BGP_MITIGATION' });
    const first = await service.rotateInboundToken(created.id);
    expect(first.token).toHaveLength(43);
    expect((await service.validatesInboundToken(first.token)).valid).toBe(true);

    const second = await service.rotateInboundToken(created.id);
    expect(second.token).not.toBe(first.token);
    expect((await service.validatesInboundToken(second.token)).valid).toBe(true);
    expect((await service.validatesInboundToken(first.token)).valid).toBe(false);
    expect((await service.get(created.id))?.inboundTokenConfigured).toBe(true);
  });

  it('usa o token do ENV quando não há inbound persistido', async () => {
    const { service } = buildService({ env: { inboundToken: 'token-env' } });
    const resolved = await service.resolveInboundToken();
    expect(resolved.source).toBe('ENV');
    expect((await service.validatesInboundToken('token-env')).valid).toBe(true);
    expect((await service.validatesInboundToken('outro')).valid).toBe(false);
  });
});

describe('log operacional', () => {
  it('registra a entrega com apenas a origem do destino', async () => {
    const { service } = buildService();
    const dto = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook?token=nao-pode-vazar',
    });
    await service.recordOutboundDelivery({
      integrationId: dto.id,
      event: 'MITIGATION_VERIFIED',
      profileId: 'profile-1',
      requestId: 'evt-1',
      destination: 'https://n8n.exemplo.com',
      ok: true,
      httpStatus: 200,
      latencyMs: 182,
      safeError: null,
    });
    const logs = await service.listLogs({ mediaIntegrationId: dto.id });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      direction: 'OUTBOUND',
      event: 'MITIGATION_VERIFIED',
      status: 'SUCCESS',
      httpStatus: 200,
      latencyMs: 182,
      destination: 'https://n8n.exemplo.com',
    });
    expect(JSON.stringify(logs)).not.toContain('nao-pode-vazar');

    const refreshed = await service.get(dto.id);
    expect(refreshed).toMatchObject({
      status: 'LAST_DELIVERY_OK',
      lastOutboundStatusCode: 200,
      lastOutboundLatencyMs: 182,
      lastOutboundEvent: 'MITIGATION_VERIFIED',
    });
  });

  it('mantém a retenção limitada', async () => {
    const repository = new InMemoryMediaRepository();
    const service = new MediaIntegrationService({
      repository,
      secretBox: createMediaSecretBox(new CredentialVault(KEY)),
      repositoryKind: 'MEMORY',
      migrationReady: async () => false,
      env: { outboundUrl: null, outboundToken: null, inboundToken: null },
      now: () => NOW,
      logRetention: 5,
      logger: () => undefined,
    });
    for (let index = 0; index < 12; index += 1) {
      await service.recordInboundDelivery({
        integrationId: null,
        requestId: `r${index}`,
        action: 'STATUS',
        profileId: 'p1',
        status: 'MITIGATED',
        httpStatus: 200,
        ok: true,
        idempotent: false,
        safeError: null,
      });
    }
    const logs = await service.listLogs({ limit: 100 });
    expect(logs.length).toBeLessThanOrEqual(5);
  });
});

describe('TESTAR WEBHOOK', () => {
  it('usa o mesmo transporte do webhook normal e grava log', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const sender: WebhookDeliverySender = async (url, _payload, headers) => {
      calls.push({ url, headers });
      return { httpStatus: 200, latencyMs: 182 };
    };
    const { service } = buildService({ sender });
    const dto = await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
      outboundToken: 'token-saida',
    });

    const outcome = await service.testWebhook(dto.id);
    expect(outcome).toMatchObject({ ok: true, httpStatus: 200, latencyMs: 182, event: 'MITIGATION_TEST' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['X-NetVision-Token']).toBe('token-saida');
    expect(calls[0]?.url).not.toContain('token-saida');

    const logs = await service.listLogs({ direction: 'OUTBOUND', mediaIntegrationId: dto.id });
    expect(logs[0]).toMatchObject({ event: 'MITIGATION_TEST', status: 'SUCCESS', httpStatus: 200 });
  });

  it('reporta timeout como safeError sem derrubar nada', async () => {
    const aborted: typeof fetch = async () => {
      const error = new Error('timeout');
      error.name = 'AbortError';
      throw error;
    };
    const { service, transport } = buildService({
      sender: createFetchWebhookSender({ fetchImpl: aborted, timeoutMs: 5 }),
    });
    await service.create({
      name: 'n8n',
      purpose: 'BGP_MITIGATION',
      outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
    });
    const outcome = await transport.publishTest();
    expect(outcome).toMatchObject({ ok: false, httpStatus: null });
    expect(outcome.safeError).toBe('Timeout ao chamar o webhook');
  });
});
