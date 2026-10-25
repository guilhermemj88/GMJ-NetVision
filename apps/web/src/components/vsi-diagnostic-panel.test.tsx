// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { VsiDiagnosticPanel } from './vsi-diagnostic-panel';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement, root: Root;
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
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result)),
  );
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe('VSI diagnose action', () => {
  it('shows SNMP observability limitations without changing confirmed live health', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ...result,
        overallStatus: 'OK',
        summary: 'Nenhuma falha encontrada no PW/underlay avaliado.',
        warnings: [
          'REMOTE_PW_SNMP_UNAVAILABLE: PW SNMP indisponível no PE remoto; validação realizada por SSH.',
          'AAA = NOT_VERIFIED',
        ],
      }),
    );
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" />));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('OK');
    expect(container.textContent).toContain('REMOTE_PW_SNMP_UNAVAILABLE');
    expect(container.textContent).toContain('AAA = NOT_VERIFIED');
    expect(container.textContent).not.toContain('PW DOWN');
    expect(container.textContent).not.toContain('PW inexistente');
  });
  it('shows progress, cancellation and the native completed result without automatic device actions', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ...result, state: 'RUNNING', stage: 'Coletando PE remoto' }),
    );
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('Coletando PE remoto');
    const cancel = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancelar',
    )!;
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ...result, state: 'CANCELLED', summary: 'Evidências parciais preservadas.' }),
    );
    await act(async () => cancel.click());
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/hosts/UNIT/mpls/vsis/VSI-1/diagnostics/unit/cancel',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(container.textContent).toContain('CANCELLED');
    expect(container.textContent).toContain('Evidências parciais preservadas');
    const count = vi.mocked(fetch).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it('renders underlay, reciprocal endpoints and trace restriction with raw output collapsed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
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
            hops: [],
            tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
          },
        ],
      }),
    );
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('UNDERLAY_REACHABLE');
    expect(container.textContent).toContain('PE remoto');
    expect(container.textContent).toContain('respostas 3/3');
    expect(container.textContent).toContain('NOT_HOMOLOGATED');
    expect(container.querySelector('details')!.open).toBe(false);
  });
  it('does not execute on mount; sends only host/VSI in the URL and an empty typed body after a click', async () => {
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" />));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(fetch).toHaveBeenCalledWith(
      '/api/hosts/UNIT/mpls/vsis/VSI-1/diagnose',
      expect.objectContaining({ method: 'POST', body: '{}', credentials: 'include' }),
    );
    expect(container.textContent).toContain('INSUFFICIENT_DATA');
    expect(container.querySelector('textarea')).toBeNull();
  });
  it('escapes device output rather than executing it in the browser', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
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
      }),
    );
    await act(async () => root.render(<VsiDiagnosticPanel hostId="UNIT" vsiId="VSI-1" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>');
  });
});
