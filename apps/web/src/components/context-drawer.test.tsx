// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollHost } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { ContextDrawer, InterfaceOpticalDetails } from './context-drawer';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  pollHost: vi.fn(),
}));
vi.mock('./metric-charts', () => ({ MetricCharts: () => null }));
vi.mock('./optical-history-charts', () => ({ OpticalHistoryCharts: () => null }));
vi.mock('./assisted-discovery-review', () => ({ AssistedDiscoveryReview: () => null }));
vi.mock('./mpls-panel', () => ({ MplsPanel: () => <div data-testid="mpls-panel" /> }));

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!button) throw new Error(`Button ${label} not found`);
  return button;
}

function verificationButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
    button.textContent?.includes('VERIFICAR AGORA'),
  );
}

describe('ContextDrawer verification action', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const showToast = vi.fn();
  const map = cloneDemoMaps()[0]!;
  const device = map.devices.find((item) => item.snmpEnabled)!;

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    useMapStore.setState({
      map,
      activeMapId: map.id,
      selection: { kind: 'device', id: device.id },
      readOnly: false,
      showToast,
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ContextDrawer />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
    useMapStore.setState({ map: null, selection: null });
  });

  it('keeps one verification button in the equipment header across every tab', async () => {
    const header = container.querySelector('.drawer-header')!;
    expect(header.querySelector('.verify-host-action')).not.toBeNull();
    expect(verificationButtons(container)).toHaveLength(1);
    expect(container.querySelector('.drawer-actions .verify-host-action')).toBeNull();

    for (const tab of ['Interfaces', 'MPLS', 'Monitoring', 'Access', 'Discovery']) {
      await act(async () => findButton(container, tab).click());
      expect(container.querySelector('.drawer-header .verify-host-action')).not.toBeNull();
      expect(verificationButtons(container)).toHaveLength(1);
    }
  });

  it('keeps MPLS between Interfaces and Monitoring in the operational tab order', () => {
    const labels = [...container.querySelectorAll('.drawer-tabs button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels[0]).toContain('Visão geral');
    expect(labels[1]).toContain('Interfaces');
    expect(labels[2]).toContain('MPLS');
    expect(labels[3]).toContain('Monitoring');
  });

  it('keeps a compact host poll action in the interface header and uses the equipment id', async () => {
    const networkInterface = device.interfaces[0]!;
    await act(async () => {
      useMapStore.getState().setSelection({
        kind: 'interface',
        id: networkInterface.id,
        deviceId: device.id,
      });
    });

    const header = container.querySelector('.drawer-header')!;
    const identity = header.querySelector('.drawer-header__identity')!;
    const verify = verificationButtons(container)[0]!;
    expect(identity.querySelector('h2')?.textContent).toBe(networkInterface.name);
    expect(verify.classList.contains('nv-button--compact')).toBe(true);
    expect([...header.children].map((item) => item.className)).toEqual([
      '',
      'drawer-header__identity',
      'verify-host-action',
      expect.stringContaining('nv-badge'),
      'drawer-close',
    ]);

    let finishPoll!: (value: Awaited<ReturnType<typeof pollHost>>) => void;
    vi.mocked(pollHost).mockReturnValue(
      new Promise((resolve) => {
        finishPoll = resolve;
      }),
    );
    await act(async () => verify.click());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    expect(pollHost).toHaveBeenCalledWith(device.id);
    const pendingVerify = container.querySelector<HTMLButtonElement>(
      '.drawer-header .verify-host-action button',
    )!;
    expect(pendingVerify.disabled).toBe(true);
    expect(pendingVerify.textContent).toContain('VERIFICANDO...');

    await act(async () => {
      finishPoll({
        hostId: device.id,
        polledAt: '2026-08-24T12:00:00.000Z',
        interfacesChecked: device.interfaces.length,
        interfaceSamples: 0,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(
      container.querySelector<HTMLButtonElement>('.drawer-header .verify-host-action button')!
        .disabled,
    ).toBe(false);
  });

  it('keeps compact header controls visible in the narrow-drawer rules', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const narrowRules = css.slice(css.indexOf('@media (max-width: 720px)'));

    expect(narrowRules).toContain('.drawer-header > .verify-host-action .nv-button');
    expect(narrowRules).toContain('.drawer-header > .nv-badge');
    expect(narrowRules).toContain('.drawer-header > button');
    expect(narrowRules).not.toContain(
      `.drawer-header > .verify-host-action {
    display: none;`,
    );
  });

  it('prioritizes useful lanes and their exact source over a misleading scalar', () => {
    const networkInterface = {
      ...device.interfaces[0]!,
      rxPowerDbm: -11.14,
      txPowerDbm: -11.14,
      opticalSource: 'SNMP' as const,
      opticalUpdatedAt: '2026-08-23T12:00:00.000Z',
      opticalLaneSource: 'SNMP' as const,
      opticalLanesUpdatedAt: '2026-08-23T12:00:01.000Z',
      opticalLanes: [
        { lane: 0, rxPowerDbm: -3.71, txPowerDbm: 0.77, biasCurrentMa: 61 },
        { lane: 1, rxPowerDbm: -3.31, txPowerDbm: 1.27, biasCurrentMa: 59.36 },
      ],
      dataSources: ['SNMP' as const, 'SSH' as const],
    };

    const html = renderToStaticMarkup(
      <InterfaceOpticalDetails networkInterface={networkInterface} />,
    );

    expect(html).toContain('RX/TX óptico');
    expect(html).toContain('multi-lane');
    expect(html).toContain('Lane 0');
    expect(html).toContain('Bias 61.00 mA');
    expect(html).toContain('SNMP');
    expect(html).not.toContain('-11.14 dBm');
    expect(html).not.toContain('SNMP + SSH');
  });
});
