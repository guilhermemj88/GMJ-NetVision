import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { buildMitigationWebhookPayload } from '../../infrastructure/bgp/mitigation/mitigation-webhook';
import { registerN8nRoutes } from '../../n8n-routes';
import { decodeNotification, type OutboxEntry } from './durable-mitigation-outbox';

/**
 * PONTA A PONTA, sem n8n e sem Telegram reais: o codigo dos nodes do workflow (o JSON PUBLICADO em
 * producao, versao 9a48c712, e o CANDIDATO RC7.1.3) e executado aqui contra a API real do NetVision
 * (rota do n8n + servico de comandos + lifecycle + executor Huawei; so a borda SSH e falsa).
 *
 * O candidato vincula o botao de retirada a mitigacao que o gerou (`mitigationRef`).
 */

type Json = Record<string, unknown>;
interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, any>;
  credentials?: unknown;
  webhookId?: string;
}
interface Workflow {
  nodes: WorkflowNode[];
  connections: unknown;
}
const load = (file: string): Workflow =>
  JSON.parse(
    readFileSync(new URL('../../../../../docs/n8n/' + file, import.meta.url), 'utf8'),
  ) as Workflow;
const PUBLISHED = load('PUBLICADO-9a48c712-sanitizado.json');
const CANDIDATE = load('GMJ-NetVision-Telegram-RC7.1.3-CANDIDATO.json');
const nodeOf = (workflow: Workflow, name: string) =>
  workflow.nodes.find((node) => node.name === name)!;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** `$('Node')` do n8n: saidas ja produzidas pelos nodes anteriores. */
type Outputs = Record<string, Json | undefined>;
const selector = (outputs: Outputs) => (name: string) => ({
  isExecuted: outputs[name] !== undefined,
  first: () => ({ json: outputs[name]! }),
  last: () => ({ json: outputs[name]! }),
});
/** Avalia um parametro de node: `=texto {{ expr }}` (mesma semantica do n8n para o que usamos). */
function evaluate(parameter: string, $json: Json, outputs: Outputs = {}): unknown {
  if (!parameter.startsWith('=')) return parameter;
  const template = parameter.slice(1);
  const run = (expression: string) =>
    (new Function('$json', '$', `return (${expression});`) as (j: Json, s: unknown) => unknown)(
      $json,
      selector(outputs),
    );
  const whole = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(template);
  if (whole && !whole[1]!.includes('}}')) return run(whole[1]!);
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) =>
    String(run(expression) ?? ''),
  );
}
function runCode(node: WorkflowNode, input: Json, outputs: Outputs = {}): Json {
  const result = (
    new Function('$input', '$', node.parameters['jsCode'] as string) as (
      i: unknown,
      s: unknown,
    ) => Array<{ json: Json }>
  )({ first: () => ({ json: input }) }, selector(outputs));
  return result[0]!.json;
}
const normalize = (workflow: Workflow, body: Json) =>
  evaluate(String(nodeOf(workflow, 'Normalizar Evento OUT').parameters['jsonOutput']), {
    body,
  }) as Json;

const TOKEN = 'token-inbound-de-teste';
const CHAT_ID = /const allowedChatId = '(-?\d+)'/.exec(
  String(nodeOf(CANDIDATE, 'Interpretar Callback').parameters['jsCode']),
)![1]!;

