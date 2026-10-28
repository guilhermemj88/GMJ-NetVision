
/**
 * RC7.1 — WORKFLOW COMPATIBILITY (REVIEW-07).
 *
 * O RC7 foi construido sobre `GMJ-NetVision-Telegram-RC4-CORRIGIDO.json` do
 * repositorio, e nao sobre o RC4 (3) que o operador usa (sha256 c83add67...).
 * Este arquivo trava o contrato do RC7.1, que parte do RC4 (3) e aplica SOMENTE:
 *   - Header Auth nativo (4 credenciais independentes);
 *   - `responseMode: lastNode` nos 3 canais de alarmes;
 *   - ramo S5 de deteccao bloqueada;
 *   - correcao das referencias cruzadas do VNT (P1);
 *   - fallback textual quando o grafico falha (P2).
 *
 * Todo o resto do RC4 (3) precisa permanecer intacto — em especial o REENVIO
 * (`MITIGATION_STATUS_RESEND`), `INCLUIR_DADOS_DE_ESCOPO=true`, as credenciais
 * originais dos nos HTTP e o `typeValidation: strict` do callback de escopo.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
}
interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const WORKFLOW_URL = new URL(
  '../../../../../../docs/n8n/GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json',
  import.meta.url,
);

const RAW = readFileSync(WORKFLOW_URL, 'utf8');
const WF = JSON.parse(RAW) as Workflow;
const NODES = new Map(WF.nodes.map((node) => [node.name, node]));

const webhooks = (): WorkflowNode[] =>
  WF.nodes.filter(
    (node) => node.type.endsWith('webhook') && node.parameters['httpMethod'] === 'POST',
  );

const reachable = (start: string): Set<string> => {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const branch of WF.connections[current]?.main ?? []) {
      for (const item of branch) if (!seen.has(item.node)) queue.push(item.node);
    }
  }
  return seen;
};

const crossRefs = (nodeName: string): string[] => {
  const raw = JSON.stringify(NODES.get(nodeName));
  const found: string[] = [];
  for (const part of raw.split("$('").slice(1)) {
    if (!part.includes("')")) continue;
    const name = part.split("')")[0];
    if (name !== undefined) found.push(name);
  }
  return [...new Set(found)].sort();
};

/** Executa o no de normalizacao (expressao n8n) com um corpo de webhook. */
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

describe('RC7.1 - base e preservacoes do RC4 (3)', () => {
  it('mantem o REENVIO v2 (MITIGATION_STATUS_RESEND) intacto', () => {
    expect(RAW).toContain('RC4 RESEND v2');
    expect(RAW).toContain('MITIGATION_STATUS_RESEND');
    expect(RAW).toContain("const PATCH_VERSION = 'rc4-resend-v2';");
  });

  it('mantem INCLUIR_DADOS_DE_ESCOPO = true (chatId/confirmedBy no REMOVE)', () => {
    expect(RAW).toContain('const INCLUIR_DADOS_DE_ESCOPO = true;');
    expect(RAW).not.toContain('const INCLUIR_DADOS_DE_ESCOPO = false;');
  });

  it('mantem as credenciais ORIGINAIS dos tres nos HTTP do comando', () => {
    for (const name of [
      'HTTP - NetVision Command',
      'HTTP - NetVision Scope Confirm',
      'HTTP - NetVision Scope Cancel',
    ]) {
      const cred = NODES.get(name)?.credentials?.['httpHeaderAuth'];
      expect(cred?.id).toBe('bkffylmXLwZUFxiC');
      expect(String(cred?.id)).not.toContain('SUBSTITUIR');
    }
  });

  it('mantem typeValidation strict no callback de escopo e os webhookIds', () => {
    const callback = NODES.get('IF - Callback de Escopo?')!;
    const options = (callback.parameters['conditions'] as { options: { typeValidation: string } })
      .options;
    expect(options.typeValidation).toBe('strict');
    expect(NODES.get('Telegram Trigger - Callback')?.webhookId).toBeTruthy();
    for (const hook of webhooks()) expect(hook.webhookId).toBeTruthy();
  });

  it('nao remove nenhum no funcional do RC4 (3) alem dos 8 de token', () => {
    // O RC4 (3) tem 62 nos. RC7.1 = 62 - 8 (IFs de token + Respond 401) + 2 (S5).
    expect(WF.nodes).toHaveLength(56);
    const removed = [
      'Validar Token OUT',
      'Validar Token OUT1',
      'Validar Token OUT2',
      'Validar Token OUT3',
      'Responder OUT 401',
      'Responder OUT ',
      'Responder OUT 1',
      'Responder OUT 2',
    ];
    for (const name of removed) expect(NODES.has(name)).toBe(false);
    for (const name of ['Somente Deteccao Bloqueada?', 'Telegram - Aviso de Deteccao (sem escrita)']) {
      expect(NODES.has(name)).toBe(true);
    }
  });
});

