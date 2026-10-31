/**
 * RC7.1.2 + PREFIXOS — candidato derivado da versao EFETIVAMENTE publicada.
 *
 * Base: activeVersion 6a97fe4a-31ea-49e6-b892-1ac55f85d115 do workflow
 * SVh8Z-zUcSzQYOOJZ-DKP (58 nos / 59 arestas). O snapshot publicado nao e
 * versionado; a preservacao e provada por hash: retirando do candidato as duas
 * insercoes do normalizador, o grafo volta a ter EXATAMENTE o sha256 medido ao
 * vivo na publicacao (60af8761...). Qualquer outra diferenca quebra o hash.
 *
 * Alem disso trava a renderizacao dos tres prefixos da AGLINK, o fallback
 * "indisponivel" (prefixes=null e eventos antigos), o retry, o ACK estrito e o
 * callback REMOVE. Nada aqui publica ou executa n8n: verificacao estatica +
 * execucao das expressoes/codigo dos nos em sandbox JS.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}
interface Workflow {
  id: string;
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const docs = (file: string) =>
  readFileSync(new URL(`../../../../../../docs/n8n/${file}`, import.meta.url), 'utf8');

const RC712_RAW = docs('GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json');
const RC712 = JSON.parse(RC712_RAW) as Workflow;
const MANIFEST = JSON.parse(docs('RC7.1.2-PREFIXOS-MANIFEST.json')) as Record<string, unknown>;
const NODES = new Map(RC712.nodes.map((node) => [node.name, node]));

const PUBLISHED_ACTIVE_VERSION = '6a97fe4a-31ea-49e6-b892-1ac55f85d115';
const PUBLISHED_GRAPH_SHA256 = '60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870';
const AGLINK_PREFIXES = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];
const PROFILE_ID = 'cmuoavm4e00bysslhqd0h3q7u';

/** Equivalente a `json.dumps(value, sort_keys=True)` do Python (ensure_ascii). */
const pyDumps = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('numero nao finito');
    return String(value);
  }
  if (typeof value === 'string') {
    let out = '"';
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      const ch = value[i]!;
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return '[' + value.map(pyDumps).join(', ') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return (
      '{' +
      keys
        .map((key) => `${pyDumps(key)}: ${pyDumps((value as Record<string, unknown>)[key])}`)
        .join(', ') +
      '}'
    );
  }
  throw new Error(`tipo nao serializavel: ${typeof value}`);
};

const graphSha256 = (workflow: Pick<Workflow, 'nodes' | 'connections'>) =>
  createHash('sha256')
    .update(pyDumps({ nodes: workflow.nodes, connections: workflow.connections }))
    .digest('hex');

const countEdges = (workflow: Workflow) =>
  Object.values(workflow.connections).reduce(
    (total, outputs) =>
      total + Object.values(outputs).reduce((sum, lists) => sum + lists.flat().length, 0),
    0,
  );

/** Desfaz exatamente as duas insercoes do normalizador. */
const BLOCK =
  /\n {2}\/\/ =+\n {2}\/\/ ESCOPO VERIFICADO - prefixos REAIS[\s\S]*?<i>indispon\\u00edvel<\/i>'\);\n {2}\}\n/g;
const OUTPUT_LINES = '    PREFIXOS: scopePrefixes,\n    QTD_PREFIXOS: scopePrefixes.length,\n';
const revertCandidate = (): Workflow => {
  const clone = JSON.parse(RC712_RAW) as Workflow;
  const node = clone.nodes.find((item) => item.name === 'Normalizar Evento OUT')!;
  const code = String(node.parameters['jsonOutput']);
  expect(code.match(BLOCK)).toHaveLength(1);
  expect(code.split(OUTPUT_LINES)).toHaveLength(2);
  node.parameters['jsonOutput'] = code.replace(BLOCK, '').replace(OUTPUT_LINES, '');
  return clone;
};

/** Executa o normalizador (expressao n8n) com um corpo de webhook. */
const runNormalizer = (body: Record<string, unknown>): Record<string, unknown> => {
  let expression = String(NODES.get('Normalizar Evento OUT')!.parameters['jsonOutput']).trim();
  if (expression.startsWith('=')) expression = expression.slice(1);
  expression = expression.trim();
  if (expression.startsWith('{{')) expression = expression.slice(2);
  if (expression.endsWith('}}')) expression = expression.slice(0, -2);
  const evaluate = new Function('$json', `return (${expression});`) as (
    input: unknown,
  ) => Record<string, unknown>;
  return evaluate({ body });
};

