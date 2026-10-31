/**
 * RC7.1.2 — APRESENTACAO DOS PREFIXOS DO ESCOPO VERIFICADO.
 *
 * RC7.1.2 = RC7.1 + UMA mudanca: o normalizador passa a renderizar `prefixes`.
 * Este arquivo trava (a) a preservacao integral do RC7.1 (quatro webhooks com
 * Header Auth nativo, `lastNode` nos alarmes, ramo S5, ausencia de `$env` e de
 * token literal) e (b) a renderizacao dos tres prefixos da AGLINK, inclusive o
 * fallback "indisponivel" quando o campo falta — que e o caso dos eventos
 * anteriores a esta versao.
 *
 * Nada aqui publica ou executa n8n: o arquivo e verificado estaticamente.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}
interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const read = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../../../docs/n8n/${file}`, import.meta.url), 'utf8'),
  ) as Workflow;

const RC71 = read('GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json');
const RC712_RAW = readFileSync(
  new URL(
    '../../../../../../docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json',
    import.meta.url,
  ),
  'utf8',
);
const RC712 = JSON.parse(RC712_RAW) as Workflow;
const NODES = new Map(RC712.nodes.map((node) => [node.name, node]));

const AGLINK_PREFIXES = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];

/** Executa o normalizador (expressao n8n) com um corpo de webhook. */
const runNormalizer = (body: Record<string, unknown>): Record<string, unknown> => {
  const node = NODES.get('Normalizar Evento OUT');
  expect(node).toBeDefined();
  let expression = String(node!.parameters['jsonOutput']).trim();
  if (expression.startsWith('=')) expression = expression.slice(1);
  expression = expression.trim();
  if (expression.startsWith('{{')) expression = expression.slice(2);
  if (expression.endsWith('}}')) expression = expression.slice(0, -2);
  const evaluate = new Function('$json', `return (${expression});`) as (
    input: unknown,
  ) => Record<string, unknown>;
  return evaluate({ body });
};

/** Corpo equivalente ao payload real de `MITIGATION_VERIFIED`. */
const verifiedBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'MITIGATION_VERIFIED',
  simulation: false,
  verified: true,
  eventId: 'AGLINK-CONTRACT-EVENT-1',
  profileId: 'cmuoavm4e00bysslhqd0h3q7u',
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
  prefixos: undefined,
  ...extra,
});

describe('RC7.1.2 - preservacao integral do RC7.1', () => {
  it('mantem o MESMO conjunto de nos e as MESMAS conexoes', () => {
    expect(RC712.nodes.map((node) => node.name).sort()).toEqual(
      RC71.nodes.map((node) => node.name).sort(),
    );
    expect(RC712.connections).toEqual(RC71.connections);
  });

  it('altera somente o no de normalizacao', () => {
    const before = new Map(RC71.nodes.map((node) => [node.name, node.parameters]));
    for (const node of RC712.nodes) {
      if (node.name === 'Normalizar Evento OUT') continue;
      expect(node.parameters, node.name).toEqual(before.get(node.name));
    }
    expect(NODES.get('Normalizar Evento OUT')!.parameters).not.toEqual(
      before.get('Normalizar Evento OUT'),
    );
  });

  it('mantem os quatro webhooks com Header Auth nativo e credencial propria', () => {
    const webhooks = RC712.nodes.filter((node) => node.type.endsWith('webhook'));
    const post = webhooks.filter(
      (node) =>
        node.parameters['httpMethod'] === 'POST' &&
        [
          'netvision-mitigation',
          'netvision-alarmes',
          'netvision-alarmes-vnt',
          'netvision-alarmes-fibinet',
        ].includes(String(node.parameters['path'])),
    );
    expect(post).toHaveLength(4);
    const credentials = new Set(post.map((node) => node.credentials?.['httpHeaderAuth']?.id));
    expect(credentials.size).toBe(4);
    for (const node of post) {
      expect(node.parameters['authentication']).toBe('headerAuth');
    }
  });

  it('nao usa $env e nao guarda token literal', () => {
    expect(RC712_RAW).not.toContain('$env');
    expect(RC712_RAW).not.toMatch(/X-NetVision-Token/i);
  });

  it('os tres alarmes respondem DEPOIS do Telegram (nunca onReceived)', () => {
    for (const path of [
      'netvision-alarmes',
      'netvision-alarmes-vnt',
      'netvision-alarmes-fibinet',
    ]) {
      const hook = RC712.nodes.find((node) => node.parameters['path'] === path)!;
      expect(hook.parameters['responseMode'], path).toBe('lastNode');
      expect(hook.parameters['responseMode'], path).not.toBe('onReceived');
    }
  });

  it('mantem o ramo de deteccao bloqueada sem botoes de retirada', () => {
    const notice = NODES.get('Telegram - Aviso de Deteccao (sem escrita)');
    expect(notice).toBeDefined();
    expect(JSON.stringify(notice!.parameters)).not.toContain('replyMarkup');
    expect(NODES.get('Somente Deteccao Bloqueada?')).toBeDefined();
  });

  it('mantem o reenvio v2 do RC4 (3)', () => {
    expect(RC712_RAW).toContain('RC4 RESEND v2');
    expect(RC712_RAW).toContain('MITIGATION_STATUS_RESEND');
  });
});