describe('RC7.1 - autenticacao (4 credenciais independentes)', () => {
  it('os quatro webhooks usam Header Auth nativo com credencial propria', () => {
    const hooks = webhooks();
    expect(hooks).toHaveLength(4);
    for (const hook of hooks) {
      expect(hook.parameters['authentication']).toBe('headerAuth');
      expect(hook.parameters['genericAuthType']).toBe('httpHeaderAuth');
      const cred = hook.credentials?.['httpHeaderAuth'];
      expect(cred?.id).toBeTruthy();
      expect(cred?.name).toBeTruthy();
      // Referencia apenas id/nome: nenhum valor secreto no JSON.
      expect(Object.keys(cred!).sort()).toEqual(['id', 'name']);
    }
    expect(new Set(hooks.map((hook) => hook.credentials!['httpHeaderAuth']!.id)).size).toBe(4);
    expect(new Set(hooks.map((hook) => hook.credentials!['httpHeaderAuth']!.name)).size).toBe(4);
  });

  it('nao usa $env nem mantem comparacao de token em no Code/IF', () => {
    expect(RAW).not.toContain('$env');
    expect(WF.nodes.filter((node) => node.name.startsWith('Validar Token'))).toHaveLength(0);
  });

  it('preserva os quatro paths, sem trocar canal', () => {
    const paths = webhooks().map((hook) => hook.parameters['path']).sort();
    expect(paths).toEqual([
      'netvision-alarmes',
      'netvision-alarmes-fibinet',
      'netvision-alarmes-vnt',
      'netvision-mitigation',
    ]);
  });
});

describe('RC7.1 - contrato de resposta HTTP', () => {
  it('mitigacao responde por no Respond alcancavel (routed/delivered)', () => {
    const hook = NODES.get('Webhook NetVision OUT')!;
    expect(hook.parameters['responseMode']).toBe('responseNode');
    const reached = reachable(hook.name);
    const responders = [...reached].filter((name) => NODES.get(name)?.type.endsWith('respondToWebhook'));
    expect(responders.length).toBeGreaterThan(0);
    const body = String(NODES.get('Responder OUT 200')!.parameters['responseBody']);
    expect(body).toContain('routed');
    expect(body).toContain('delivered');
    expect(body).toContain('episodeId');
  });

  it('os tres alarmes respondem DEPOIS do Telegram (lastNode), nunca onReceived', () => {
    const alarms = webhooks().filter((hook) =>
      String(hook.parameters['path']).startsWith('netvision-alarmes'),
    );
    expect(alarms).toHaveLength(3);
    for (const hook of alarms) {
      // REVIEW-07 R7-W1: onReceived devolve 200 ANTES do Telegram e a API marca
      // o alarme como notificado mesmo quando o Telegram falha.
      expect(hook.parameters['responseMode']).toBe('lastNode');
      expect(hook.parameters['responseMode']).not.toBe('onReceived');
    }
  });

  it('o ramo de alarmes termina em um no Telegram (nao ha caminho sem entrega)', () => {
    for (const [hook, textNode] of [
      ['Webhook NetVision Alarmes', 'Telegram - Resposta NetVision-alarmes'],
      ['Webhook NetVision Alarmes - VNT', 'Telegram - Resposta NetVision-alarmes1'],
      ['Webhook NetVision Alarmes - Fibinet', 'Telegram - Resposta NetVision-alarmes2'],
    ] as const) {
      const reached = reachable(hook);
      expect(reached.has(textNode)).toBe(true);
    }
  });
});

