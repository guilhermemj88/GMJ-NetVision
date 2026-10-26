// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { VsiDiagnosticResultView } from './result-view';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const base = {
  diagnosticId: '04778b69-0000-4000-8000-000000000000',
  hostId: 'host-local',
  vsiId: 'vsi-1',
  vsiName: '1809-L2L-VCONLINE-QinQ',
  operator: { id: 'u1', username: 'operator', role: 'OPERATOR' },
  state: 'COMPLETED',
  stage: 'Concluído',
  startedAt: '2026-10-26T10:00:00.000Z',
  completedAt: '2026-10-26T10:00:09.000Z',
  underlayClassification: 'UNDERLAY_REACHABLE',
  overallStatus: 'OK',
  summary: 'Circuito confirmado ponta a ponta.',
  local: {
    hostId: 'host-local',
    name: 'IIE-VSR-6730-MPLS-01',
    vsiId: '1',
    vsiName: 'SERVICE-A',
    loopback: { address: '10.0.0.1', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] },
    association: 'LOCAL',
    observedVsi: {
      vsiId: 1,
      status: 'UP',
      peers: [
        { address: '10.0.0.2', vcId: 100, state: 'UP', inboundLabel: 40943, outboundLabel: 40944, tunnel: null },
      ],
    },
  },
  remotes: [
    {
      hostId: 'host-remote',
      name: 'RNS-FLOR-6730-MPLS-01',
      vsiId: '2',
      vsiName: 'SERVICE-B',
      loopback: { address: '10.0.0.2', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] },
      association: 'EXACT_INVENTORY_IP',
    },
  ],
  checks: [
    { id: 'c1', category: 'UNDERLAY', label: 'LoopBack atual', status: 'OK', hostId: 'host-local', message: 'LoopBack confirmado.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c2', category: 'VSI', label: 'VSI atual', status: 'OK', hostId: 'host-local', message: 'VSI UP na CLI.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c3', category: 'VSI', label: 'VSI remota', status: 'OK', hostId: 'host-remote', message: 'VSI remota UP.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c4', category: 'PW', label: 'PW 10.0.0.2', status: 'OK', hostId: 'host-local', message: 'PW UP.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c5', category: 'PW', label: 'Reciprocidade e labels', status: 'OK', hostId: 'host-local', message: 'Labels cruzados MATCH.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c6', category: 'AC', label: 'AC GE0/0/1', status: 'OK', hostId: 'host-local', message: 'AC UP.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c7', category: 'AC', label: 'AC GE0/0/2', status: 'OK', hostId: 'host-remote', message: 'AC remota UP.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
    { id: 'c8', category: 'LOOPBACK_REACHABILITY', label: 'Ping atual', status: 'OK', hostId: 'host-local', message: 'Ping OK.', evidence: [], durationMs: 4, certainty: 'CONFIRMED', required: true },
  ],
  evidence: [
    {
      id: 'ev-1',
      hostId: 'host-local',
      source: 'LIVE_SSH',
      observedAt: '2026-10-26T10:00:03.000Z',
      collectedAt: '2026-10-26T10:00:03.000Z',
      command: 'display vsi name SERVICE-A verbose',
      output: '<script>alert(1)</script>',
    },
  ],
  probes: [
    {
      sourceHostId: 'host-local',
      destinationHostId: 'host-remote',
      source: '10.0.0.1',
      destination: '10.0.0.2',
      routingContext: 'GLOBAL',
      lossPercent: 0,
      rttMs: { min: 1, avg: 2, max: 3 },
      hops: [],
      status: 'OK',
      transmitted: 3,
      received: 3,
      tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
    },
  ],
  warnings: [
    'REMOTE_PW_SNMP_UNAVAILABLE: evidência PW indisponível no PE remoto.',
    'AAA = NOT_VERIFIED; privilégios da conta não foram verificados pelo diagnóstico.',
  ],
  nextTests: ['Correlacionar IGP/LDP/LSP entre os PEs.'],
} as unknown as VsiDiagnosticResult;

let container: HTMLDivElement;
let root: Root;

function summaryOf(title: string): HTMLElement | null {
  return [...container.querySelectorAll('summary')].find((node) =>
    node.textContent?.includes(title),
  ) as HTMLElement | null;
}