/** Executa a expressao do `Responder OUT 200` com o recibo do Telegram. */
const runAck = (normalized: Record<string, unknown>, receipt: unknown) => {
  let expression = String(NODES.get('Responder OUT 200')!.parameters['responseBody']).trim();
  expression = expression.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  const $ = (name: string) =>
    name === 'Normalizar Evento OUT'
      ? { first: () => ({ json: normalized }) }
      : name === 'Telegram - Alerta com Botoes' && receipt !== undefined
        ? { isExecuted: true, last: () => ({ json: receipt }) }
        : { isExecuted: false, last: () => ({ json: null }) };
  return (
    new Function('$', `return (${expression});`) as (fn: typeof $) => Record<string, unknown>
  )($);
};

/** Executa o Code node `Interpretar Callback` com um callback_query do Telegram. */
const runCallback = (data: string) => {
  const code = String(NODES.get('Interpretar Callback')!.parameters['jsCode']);
  const input = {
    callback_query: {
      id: 'cbq-1',
      data,
      from: { id: 101, username: 'operador' },
      message: { message_id: 7, chat: { id: -5522540056 } },
    },
  };
  const run = new Function('$input', code) as (
    stub: unknown,
  ) => { json: Record<string, unknown> }[];
  return run({ first: () => ({ json: input }) })[0]!.json;
};

/** Corpo equivalente ao payload real de `MITIGATION_VERIFIED`. */
const verifiedBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'MITIGATION_VERIFIED',
  simulation: false,
  verified: true,
  eventId: 'AGLINK-CONTRACT-EVENT-1',
  profileId: PROFILE_ID,
  customer: 'AGLINK',
  device: 'BHE-VTA-F1A-BGP-01',
  interface: 'Eth-Trunk1.3058',
  addressFamily: 'IPV4',
  peer: '10.200.201.2',
  affectedPeers: ['10.200.201.2'],
  policy: 'PL-AGLINK_IPv4-IN',
  bogonNode: 1,
  mitigationNode: 2,
  rt: '268568:660',
  sharedPolicy: false,
  sharedPolicyTargets: [],
  fieldsUnavailable: [],
  ...extra,
});

describe('RC7.1.2+prefixos - derivado da versao publicada', () => {
  it('identidade e contagens da versao publicada (58 nos / 59 arestas)', () => {
    expect(RC712.id).toBe('SVh8Z-zUcSzQYOOJZ-DKP');
    expect(RC712.nodes).toHaveLength(58);
    expect(countEdges(RC712)).toBe(59);
    expect(RC712.active).toBe(false);
    expect(MANIFEST['baseActiveVersionId']).toBe(PUBLISHED_ACTIVE_VERSION);
    expect(MANIFEST['baseGraphSha256']).toBe(PUBLISHED_GRAPH_SHA256);
    expect(NODES.has('Somente Status Mitigacao RC712?')).toBe(true);
    expect(NODES.has('Telegram - Status Mitigacao RC712')).toBe(true);
  });

  it('candidato menos o delta do normalizador == grafo publicado (sha256)', () => {
    expect(graphSha256(RC712)).not.toBe(PUBLISHED_GRAPH_SHA256);
    expect(graphSha256(RC712)).toBe(MANIFEST['candidateGraphSha256']);
    expect(graphSha256(revertCandidate())).toBe(PUBLISHED_GRAPH_SHA256);
  });

  it('o manifesto confere com o arquivo versionado', () => {
    expect(createHash('sha256').update(RC712_RAW).digest('hex')).toBe(
      MANIFEST['candidateFileSha256'],
    );
  });

  it('preserva as referencias reais de credencial (sem placeholder, sem valor)', () => {
    expect(RC712_RAW).not.toContain('PLACEHOLDER');
    const ids = new Set(
      RC712.nodes.flatMap((node) => Object.values(node.credentials ?? {}).map((c) => c.id)),
    );
    expect(ids).toEqual(
      new Set([
        'B9d3Hr3c9SPsPor2',
        'XBwaqw4mY1tH2pwf',
        'bkffylmXLwZUFxiC',
        'gjbB9eOXEJWGKxQ5',
        'ixNUvgLE27w9cCmb',
        'm4O4GW2RMuBFNOUn',
      ]),
    );
    expect(RC712_RAW).not.toContain('$env');
    expect(RC712_RAW).not.toMatch(/X-NetVision-Token/i);
  });

  it('mantem os quatro webhooks POST com Header Auth e credencial propria', () => {
    const post = RC712.nodes.filter(
      (node) =>
        node.type.endsWith('webhook') &&
        node.parameters['httpMethod'] === 'POST' &&
        [
          'netvision-mitigation',
          'netvision-alarmes',
          'netvision-alarmes-vnt',
          'netvision-alarmes-fibinet',
        ].includes(String(node.parameters['path'])),
    );
    expect(post).toHaveLength(4);
    expect(new Set(post.map((node) => node.credentials?.['httpHeaderAuth']?.id)).size).toBe(4);
    for (const node of post) expect(node.parameters['authentication']).toBe('headerAuth');
  });
});

