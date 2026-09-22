/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontPanelImageMap } from './front-panel-image-map';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import {
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalPort,
  physicalRack,
  physicalTemplate,
} from './physical-fixtures';

/**
 * Integração no rack: o equipamento com imagem aprovada é desenhado pela
 * imagem, e o cabo nasce no **centro do bbox do hotspot** — a mesma caixa usada
 * para o clique. Equipamentos sem imagem (e os V2) continuam no renderer
 * geométrico, sem nenhuma mudança de comportamento.
 */

const H48 = 'huawei-s6730-h48x6c';
const H48_V2 = 'huawei-s6730-h48x6c-v2';

function s6730Ports() {
  return Array.from({ length: 54 }, (_, index) => {
    const uplink = index >= 48;
    return physicalPort({
      id: `port-${index + 1}`,
      assetId: 'asset-sw',
      name: uplink ? `QSFP28-${index - 47}` : `10GE-${index + 1}`,
      label: uplink ? `QSFP28-${index - 47}` : `10GE-${index + 1}`,
      order: index + 1,
      type: uplink ? 'QSFP' : 'SFP_PLUS',
    });
  });
}

function rackWithImageAsset() {
  return physicalRack({
    units: 6,
    assets: [
      physicalAsset({
        id: 'asset-sw',
        name: 'SW-S6730',
        startU: 4,
        heightU: 1,
        template: physicalTemplate({ catalogKey: H48, model: 'S6730-H48X6C' }),
        ports: s6730Ports(),
      }),
      physicalAsset({
        id: 'asset-edd',
        name: 'EDD-01',
        kind: 'GENERIC',
        startU: 2,
        heightU: 1,
        ports: [physicalPort({ id: 'port-edd', assetId: 'asset-edd', name: 'LAN1', type: 'RJ45' })],
      }),
    ],
  });
}

function catalogFor(key: string, model: string) {
  return catalogEntry({
    catalogKey: key,
    model,
    manufacturer: 'Huawei',
    ports: Array.from({ length: 54 }, (_, index) => {
      const uplink = index >= 48;
      const name = uplink ? `QSFP28-${index - 47}` : `10GE-${index + 1}`;
      return {
        name,
        label: name,
        order: index + 1,
        side: 'DEVICE' as const,
        type: (uplink ? 'QSFP' : 'SFP_PLUS') as 'QSFP' | 'SFP_PLUS',
        connector: (uplink ? 'QSFP28' : 'SFP_PLUS') as 'QSFP28' | 'SFP_PLUS',
        portFunction: 'SERVICE' as const,
        groupKey: uplink ? 'qsfp28-uplink' : 'sfpplus-10g',
      };
    }),
  });
}

const connection = physicalConnection({
  id: 'connection-image',
  portAId: 'port-49',
  portBId: 'port-edd',
  a: {
    portId: 'port-49',
    portName: 'QSFP28-1',
    side: 'DEVICE',
    assetId: 'asset-sw',
    assetName: 'SW-S6730',
    rackId: 'rack-1',
    rackName: 'Rack 01',
    siteId: 'site-1',
    siteName: 'POP Centro',
  },
  b: {
    portId: 'port-edd',
    portName: 'LAN1',
    side: 'DEVICE',
    assetId: 'asset-edd',
    assetName: 'EDD-01',
    rackId: 'rack-1',
    rackName: 'Rack 01',
    siteId: 'site-1',
    siteName: 'POP Centro',
  },
});

function px(element: Element, property: 'left' | 'top' | 'width' | 'height'): number {
  const inline = (element as HTMLElement).style[property];
  return Number.parseFloat(inline || '0');
}

function cableStart(container: HTMLElement): { x: number; y: number } {
  const path = container.querySelector('.physical-cable') as SVGPathElement;
  const d = path.getAttribute('d') ?? '';
  const match = /^M ([-\d.]+) ([-\d.]+)/.exec(d);
  expect(match, `caminho do cabo inesperado: ${d}`).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]) };
}

