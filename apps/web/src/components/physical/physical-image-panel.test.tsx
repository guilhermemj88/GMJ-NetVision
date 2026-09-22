/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontPanelImageMap } from './front-panel-image-map';
import { PhysicalImagePanel } from './physical-image-panel';
import { physicalPort } from './physical-fixtures';

/**
 * O hitbox é a interface técnica do painel por imagem: ele deve refletir a
 * `PhysicalPort` real (estado/operStatus/interface mapeada) sem alterar o mapa.
 */

const H48 = frontPanelImageMap('huawei-s6730-h48x6c')!;

const ports = [
  physicalPort({
    id: 'port-qsfp1',
    name: 'QSFP28-1',
    label: 'QSFP28-1',
    type: 'QSFP',
    state: 'CONNECTED',
    operStatus: 'UP',
    mappedInterface: {
      id: 'iface-1',
      deviceId: 'device-1',
      name: '100GE0/0/4',
      ifIndex: 4,
      alias: null,
      operStatus: 'UP',
    },
    lldp: {
      adjacencyId: 'adj-1',
      remoteHostname: 'POP-CENTRO-SW2',
      remotePortName: 'GE1/0/1',
      confidence: 'HIGH',
      resolved: true,
      ambiguous: false,
      source: 'LLDP',
      observedAt: '2026-09-21T12:00:00.000Z',
    },
  }),
];

function renderPanel(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe('PhysicalImagePanel', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) act(() => mounted!.root.unmount());
    mounted?.container.remove();
  });

  it('desenha a imagem e um hitbox por hotspot do mapa', () => {
    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports }));
    const hitboxes = mounted.container.querySelectorAll('.physical-image-panel__hitbox');
    expect(hitboxes).toHaveLength(54);
    expect(mounted.container.querySelector('img')?.getAttribute('src')).toBe(H48.image);
    // posições normalizadas (%): nada em pixel absoluto
    const first = hitboxes[0] as HTMLElement;
    expect(first.style.left.endsWith('%')).toBe(true);
    expect(first.style.width.endsWith('%')).toBe(true);
    expect(first.getAttribute('data-port-name')).toBe('10GE-1');
  });

  it('mostra porta física, interface real, estado e operStatus no tooltip', () => {
    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports }));
    const hotspot = mounted.container.querySelector('[data-port-name="QSFP28-1"]')!;
    const title = hotspot.getAttribute('title')!;
    expect(title).toContain('QSFP28-1');
    expect(title).toContain('100GE0/0/4');
    expect(title).toContain('CONECTADA');
    expect(title).toContain('UP');
    expect(title).toContain('LLDP POP-CENTRO-SW2/GE1/0/1');
    expect(hotspot.getAttribute('data-port-id')).toBe('port-qsfp1');
    expect(hotspot.getAttribute('data-state')).toBe('CONNECTED');
    expect(hotspot.getAttribute('data-oper-status')).toBe('UP');
  });

  it('seleciona a PhysicalPort real ao clicar (nunca cria entidade nova)', () => {
    const onSelectPort = vi.fn();
    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports, onSelectPort }));
    const hotspot = mounted.container.querySelector(
      '[data-port-name="QSFP28-1"]',
    ) as HTMLButtonElement;
    act(() => hotspot.click());
    expect(onSelectPort).toHaveBeenCalledWith('port-qsfp1');
    // porta sem PhysicalPort correspondente não seleciona nada e fica marcada
    const unresolved = mounted.container.querySelector('[data-port-name="10GE-7"]')!;
    expect(unresolved.className).toContain('is-unresolved');
    act(() => (unresolved as HTMLButtonElement).click());
    expect(onSelectPort).toHaveBeenCalledTimes(1);
  });

  it('mantém o anchor no mesmo ponto normalizado em qualquer tamanho', () => {
    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports }));
    const hotspot = mounted.container.querySelector('[data-port-name="QSFP28-1"]') as HTMLElement;
    const bbox = H48.ports.find((port) => port.portName === 'QSFP28-1')!.bbox;
    expect(Number(hotspot.getAttribute('data-anchor-x'))).toBeCloseTo(
      bbox.x + bbox.width / 2,
      10,
    );
    expect(Number(hotspot.getAttribute('data-anchor-y'))).toBeCloseTo(
      bbox.y + bbox.height / 2,
      10,
    );
    // o anchor é o centro do próprio hitbox: mesma caixa, sem geometria paralela
    expect(hotspot.style.left).toBe(`${bbox.x * 100}%`);
    expect(hotspot.style.width).toBe(`${bbox.width * 100}%`);
  });

  it('debug desenha hitboxes e âncoras; sem debug a imagem fica limpa', () => {
    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports, debug: true }));
    expect(mounted.container.querySelector('.physical-image-panel')?.className).toContain(
      'is-debug',
    );
    expect(mounted.container.querySelectorAll('.physical-image-panel__anchor')).toHaveLength(54);
    act(() => mounted!.root.unmount());
    mounted.container.remove();

    mounted = renderPanel(createElement(PhysicalImagePanel, { map: H48, ports }));
    expect(mounted.container.querySelector('.physical-image-panel')?.className).not.toContain(
      'is-debug',
    );
  });

  it('destaca a porta selecionada e a porta que está no caminho', () => {
    mounted = renderPanel(
      createElement(PhysicalImagePanel, {
        map: H48,
        ports,
        selectedPortId: 'port-qsfp1',
        pathPortIds: new Set(['port-qsfp1']),
      }),
    );
    const hotspot = mounted.container.querySelector('[data-port-name="QSFP28-1"]')!;
    expect(hotspot.className).toContain('is-selected');
    expect(hotspot.className).toContain('is-path');
  });
});
