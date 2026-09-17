// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps, type MapNode, type NetworkLink } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollHost, updateConceptualNode, updateLink } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { ContextDrawer, InterfaceOpticalDetails } from './context-drawer';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  pollHost: vi.fn(),
  updateLink: vi.fn(),
  updateConceptualNode: vi.fn(),
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

describe.each(['SOURCE', 'TARGET'] as const)('SINGLE_ENDED drawer with %s monitored', (side) => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let link: NetworkLink;
  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const map = cloneDemoMaps()[0]!;
    const host = map.devices.find((device) => device.interfaces.length >= 2)!;
    const carrier = { ...map.nodes[0]!, id: 'carrier', deviceId: null, nodeKind: 'GENERIC' as const, genericType: 'carrier', label: 'FTI' };
    map.nodes.push(carrier);
    link = { ...map.links[0]!, sourceDeviceId: side === 'SOURCE' ? host.id : null,
      targetDeviceId: side === 'TARGET' ? host.id : null, sourceNodeId: side === 'TARGET' ? carrier.id : null,
      targetNodeId: side === 'SOURCE' ? carrier.id : null, sourceInterfaceId: side === 'SOURCE' ? host.interfaces[0]!.id : null,
      targetInterfaceId: side === 'TARGET' ? host.interfaces[0]!.id : null, trafficMode: 'SINGLE_ENDED',
      aggregationMode: 'SUM', metricSources: host.interfaces.slice(0, 2).map((item) => ({ side, interfaceId: item.id })),
      trafficColorAToB: '#112233', trafficColorBToA: '#abcdef', customColor: '#123456',
      visualPaths: [{ order: 0, label: 'FTI', curvature: 175, enabled: true, customColor: '#654321' }], animationEnabled: true };
    map.links = [link];
    useMapStore.setState({ map, selection: { kind: 'link', id: link.id }, editMode: true, readOnly: false, linkGeometryDrafts: {}, showToast: vi.fn() });
    vi.mocked(updateLink).mockImplementation(async (_mapId, _linkId, input) => ({ ...link, ...input }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ContextDrawer /></QueryClientProvider>));
    await act(async () => findButton(container, 'Editar enlace').click());
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear(); container.remove();
    useMapStore.setState({ map: null, selection: null, editMode: false });
  });

  it('preserves directional colors, fallback, SUM sources and geometry when saving', async () => {
    expect(container.textContent).toContain(`A → B (${side === 'SOURCE' ? 'TX' : 'RX'} local)`);
    expect(container.textContent).toContain(`B → A (${side === 'SOURCE' ? 'RX' : 'TX'} local)`);
    expect(container.textContent).toContain(`Interfaces da ponta ${side === 'SOURCE' ? 'A' : 'B'} (soma)`);
    expect(container.textContent).not.toContain(`Interfaces da ponta ${side === 'SOURCE' ? 'B' : 'A'} (soma)`);
    await act(async () => { findButton(container, 'Salvar alterações').click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(updateLink).toHaveBeenCalledWith(link.mapId, link.id, expect.objectContaining({ trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: link.sourceInterfaceId, targetInterfaceId: link.targetInterfaceId,
      trafficColorAToB: '#112233', trafficColorBToA: '#abcdef', customColor: '#123456', aggregationMode: 'SUM',
      metricSources: link.metricSources, visualPaths: link.visualPaths, animationEnabled: true }));
  });
});