describe('RC7.1 - referencias cruzadas (P1)', () => {
  it('o ramo VNT usa o webhook do VNT e nao o de alarmes gerais', () => {
    expect(crossRefs('Tem gráfico?1')).toEqual(['Webhook NetVision Alarmes - VNT']);
    expect(crossRefs('HTTP Request1')).toEqual(['Webhook NetVision Alarmes - VNT']);
  });

  it('cada canal le o proprio webhook', () => {
    expect(crossRefs('Tem gráfico?')).toEqual(['Webhook NetVision Alarmes']);
    expect(crossRefs('HTTP Request')).toEqual(['Webhook NetVision Alarmes']);
    expect(crossRefs('Tem gráfico?2')).toEqual(['Webhook NetVision Alarmes - Fibinet']);
    expect(crossRefs('HTTP Request2')).toEqual(['Webhook NetVision Alarmes - Fibinet']);
    // A legenda da foto usa o codigo do PROPRIO canal.
    expect(crossRefs('Telegram - Alarme com gráfico')).toEqual(['Montar Mensagem Telegram']);
    expect(crossRefs('Telegram - Alarme com gráfico1')).toEqual(['Montar Mensagem Telegram1']);
    expect(crossRefs('Telegram - Alarme com gráfico2')).toEqual(['Montar Mensagem Telegram2']);
  });
});

describe('RC7.1 - fallback de grafico (P2)', () => {
  it.each([
    ['Download do gráfico OK?', 'Telegram - Alarme com gráfico', 'Telegram - Resposta NetVision-alarmes'],
    ['Download do gráfico OK?1', 'Telegram - Alarme com gráfico1', 'Telegram - Resposta NetVision-alarmes1'],
    ['Download do gráfico OK?2', 'Telegram - Alarme com gráfico2', 'Telegram - Resposta NetVision-alarmes2'],
  ])('%s: sucesso envia foto e falha envia o texto', (gate, photoNode, textNode) => {
    const branches = WF.connections[gate]!.main;
    expect(branches[0]![0]!.node).toBe(photoNode);
    // Sem esta conexao, falha de download descartava o alarme em silencio.
    expect(branches[1]?.[0]?.node).toBe(textNode);
  });

  it('os tres destinos de texto existem e sao nos Telegram', () => {
    for (const name of [
      'Telegram - Resposta NetVision-alarmes',
      'Telegram - Resposta NetVision-alarmes1',
      'Telegram - Resposta NetVision-alarmes2',
    ]) {
      expect(NODES.get(name)?.type).toBe('n8n-nodes-base.telegram');
    }
  });
});

describe('RC7.1 - ramo S5 (deteccao bloqueada)', () => {
  it('o false de "Somente Mitigacao Real Verificada" passa pela deteccao', () => {
    const gate = WF.connections['Somente Mitigacao Real Verificada']!.main;
    expect(gate[0]![0]!.node).toBe('Telegram - Alerta com Botoes');
    expect(gate[1]![0]!.node).toBe('Somente Deteccao Bloqueada?');
  });

  it('deteccao confirmada vai para o Telegram proprio; resto vai ao Respond', () => {
    const gate = WF.connections['Somente Deteccao Bloqueada?']!.main;
    expect(gate[0]![0]!.node).toBe('Telegram - Aviso de Deteccao (sem escrita)');
    expect(gate[1]![0]!.node).toBe('Responder OUT 200');
    expect(WF.connections['Telegram - Aviso de Deteccao (sem escrita)']!.main[0]![0]!.node).toBe(
      'Responder OUT 200',
    );
  });

  it('o aviso de deteccao nao tem botoes de retirada', () => {
    const params = NODES.get('Telegram - Aviso de Deteccao (sem escrita)')!.parameters;
    expect(params['replyMarkup']).toBeUndefined();
    // Mesmo chat da mitigacao: o NOC acompanha no mesmo grupo.
    expect(params['chatId']).toBe(NODES.get('Telegram - Alerta com Botoes')!.parameters['chatId']);
  });
});

