/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import {
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
  physicalTemplate,
} from './physical-fixtures';

/**
 * Chassi modular no rack:
 *
 * CHASSIS IMAGE → SLOT HITBOX → MÓDULO → (imagem da placa | painel geométrico)
 * → PhysicalPort → cabo/LLDP/status.
 *
 * O chassi não declara porta de serviço: sem placa instalada não existe
 * conector, e o fallback geométrico continua valendo quando não há mapa.
 */

const M4 = 'huawei-ne8000-m4';

function m4Slots() {
  return [1, 2, 3, 4].map((index) =>
    physicalSlot({ id: `slot-${index}`, index, label: `Slot ${index}`, assetId: 'asset-m4' }),
  );
}

function m4Rack(options: { withModule?: boolean } = {}) {
  const modulePorts = [
    physicalPort({
      id: 'module-port-1',
      assetId: 'asset-m4',
      moduleId: 'module-1',
      slotId: 'slot-2',
      name: 'GE1',
      label: 'GE1',
      order: 1,
      state: 'CONNECTED',
      connectionId: 'connection-module',
    }),
    physicalPort({
      id: 'module-port-2',
      assetId: 'asset-m4',
      moduleId: 'module-1',
      slotId: 'slot-2',
      name: 'GE2',
      label: 'GE2',
      order: 2,
    }),
  ];
  const module = physicalModule({
    id: 'module-1',
    assetId: 'asset-m4',
    slotId: 'slot-2',
    slotIndex: 2,
    name: 'LPU de teste',
    model: 'LPU-TESTE',
    ports: modulePorts,
  });

  const slots = m4Slots().map((slot) =>
    options.withModule && slot.id === 'slot-2' ? { ...slot, module, ports: modulePorts } : slot,
  );

  return physicalRack({
    units: 8,
    assets: [
      physicalAsset({
        id: 'asset-m4',
        name: 'BNG-M4',
        kind: 'NETWORK',
        startU: 4,
        heightU: 2,
        template: physicalTemplate({
          catalogKey: M4,
          name: 'Huawei NetEngine 8000 M4',
          model: 'M4',
          kind: 'NETWORK',
          heightU: 2,
        }),
        slots,
        modules: options.withModule ? [module] : [],
        ports: options.withModule ? modulePorts : [],
      }),
      physicalAsset({
        id: 'asset-other',
        name: 'SW-01',
        kind: 'NETWORK',
        startU: 1,
        heightU: 1,
        ports: [
          physicalPort({
            id: 'other-port-1',
            assetId: 'asset-other',
            name: 'GE1',
            label: 'GE1',
            state: 'CONNECTED',
            connectionId: 'connection-module',
          }),
        ],
      }),
    ],
  });
}

const moduleConnection = physicalConnection({
  id: 'connection-module',
  portAId: 'module-port-1',
  portBId: 'other-port-1',
  a: {
    portId: 'module-port-1',
    portName: 'GE1',
    side: 'DEVICE',
    assetId: 'asset-m4',
    assetName: 'BNG-M4',
    rackId: 'rack-1',
    rackName: 'Rack 01',
    siteId: 'site-1',
    siteName: 'POP Centro',
  },
  b: {
    portId: 'other-port-1',
    portName: 'GE1',
    side: 'DEVICE',
    assetId: 'asset-other',
    assetName: 'SW-01',
    rackId: 'rack-1',
    rackName: 'Rack 01',
    siteId: 'site-1',
    siteName: 'POP Centro',
  },
});

const m4CatalogEntry = catalogEntry({
  catalogKey: M4,
  manufacturer: 'Huawei',
  family: 'NetEngine 8000',
  model: 'M4',
  heightU: 2,
  layoutType: 'MODULAR',
  ports: [],
  slots: [1, 2, 3, 4].map((index) => ({
    index,
    label: `Slot ${index}`,
    description: '',
    moduleKeys: [],
  })),
});

function s6730Rack(catalogKey: string, count10ge: number) {
  const ports = Array.from({ length: count10ge + 6 }, (_value, index) => {
    const uplink = index >= count10ge;
    const name = uplink ? `QSFP28-${index - count10ge + 1}` : `10GE-${index + 1}`;
    return physicalPort({
      id: `${catalogKey}-${index + 1}`,
      assetId: 'asset-s6730',
      name,
      label: name,
      order: index + 1,
      type: uplink ? 'QSFP' : 'SFP_PLUS',
    });
  });
  return physicalRack({
    units: 6,
    assets: [
      physicalAsset({
        id: 'asset-s6730',
        name: 'SW-S6730',
        startU: 4,
        heightU: 1,
        template: physicalTemplate({ catalogKey, model: catalogKey }),
        ports,
      }),
    ],
  });
}

