/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { CreatePhysicalModuleInput, PhysicalLldpSuggestion } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalInspector } from './physical-inspector';
import type { PhysicalSelection } from './physical-types';
import {
  physicalAsset,
  physicalInventory,
  physicalModule,
  physicalPort,
  physicalSlot,
  physicalTemplate,
} from './physical-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const template = physicalTemplate({
  slots: [{ id: 'tslot-1', index: 1, label: 'Slot 1', description: '', moduleKeys: ['generic-lpu-4x-sfp'] }],
  modules: [
    {
      id: 'tmodule-1',
      catalogKey: 'generic-lpu-4x-sfp',
      name: 'Placa 4x SFP+',
      model: 'LPU-4SFP',
      description: '',
      slotsRequired: 1,
      ports: [],
    },
  ],
});

function suggestion(partial: Partial<PhysicalLldpSuggestion> = {}): PhysicalLldpSuggestion {
  return {
    adjacencyId: 'lldp-1',
    confidence: 'CONFIRMED',
    state: 'READY',
    local: {
      assetId: 'asset-olt',
      assetName: 'OLT-01',
      portId: 'port-gpon-1',
      portName: 'GPON0/1/0',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    remote: {
      assetId: 'asset-sw',
      assetName: 'SW-01',
      portId: 'port-ge1',
      portName: 'GE1',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    localPortName: 'GPON0/1/0',
    remoteHostname: 'SW-CORE',
    remotePortName: 'GE1/0/1',
    observedAt: '2026-09-21T11:00:00.000Z',
    reason: 'Ambos os lados mapeados',
    ...partial,
  };
}

const assetWithSlots = physicalAsset({
  id: 'asset-olt',
  name: 'OLT-01',
  kind: 'OLT',
  heightU: 6,
  startU: 5,
  templateId: 'template-1',
  template,
  ports: [
    physicalPort({ id: 'port-gpon-1', assetId: 'asset-olt', name: 'GPON0/1/0', state: 'LLDP_DETECTED', lldp: {
      adjacencyId: 'lldp-1', remoteHostname: 'SW-CORE', remotePortName: 'GE1/0/1', confidence: 'CONFIRMED',
      resolved: true, ambiguous: false, source: 'LLDP', observedAt: '2026-09-21T11:00:00.000Z',
    } }),
  ],
  slots: [
    physicalSlot({ id: 'slot-1', assetId: 'asset-olt', index: 1, ports: [] }),
    physicalSlot({
      id: 'slot-2',
      assetId: 'asset-olt',
      index: 2,
      module: physicalModule({
        id: 'module-9',
        assetId: 'asset-olt',
        slotId: 'slot-2',
        name: 'Placa GPON 8 portas',
        model: 'H802GPBD',
        ports: [physicalPort({ id: 'port-gpon-9', assetId: 'asset-olt', slotId: 'slot-2', moduleId: 'module-9', name: 'GPON0/2/0', state: 'CONNECTED' })],
      }),
    }),
  ],
});

interface Rendered {
  container: HTMLDivElement;
  root: Root;
  installs: CreatePhysicalModuleInput[];
  removals: string[];
  confirmations: string[];
}

let rendered: Rendered | null = null;
let queryClient: QueryClient | null = null;

function render(
  suggestions: PhysicalLldpSuggestion[],
  selection: PhysicalSelection = { kind: 'asset', id: 'asset-olt' },
): Rendered {
  const inventory = physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Centro',
        code: 'CTO',
        description: '',
        racks: [
          {
            id: 'rack-1',
            siteId: 'site-1',
            name: 'Rack 01',
            units: 42,
            description: '',
            assets: [assetWithSlots],
            createdAt: '2026-09-21T12:00:00.000Z',
            updatedAt: '2026-09-21T12:00:00.000Z',
          },
        ],
        createdAt: '2026-09-21T12:00:00.000Z',
        updatedAt: '2026-09-21T12:00:00.000Z',
      },
    ],
    templates: [template],
    lldpSuggestions: suggestions,
    lldpObservedAt: '2026-09-21T11:00:00.000Z',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const installs: CreatePhysicalModuleInput[] = [];
  const removals: string[] = [];
  const confirmations: string[] = [];
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient as QueryClient },
        createElement(PhysicalInspector, {
          inventory,
          selection,
          path: null,
          canEdit: true,
          busy: false,
          onClose: vi.fn(),
          onSelectPort: vi.fn(),
          onUpdateAsset: vi.fn(),
          onSyncPorts: vi.fn(),
          onConnect: vi.fn(),
          onDeleteConnection: vi.fn(),
          onUpdatePort: vi.fn(),
          onInstallModule: (_assetId: string, input: CreatePhysicalModuleInput) => installs.push(input),
          onRemoveModule: (moduleId: string) => removals.push(moduleId),
          onConfirmLldp: (adjacencyId: string) => confirmations.push(adjacencyId),
        }),
      ),
    );
  });
  return { container, root, installs, removals, confirmations };
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('elemento não encontrado');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  act(() => rendered?.root.unmount());
  rendered = null;
  queryClient?.clear();
  queryClient = null;
});