describe('RC7.1 - normalizador', () => {
  it('MITIGATION_VERIFIED continua REAL_ACTIVATED com o texto original', () => {
    const out = runNormalizer({
      event: 'MITIGATION_VERIFIED',
      simulation: false,
      verified: true,
      profileId: 'p1',
      customer: 'C',
      device: 'D',
      interfaceName: 'I',
      bogonNode: 1,
      mitigationNode: 2,
      rt: '268568:660',
      trafficGbps: 9.5,
    });
    expect(out.REAL_ACTIVATED).toBe(true);
    expect(out.DETECTION_BLOCKED).toBe(false);
    expect(String(out.telegramText)).toContain('MITIGA');
  });

  it('MITIGATION_DETECTION_BLOCKED gera texto de NOC sem virar mitigacao aplicada', () => {
    const out = runNormalizer({
      event: 'MITIGATION_DETECTION_BLOCKED',
      simulation: true,
      verified: false,
      profileId: 'p1',
      customer: 'CLIENTE-X',
      device: 'BHE-VTA-F1A',
      interfaceName: 'Eth-Trunk1.3066',
      addressFamily: 'IPV4',
      policy: 'PL-X',
      peer: '10.0.0.1',
      trafficGbps: 0,
      thresholdGbps: 0.9,
      trafficMbps: 4.5,
      thresholdMbps: 900,
      direction: 'tx',
      directionSource: 'INTERFACE',
      blockedReason: 'AUTO_EXECUTION_DISABLED',
      episodeId: 'p1:123',
      occurredAt: '2026-10-28T12:00:00Z',
      sharedPolicy: true,
      fieldsUnavailable: ['bandwidth'],
    });
    expect(out.DETECTION_BLOCKED).toBe(true);
    expect(out.REAL_ACTIVATED).toBe(false);
    expect(out.EPISODIO_ID).toBe('p1:123');
    expect(out.MOTIVO_BLOQUEIO).toBe('AUTO_EXECUTION_DISABLED');
    const text = String(out.detectionText);
    expect(text).toContain('ATAQUE DETECTADO');
    expect(text).toContain('CLIENTE-X');
    expect(text).toContain('Eth-Trunk1.3066');
    expect(text).toContain('4.5 Mbps');
    expect(text).toContain('COMPARTILHADA');
    expect(text).toContain('Campos sem leitura');
    expect(text).not.toContain('0 Gbps');
  });

  it('deteccao com simulation=false NAO e roteada (contrato preservado)', () => {
    const out = runNormalizer({
      event: 'MITIGATION_DETECTION_BLOCKED',
      simulation: false,
      verified: false,
      profileId: 'p1',
    });
    expect(out.DETECTION_BLOCKED).toBe(false);
    expect(out.REAL_ACTIVATED).toBe(false);
  });

  it('evento desconhecido nao e roteado', () => {
    const out = runNormalizer({ event: 'QUALQUER_COISA', simulation: true, profileId: 'p1' });
    expect(out.REAL_ACTIVATED).toBe(false);
    expect(out.DETECTION_BLOCKED).toBe(false);
  });

  it('RESEND valido ativa o reenvio; readback incompleto bloqueia (fail-closed)', () => {
    const base = {
      event: 'MITIGATION_STATUS_RESEND',
      profileId: 'p1',
      simulation: false,
      verified: true,
      mitigationState: 'MITIGATED',
      policy: 'PL-X',
      bogonNode: 1,
      mitigationNode: 2,
      rt: '268568:660',
      customer: 'C',
      device: 'D',
      interfaceName: 'I',
    };
    const ok = runNormalizer({
      ...base,
      readback: {
        verified: true,
        state: 'MITIGATED',
        policy: 'PL-X',
        bogonNode: 1,
        mitigationNode: 2,
        readAt: '2026-10-28T12:00:00Z',
      },
    });
    expect(ok.RESEND_VALIDO).toBe(true);
    expect(ok.REAL_ACTIVATED).toBe(true);
    expect(String(ok.telegramText)).toContain('MITIGAÇÃO EXISTENTE');

    for (const [patch, motivo] of [
      [{ readback: undefined }, 'READBACK_AUSENTE'],
      [{ readback: { verified: false } }, 'READBACK_NAO_VERIFICADO'],
      [
        {
          readback: {
            verified: true,
            state: 'MITIGATED',
            policy: 'PL-X',
            bogonNode: 1,
            mitigationNode: 2,
          },
        },
        'READBACK_SEM_READAT',
      ],
    ] as const) {
      const out = runNormalizer({ ...base, ...(patch as Record<string, unknown>) });
      expect(out.RESEND_VALIDO).toBe(false);
      expect(out.MOTIVO).toBe(motivo);
      expect(out.telegramText).toBe('');
    }
  });
});
