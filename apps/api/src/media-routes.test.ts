import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { CredentialVault } from './application/credential-vault';
import { registerMediaRoutes } from './media-routes';
import { InMemoryMediaRepository } from './infrastructure/media/in-memory-media-repository';
import { createMediaSecretBox } from './infrastructure/media/media-secret-box';
import { MediaIntegrationService } from './infrastructure/media/media-integration-service';
import { N8nMediaTransport } from './infrastructure/media/n8n-media-transport';

const KEY = Buffer.alloc(32, 9).toString('base64');
const NOW = new Date('2026-09-29T14:03:00.000Z');
const ADMIN = { id: 'u1', username: 'admin', role: 'ADMIN' } as unknown as AuthUser;
const VIEWER = { id: 'u2', username: 'viewer', role: 'VIEWER' } as unknown as AuthUser;

async function buildApp(user: AuthUser | null = ADMIN): Promise<FastifyInstance> {
  const repository = new InMemoryMediaRepository();
  const media = new MediaIntegrationService({
    repository,
    secretBox: createMediaSecretBox(new CredentialVault(KEY)),
    repositoryKind: 'DATABASE',
    migrationReady: async () => true,
    env: { outboundUrl: null, outboundToken: null, inboundToken: null },
    now: () => NOW,
    logger: () => undefined,
  });
  const transport = new N8nMediaTransport({
    media,
    send: async () => ({ httpStatus: 200, latencyMs: 182 }),
    now: () => NOW,
  });
  media.attachTransport(transport);

  const app = Fastify();
  registerMediaRoutes(app, { media, currentUser: async () => user });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

describe('API de MÍDIAS', () => {
  it('exige sessão do NetVision', async () => {
    const app = await buildApp(null);
    const response = await app.inject({ method: 'GET', url: '/api/media/integrations' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('exige administrador para escrever', async () => {
    const app = await buildApp(VIEWER);
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: { name: 'n8n', purpose: 'BGP_MITIGATION' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('cadastra a integração sem devolver o token', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: {
        name: 'n8n — Mitigação DDoS',
        purpose: 'BGP_MITIGATION',
        outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
        outboundToken: 'segredo-nao-pode-vazar',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ outboundTokenConfigured: true, configSource: 'DATABASE' });
    expect(JSON.stringify(body)).not.toContain('segredo-nao-pode-vazar');

    const overview = await app.inject({ method: 'GET', url: '/api/media/integrations' });
    expect(overview.json().integration).toMatchObject({ outboundTokenConfigured: true });
    expect(JSON.stringify(overview.json())).not.toContain('segredo-nao-pode-vazar');
    await app.close();
  });

  it('gera o token de entrada uma única vez e mantém o valor fora das leituras', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: { name: 'n8n', purpose: 'BGP_MITIGATION' },
    });
    const id = created.json().id as string;
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/media/integrations/${id}/rotate-inbound-token`,
    });
    expect(rotated.statusCode).toBe(200);
    const token = rotated.json().token as string;
    expect(token).toHaveLength(43);

    const detail = await app.inject({ method: 'GET', url: `/api/media/integrations/${id}` });
    expect(detail.json().inboundTokenConfigured).toBe(true);
    expect(JSON.stringify(detail.json())).not.toContain(token);
    await app.close();
  });

  it('testa o webhook e registra o log de entrega', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: {
        name: 'n8n',
        purpose: 'BGP_MITIGATION',
        outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
        outboundToken: 'token-saida',
      },
    });
    const id = created.json().id as string;
    const tested = await app.inject({ method: 'POST', url: `/api/media/integrations/${id}/test` });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true, httpStatus: 200, event: 'MITIGATION_TEST' });

    const logs = await app.inject({
      method: 'GET',
      url: `/api/media/integrations/${id}/logs?direction=OUTBOUND&limit=10`,
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json()[0]).toMatchObject({ event: 'MITIGATION_TEST', status: 'SUCCESS', httpStatus: 200 });
    expect(JSON.stringify(logs.json())).not.toContain('token-saida');
    await app.close();
  });

  it('resume a configuração para o drawer da mitigação sem expor segredo', async () => {
    const app = await buildApp();
    const empty = await app.inject({ method: 'GET', url: '/api/media/summary' });
    expect(empty.json()).toMatchObject({ configured: false, outboundConfigured: false });

    await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: {
        name: 'n8n',
        purpose: 'BGP_MITIGATION',
        outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
        outboundToken: 'token-saida',
      },
    });
    const configured = await app.inject({ method: 'GET', url: '/api/media/summary' });
    expect(configured.json()).toMatchObject({
      configured: true,
      outboundConfigured: true,
      status: 'NEVER_TESTED',
    });
    expect(JSON.stringify(configured.json())).not.toContain('token-saida');
    await app.close();
  });

  it('rejeita URL inválida no schema estrito', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/integrations',
      payload: { name: 'n8n', purpose: 'BGP_MITIGATION', outboundUrl: 'nao-e-url' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('devolve 404 (e não 500) para integração inexistente', async () => {
    const app = await buildApp();
    const missing = 'media_nao_existe';

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/media/integrations/${missing}`,
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(404);

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/media/integrations/${missing}/rotate-inbound-token`,
    });
    expect(rotated.statusCode).toBe(404);

    const tested = await app.inject({
      method: 'POST',
      url: `/api/media/integrations/${missing}/test`,
    });
    expect(tested.statusCode).toBe(404);
    await app.close();
  });
});
