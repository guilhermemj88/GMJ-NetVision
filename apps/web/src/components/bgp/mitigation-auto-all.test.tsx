// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { MitigationAutoAllFacts, type AutoAllLiveData } from './mitigation-auto-all';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, el: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  el?.remove();
});
const data = (): AutoAllLiveData => ({
  all: {
    phases: { enforcementScope: 'AUTO_ALL', physicalExecutionAuthorized: false, cadenceMs: 5000 },
    lease: { enabled: true, acquired: true, lost: false, holderBackendPid: 42 },
    clients: [
      {
        profileId: 'p',
        interfaceId: 'i',
        eligible: true,
        reasons: [],
        direction: 'tx',
        bandwidthBps: '1000000000',
        score: {
          progress: '3/3',
          samplesOver: 3,
          requiredSamples: 3,
          outcome: 'WOULD_ACTIVATE',
          reason: 'AUTO_EXECUTION_DISABLED',
          firstAbnormalAt: '2026-11-05T00:00:00Z',
          decisionMs: 12,
        },
      },
    ],
  },
  poller: {
    running: true,
    monitoredInterfaces: 1,
    entries: [
      {
        interfaceId: 'i',
        profileIds: ['p'],
        quality: 'VALID',
        rxBps: 200000000,
        txBps: 980000000,
        contractedPercent: { p: 98 },
      },
    ],
  },
});
async function render(value: AutoAllLiveData) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(<MitigationAutoAllFacts data={value} names={{ p: 'SYNTHETIC' }} />),
  );
}
it('shows confirmed detection and actual RX/TX without claiming physical mitigation', async () => {
  await render(data());
  expect(el.textContent).toContain('DETECÇÃO CONFIRMADA');
  expect(el.textContent).toContain('ESCRITA BLOQUEADA');
  expect(el.textContent).toContain('DESABILITADA');
  expect(el.textContent).toContain('980.0 Mbps');
  expect(el.textContent).toContain('98.0%');
  expect(el.querySelectorAll('[data-profile-id]')).toHaveLength(1);
});
it('shows lease loss and unknown metrics without inventing values', async () => {
  const value = data();
  value.all.lease.acquired = false;
  value.all.lease.lost = true;
  value.poller.running = false;
  value.poller.entries = [];
  value.all.clients[0]!.score = null;
  await render(value);
  expect(el.textContent).toContain('PERDIDA');
  expect(el.textContent).toContain('PARADO');
  expect(el.textContent).not.toContain('DETECÇÃO CONFIRMADA');
  expect(el.textContent).not.toContain('0.0%');
});