describe('RC7.1.2+prefixos - apresentacao', () => {
  it('renderiza os tres prefixos da AGLINK na mensagem verificada', () => {
    const out = runNormalizer(verifiedBody({ prefixes: AGLINK_PREFIXES }));
    const text = String(out['telegramText']);
    for (const prefix of AGLINK_PREFIXES) expect(text).toContain(`• ${prefix}`);
    expect(text).toContain('Prefixos (3)');
    expect(out['PREFIXOS']).toEqual(AGLINK_PREFIXES);
    expect(out['QTD_PREFIXOS']).toBe(3);
    expect(out['RC712_VALID']).toBe(true);
    expect(out['RC712_ROUTE']).toBe('ACTIVATED');
    expect(out['REAL_ACTIVATED']).toBe(true);
    expect(out['EVENT_ID']).toBe('AGLINK-CONTRACT-EVENT-1');
  });

  it('prefixes=null mostra "indisponivel" e nao inventa prefixo', () => {
    const out = runNormalizer(verifiedBody({ prefixes: null, fieldsUnavailable: ['prefixes'] }));
    const text = String(out['telegramText']);
    expect(text).toContain('<b>Prefixos:</b> <i>indisponível</i>');
    expect(text).not.toContain('/23');
    expect(out['PREFIXOS']).toEqual([]);
    expect(out['QTD_PREFIXOS']).toBe(0);
    expect(out['RC712_ROUTE']).toBe('ACTIVATED');
  });

  it('evento ANTIGO (sem o campo) sai igual ao publicado + linha indisponivel', () => {
    const out = runNormalizer(verifiedBody());
    expect(out['REAL_ACTIVATED']).toBe(true);
    expect(out['PREFIXOS']).toEqual([]);
    const published = revertCandidate().nodes.find(
      (node) => node.name === 'Normalizar Evento OUT',
    )!;
    let expression = String(published.parameters['jsonOutput']).trim().slice(1).trim();
    expression = expression.slice(2, -2);
    const before = (
      new Function('$json', `return (${expression});`) as (i: unknown) => {
        telegramText: string;
      }
    )({ body: verifiedBody() });
    const lines = String(out['telegramText']).split('\n');
    const index = lines.indexOf('<b>Prefixos:</b> <i>indisponível</i>');
    expect(index).toBeGreaterThan(0);
    lines.splice(index - 1, 2);
    expect(lines.join('\n')).toBe(before.telegramText);
  });

  it('descarta itens invalidos e trata lista vazia como indisponivel', () => {
    expect(
      runNormalizer(verifiedBody({ prefixes: [...AGLINK_PREFIXES, '', null, 42] }))['PREFIXOS'],
    ).toEqual(AGLINK_PREFIXES);
    const empty = runNormalizer(verifiedBody({ prefixes: [] }));
    expect(empty['PREFIXOS']).toEqual([]);
    expect(String(empty['telegramText'])).toContain('indispon');
  });

  it('escapa HTML vindo do campo', () => {
    const out = runNormalizer(verifiedBody({ prefixes: ['<b>x</b>'] }));
    expect(String(out['telegramText'])).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('retry: o mesmo evento produz exatamente a mesma saida', () => {
    const body = verifiedBody({ prefixes: AGLINK_PREFIXES });
    expect(runNormalizer(structuredClone(body))).toEqual(runNormalizer(structuredClone(body)));
  });

  it('simulacao e ativacao nao verificada continuam rejeitadas', () => {
    const sim = runNormalizer(verifiedBody({ simulation: true, prefixes: AGLINK_PREFIXES }));
    expect(sim['REAL_ACTIVATED']).toBe(false);
    expect(sim['RC712_VALID']).toBe(false);
    const unverified = runNormalizer(verifiedBody({ verified: false, prefixes: AGLINK_PREFIXES }));
    expect(unverified['REAL_ACTIVATED']).toBe(false);
  });

  it('deteccao bloqueada e reenvio nao ganham a linha de prefixos', () => {
    const blocked = runNormalizer({
      event: 'MITIGATION_DETECTION_BLOCKED',
      simulation: true,
      verified: false,
      eventId: 'AGLINK-DET-1',
      episodeId: 'EP-1',
      profileId: PROFILE_ID,
      customer: 'AGLINK',
      policy: 'PL-AGLINK_IPv4-IN',
      peer: '10.200.201.2',
      blockedReason: 'AUTO_EXECUTION_DISABLED',
      prefixes: AGLINK_PREFIXES,
    });
    expect(blocked['DETECTION_BLOCKED']).toBe(true);
    expect(String(blocked['detectionText'])).not.toContain('Prefixos');
  });
});

describe('RC7.1.2+prefixos - ACK estrito e callback REMOVE', () => {
  const receipt = { ok: true, result: { message_id: 4242 } };

  it('ACK positivo so com rota valida E recibo do Telegram (com ou sem prefixos)', () => {
    for (const prefixes of [AGLINK_PREFIXES, null, undefined]) {
      const normalized = runNormalizer(verifiedBody(prefixes === undefined ? {} : { prefixes }));
      expect(runAck(normalized, receipt)).toEqual({
        ok: true,
        received: true,
        routed: true,
        delivered: true,
        event: 'MITIGATION_VERIFIED',
        eventId: 'AGLINK-CONTRACT-EVENT-1',
        profileId: PROFILE_ID,
        episodeId: null,
      });
      expect(runAck(normalized, undefined)['delivered']).toBe(false);
      expect(runAck(normalized, { ok: false, error: 'x' })['delivered']).toBe(false);
    }
  });

  it('botao REMOVE continua remove_confirm|<perfil> dentro de 64 bytes', () => {
    const button = NODES.get('Telegram - Alerta com Botoes')!.parameters as {
      inlineKeyboard: {
        rows: { row: { buttons: { additionalFields: Record<string, string> }[] } }[];
      };
    };
    const template =
      button.inlineKeyboard.rows[0]!.row.buttons[0]!.additionalFields['callback_data'];
    expect(template).toBe('=remove_confirm|{{ $json.PROFILE_ID }}');
    const out = runNormalizer(verifiedBody({ prefixes: AGLINK_PREFIXES }));
    const data = `remove_confirm|${String(out['PROFILE_ID'])}`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    const parsed = runCallback(data);
    expect(parsed['cmd']).toBe('remove_confirm');
    expect(parsed['profileId']).toBe(PROFILE_ID);
    expect(parsed['action']).toBeNull();
  });

  it('remove_execute autorizado vira REMOVE; chat estranho nao', () => {
    expect(runCallback(`remove_execute|${PROFILE_ID}`)['action']).toBe('REMOVE');
    const code = String(NODES.get('Interpretar Callback')!.parameters['jsCode']);
    const run = new Function('$input', code) as (s: unknown) => { json: Record<string, unknown> }[];
    const foreign = run({
      first: () => ({
        json: {
          callback_query: {
            id: 'cbq-2',
            data: `remove_execute|${PROFILE_ID}`,
            from: { id: 9 },
            message: { message_id: 1, chat: { id: -1 } },
          },
        },
      }),
    })[0]!.json;
    expect(foreign['action']).toBeNull();
  });
});
