import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { buildMitigationWebhookPayload } from '../../infrastructure/bgp/mitigation/mitigation-webhook';
import { MITIGATION_REF_PATTERN } from '../../infrastructure/bgp/mitigation/mitigation-ref';
import { registerN8nRoutes } from '../../n8n-routes';
import { decodeNotification, type OutboxEntry } from './durable-mitigation-outbox';

/**
 * RETIRADA VINCULADA A UMA MITIGACAO. O botao do Telegram devolve a `mitigationRef` recebida no
 * evento MITIGATION_VERIFIED; o REMOVE so executa se ela for a mitigacao ATIVA do escopo. Um
 * botao antigo (mitigacao anterior do mesmo cliente) nunca retira a mitigacao nova.
 */

type H = Awaited<ReturnType<typeof createPilotHarness>>;
const TOKEN = 'token-inbound-de-teste';

const payloads = async (h: H) =>
  (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'))).map(
    (row) =>
      buildMitigationWebhookPayload(decodeNotification(row.payload)) as unknown as Record<
        string,
        unknown
      >,
  );
/** Referencias das mitigacoes verificadas, na ordem em que foram anunciadas ao n8n. */
const refs = async (h: H) =>
  (await payloads(h))
    .filter((body) => body['event'] === 'MITIGATION_VERIFIED')
    .sort((a, b) => String(a['occurredAt']).localeCompare(String(b['occurredAt'])))
    .map((body) => String(body['mitigationRef']));
const activate = async (h: H, requestId: string) => {
  h.advance(1_000);
  return h.commands.execute({ requestId, action: 'ACTIVATE', profileId: h.target.profileId });
};
const remove = async (h: H, callbackId: string, mitigationRef?: string) => {
  h.advance(1_000);
  return h.commands.execute({
    requestId: `telegram-${callbackId}`,
    action: 'REMOVE',
    profileId: h.target.profileId,
    ...(mitigationRef ? { mitigationRef } : {}),
  });
};
const undoWrites = (h: H) =>
  h.ssh.writes.filter((commands) => commands.some((line) => line.startsWith('undo '))).length;

describe('botao de retirada vinculado a mitigacao que o gerou', () => {
  it('a referencia da mitigacao ativa retira; a mesma referencia nao serve para a proxima', async () => {
    const h = await createPilotHarness();
    expect((await activate(h, 'ui-activate-1')).status).toBe('ACTIVATED_VERIFIED');
    const [first] = await refs(h);
    expect(first).toMatch(MITIGATION_REF_PATTERN);
    expect((await remove(h, 'cb-1', first)).status).toBe('REMOVED_VERIFIED');

    // nova mitigacao do MESMO cliente
    expect((await activate(h, 'ui-activate-2')).status).toBe('ACTIVATED_VERIFIED');
    const [, second] = await refs(h);
    expect(second).toMatch(MITIGATION_REF_PATTERN);
    expect(second).not.toBe(first);

    // botao ANTIGO (novo toque = novo callback id) nao retira a mitigacao nova
    const stale = await remove(h, 'cb-2', first);
    expect(stale).toMatchObject({ ok: false, verified: false, status: 'MITIGATION_REFERENCE_STALE' });
    expect(stale.commandPreview).toEqual([]);
    expect(undoWrites(h)).toBe(1);
    expect(h.ssh.active).toBe(true);
    expect((await h.repository.getRuntime(h.target.profileId))?.state).toBe('MITIGATED');

    // o botao da mitigacao atual funciona; depois dele, nenhum dos dois retira mais nada
    expect((await remove(h, 'cb-3', second)).status).toBe('REMOVED_VERIFIED');
    expect((await remove(h, 'cb-4', second)).status).toBe('MITIGATION_REFERENCE_STALE');
    expect((await remove(h, 'cb-5', first)).status).toBe('MITIGATION_REFERENCE_STALE');
    expect(undoWrites(h)).toBe(2);
  });

  it('mitigacao AUTO: o botao de uma mitigacao manual anterior nao a retira', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [manualRef] = await refs(h);
    await remove(h, 'cb-1', manualRef);
    h.advance(h.config.cooldownMs + 60_000);
    h.sample(100_000_000n);
    await h.lifecycle.tickPilot();
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const autoRef = (await refs(h)).at(-1)!;
    expect(autoRef).not.toBe(manualRef);
    expect((await remove(h, 'cb-2', manualRef)).status).toBe('MITIGATION_REFERENCE_STALE');
    expect(h.ssh.active).toBe(true);
    expect((await remove(h, 'cb-3', autoRef)).status).toBe('REMOVED_VERIFIED');
  });

  it('sem mitigacao verificada no escopo, um botao com referencia nunca escreve', async () => {
    const h = await createPilotHarness();
    const result = await remove(h, 'cb-1', '0123456789abcdef');
    expect(result.status).toBe('MITIGATION_REFERENCE_STALE');
    expect(h.ssh.writes).toHaveLength(0);
  });

  it('compatibilidade: REMOVE sem referencia (painel, workflow atual) segue como antes', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    expect((await remove(h, 'cb-1')).status).toBe('REMOVED_VERIFIED');
  });

  it('o evento com mitigationRef continua valido nas duas variantes do normalizador RC7.1.2', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const body = (await payloads(h)).find((entry) => entry['event'] === 'MITIGATION_VERIFIED')!;
    expect(body['mitigationRef']).toMatch(MITIGATION_REF_PATTERN);
    for (const file of [
      'RC7.1.2-PREFIXOS-NORMALIZER-BEFORE.txt',
      'RC7.1.2-PREFIXOS-NORMALIZER-AFTER.txt',
    ]) {
      let expression = readFileSync(
        new URL('../../../../../docs/n8n/' + file, import.meta.url),
        'utf8',
      ).trim();
      if (expression.startsWith('=')) expression = expression.slice(1).trim();
      if (expression.startsWith('{{')) expression = expression.slice(2);
      if (expression.endsWith('}}')) expression = expression.slice(0, -2);
      const normalized = (
        new Function('$json', `return (${expression});`) as (i: unknown) => Record<string, unknown>
      )({ body });
      expect(normalized).toMatchObject({ RC712_VALID: true, RC712_ROUTE: 'ACTIVATED' });
    }
    // callback_data do Telegram: limite de 64 bytes
    const callback = `remove_execute|${h.target.profileId}|${String(body['mitigationRef'])}`;
    expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
  });
});