describe('PhysicalRackCanvas — chassi modular', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(rack = m4Rack(), connections: typeof moduleConnection[] = []) {
    act(() => {
      root.render(
        createElement(PhysicalRackCanvas, {
          rack,
          connections,
          mode: 'all',
          selection: null,
          path: null,
          catalog: [m4CatalogEntry],
          onSelectAsset: vi.fn(),
          onSelectPort: vi.fn(),
          onSelectConnection: vi.fn(),
          onClear: vi.fn(),
        }),
      );
    });
  }

  function faceplatePorts(assetId: string) {
    return container.querySelectorAll(`[data-asset-id="${assetId}"] .physical-port`);
  }

  it('desenha o chassi M4 pela imagem com 4 slots e nenhuma porta de serviço', () => {
    render();

    const faceplate = container.querySelector('[data-asset-id="asset-m4"]')!;
    expect(faceplate.querySelector('.physical-modular-panel')).not.toBeNull();
    expect(faceplate.querySelector('.physical-modular-panel__image')?.getAttribute('src')).toBe(
      '/physical-panels/huawei/ne8000-m4-front.png',
    );
    expect(faceplate.querySelectorAll('.physical-modular-panel__slot')).toHaveLength(4);
    // chassi vazio: nenhum conector inventado
    expect(faceplate.querySelectorAll('.physical-port')).toHaveLength(0);
    // identidade física intacta
    expect(faceplate.textContent).toContain('U4–U5 · 2U');
  });

  it('mantém os 4 slots vazios quando não há placa instalada', () => {
    render();

    const slots = container.querySelectorAll('[data-asset-id="asset-m4"] .physical-modular-panel__slot');
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.getAttribute('data-slot-state')).toBe('EMPTY');
    }
  });

  it('renderiza a placa instalada dentro do slot correto', () => {
    render(m4Rack({ withModule: true }));

    const slot2 = container.querySelector('[data-slot-key="service-2"]')!;
    const slot1 = container.querySelector('[data-slot-key="service-1"]')!;

    expect(slot2.getAttribute('data-slot-state')).toBe('OCCUPIED');
    expect(slot1.getAttribute('data-slot-state')).toBe('EMPTY');
    expect(slot2.querySelectorAll('.physical-port')).toHaveLength(2);
    expect(slot2.getAttribute('title')).toContain('LPU-TESTE');
    // só a placa instalada tem conectores (o outro equipamento do rack é separado)
    expect(faceplatePorts('asset-m4')).toHaveLength(2);
  });

  it('ancora o cabo no centro do conector dentro do slot (mesma caixa do desenho)', () => {
    render(m4Rack({ withModule: true }), [moduleConnection]);

    const faceplate = container.querySelector('[data-asset-id="asset-m4"]') as HTMLElement;
    const panel = faceplate.querySelector('.physical-faceplate__panel') as HTMLElement;
    const chassisArea = faceplate.querySelector('.physical-modular-panel-area') as HTMLElement;
    const slot = faceplate.querySelector('[data-slot-key="service-2"]') as HTMLElement;
    const modulePanel = slot.querySelector(
      '.physical-modular-panel__module-panel',
    ) as HTMLElement;
    const port = slot.querySelector('.physical-port[data-port-id="module-port-1"]') as HTMLElement;

    const px = (element: HTMLElement, property: 'left' | 'top' | 'width' | 'height') =>
      Number.parseFloat(element.style[property] || '0');
    /** O slot é posicionado em % do painel: converte para px do painel. */
    const pct = (element: HTMLElement, property: 'left' | 'top', basis: number) =>
      (Number.parseFloat(element.style[property] || '0') / 100) * basis;

    const expectedX =
      px(faceplate, 'left') +
      px(panel, 'left') +
      px(chassisArea, 'left') +
      pct(slot, 'left', px(chassisArea, 'width')) +
      px(modulePanel, 'left') +
      px(port, 'left') +
      px(port, 'width') / 2;
    const expectedY =
      px(faceplate, 'top') +
      px(panel, 'top') +
      px(chassisArea, 'top') +
      pct(slot, 'top', px(chassisArea, 'height')) +
      px(modulePanel, 'top') +
      px(port, 'top') +
      px(port, 'height') / 2;

    const d = container.querySelector('.physical-cable')!.getAttribute('d') ?? '';
    const match = /^M ([-\d.]+) ([-\d.]+)/.exec(d)!;
    const start = { x: Number(match[1]), y: Number(match[2]) };

    // A âncora sai da MESMA caixa usada para desenhar a porta. A diferença de
    // até ~2 px vem de artefatos de renderização (borda de 1 px da faceplate,
    // % do slot arredondado e largura do botão arredondada) — o cabo continua
    // dentro do conector, que é o que importa.
    expect(Math.abs(start.x - expectedX)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(start.y - expectedY)).toBeLessThanOrEqual(2.5);

    const portWidth = Number.parseFloat(port.style.width || '0');
    const portHeight = Number.parseFloat(port.style.height || '0');
    expect(Math.abs(start.x - expectedX)).toBeLessThan(portWidth / 2);
    expect(Math.abs(start.y - expectedY)).toBeLessThan(portHeight / 2);
  });

  it('chassi modular sem mapa continua no renderer geométrico atual', () => {
    const rack = physicalRack({
      units: 8,
      assets: [
        physicalAsset({
          id: 'asset-m4',
          name: 'CHASSI-SEM-MAPA',
          startU: 4,
          heightU: 2,
          template: physicalTemplate({
            catalogKey: 'chassi-modular-sem-mapa',
            name: 'Chassi modular sem mapa',
            kind: 'NETWORK',
            heightU: 2,
          }),
          slots: m4Slots(),
        }),
      ],
    });
    render(rack);

    const faceplate = container.querySelector('[data-asset-id="asset-m4"]')!;
    expect(faceplate.querySelector('.physical-modular-panel')).toBeNull();
    expect(faceplate.querySelectorAll('.physical-slot')).toHaveLength(4);
  });

  it('regressão S6730: H24X6C 30 hotspots e H48X6C 54 hotspots', () => {
    render(s6730Rack('huawei-s6730-h24x6c', 24));
    expect(container.querySelectorAll('.physical-image-panel__hitbox')).toHaveLength(30);
    act(() => root.unmount());

    root = createRoot(container);
    render(s6730Rack('huawei-s6730-h48x6c', 48));
    expect(container.querySelectorAll('.physical-image-panel__hitbox')).toHaveLength(54);
    expect(container.querySelectorAll('.physical-modular-panel')).toHaveLength(0);
  });
});
