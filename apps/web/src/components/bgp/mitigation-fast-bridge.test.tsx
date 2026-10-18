// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MitigationFastBridgeStatusDto } from '@gmj/shared';
import { MitigationFastBridgeFacts } from './mitigation-fast-bridge';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  el?.remove();
  vi.useRealTimers();
});
async function render(report: MitigationFastBridgeStatusDto) {
  el = document.createElement('div');
  root = createRoot(el);
  await act(async () => root.render(<MitigationFastBridgeFacts report={report} profileId="p" />));
}
const fixture = () =>
  ({
    generatedAt: new Date().toISOString(),
    mode: 'SHADOW',
    fallback: 'FAIL_CLOSED',
    executionAvailable: false,
    profileIds: ['p'],
    enforceProfileIds: [],
    samples: [
      {
        profileId: 'p',
        source: 'FAST',
        available: true,
        reason: null,
        sampleId: 's',
        sampleAt: new Date().toISOString(),
        generation: 'g',
        rxBps: '232000000',
        txBps: '9500000000',
        intervalMs: 10000,
        readMs: 5,
      },
    ],
    decisions: [
      {
        at: new Date().toISOString(),
        deviceId: 'd',
        customer: 'synthetic',
        trafficBps: '9500000000',
        runtimeState: 'NORMAL',
        detail: null,
        profileId: 'p',
        outcome: 'WOULD_ACTIVATE',
        reason: 'GLOBAL_MODE_SIMULATION_ONLY',
        samplesOver: 3,
        requiredSamples: 3,
        thresholdBps: '9000000000',
        verified: false,
        commandStatus: null,
        totalResponseMs: null,
      },
    ],
    shadow: { state: 'RUNNING', lastTickAt: new Date().toISOString(), lastError: null },
    engine: null,
    responseBudgetMs: 60000,
  }) as MitigationFastBridgeStatusDto;
it('shows FAST confirmations and SHADOW without claiming execution/readback', async () => {
  await render(fixture());
  expect(el.textContent).toContain('FAST · SHADOW · CONFIRMED');
  expect(el.textContent).toContain('Confirmações 3/3');
  expect(el.textContent).toContain('nenhuma execução Huawei disponível');
  expect(el.textContent).toContain('NÃO CONFIRMADO');
  expect(el.textContent).toContain('Total: não medido');
});
it('shows an operation awaiting readback as MITIGATING with no verified protection claim', async () => {
  const report = fixture();
  report.mode = 'ENFORCE';
  report.enforceProfileIds = ['p'];
  report.inFlightProfileIds = ['p'];
  report.decisions[0] = {
    ...report.decisions[0]!,
    runtimeState: 'MITIGATING',
    commandStatus: 'IN_FLIGHT',
    verified: false,
  };
  await render(report);
  expect(el.textContent).toContain('FAST · ENFORCE · MITIGATING');
  expect(el.textContent).toContain('readback: NÃO CONFIRMADO');
  expect(el.textContent).not.toContain('FAST · ENFORCE · MITIGATED');
});
it('expires stale diagnostics and never presents an old CONFIRMED as current', async () => {
  vi.useFakeTimers();
  await render(fixture());
  await act(async () => {
    vi.advanceTimersByTime(31000);
  });
  expect(el.textContent).toContain('UNAVAILABLE');
  expect(el.textContent).toContain('ANTIGO');
});
it('shows actual verified result, latency and budget violation only from supplied evidence', async () => {
  const r = fixture();
  r.mode = 'ENFORCE';
  r.enforceProfileIds = ['p'];
  r.executionAvailable = true;
  r.decisions[0] = {
    ...r.decisions[0]!,
    outcome: 'ACTIVATED',
    verified: true,
    commandStatus: 'ACTIVATED_VERIFIED',
    totalResponseMs: 65000,
    responseDeadlineExceeded: true,
  };
  await render(r);
  expect(el.textContent).toContain('FAST · ENFORCE · MITIGATED');
  expect(el.textContent).toContain('readback: CONFIRMADO');
  expect(el.textContent).toContain('65.000 s');
  expect(el.textContent).toContain('60 s EXCEDIDO');
});