async function setup(requireRemoveRef = true) {
  const h = await createPilotHarness();
  const app = Fastify();
  registerN8nRoutes(app, { commands: h.commands, commandToken: TOKEN, requireRemoveRef });
  await app.ready();
  let callbackSeq = 0;
  const bodies = async () =>
    (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox')))
      .map(
        (row) => buildMitigationWebhookPayload(decodeNotification(row.payload)) as unknown as Json,
      )
      .sort((a, b) => String(a['occurredAt']).localeCompare(String(b['occurredAt'])));
  /** NetVision -> n8n: evento MITIGATION_VERIFIED vira alerta com botao (callback_data). */
  const alertButton = (workflow: Workflow, body: Json): string => {
    const normalized = normalize(workflow, body);
    expect(normalized).toMatchObject({ RC712_VALID: true, RC712_ROUTE: 'ACTIVATED' });
    const button = nodeOf(workflow, 'Telegram - Alerta com Botoes').parameters['inlineKeyboard']
      .rows[0].row.buttons[0];
    return String(
      evaluate(button.additionalFields.callback_data, normalized, {
        'Webhook NetVision OUT': { body },
      }),
    );
  };
  /** Telegram -> n8n: um toque no botao. `id` fixo simula a reentrega do MESMO callback. */
  const press = (workflow: Workflow, data: string, id?: string) =>
    runCode(nodeOf(workflow, 'Interpretar Callback'), {
      callback_query: {
        id: id ?? `cbq-${++callbackSeq}`,
        data,
        from: { id: 4242, username: 'operador' },
        message: { message_id: 77, chat: { id: Number(CHAT_ID) } },
      },
    });
  /** Botao "CONFIRMAR RETIRADA" emitido em resposta ao pedido. */
  const confirmButton = (workflow: Workflow, interpreted: Json): string =>
    String(
      evaluate(
        nodeOf(workflow, 'Telegram - Confirmar Retirada').parameters['inlineKeyboard'].rows[0].row
          .buttons[1].additionalFields.callback_data,
        interpreted,
      ),
    );
  /** n8n -> NetVision: corpo montado pelo node e enviado ao endpoint real. */
  const send = async (workflow: Workflow, interpreted: Json) => {
    const built = runCode(nodeOf(workflow, 'Montar Corpo do Comando'), interpreted, {
      'Interpretar Callback': interpreted,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: String(built['bodyJson']),
    });
    return { code: response.statusCode, body: response.json() as Json };
  };
  /** Fluxo completo do operador a partir de um alerta: pedir -> confirmar -> executar. */
  const removeFrom = async (workflow: Workflow, alertData: string) => {
    const asked = press(workflow, alertData);
    if (asked['authorized'] !== true) return { blockedAt: 'pedido', interpreted: asked };
    expect(asked['cmd']).toBe('remove_confirm');
    const confirmed = press(workflow, confirmButton(workflow, asked));
    if (confirmed['authorized'] !== true) return { blockedAt: 'confirmacao', interpreted: confirmed };
    expect(confirmed).toMatchObject({ cmd: 'remove_execute', action: 'REMOVE' });
    return { blockedAt: null, interpreted: confirmed, response: await send(workflow, confirmed) };
  };
  const activate = async (requestId: string) => {
    h.advance(1_000);
    const result = await h.commands.execute({
      requestId,
      action: 'ACTIVATE',
      profileId: h.target.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    return (await bodies()).filter((body) => body['event'] === 'MITIGATION_VERIFIED').at(-1)!;
  };
  const undoWrites = () =>
    h.ssh.writes.filter((commands) => commands.some((line) => line.startsWith('undo '))).length;
  return { h, app, bodies, alertButton, press, confirmButton, send, removeFrom, activate, undoWrites };
}

describe('workflow candidato RC7.1.3 x API: retirada vinculada a mitigacao', () => {
  it('o candidato difere do publicado em exatamente 5 nodes; ids, credenciais e conexoes intactos', () => {
    const changed = CANDIDATE.nodes
      .filter((node) => sha(node) !== sha(nodeOf(PUBLISHED, node.name)))
      .map((node) => node.name)
      .sort();
    expect(changed).toEqual([
      'Interpretar Callback',
      'Montar Corpo do Comando',
      'Telegram - Alerta com Botoes',
      'Telegram - Confirmar Retirada',
      'Telegram - Nao Autorizado',
    ]);
    expect(CANDIDATE.nodes).toHaveLength(PUBLISHED.nodes.length);
    expect(sha(CANDIDATE.connections)).toBe(sha(PUBLISHED.connections));
    for (const node of CANDIDATE.nodes) {
      const original = nodeOf(PUBLISHED, node.name);
      expect([node.id, node.type, node.webhookId, sha(node.credentials ?? null)]).toEqual([
        original.id,
        original.type,
        original.webhookId,
        sha(original.credentials ?? null),
      ]);
    }
  });

  it('botao do alerta atual: pedir -> confirmar -> REMOVED_VERIFIED; callback_data cabe em 64 bytes', async () => {
    const t = await setup();
    const body = await t.activate('ui-activate-1');
    const data = t.alertButton(CANDIDATE, body);
    expect(data).toBe(`remove_confirm|${t.h.target.profileId}|${String(body['mitigationRef'])}`);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    const asked = t.press(CANDIDATE, data);
    const execute = t.confirmButton(CANDIDATE, asked);
    expect(Buffer.byteLength(execute)).toBeLessThanOrEqual(64);
    const done = await t.removeFrom(CANDIDATE, data);
    expect(done.response?.body).toMatchObject({ ok: true, status: 'REMOVED_VERIFIED' });
    expect(t.h.ssh.active).toBe(false);
    await t.app.close();
  });

  it('botao ANTIGO (mitigacao anterior) nao retira a mitigacao nova', async () => {
    const t = await setup();
    const oldAlert = t.alertButton(CANDIDATE, await t.activate('ui-activate-1'));
    expect((await t.removeFrom(CANDIDATE, oldAlert)).response?.body['status']).toBe(
      'REMOVED_VERIFIED',
    );
    const newAlert = t.alertButton(CANDIDATE, await t.activate('ui-activate-2'));
    expect(newAlert).not.toBe(oldAlert);

    const stale = await t.removeFrom(CANDIDATE, oldAlert);
    expect(stale.response?.body).toMatchObject({
      ok: false,
      verified: false,
      status: 'MITIGATION_REFERENCE_STALE',
    });
    expect(t.h.ssh.active).toBe(true);
    expect(t.undoWrites()).toBe(1);
    // tambem o botao de CONFIRMAR antigo, que ficou na conversa
    const oldConfirm = t.confirmButton(CANDIDATE, t.press(CANDIDATE, oldAlert));
    expect((await t.send(CANDIDATE, t.press(CANDIDATE, oldConfirm))).body['status']).toBe(
      'MITIGATION_REFERENCE_STALE',
    );
    expect(t.h.ssh.active).toBe(true);

    expect((await t.removeFrom(CANDIDATE, newAlert)).response?.body['status']).toBe(
      'REMOVED_VERIFIED',
    );
    expect(t.undoWrites()).toBe(2);
    await t.app.close();
  });

  it('botoes emitidos ANTES da correcao (sem referencia) sao barrados no n8n e na API', async () => {
    const t = await setup();
    await t.activate('ui-activate-1');
    for (const legacy of [
      `remove_confirm|${t.h.target.profileId}`,
      `remove_execute|${t.h.target.profileId}`,
      `remove_execute|${t.h.target.profileId}|`,
      `remove_execute|${t.h.target.profileId}|nao-e-uma-referencia`,
    ]) {
      const interpreted = t.press(CANDIDATE, legacy);
      expect(interpreted).toMatchObject({ authorized: false, action: null, canRemove: false });
    }
    const interpreted = t.press(CANDIDATE, `remove_execute|${t.h.target.profileId}`);
    expect(interpreted['staleButton']).toBe(true);
    expect(
      String(evaluate(nodeOf(CANDIDATE, 'Telegram - Nao Autorizado').parameters['text'], interpreted)),
    ).toContain('Botão antigo');
    // defesa em profundidade: mesmo que o workflow PUBLICADO (botao sem referencia) chame a API
    const viaOldWorkflow = await t.send(
      PUBLISHED,
      t.press(PUBLISHED, `remove_execute|${t.h.target.profileId}`),
    );
    expect(viaOldWorkflow.body).toMatchObject({ ok: false, status: 'MITIGATION_REFERENCE_REQUIRED' });
    expect(t.h.ssh.active).toBe(true);
    expect(t.undoWrites()).toBe(0);
    await t.app.close();
  });

  it('callback duplicado (mesma entrega do Telegram) e idempotente: uma retirada fisica', async () => {
    const t = await setup();
    const data = t.alertButton(CANDIDATE, await t.activate('ui-activate-1'));
    const execute = t.confirmButton(CANDIDATE, t.press(CANDIDATE, data));
    const [first, replay] = await Promise.all([
      t.send(CANDIDATE, t.press(CANDIDATE, execute, 'cbq-same')),
      t.send(CANDIDATE, t.press(CANDIDATE, execute, 'cbq-same')),
    ]);
    expect([first.body['status'], replay.body['status']]).toEqual([
      'REMOVED_VERIFIED',
      'REMOVED_VERIFIED',
    ]);
    // segundo toque (novo callback) depois da retirada: nada a retirar
    const again = await t.send(CANDIDATE, t.press(CANDIDATE, execute));
    expect(again.body['status']).toBe('MITIGATION_REFERENCE_STALE');
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('autorizacao e auditoria preservadas: fora do grupo nada executa; operador segue no corpo', async () => {
    const t = await setup();
    const data = t.alertButton(CANDIDATE, await t.activate('ui-activate-1'));
    const outsider = runCode(nodeOf(CANDIDATE, 'Interpretar Callback'), {
      callback_query: {
        id: 'cbq-x',
        data,
        from: { id: 1, username: 'intruso' },
        message: { message_id: 1, chat: { id: -1 } },
      },
    });
    expect(outsider).toMatchObject({ authorized: false, action: null, staleButton: false });
    const confirmed = t.press(CANDIDATE, t.confirmButton(CANDIDATE, t.press(CANDIDATE, data)));
    const built = JSON.parse(
      String(
        runCode(nodeOf(CANDIDATE, 'Montar Corpo do Comando'), confirmed, {
          'Interpretar Callback': confirmed,
        })['bodyJson'],
      ),
    ) as Json;
    expect(Object.keys(built).sort()).toEqual(
      ['action', 'chatId', 'confirmedBy', 'mitigationRef', 'profileId', 'requestId'].sort(),
    );
    expect(built['confirmedBy']).toBe('telegram:4242(@operador)');
    expect(String(built['requestId'])).toMatch(/^telegram-cbq-/);
    await t.app.close();
  });
});

describe('workflow PUBLICADO (9a48c712) x release atual: eventos do E0 e ACK do outbox', () => {
  /** Resposta do node "Responder OUT 200" (ACK estrito lido pelo outbox do NetVision). */
  const ack = (workflow: Workflow, body: Json, telegramReceipt: Json | undefined) => {
    const normalized = normalize(workflow, body);
    const routes: Record<string, string> = {
      ACTIVATED: 'Telegram - Alerta com Botoes',
      DETECTION: 'Telegram - Aviso de Deteccao (sem escrita)',
      STATUS: 'Telegram - Status Mitigacao RC712',
    };
    const outputs: Outputs = { 'Normalizar Evento OUT': normalized };
    const route = routes[String(normalized['RC712_ROUTE'])];
    if (route) outputs[route] = telegramReceipt;
    return {
      normalized,
      ack: evaluate(
        String(nodeOf(workflow, 'Responder OUT 200').parameters['responseBody']),
        normalized,
        outputs,
      ) as Json,
    };
  };
  const delivered = { ok: true, result: { message_id: 4321 } };

  it.each([
    ['PUBLICADO', PUBLISHED],
    ['CANDIDATO', CANDIDATE],
  ] as const)(
    '%s: MITIGATION_VERIFIED, MITIGATION_REMOVED_VERIFIED e MITIGATION_FAILED/UNVERIFIED_PHYSICAL sao roteados e confirmados',
    async (_label, workflow) => {
      const ok = await setup(false);
      await ok.activate('e0-activate');
      await ok.h.commands.execute({
        requestId: 'e0-remove',
        action: 'REMOVE',
        profileId: ok.h.target.profileId,
      });
      const failed = await setup(false);
      failed.h.ssh.physical.mode = 'not-advertised';
      await failed.h.commands.execute({
        requestId: 'e0-activate',
        action: 'ACTIVATE',
        profileId: failed.h.target.profileId,
      });
      const events = [...(await ok.bodies()), ...(await failed.bodies())];
      expect(events.map((body) => body['event'])).toEqual([
        'MITIGATION_VERIFIED',
        'MITIGATION_REMOVED_VERIFIED',
        'MITIGATION_FAILED',
      ]);
      const expectedRoute = ['ACTIVATED', 'STATUS', 'STATUS'];
      for (const [index, body] of events.entries()) {
        const result = ack(workflow, body, delivered);
        expect(result.normalized).toMatchObject({
          RC712_VALID: true,
          RC712_ROUTE: expectedRoute[index],
        });
        // ACK positivo: o outbox do NetVision so marca SENT com delivered === true
        expect(result.ack).toMatchObject({
          ok: true,
          received: true,
          routed: true,
          delivered: true,
          event: body['event'],
          eventId: body['eventId'],
          profileId: body['profileId'],
        });
        // Telegram nao entregou: sem ACK positivo (o outbox reenvia)
        expect(ack(workflow, body, undefined).ack['delivered']).toBe(false);
        expect(ack(workflow, body, { ok: false }).ack['delivered']).toBe(false);
      }
      expect(String(events[2]!['failureKind'])).toBe('UNVERIFIED_PHYSICAL');
      await ok.app.close();
      await failed.app.close();
    },
  );

  it('o publicado ignora o campo novo mitigationRef (compatibilidade da ordem de implantacao)', async () => {
    const t = await setup(false);
    const body = await t.activate('ui-activate-1');
    expect(body['mitigationRef']).toMatch(/^[a-f0-9]{16}$/);
    // botao do workflow publicado: sem referencia; continua funcionando enquanto a exigencia esta desligada
    const data = t.alertButton(PUBLISHED, body);
    expect(data).toBe(`remove_confirm|${t.h.target.profileId}`);
    const done = await t.removeFrom(PUBLISHED, data);
    expect(done.response?.body['status']).toBe('REMOVED_VERIFIED');
    await t.app.close();
  });
});
