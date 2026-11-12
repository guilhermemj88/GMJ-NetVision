import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { buildMitigationWebhookPayload } from '../../infrastructure/bgp/mitigation/mitigation-webhook';
import { registerN8nRoutes } from '../../n8n-routes';
import { decodeNotification, type OutboxEntry } from './durable-mitigation-outbox';

/**
 * RC7.1.4 (candidato, NAO publicado): "Solicitacao recebida. Retirada em andamento." + segundo toque sem
 * segunda retirada fisica. O n8n NAO guarda estado (execucoes simultaneas do n8n nao compartilham static data
 * de forma confiavel): a API e a fonte de verdade (REMOVE_IN_PROGRESS, MITIGATION_REFERENCE_STALE,
 * MANUAL_RECONCILIATION_REQUIRED). O codigo dos nodes roda aqui contra a API real (so a borda SSH e falsa).
 */

type Json = Record<string, unknown>;
interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  credentials?: unknown;
  onError?: string;
  webhookId?: string;
}
interface Workflow {
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}
const load = (file: string): Workflow =>
  JSON.parse(
    readFileSync(new URL('../../../../../docs/n8n/' + file, import.meta.url), 'utf8'),
  ) as Workflow;
const RC713 = load('GMJ-NetVision-Telegram-RC7.1.3-CANDIDATO.json');
const RC714 = load('GMJ-NetVision-Telegram-RC7.1.4-CANDIDATO.json');
const nodeOf = (workflow: Workflow, name: string) =>
  workflow.nodes.find((node) => node.name === name)!;
const sha = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');

type Outputs = Record<string, Json | undefined>;
const selector = (outputs: Outputs) => (name: string) => ({
  first: () => ({ json: outputs[name]! }),
  last: () => ({ json: outputs[name]! }),
});
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
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expression: string) =>
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

const TOKEN = 'token-inbound-de-teste';
const CHAT_ID = /const allowedChatId = '(-?\d+)'/.exec(
  String(nodeOf(RC714, 'Interpretar Callback').parameters['jsCode']),
)![1]!;

