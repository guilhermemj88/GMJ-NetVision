// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { VsiDiagnosticPanel } from './vsi-diagnostic-panel';
import { vsi1809Result } from './diagnostics/result/vsi-1809.fixture';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const APPROVAL_ID = '11111111-2222-4333-8444-555555555555';
const APPROVAL_URL = '/api/hosts/UNIT/mpls/vsis/VSI-1/diagnostic-approvals';
const DIAGNOSE_URL = '/api/hosts/UNIT/mpls/vsis/VSI-1/diagnose';

let container: HTMLDivElement, root: Root;
let nextResult: unknown;

const result = {
  diagnosticId: 'unit',
  operator: { id: 'unit', username: 'offline-operator', role: 'OPERATOR' },
  vsiName: 'SERVICE-A',
  state: 'COMPLETED',
  stage: 'Concluído',
  overallStatus: 'INSUFFICIENT_DATA',
  summary: 'Sem origem comprovada.',
  local: { hostId: 'UNIT', name: 'UNIT', loopback: null },
  remotes: [],
  checks: [],
  evidence: [],
  warnings: [],
  nextTests: [],
} as unknown as VsiDiagnosticResult;

function approval() {
  const now = Date.now();
  return {
    approvalId: APPROVAL_ID,
    hostId: 'UNIT',
    vsiId: 'VSI-1',
    createdBy: 'admin',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
  };
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === text);
}

async function armar() {
  const alvo = button('Preparar janela') ?? button('Renovar janela');
  expect(alvo).toBeDefined();
  await act(async () => alvo!.click());
}

async function diagnosticar() {
  const alvo = button('Diagnosticar');
  expect(alvo).toBeDefined();
  await act(async () => alvo!.click());
}

