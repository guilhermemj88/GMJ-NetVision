/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { physicalAsset, physicalPort, physicalRack } from './physical-fixtures';

/**
 * Interação: a porta desenhada continua clicável e o canvas continua limpando a
 * seleção ao clicar fora. A geometria visual não muda esses comportamentos.
 */
describe('PhysicalRackCanvas (interação)', () => {
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

  it('seleciona a porta clicada e limpa a seleção ao clicar no fundo', () => {
    const onSelectPort = vi.fn();
    const onSelectAsset = vi.fn();
    const onClear = vi.fn();
    const rack = physicalRack({
      units: 6,
      assets: [
        physicalAsset({
          id: 'asset-a',
          name: 'SW-01',
          startU: 4,
          heightU: 1,
          ports: [
            physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', state: 'MAPPED' }),
            physicalPort({ id: 'port-b', assetId: 'asset-a', name: 'GE2', order: 2 }),
          ],
        }),
      ],
    });

    act(() => {
      root.render(
        createElement(PhysicalRackCanvas, {
          rack,
          connections: [],
          mode: 'hidden',
          selection: { kind: 'port', id: 'port-a' },
          path: null,
          onSelectAsset,
          onSelectPort,
          onSelectConnection: vi.fn(),
          onClear,
        }),
      );
    });

    const port = container.querySelector<HTMLButtonElement>('[data-port-id="port-b"]');
    expect(port).not.toBeNull();
    act(() => {
      port!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectPort).toHaveBeenCalledWith('port-b');
    // o clique na porta não seleciona o equipamento inteiro
    expect(onSelectAsset).not.toHaveBeenCalled();

    const faceplate = container.querySelector<HTMLElement>('[data-asset-id="asset-a"]');
    act(() => {
      faceplate!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectAsset).toHaveBeenCalledWith('asset-a');

    const scroll = container.querySelector<HTMLElement>('.physical-canvas-scroll');
    act(() => {
      scroll!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalled();
  });

  it('mantém o scroll horizontal do stage para viewports pequenos', () => {
    const rack = physicalRack({
      units: 4,
      assets: [physicalAsset({ id: 'asset-a', startU: 2, heightU: 1 })],
    });
    act(() => {
      root.render(
        createElement(PhysicalRackCanvas, {
          rack,
          connections: [],
          mode: 'hidden',
          selection: null,
          path: null,
          onSelectAsset: vi.fn(),
          onSelectPort: vi.fn(),
          onSelectConnection: vi.fn(),
          onClear: vi.fn(),
        }),
      );
    });
    const scroll = container.querySelector<HTMLElement>('.physical-canvas-scroll');
    const canvas = container.querySelector<HTMLElement>('.physical-canvas');
    expect(scroll).not.toBeNull();
    // a largura não é comprimida: o canvas mantém a largura da geometria
    const width = Number.parseInt(canvas?.style.width ?? '0', 10);
    expect(width).toBeGreaterThan(900);
  });
});