describe('PhysicalInspector', () => {
  it('lists slots, marks free and occupied ones and reports module ports', () => {
    rendered = render([]);
    const { container } = rendered;
    expect(container.textContent).toContain('SLOTS E MÓDULOS');
    expect(container.textContent).toContain('Vazio');
    expect(container.textContent).toContain('Placa GPON 8 portas · H802GPBD');
    expect(container.textContent).toContain('1 portas');
    expect(container.textContent).toContain('1 / 2 ocupados');
  });

  it('installs the module template accepted by the slot and never invents a board', () => {
    rendered = render([]);
    const { container } = rendered;
    const selectElement = container.querySelector(
      'select[aria-label="Placa do Slot 1"]',
    ) as HTMLSelectElement | null;
    expect(selectElement).not.toBeNull();
    act(() => {
      selectElement!.value = 'tmodule-1';
      selectElement!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const install = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Instalar placa'),
    );
    click(install);
    expect(rendered.installs).toEqual([
      { slotId: 'slot-1', moduleTemplateId: 'tmodule-1', name: 'Placa 4x SFP+', model: 'LPU-4SFP' },
    ]);
  });

  it('blocks the install button until a template or a board name is informed', () => {
    rendered = render([]);
    const install = [...rendered.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Instalar placa'),
    );
    expect(install?.hasAttribute('disabled')).toBe(true);
  });

  it('removes an installed board through the guarded action', () => {
    rendered = render([]);
    const remove = [...rendered.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Remover placa'),
    );
    click(remove);
    expect(rendered.removals).toEqual(['module-9']);
  });

  it('shows the LLDP neighbour of the port and confirms only READY suggestions', () => {
    rendered = render(
      [
        suggestion(),
        suggestion({
          adjacencyId: 'lldp-2',
          state: 'PARTIAL',
          remote: null,
          remoteHostname: 'SW-DESCONHECIDO',
          remotePortName: 'GE2',
          reason: 'Apenas o lado local está mapeado',
        }),
      ],
      { kind: 'asset', id: 'asset-olt' },
    );
    const { container } = rendered;
    expect(container.textContent).toContain('SUGESTÕES LLDP');
    expect(container.textContent).toContain('GPON0/1/0 → SW-01 / GE1');
    const buttons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Confirmar conexão física'),
    );
    expect(buttons).toHaveLength(1);
    click(buttons[0]);
    expect(rendered.confirmations).toEqual(['lldp-1']);
    expect(container.textContent).toContain('PARTIAL');
  });

  it('reports the LLDP neighbour and the physical state of the selected port', () => {
    rendered = render([], { kind: 'port', id: 'port-gpon-1' });
    const { container } = rendered;
    expect(container.textContent).toContain('PORTA FÍSICA');
    expect(container.textContent).toContain('VIZINHO LLDP');
    expect(container.textContent).toContain('SW-CORE / GE1/0/1');
    expect(container.textContent).toContain('LLDP');
    expect(container.textContent).toContain('confirme a conexão física');
  });

  it('never offers auto-connection when there is no suggestion', () => {
    rendered = render([]);
    expect(rendered.container.textContent).toContain('Nenhuma adjacência LLDP');
    expect(rendered.container.textContent).not.toContain('Confirmar conexão física');
  });
});