beforeEach(() => {
  nextResult = result;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/diagnostic-approvals')) return Response.json(approval());
      return Response.json(nextResult);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('VSI diagnose action', () => {
  it('exige janela one-shot: sem armar nao dispara nada', async () => {
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    expect(fetch).not.toHaveBeenCalled();
    expect(button('Preparar janela')).toBeDefined();
    const diagnostico = button('Diagnosticar') as HTMLButtonElement;
    expect(diagnostico.disabled).toBe(true);
    await act(async () => diagnostico.click());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('arma a janela, mostra a contagem e envia approvalId no diagnostico', async () => {
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    await armar();
    expect(fetch).toHaveBeenCalledWith(APPROVAL_URL, expect.objectContaining({ method: 'POST' }));
    expect(container.textContent).toContain('Janela one-shot válida');
    expect(button('Renovar janela')).toBeDefined();
    await diagnosticar();
    expect(fetch).toHaveBeenCalledWith(
      DIAGNOSE_URL,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ approvalId: APPROVAL_ID }),
      }),
    );
    expect(button('Preparar janela')).toBeDefined();
    expect(button('Renovar janela')).toBeUndefined();
  });

  it('shows SNMP observability limitations without changing confirmed live health', async () => {
    nextResult = {
      ...result,
      overallStatus: 'OK',
      summary: 'Nenhuma falha encontrada no PW/underlay avaliado.',
      warnings: [
        'REMOTE_PW_SNMP_UNAVAILABLE: PW SNMP indisponível no PE remoto; validação realizada por SSH.',
      ],
    };
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    expect(fetch).not.toHaveBeenCalled();
    await armar();
    await diagnosticar();
    expect(container.textContent).toContain('OK');
    expect(container.textContent).toContain('REMOTE_PW_SNMP_UNAVAILABLE');
    expect(container.textContent).not.toContain('PW DOWN');
    expect(container.textContent).not.toContain('PW inexistente');
  });

  it('shows progress, cancellation and the native completed result without automatic device actions', async () => {
    vi.useFakeTimers();
    nextResult = { ...result, state: 'RUNNING', stage: 'Coletando PE remoto' };
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    await armar();
    await diagnosticar();
    expect(container.textContent).toContain('Coletando PE remoto');
    expect(container.textContent).toContain('DIAGNÓSTICO EM ANDAMENTO');
    expect(container.textContent).toContain('Coletando e validando evidências dos PEs…');
    // The provisional backend status is not a verdict while the job runs.
    expect(container.textContent).not.toContain('INSUFFICIENT_DATA');
    expect(container.textContent).not.toContain('Sem origem comprovada.');
    const cancelar = button('Cancelar')!;
    nextResult = { ...result, state: 'CANCELLED', summary: 'Evidências parciais preservadas.' };
    await act(async () => cancelar.click());
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/hosts/UNIT/mpls/vsis/VSI-1/diagnostics/unit/cancel',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(container.textContent).toContain('CANCELLED');
    expect(container.textContent).toContain('Evidências parciais preservadas');
    const antes = vi.mocked(fetch).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch).toHaveBeenCalledTimes(antes);
  });

  it('renders underlay, reciprocal endpoints and trace restriction with raw output collapsed', async () => {
    nextResult = {
      ...result,
      underlayClassification: 'UNDERLAY_REACHABLE',
      remotes: [{ hostId: 'PE-B', name: 'PE remoto', loopback: { address: '192.0.2.2' } }],
      probes: [
        {
          sourceHostId: 'UNIT',
          destinationHostId: 'PE-B',
          source: '192.0.2.1',
          destination: '192.0.2.2',
          lossPercent: 0,
          rttMs: { min: 1, avg: 2, max: 3 },
          transmitted: 3,
          received: 3,
          status: 'OK',
          hops: [],
          tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
        },
      ],
    };
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    await armar();
    await diagnosticar();
    expect(container.textContent).toContain('UNDERLAY_REACHABLE');
    expect(container.textContent).toContain('PE remoto');
    const text = container.textContent!;
    expect(text).toContain('Alcançável · 3/3 respostas');
    // Loss stays a secondary detail after the replies headline, never the headline with 3 probes.
    expect(text.indexOf('perda 0%')).toBeGreaterThan(text.indexOf('Alcançável · 3/3 respostas'));
    expect(container.textContent).toContain('NOT_HOMOLOGATED');
    expect(container.querySelector('details')!.open).toBe(false);
  });

  it('does not execute on mount, sends host/VSI in the URL and never a free-form body', async () => {
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    expect(fetch).not.toHaveBeenCalled();
    await armar();
    await diagnosticar();
    expect(container.textContent).toContain('INSUFFICIENT_DATA');
    expect(container.querySelector('textarea')).toBeNull();
    const envios = vi.mocked(fetch).mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(envios.every((body) => body === '{}' || body === JSON.stringify({ approvalId: APPROVAL_ID }))).toBe(
      true,
    );
  });

  it('escapes device output rather than executing it in the browser', async () => {
    nextResult = {
      ...result,
      evidence: [
        {
          id: 'test',
          hostId: 'UNIT',
          source: 'LIVE_SSH',
          observedAt: null,
          collectedAt: 'now',
          command: 'display vsi name SERVICE-A verbose',
          output: '<script>alert(1)</script>',
        },
      ],
    };
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    await armar();
    await diagnosticar();
    expect(container.querySelector('script')).toBeNull();
    const secaoEvidencias = [...container.querySelectorAll('summary')].find((node) =>
      node.textContent?.includes('Evidências e comandos'),
    ) as HTMLElement;
    await act(async () => secaoEvidencias.click());
    const itemEvidencia = [...container.querySelectorAll('button')].find((node) =>
      node.className.includes('evidenceItem'),
    ) as HTMLButtonElement;
    await act(async () => itemEvidencia.click());
    const abaSaida = [...container.querySelectorAll('[role="dialog"] button')].find(
      (node) => node.textContent === 'Saída bruta',
    ) as HTMLButtonElement;
    await act(async () => abaSaida.click());
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[role="dialog"] pre')?.textContent).toBe(
      '<script>alert(1)</script>',
    );
  });

  it('com recurso desativado mostra o estado e nao dispara nenhuma request', async () => {
    await act(async () =>
      root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled={false} />),
    );
    expect(container.textContent).toContain('Diagnóstico VSI desativado');
    for (const label of ['Preparar janela', 'Diagnosticar']) {
      expect((button(label) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => (button('Preparar janela') as HTMLButtonElement).click());
    await act(async () => (button('Diagnosticar') as HTMLButtonElement).click());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sem permissao de armar a janela o botao fica bloqueado', async () => {
    await act(async () =>
      root.render(
        <VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled canArm={false} />,
      ),
    );
    expect((button('Preparar janela') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Diagnosticar') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => (button('Preparar janela') as HTMLButtonElement).click());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('janela expirada desabilita o diagnostico', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () =>
      Response.json({ ...approval(), expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    await armar();
    expect((button('Diagnosticar') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).not.toContain('Janela one-shot válida');
  });

  it('ADMIN continua podendo preparar a janela e diagnosticar', async () => {
    await act(async () =>
      root.render(
        <VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled canArm canExecute />,
      ),
    );
    expect((button('Preparar janela') as HTMLButtonElement).disabled).toBe(false);
    await armar();
    expect((button('Diagnosticar') as HTMLButtonElement).disabled).toBe(false);
    await diagnosticar();
    expect(fetch).toHaveBeenCalledWith(DIAGNOSE_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('descarta a janela quando a execucao falha (fail-closed)', async () => {
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />));
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json(approval()));
    vi.mocked(fetch).mockImplementationOnce(async () =>
      Response.json({ message: 'Aprovacao expirada' }, { status: 423 }),
    );
    await armar();
    await diagnosticar();
    expect(container.textContent).toContain('Aprovacao expirada');
    expect(button('Preparar janela')).toBeDefined();
    expect(button('Renovar janela')).toBeUndefined();
  });
});

describe('Contexto de execução no painel (UI gráfica + executionContext)', () => {
  it('caso 1809: veredito técnico primeiro, contexto depois, AAA fora das limitações', async () => {
    nextResult = vsi1809Result;
    await act(async () =>
      root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" diagnosticEnabled />),
    );
    await armar();
    await diagnosticar();
    const text = container.textContent!;
    const context = container.querySelector('dl[aria-label="Contexto de execução"]')!;
    expect(context.textContent).toContain('admin (ADMIN)');
    expect(context.textContent).toContain('Conta de serviço guilherme3.');
    expect(context.textContent).toContain(
      'Confirmada para os comandos executados nesta execução nos dois PEs.',
    );
    expect(context.textContent).toContain('Não verificado explicitamente.');
    expect(text.indexOf('Reciprocidade e labels')).toBeLessThan(
      text.indexOf('Contexto de execução'),
    );
    expect(text).toContain('Traceroute: ainda não homologado para execução ativa.');
    expect(text).not.toContain('Homologar o fluxo nativo completo pela API/WEB');
    expect(text).not.toContain('AAA = NOT_VERIFIED');
    expect(text).not.toContain('AAA não verificado');
  });
});