describe('PhysicalRackCanvas com painel por imagem', () => {
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

  function renderCanvas(rack = rackWithImageAsset(), catalog = [catalogFor(H48, 'S6730-H48X6C')]) {
    act(() => {
      root.render(
        createElement(PhysicalRackCanvas, {
          rack,
          connections: [connection],
          mode: 'all',
          selection: null,
          path: null,
          catalog,
          onSelectAsset: vi.fn(),
          onSelectPort: vi.fn(),
          onSelectConnection: vi.fn(),
          onClear: vi.fn(),
        }),
      );
    });
  }

  it('desenha o S6730-H48X6C pela imagem com 54 hotspots e sem portas geométricas', () => {
    renderCanvas();
    const faceplate = container.querySelector('[data-asset-id="asset-sw"]')!;
    expect(faceplate.querySelector('.physical-image-panel')).not.toBeNull();
    expect(faceplate.querySelectorAll('.physical-image-panel__hitbox')).toHaveLength(54);
    expect(faceplate.querySelectorAll('.physical-port')).toHaveLength(0);
    // a identidade física continua sendo a do template
    expect(faceplate.textContent).toContain('S6730-H48X6C');
    expect(faceplate.textContent).toContain('U4 · 1U');
  });

  it('ancora o cabo no centro do bbox do hotspot (mesma caixa do clique)', () => {
    renderCanvas();
    const faceplate = container.querySelector('[data-asset-id="asset-sw"]') as HTMLElement;
    const panel = faceplate.querySelector('.physical-faceplate__panel') as HTMLElement;
    const imageSlot = faceplate.querySelector('.physical-image-panel-slot') as HTMLElement;
    const hotspot = faceplate.querySelector('[data-port-name="QSFP28-1"]') as HTMLElement;
    const bbox = frontPanelImageMap(H48)!.ports.find((port) => port.portName === 'QSFP28-1')!.bbox;

    const expectedX =
      px(faceplate, 'left') +
      px(panel, 'left') +
      px(imageSlot, 'left') +
      (bbox.x + bbox.width / 2) * px(imageSlot, 'width');
    const expectedY =
      px(faceplate, 'top') +
      px(panel, 'top') +
      px(imageSlot, 'top') +
      (bbox.y + bbox.height / 2) * px(imageSlot, 'height');

    const start = cableStart(container);
    expect(start.x).toBeCloseTo(expectedX, 6);
    expect(start.y).toBeCloseTo(expectedY, 6);

    // o hitbox está exatamente na mesma posição normalizada (visual = clique)
    expect(hotspot.style.left).toBe(`${bbox.x * 100}%`);
    expect(hotspot.style.top).toBe(`${bbox.y * 100}%`);
    expect(Number(hotspot.getAttribute('data-anchor-x'))).toBeCloseTo(
      bbox.x + bbox.width / 2,
      10,
    );
  });

  it('o anchor acompanha a caixa da imagem em racks diferentes (nunca px fixo)', () => {
    const rack = rackWithImageAsset();
    renderCanvas(rack);
    const firstSlot = (container.querySelector('.physical-image-panel-slot') as HTMLElement).style
      .width;
    const first = cableStart(container);
    act(() => root.unmount());

    // mesmo painel, rack com outra quantidade de U: a caixa se desloca no canvas
    root = createRoot(container);
    renderCanvas(physicalRack({ ...rack, units: 24 }));
    const secondSlot = (container.querySelector('.physical-image-panel-slot') as HTMLElement).style
      .width;
    const second = cableStart(container);
    const bbox = frontPanelImageMap(H48)!.ports.find((port) => port.portName === 'QSFP28-1')!.bbox;

    const faceplate = container.querySelector('[data-asset-id="asset-sw"]') as HTMLElement;
    const panel = faceplate.querySelector('.physical-faceplate__panel') as HTMLElement;
    const imageSlot = faceplate.querySelector('.physical-image-panel-slot') as HTMLElement;
    // a posição relativa à caixa da imagem é a mesma porta, em qualquer rack
    const localX = second.x - px(faceplate, 'left') - px(panel, 'left') - px(imageSlot, 'left');
    const localY = second.y - px(faceplate, 'top') - px(panel, 'top') - px(imageSlot, 'top');
    expect(localX / px(imageSlot, 'width')).toBeCloseTo(bbox.x + bbox.width / 2, 10);
    expect(localY / px(imageSlot, 'height')).toBeCloseTo(bbox.y + bbox.height / 2, 10);
    // ...e o y absoluto mudou porque a caixa mudou de lugar (não é px fixo)
    expect(first.y).not.toBeCloseTo(second.y, 3);
    expect(secondSlot).toBe(firstSlot);
  });

  it('equipamento sem imagem continua no renderer geométrico (fallback)', () => {
    const rack = physicalRack({
      units: 6,
      assets: [
        physicalAsset({
          id: 'asset-sw',
          name: 'MX-01',
          startU: 4,
          heightU: 1,
          template: physicalTemplate({ catalogKey: 'juniper-mx80', model: 'MX80' }),
          ports: [physicalPort({ id: 'port-a', assetId: 'asset-sw', name: 'GE1' })],
        }),
      ],
    });
    renderCanvas(rack, [catalogFor('juniper-mx80', 'MX80')]);
    const faceplate = container.querySelector('[data-asset-id="asset-sw"]')!;
    expect(faceplate.querySelector('.physical-image-panel')).toBeNull();
    expect(faceplate.querySelectorAll('.physical-port')).toHaveLength(1);
    expect(faceplate.querySelector('.physical-port')?.getAttribute('data-port-id')).toBe('port-a');
  });

  it('os modelos V2 não usam imagem automaticamente', () => {
    const rack = physicalRack({
      units: 6,
      assets: [
        physicalAsset({
          id: 'asset-sw',
          name: 'SW-V2',
          startU: 4,
          heightU: 1,
          template: physicalTemplate({ catalogKey: H48_V2, model: 'S6730-H48X6C-V2' }),
          ports: s6730Ports(),
        }),
      ],
    });
    renderCanvas(rack, [catalogFor(H48_V2, 'S6730-H48X6C-V2')]);
    const faceplate = container.querySelector('[data-asset-id="asset-sw"]')!;
    expect(faceplate.querySelector('.physical-image-panel')).toBeNull();
    // o renderer geométrico desenha todas as 54 portas do template
    expect(faceplate.querySelectorAll('.physical-port')).toHaveLength(54);
  });
});