async function render(result: VsiDiagnosticResult): Promise<void> {
  await act(async () => root.render(<VsiDiagnosticResultView result={result} />));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('VsiDiagnosticResultView', () => {
  it('mostra cabecalho com status, VSI, PEs, underlay, execucao e duracao', async () => {
    await render(base);
    const text = container.textContent ?? '';
    expect(text).toContain('OK');
    expect(text).toContain('1809-L2L-VCONLINE-QinQ');
    expect(text).toContain('IIE-VSR-6730-MPLS-01');
    expect(text).toContain('RNS-FLOR-6730-MPLS-01');
    expect(text).toContain('UNDERLAY_REACHABLE');
    expect(text).toContain('04778b69-0000-4000-8000-000000000000');
    expect(text).toContain('operator');
    expect(text).toContain('9.0 s');
  });

  it('mostra os 9 cards de saude antes de qualquer detalhe', async () => {
    await render(base);
    const list = container.querySelector('ul[aria-label="Saúde dos componentes"]');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('li')).toHaveLength(9);
    expect(container.textContent).toContain('Alcançável · 3/3 respostas');
  });

  it('mostra a cadeia local -> VSI -> PW -> VSI -> remoto', async () => {
    await render(base);
    const topology = container.querySelector('[aria-label="Cadeia do circuito"]');
    expect(topology).not.toBeNull();
    expect(topology!.textContent).toContain('PE local');
    expect(topology!.textContent).toContain('PE remoto');
    expect(topology!.textContent).toContain('PW');
  });

  it('mantem as secoes fechadas e abre ao clicar', async () => {
    await render(base);
    const details = [...container.querySelectorAll('details')];
    expect(details.length).toBeGreaterThanOrEqual(7);
    expect(details.every((node) => node.open === false)).toBe(true);
    const vsi = summaryOf('VSI');
    expect(vsi).not.toBeNull();
    await act(async () => vsi!.click());
    expect((summaryOf('VSI')!.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(container.textContent).toContain('VSI UP na CLI.');
  });

  it('separa contexto de execucao e limitacoes do veredito', async () => {
    await render(base);
    await act(async () => summaryOf('Contexto de execução')!.click());
    await act(async () => summaryOf('Limitações da análise')!.click());
    expect(container.textContent).toContain('AAA = NOT_VERIFIED');
    expect(container.textContent).toContain('limitação de escopo, não falha');
    expect(container.textContent).toContain('REMOTE_PW_SNMP_UNAVAILABLE');
    expect(container.textContent).toContain('NOT_HOMOLOGATED');
  });

  it('abre a evidencia em drawer com abas e escapa a saida do equipamento', async () => {
    await render(base);
    await act(async () => summaryOf('Evidências e comandos')!.click());
    const item = container.querySelector<HTMLButtonElement>('[class*="evidenceItem"]');
    expect(item).not.toBeNull();
    await act(async () => item!.click());
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('LIVE_SSH');
    const saida = [...dialog!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Saída bruta',
    )!;
    await act(async () => saida.click());
    expect(container.querySelector('script')).toBeNull();
    expect(dialog!.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>');
    const fechar = dialog!.querySelector<HTMLButtonElement>('[aria-label="Fechar"]')!;
    await act(async () => fechar.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('durante a execucao mostra progresso e nao exibe veredito', async () => {
    await render({ ...base, state: 'RUNNING', completedAt: null, overallStatus: 'INSUFFICIENT_DATA' } as VsiDiagnosticResult);
    expect(container.textContent).toContain('Diagnóstico em andamento');
    expect(container.textContent).toContain('RUNNING');
    expect(container.querySelector('ul[aria-label="Saúde dos componentes"]')).toBeNull();
    expect(container.querySelector('[aria-label="Cadeia do circuito"]')).toBeNull();
    expect(container.querySelectorAll('details')).toHaveLength(0);
  });

  it('nao renderiza campos sensiveis', async () => {
    await render(base);
    const text = (container.textContent ?? '').toLowerCase();
    for (const term of ['password', 'encryptedpayload', 'private key', 'token', 'secret']) {
      expect(text).not.toContain(term);
    }
  });
});