describe('o botao da mitigacao ATUAL continua valendo depois de comandos recusados', () => {
  it('ACTIVATE repetido (recusado) nao mata o botao de uma mitigacao manual', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [ref] = await refs(h);
    const again = await activate(h, 'ui-activate-again');
    expect(again.ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(1);
    expect((await remove(h, 'cb-1', ref)).status).toBe('REMOVED_VERIFIED');
  });

  it('REMOVE que falha ANTES da escrita pode ser repetido com o mesmo botao', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [ref] = await refs(h);
    h.ssh.readFails = true;
    const failed = await remove(h, 'cb-1', ref);
    expect(failed.ok).toBe(false);
    expect(undoWrites(h)).toBe(0);
    h.ssh.readFails = false;
    expect((await remove(h, 'cb-2', ref)).status).toBe('REMOVED_VERIFIED');
  });

  it('mitigacao AUTO: um comando manual recusado nao invalida o botao do alerta AUTO', async () => {
    const h = await createPilotHarness();
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const [ref] = await refs(h);
    expect((await activate(h, 'ui-activate-over-auto')).ok).toBe(false);
    expect((await remove(h, 'cb-1', ref)).status).toBe('REMOVED_VERIFIED');
  });

  it('escrita de resultado incerto derruba o vinculo: nenhum botao retira um escopo em quarentena', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [ref] = await refs(h);
    h.ssh.timeout = true;
    expect((await remove(h, 'cb-1', ref)).ok).toBe(false);
    h.ssh.timeout = false;
    const retry = await remove(h, 'cb-2', ref);
    expect(['MITIGATION_REFERENCE_STALE', 'MANUAL_RECONCILIATION_REQUIRED']).toContain(retry.status);
    expect(undoWrites(h)).toBe(1);
  });
});

describe('canal n8n: campo mitigationRef e exigencia opcional', () => {
  const server = async (h: H, requireRemoveRef: boolean) => {
    const app = Fastify();
    registerN8nRoutes(app, { commands: h.commands, commandToken: TOKEN, requireRemoveRef });
    await app.ready();
    const post = async (body: Record<string, unknown>) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/integrations/n8n/mitigation-command',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: body,
      });
      return { code: response.statusCode, body: response.json() as Record<string, unknown> };
    };
    return { app, post };
  };

  it('referencia mal formada e recusada no schema; a referencia chega ao comando', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [ref] = await refs(h);
    const { app, post } = await server(h, false);
    const base = { action: 'REMOVE', profileId: h.target.profileId };
    expect((await post({ ...base, requestId: 'telegram-a', mitigationRef: 'x' })).code).toBe(400);
    const stale = await post({ ...base, requestId: 'telegram-b', mitigationRef: 'f'.repeat(16) });
    expect(stale.body['status']).toBe('MITIGATION_REFERENCE_STALE');
    expect(h.ssh.active).toBe(true);
    const ok = await post({ ...base, requestId: 'telegram-c', mitigationRef: ref });
    expect(ok.body['status']).toBe('REMOVED_VERIFIED');
    await app.close();
  });

  it('com a exigencia ligada, botao sem referencia (antigo) nao executa; ACTIVATE e STATUS seguem', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const [ref] = await refs(h);
    const { app, post } = await server(h, true);
    const base = { action: 'REMOVE', profileId: h.target.profileId };
    const refused = await post({ ...base, requestId: 'telegram-old' });
    expect(refused.code).toBe(200);
    expect(refused.body).toMatchObject({ ok: false, status: 'MITIGATION_REFERENCE_REQUIRED' });
    expect(h.ssh.active).toBe(true);
    const status = await post({ requestId: 's-1', action: 'STATUS', profileId: h.target.profileId });
    expect(status.body['ok']).toBe(true);
    expect((await post({ ...base, requestId: 'telegram-new', mitigationRef: ref })).body['status']).toBe(
      'REMOVED_VERIFIED',
    );
    await app.close();
  });

  it('com a exigencia ligada, token de escopo junto de profileId NAO isenta a referencia', async () => {
    const h = await createPilotHarness();
    await activate(h, 'ui-activate-1');
    const { app, post } = await server(h, true);
    const bogus = await post({
      requestId: 'telegram-bogus',
      action: 'REMOVE',
      profileId: h.target.profileId,
      scopeConfirmationToken: 'x'.repeat(32),
    });
    expect(bogus.body).toMatchObject({ ok: false, status: 'MITIGATION_REFERENCE_REQUIRED' });
    expect(JSON.stringify(bogus.body)).not.toContain('token');
    expect(h.ssh.active).toBe(true);
    // callback de escopo legitimo (so o token): token desconhecido nao resolve perfil nem executa
    const unknown = await post({
      requestId: 'telegram-rmx',
      action: 'REMOVE',
      scopeConfirmationToken: 'y'.repeat(32),
    });
    expect(unknown.body['status']).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(h.ssh.active).toBe(true);
    await app.close();
  });
});