describe('RC7.1.2 - prefixos do escopo verificado', () => {
  it('renderiza os tres prefixos da AGLINK na mensagem verificada', () => {
    const out = runNormalizer(verifiedBody({ prefixes: AGLINK_PREFIXES }));
    const text = String(out['telegramText']);
    for (const prefix of AGLINK_PREFIXES) expect(text).toContain(prefix);
    expect(text).toContain('Prefixos (3)');
    expect(out['PREFIXOS']).toEqual(AGLINK_PREFIXES);
    expect(out['QTD_PREFIXOS']).toBe(3);
    // O contrato de mitigacao verificada continua intacto.
    expect(out['REAL_ACTIVATED']).toBe(true);
    expect(out['VERIFICADO']).toBe(true);
    expect(out['EVENT_ID']).toBe('AGLINK-CONTRACT-EVENT-1');
  });

  it('sem lista mostra "indisponivel" e nao inventa prefixo', () => {
    const out = runNormalizer(verifiedBody({ prefixes: null, fieldsUnavailable: ['prefixes'] }));
    const text = String(out['telegramText']);
    expect(text).toContain('indispon');
    expect(text).not.toContain('/23');
    expect(out['PREFIXOS']).toEqual([]);
    expect(out['QTD_PREFIXOS']).toBe(0);
  });

  it('evento ANTERIOR ao campo (sem `prefixes`) continua funcionando', () => {
    const legacy = verifiedBody();
    delete legacy.prefixes;
    const out = runNormalizer(legacy);
    expect(out['REAL_ACTIVATED']).toBe(true);
    expect(out['PREFIXOS']).toEqual([]);
    expect(String(out['telegramText'])).toContain('indispon');
  });

  it('descarta itens invalidos sem quebrar a lista boa', () => {
    const out = runNormalizer(verifiedBody({ prefixes: [...AGLINK_PREFIXES, '', null, 42] }));
    expect(out['PREFIXOS']).toEqual(AGLINK_PREFIXES);
  });

  it('lista vazia e tratada como indisponivel', () => {
    const out = runNormalizer(verifiedBody({ prefixes: [] }));
    expect(out['PREFIXOS']).toEqual([]);
    expect(String(out['telegramText'])).toContain('indispon');
  });

  it('simulacao continua NAO sendo mitigacao real, com ou sem prefixos', () => {
    const out = runNormalizer(verifiedBody({ simulation: true, prefixes: AGLINK_PREFIXES }));
    expect(out['REAL_ACTIVATED']).toBe(false);
    expect(out['SIMULACAO']).toBe(true);
  });

  it('a deteccao bloqueada nao ganha a linha de prefixos da mitigacao', () => {
    const out = runNormalizer({
      event: 'MITIGATION_DETECTION_BLOCKED',
      simulation: true,
      verified: false,
      profileId: 'cmuoavm4e00bysslhqd0h3q7u',
      customer: 'AGLINK',
      device: 'BHE-VTA-F1A-BGP-01',
      interface: 'Eth-Trunk1.3058',
      addressFamily: 'IPV4',
      policy: 'PL-AGLINK_IPv4-IN',
      peer: '10.200.201.2',
      blockedReason: 'AUTO_EXECUTION_DISABLED',
      fieldsUnavailable: ['prefixes'],
      prefixes: null,
    });
    expect(out['DETECTION_BLOCKED']).toBe(true);
    expect(String(out['detectionText'])).not.toContain('Prefixos (');
  });
});
