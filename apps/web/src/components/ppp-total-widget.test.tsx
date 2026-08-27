// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, MapWidget } from '@gmj/shared';
import { PppTotalWidget } from './ppp-total-widget';

vi.mock('@/lib/api', () => ({
  updateWidget: vi.fn().mockResolvedValue(undefined),
}));

function host(id: string, pppOnline: number, updatedAt: string | null = new Date().toISOString()): HostRecord {
  return {
    id,
    name: id,
    hostname: id,
    ip: '10.0.0.1',
    vendor: 'Huawei',
    model: '',
    status: 'UP',
    deviceType: 'router',
    site: '',
    source: 'MANUAL',
    discoveryMethod: 'SNMP',
    uptimeSeconds: 0,
    pppSupported: true,
    pppOnline,
    pppUpdatedAt: updatedAt,
    pppSource: 'SNMP_HUAWEI',
    updatedAt: '',
    interfaces: [],
    displayName: id,
    managementIp: '10.0.0.1',
    description: '',
    notes: '',
    origin: 'MANUAL',
    useZabbix: false,
    zabbix: null,
    sshEnabled: false,
    ssh: null,
    snmpEnabled: true,
    snmp: null,
    sourceHealth: {
      ZABBIX: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SSH: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SNMP: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
    },
    lastPollingAt: null,
    lastDiscoveryAt: null,
    mapIds: [],
    mapCount: 0,
    createdAt: '',
  };
}

function widget(overrides: Partial<MapWidget['settings']> = {}): MapWidget {
  return {
    id: 'w-1',
    mapId: 'map-1',
    type: 'PPP_TOTAL',
    positionX: 100,
    positionY: 100,
    enabled: true,
    settings: {
      mode: 'AUTO',
      selectedHostIds: [],
      title: 'PPP TOTAL',
      fontColor: null,
      fontSize: 24,
      backgroundColor: null,
      backgroundOpacity: 85,
      showHostCount: true,
      showFreshness: true,
      ...overrides,
    },
    createdAt: '',
    updatedAt: '',
  };
}

describe('PppTotalWidget', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  afterEach(() => {
    for (const { root, container } of roots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
  });

  function mount(devices: HostRecord[], widgetConfig: MapWidget) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => {
      root.render(
        <ReactFlowProvider>
          <PppTotalWidget widget={widgetConfig} devices={devices} readOnly={false} />
        </ReactFlowProvider>,
      );
    });
    return container;
  }

  it('sums all PPP-capable hosts in AUTO and shows host count and freshness', () => {
    const container = mount(
      [host('a', 5_000), host('b', 7_000)],
      widget(),
    );
    expect(container.textContent).toContain('PPP TOTAL');
    expect(container.textContent).toContain('12.000');
    expect(container.textContent).toContain('2 hosts');
    expect(container.textContent).toContain('2/2 hosts atualizados');
  });

  it('shows a partial freshness count when a host is stale', () => {
    const stale = new Date(Date.now() - 600_000).toISOString();
    const container = mount(
      [host('a', 5_000), host('b', 7_000, stale)],
      widget(),
    );
    expect(container.textContent).toContain('1/2 hosts atualizados');
  });
});