describe('link drawer curve controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const link = { ...cloneDemoMaps()[0]!.links[0]!, linkLayoutMode: 'MANUAL' as const,
    visualPaths: [{ order: 0, label: 'Principal', customColor: '#123456', curvature: 175, enabled: true }] };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const map = cloneDemoMaps()[0]!;
    map.links = [structuredClone(link)];
    useMapStore.setState({ map, activeMapId: map.id, selection: { kind: 'link', id: link.id }, editMode: true, readOnly: false, linkGeometryDrafts: {}, showToast: vi.fn() });
    vi.mocked(updateLink).mockImplementation(async (_mapId, _linkId, input) => ({ ...link, ...input }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ContextDrawer /></QueryClientProvider>));
    await act(async () => findButton(container, 'Editar enlace').click());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    useMapStore.setState({ map: null, selection: null, editMode: false, linkGeometryDrafts: {} });
  });

  it.each([['Resetar curva', 'MANUAL'], ['Voltar ao automático', 'AUTO']])('saves %s with zero curvature', async (label, mode) => {
    await act(async () => findButton(container, label!).click());
    expect(container.querySelector<HTMLInputElement>('.visual-path-grid input[type="number"]')!.value).toBe('0');
    await act(async () => {
      findButton(container, 'Salvar alterações').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(updateLink).toHaveBeenCalledTimes(1);
    expect(updateLink).toHaveBeenCalledWith(link.mapId, link.id, expect.objectContaining({
      linkLayoutMode: mode, visualPaths: [{ ...link.visualPaths[0], curvature: 0 }],
    }));
  });

  it('synchronizes canvas edits into an open form and prevents simultaneous saves', async () => {
    await act(async () => useMapStore.getState().setLinkGeometryDraft(link.id, {
      linkLayoutMode: 'MANUAL', visualPaths: [{ ...link.visualPaths[0]!, curvature: -200 }],
    }));
    expect(container.querySelector<HTMLInputElement>('.visual-path-grid input[type="number"]')!.value).toBe('-200');
    expect(findButton(container, 'Salvar alterações').disabled).toBe(true);
    await act(async () => useMapStore.getState().setLinkGeometryDraft(link.id, null));
    await act(async () => {
      findButton(container, 'Salvar alterações').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(updateLink).toHaveBeenCalledWith(link.mapId, link.id, expect.objectContaining({ visualPaths: [{ ...link.visualPaths[0], curvature: -200 }] }));
  });

  it('hides geometry controls in a public drawer', async () => {
    await act(async () => useMapStore.setState({ readOnly: true }));
    expect(container.querySelector('.edit-link-form')).toBeNull();
  });

  it('shows and saves the manual connection sides with the remaining link properties', async () => {
    const selects = () =>
      [...container.querySelectorAll<HTMLSelectElement>('.link-handle-sides select')];
    expect(selects()).toHaveLength(2);
    expect(selects().map((select) => select.value)).toEqual(['AUTO', 'AUTO']);
    expect([...selects()[0]!.options].map((option) => option.textContent)).toEqual([
      'Automática',
      'Superior',
      'Direita',
      'Inferior',
      'Esquerda',
    ]);
    expect(container.textContent).toContain('Conexão da ponta A');
    expect(container.textContent).toContain('Conexão da ponta B');

    // a side changed on the canvas must be reflected by the already-open form
    await act(async () =>
      useMapStore.getState().replaceLink({
        ...useMapStore.getState().map!.links[0]!,
        sourceHandleSide: 'TOP',
        targetHandleSide: 'RIGHT',
      }),
    );
    expect(selects().map((select) => select.value)).toEqual(['TOP', 'RIGHT']);

    await act(async () => setSelectValue(selects()[0]!, 'BOTTOM'));
    await act(async () => setSelectValue(selects()[1]!, 'LEFT'));
    await act(async () => {
      findButton(container, 'Salvar alterações').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(updateLink).toHaveBeenCalledWith(
      link.mapId,
      link.id,
      expect.objectContaining({
        sourceHandleSide: 'BOTTOM',
        targetHandleSide: 'LEFT',
        // the rest of the link form is still saved together
        visualPaths: link.visualPaths,
        linkLayoutMode: 'MANUAL',
        label: link.label,
        capacityBps: link.capacityBps,
      }),
    );
    // endpoints are never part of the payload
    expect(vi.mocked(updateLink).mock.calls[0]![2]).not.toHaveProperty('sourceDeviceId');
    expect(vi.mocked(updateLink).mock.calls[0]![2]).not.toHaveProperty('targetNodeId');
  });
});

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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('conceptual node drawer editing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const showToast = vi.fn();
  const map = cloneDemoMaps()[0]!;
  const conceptual: MapNode = {
    id: 'conceptual-carrier',
    mapId: map.id,
    deviceId: null,
    nodeKind: 'GENERIC',
    genericType: 'CARRIER',
    label: 'Operadora A',
    position: { x: 512.5, y: 348.25 },
    locked: false,
    positionSource: 'MANUAL',
    pppDisplayMode: 'AUTO',
    pppPosition: 'BOTTOM',
    pppColor: null,
    pppFontSize: 14,
  };
  const deviceNode = map.nodes[0]!;
  const liveMap = () => useMapStore.getState().map!;
  const nodeInStore = (id: string) => liveMap().nodes.find((item) => item.id === id)!;
  const findButtonIn = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(label),
    )!;
  const saveButton = () => findButtonIn('Salvar alterações');

  async function render(selection: string, state: { editMode: boolean; readOnly: boolean }) {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const withConceptual = {
      ...structuredClone(map),
      nodes: [...structuredClone(map.nodes), structuredClone(conceptual)],
    };
    useMapStore.setState({
      map: withConceptual,
      activeMapId: withConceptual.id,
      selection: { kind: 'node', id: selection },
      editMode: state.editMode,
      readOnly: state.readOnly,
      linkGeometryDrafts: {},
      showToast,
    });
    vi.mocked(updateConceptualNode).mockImplementation(async (_mapId, nodeId, input) => ({
      ...nodeInStore(nodeId),
      ...input,
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ContextDrawer />
        </QueryClientProvider>,
      );
    });
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
    useMapStore.setState({ map: null, selection: null, editMode: false, readOnly: false });
  });

  it('opens the drawer of an existing conceptual node', async () => {
    await render(conceptual.id, { editMode: false, readOnly: false });
    expect(container.textContent).toContain('NODE CONCEITUAL');
    expect(container.textContent).toContain('CARRIER');
    expect(container.textContent).toContain('513 × 348');
    expect(container.textContent).toContain('Livre');
  });

  it('does not offer editing in a read-only/public view', async () => {
    await render(conceptual.id, { editMode: true, readOnly: true });
    expect(container.textContent).not.toContain('Editar node');
    expect(container.querySelector('.edit-link-form')).toBeNull();
  });

  it('does not offer editing for DEVICE nodes', async () => {
    await render(deviceNode.id, { editMode: true, readOnly: false });
    expect(container.textContent).not.toContain('Editar node');
  });

  it('offers editing in edit mode and saves label, icon type and lock together', async () => {
    await render(conceptual.id, { editMode: true, readOnly: false });
    await act(async () => findButtonIn('Editar node').click());

    expect(container.textContent).toContain('DADOS DO NODE');
    const labelInput = container.querySelector<HTMLInputElement>(
      '.edit-link-form input[type="text"]',
    )!;
    const typeSelect = container.querySelector<HTMLSelectElement>('.edit-link-form select')!;
    const lockInput = container.querySelector<HTMLInputElement>(
      '.conceptual-node-form__lock input',
    )!;
    expect(labelInput.value).toBe('Operadora A');
    expect(typeSelect.value).toBe('CARRIER');
    expect(lockInput.checked).toBe(false);
    // every supported conceptual icon type stays selectable
    const optionValues = [...typeSelect.options].map((option) => option.value);
    expect(optionValues).toContain('CLOUD');
    expect(optionValues).toContain('DATACENTER');

    await act(async () => setInputValue(labelInput, 'Operadora B'));
    await act(async () => setSelectValue(typeSelect, 'DATACENTER'));
    await act(async () => lockInput.click());
    await act(async () => {
      saveButton().click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(updateConceptualNode).toHaveBeenCalledWith(map.id, conceptual.id, {
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
    });
    // the store now carries the server object, so the canvas re-renders the icon
    expect(nodeInStore(conceptual.id)).toEqual({
      ...conceptual,
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
    });
    expect(showToast).toHaveBeenCalledWith('Node atualizado');
    expect(container.querySelector('.edit-link-form')).toBeNull();
    expect(container.textContent).toContain('Operadora B');
  });

  it('cancels without touching the store and blocks an empty label', async () => {
    await render(conceptual.id, { editMode: true, readOnly: false });
    await act(async () => findButtonIn('Editar node').click());
    const labelInput = container.querySelector<HTMLInputElement>(
      '.edit-link-form input[type="text"]',
    )!;
    await act(async () => setInputValue(labelInput, '   '));
    expect(saveButton().disabled).toBe(true);

    await act(async () => setInputValue(labelInput, 'Rascunho'));
    expect(saveButton().disabled).toBe(false);
    await act(async () => findButtonIn('Cancelar').click());

    expect(container.querySelector('.edit-link-form')).toBeNull();
    expect(nodeInStore(conceptual.id)).toEqual(conceptual);
    expect(updateConceptualNode).not.toHaveBeenCalled();
  });

  it('keeps the node and its links untouched when the PATCH fails', async () => {
    await render(conceptual.id, { editMode: true, readOnly: false });
    const before = structuredClone(nodeInStore(conceptual.id));
    const linksBefore = structuredClone(liveMap().links);
    vi.mocked(updateConceptualNode).mockRejectedValueOnce(new Error('API 500'));

    await act(async () => findButtonIn('Editar node').click());
    const labelInput = container.querySelector<HTMLInputElement>(
      '.edit-link-form input[type="text"]',
    )!;
    await act(async () => setInputValue(labelInput, 'Quebrado'));
    await act(async () => {
      saveButton().click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(showToast).toHaveBeenCalledWith('Não foi possível salvar o node. Tente novamente.');
    expect(nodeInStore(conceptual.id)).toEqual(before);
    expect(liveMap().links).toEqual(linksBefore);
    expect(linksBefore).toHaveLength(map.links.length);
  });
});