async function setup() {
  const h = await createPilotHarness();
  const app = Fastify();
  registerN8nRoutes(app, { commands: h.commands, commandToken: TOKEN, requireRemoveRef: true });
  await app.ready();
  let callbackSeq = 0;
  const bodies = async () =>
    (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox')))
      .map(
        (row) => buildMitigationWebhookPayload(decodeNotification(row.payload)) as unknown as Json,
      )
      .sort((a, b) => String(a['occurredAt']).localeCompare(String(b['occurredAt'])));
  const activate = async (requestId: string) => {
    h.advance(1_000);
    const result = await h.commands.execute({
      requestId,
      action: 'ACTIVATE',
      profileId: h.target.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    return (await bodies()).filter((b) => b['event'] === 'MITIGATION_VERIFIED').at(-1)!;
  };
  const alertData = (body: Json): string => {
    const normalized = evaluate(
      String(nodeOf(RC714, 'Normalizar Evento OUT').parameters['jsonOutput']),
      { body },
    ) as Json;
    const button = nodeOf(RC714, 'Telegram - Alerta com Botoes').parameters['inlineKeyboard']
      .rows[0].row.buttons[0];
    return String(
      evaluate(button.additionalFields.callback_data, normalized, {
        'Webhook NetVision OUT': { body },
      }),
    );
  };
  const interpret = (data: string, id?: string, chat = Number(CHAT_ID)) =>
    runCode(nodeOf(RC714, 'Interpretar Callback'), {
      callback_query: {
        id: id ?? `cbq-${++callbackSeq}`,
        data,
        from: { id: 4242, username: 'operador' },
        message: { message_id: 77, chat: { id: chat } },
      },
    });
  const confirmData = (asked: Json): string =>
    String(
      evaluate(
        nodeOf(RC714, 'Telegram - Confirmar Retirada').parameters['inlineKeyboard'].rows[0].row
          .buttons[1].additionalFields.callback_data,
        asked,
      ),
    );

  /** Um toque em CONFIRMAR RETIRADA percorrendo os nodes na ordem das conexoes do RC7.1.4. */
  const confirmTap = async (
    data: string,
    opts: { id?: string; respond?: () => Promise<Json> | Json } = {},
  ) => {
    const events: string[] = [];
    const interpreted = interpret(data, opts.id);
    expect(interpreted).toMatchObject({
      authorized: true,
      cmd: 'remove_execute',
      action: 'REMOVE',
    });
    const outputs: Outputs = { 'Interpretar Callback': interpreted };
    events.push(
      'ACK:' + String(nodeOf(RC714, 'Telegram - Ack Retirada').parameters['additionalFields'].text),
    );
    events.push('EDIT_MENSAGEM_SEM_BOTOES');
    const built = runCode(nodeOf(RC714, 'Montar Corpo do Comando'), interpreted, outputs);
    events.push('HTTP');
    let response: Json;
    if (opts.respond) {
      response = await opts.respond();
    } else {
      const res = await app.inject({
        method: 'POST',
        url: '/api/integrations/n8n/mitigation-command',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: String(built['bodyJson']),
      });
      response = res.json() as Json;
    }
    const formatted = runCode(nodeOf(RC714, 'Formatar Resposta NetVision'), response, outputs);
    return {
      events,
      status: String(response['status'] ?? ''),
      text: String(formatted['telegramText']),
      removalVerified: formatted['removalVerified'] === true,
    };
  };
  const undoWrites = () =>
    h.ssh.writes.filter((c) => c.some((line) => line.startsWith('undo '))).length;
  /**
   * Segura a escrita fisica do REMOVE (como os ~22 s reais do E1) ate `release()`: o toque 1 fica em
   * execucao enquanto os demais chegam. Devolve o toque 1 (promessa) depois que a escrita comecou.
   */
  const holdRemove = async (execute: string) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const writing = new Promise<void>((resolve) => (started = resolve));
    h.ssh.afterWrite = async () => {
      started();
      await held;
    };
    const first = confirmTap(execute);
    await writing;
    return {
      first,
      release: async () => {
        delete h.ssh.afterWrite;
        release();
        return first;
      },
    };
  };
  return {
    h,
    app,
    activate,
    alertData,
    interpret,
    confirmData,
    confirmTap,
    undoWrites,
    holdRemove,
  };
}

describe('RC7.1.4 candidato: diferenca minima em relacao ao RC7.1.3 publicado', () => {
  it('muda so o caminho da retirada: 2 nodes novos + 2 alterados; o resto (ACTIVATE, alarmes, autorizacao) e identico', () => {
    const before = new Map(RC713.nodes.map((n) => [n.name, n]));
    const after = new Map(RC714.nodes.map((n) => [n.name, n]));
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const changed = [...before.keys()]
      .filter((k) => after.has(k) && sha(before.get(k)) !== sha(after.get(k)))
      .sort();
    expect(removed).toEqual([]);
    expect(added).toEqual(['Telegram - Ack Retirada', 'Telegram - Marcar Em Andamento']);
    expect(changed).toEqual(['Formatar Resposta NetVision', 'HTTP - NetVision Command']);
    expect(RC714.nodes.length).toBe(RC713.nodes.length + 2);
    for (const [name, node] of before) {
      expect(after.get(name)!.id).toBe(node.id);
      expect(after.get(name)!.webhookId).toBe(node.webhookId);
    }
    const oldCreds = new Set(
      RC713.nodes.filter((n) => n.credentials).map((n) => sha(n.credentials)),
    );
    expect(
      RC714.nodes.filter((n) => n.credentials).every((n) => oldCreds.has(sha(n.credentials))),
    ).toBe(true);
    for (const name of [
      'Telegram Trigger - Callback',
      'Interpretar Callback',
      'Autorizar Telegram',
      'Pedido de Retirada?',
      'Confirmou Retirada?',
      'Montar Corpo do Comando',
      'Montar Confirmacao Compartilhada',
      'Telegram - Confirmar Retirada',
      'Telegram - Alerta com Botoes',
      'Normalizar Evento OUT',
    ]) {
      expect(sha(after.get(name))).toBe(sha(before.get(name)));
    }
    const changedConnections = Object.keys({ ...RC713.connections, ...RC714.connections })
      .filter((k) => sha(RC713.connections[k]) !== sha(RC714.connections[k]))
      .sort();
    expect(changedConnections).toEqual([
      'Confirmou Retirada?',
      'Telegram - Ack Retirada',
      'Telegram - Marcar Em Andamento',
    ]);
  });

  it('cadeia: Confirmou? -> Ack -> Marcar Em Andamento -> Montar Corpo -> HTTP; ack/edicao nao bloqueiam a retirada', () => {
    const next = (name: string, out = 0) => RC714.connections[name]!.main[out]!.map((x) => x.node);
    expect(next('Confirmou Retirada?', 0)).toEqual(['Telegram - Ack Retirada']);
    expect(next('Telegram - Ack Retirada')).toEqual(['Telegram - Marcar Em Andamento']);
    expect(next('Telegram - Marcar Em Andamento')).toEqual(['Montar Corpo do Comando']);
    expect(next('Montar Corpo do Comando')).toEqual(['HTTP - NetVision Command']);
    expect(next('Confirmou Retirada?', 1)).toEqual(['Telegram - Retirada Cancelada']);
    for (const n of ['Telegram - Ack Retirada', 'Telegram - Marcar Em Andamento']) {
      expect(nodeOf(RC714, n).onError).toBe('continueRegularOutput');
    }
    const edit = nodeOf(RC714, 'Telegram - Marcar Em Andamento').parameters;
    expect(edit['operation']).toBe('editMessageText');
    expect(edit['replyMarkup']).toBeUndefined();
    expect(edit['inlineKeyboard']).toBeUndefined();
    expect(nodeOf(RC714, 'Telegram - Ack Retirada').parameters['additionalFields'].text).toBe(
      'Solicitação recebida. Retirada em andamento.',
    );
    const http = nodeOf(RC714, 'HTTP - NetVision Command');
    expect(http.parameters['options'].timeout).toBe(120000);
    expect(http.parameters['options'].response.response.neverError).toBe(true);
    // nenhum estado no n8n
    expect(JSON.stringify(RC714)).not.toContain('getWorkflowStaticData');
  });
});

describe('RC7.1.4 x API real: toque normal, toque duplo, concorrencia, inconclusivo', () => {
  it('toque normal: ack e remocao do teclado ANTES do comando; 1 retirada fisica; mensagem final', async () => {
    const t = await setup();
    const data = t.alertData(await t.activate('act-1'));
    const tap = await t.confirmTap(t.confirmData(t.interpret(data)));
    expect(tap.events).toEqual([
      'ACK:Solicitação recebida. Retirada em andamento.',
      'EDIT_MENSAGEM_SEM_BOTOES',
      'HTTP',
    ]);
    expect(tap.removalVerified).toBe(true);
    expect(tap.text).toContain('MITIGAÇÃO RETIRADA');
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('segundo toque DEPOIS do fim: a API devolve STALE, sem escrita; mensagem clara', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    await t.confirmTap(execute);
    const second = await t.confirmTap(execute);
    expect(second.status).toBe('MITIGATION_REFERENCE_STALE');
    expect(second.text).toContain('SEM MITIGAÇÃO ATIVA COM ESTA REFERÊNCIA');
    expect(second.text).not.toContain('AÇÃO NÃO CONFIRMADA');
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('callback REPETIDO (mesma entrega, mesmo id) em paralelo: idempotente, 1 retirada fisica', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    const [a, b] = await Promise.all([
      t.confirmTap(execute, { id: 'cbq-igual' }),
      t.confirmTap(execute, { id: 'cbq-igual' }),
    ]);
    expect(a.removalVerified && b.removalVerified).toBe(true);
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('toque duplo SIMULTANEO (ids diferentes, como no E1): o 2o recebe REMOVE_IN_PROGRESS da API, sem escrita', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    const held = await t.holdRemove(execute);
    const second = await t.confirmTap(execute);
    expect(second.status).toBe('REMOVE_IN_PROGRESS');
    expect(second.text).toContain('RETIRADA EM ANDAMENTO');
    expect(second.text).toContain('IN_PROGRESS');
    expect(second.text).toContain('NÃO enviou nenhum comando');
    expect(second.text).not.toMatch(/tente novamente/i);
    expect(second.text).not.toContain('Alteração não verificada');
    expect((await held.release()).removalVerified).toBe(true);
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('concorrencia entre execucoes do n8n: 6 toques (ids distintos) com a retirada em curso => 1 retirada fisica; nenhum estado no n8n', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    const held = await t.holdRemove(execute);
    const others = await Promise.all(Array.from({ length: 5 }, () => t.confirmTap(execute)));
    expect(others.every((x) => x.status === 'REMOVE_IN_PROGRESS')).toBe(true);
    expect((await held.release()).removalVerified).toBe(true);
    expect(t.undoWrites()).toBe(1);
    // depois do fim, novos toques sao STALE (nunca nova escrita)
    expect((await t.confirmTap(execute)).status).toBe('MITIGATION_REFERENCE_STALE');
    expect(t.undoWrites()).toBe(1);
    await t.app.close();
  });

  it('resultado INCONCLUSIVO (read-back diverge): novo toque, mesmo apos 11 min, NAO gera 2a escrita (reconciliacao exigida pela API)', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    t.h.ssh.afterWrite = async () => {
      t.h.ssh.readFails = true; // o comando foi enviado, mas o read-back nao confirma
    };
    const first = await t.confirmTap(execute);
    expect(first.removalVerified).toBe(false);
    expect(first.text).toContain('INCONCLUSIVO');
    const writesAfterFirst = t.h.ssh.writes.length;
    delete t.h.ssh.afterWrite;
    t.h.ssh.readFails = false;
    t.h.advance(11 * 60_000);
    const later = await t.confirmTap(execute);
    expect(later.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(later.text).toContain('RECONCILIAÇÃO EXIGIDA');
    expect(later.text).toContain('NÃO repita');
    expect(t.h.ssh.writes.length).toBe(writesAfterFirst);
    await t.app.close();
  });

  it('SSH falha na escrita (timeout fisico): toque seguinte nao reenvia; exige reconciliacao', async () => {
    const t = await setup();
    const execute = t.confirmData(t.interpret(t.alertData(await t.activate('act-1'))));
    t.h.ssh.timeout = true;
    const first = await t.confirmTap(execute);
    expect(first.removalVerified).toBe(false);
    const writes = t.h.ssh.writes.length;
    t.h.ssh.timeout = false;
    const again = await t.confirmTap(execute);
    expect(again.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(t.h.ssh.writes.length).toBe(writes);
    await t.app.close();
  });

  it('REMOVE_IN_PROGRESS vale so para REMOVE manual da MESMA mitigacao: outra referencia e novo ACTIVATE nao sao afetados', async () => {
    const t = await setup();
    const data = t.alertData(await t.activate('act-1'));
    const other = await t.confirmTap(`remove_execute|${t.h.target.profileId}|0123456789abcdef`);
    expect(other.status).toBe('MITIGATION_REFERENCE_STALE');
    const real = await t.confirmTap(t.confirmData(t.interpret(data)));
    expect(real.removalVerified).toBe(true);
    t.h.advance(3_600_000);
    const again = await t.activate('act-2');
    expect(again['event']).toBe('MITIGATION_VERIFIED');
    await t.app.close();
  });
});

describe('RC7.1.4: mensagens para respostas sem a API (timeout, POLICY_BUSY, erro)', () => {
  const profileId = 'cmuoavm4e00bysslhqd0h3q7u';
  const ref = 'b1187e83043161f0';
  const format = (response: Json) => {
    const interpreted = runCode(nodeOf(RC714, 'Interpretar Callback'), {
      callback_query: {
        id: 'cbq-x',
        data: `remove_execute|${profileId}|${ref}`,
        from: { id: 4242, username: 'operador' },
        message: { message_id: 77, chat: { id: Number(CHAT_ID) } },
      },
    });
    return String(
      runCode(nodeOf(RC714, 'Formatar Resposta NetVision'), response, {
        'Interpretar Callback': interpreted,
      })['telegramText'],
    );
  };

  it('POLICY_BUSY (resposta do E1): IN_PROGRESS, sem "tente novamente" e sem "alteracao nao verificada"', () => {
    const text = format({
      ok: false,
      status: 'POLICY_BUSY',
      action: 'REMOVE',
      profileId,
      verified: false,
      safeError:
        'Policy ocupada por outra operacao no mesmo equipamento (deviceId + policy). Nenhuma escrita foi feita; tente novamente.',
    });
    expect(text).toContain('RETIRADA EM ANDAMENTO');
    expect(text).not.toMatch(/tente novamente/i);
    expect(text).not.toContain('Alteração não verificada');
  });

  it('TIMEOUT / erro de conexao do HTTP (item de erro, sem status): INCONCLUSIVO, manda conferir e NAO repetir', () => {
    const text = format({ error: { message: 'timeout of 120000ms exceeded' } });
    expect(text).toContain('INCONCLUSIVO');
    expect(text).toContain('NÃO repita');
    expect(text).not.toContain('MITIGAÇÃO RETIRADA');
  });

  it('retirada nao verificada devolvida pela API e INCONCLUSIVA; sucesso exige REMOVED_VERIFIED + verified', () => {
    expect(
      format({
        ok: false,
        status: 'REVALIDATION_FAILED',
        action: 'REMOVE',
        profileId,
        verified: false,
      }),
    ).toContain('INCONCLUSIVO');
    expect(
      format({ ok: true, status: 'REMOVED_VERIFIED', action: 'REMOVE', profileId, verified: true }),
    ).toContain('MITIGAÇÃO RETIRADA');
    expect(
      format({
        ok: true,
        status: 'REMOVED_VERIFIED',
        action: 'REMOVE',
        profileId,
        verified: false,
      }),
    ).not.toContain('MITIGAÇÃO RETIRADA');
  });

  it('autorizacao e protecao contra botao antigo preservadas: fora do grupo e botao sem referencia nao executam', () => {
    const outsider = runCode(nodeOf(RC714, 'Interpretar Callback'), {
      callback_query: {
        id: 'x',
        data: `remove_execute|${profileId}|${ref}`,
        from: { id: 1, username: 'intruso' },
        message: { message_id: 1, chat: { id: -1 } },
      },
    });
    expect(outsider).toMatchObject({ authorized: false, action: null });
    const old = runCode(nodeOf(RC714, 'Interpretar Callback'), {
      callback_query: {
        id: 'y',
        data: `remove_execute|${profileId}`,
        from: { id: 4242, username: 'operador' },
        message: { message_id: 1, chat: { id: Number(CHAT_ID) } },
      },
    });
    expect(old).toMatchObject({ staleButton: true, authorized: false, action: null });
  });
});
