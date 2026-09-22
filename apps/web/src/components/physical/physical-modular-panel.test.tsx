/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modularChassisMap } from './modular-chassis-map';
import { PhysicalModularPanel, type ModularSlotView } from './physical-modular-panel';

/**
 * Painel de chassi modular: imagem (ou moldura lógica) + um hitbox por slot.
 *
 * O chassi não tem porta própria: nenhum conector pode aparecer sem placa
 * instalada, e o slot vazio precisa ficar visualmente vazio.
 */

const M4 = modularChassisMap('huawei-ne8000-m4')!;

function slotViews(): ModularSlotView[] {
  return [1, 2, 3, 4].map((ordinal) => ({
    slotId: `slot-${ordinal}`,
    ordinal,
    label: `Slot ${ordinal}`,
    occupied: false,
    moduleName: null,
    moduleImage: null,
  }));
}

describe('PhysicalModularPanel', () => {
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

  function render(props: Partial<Parameters<typeof PhysicalModularPanel>[0]> = {}) {
    act(() => {
      root.render(
        createElement(PhysicalModularPanel, {
          map: M4,
          slots: slotViews(),
          panelSize: { width: 828, height: 276 },
          ...props,
        }),
      );
    });
  }

  it('desenha a imagem do chassi e um hitbox por slot, sem porta inventada', () => {
    render();

    const image = container.querySelector('.physical-modular-panel__image');
    expect(image?.getAttribute('src')).toBe(M4.image);
    expect(container.querySelectorAll('.physical-modular-panel__slot')).toHaveLength(4);
    // chassi vazio: nenhum conector de serviço é inventado
    expect(container.querySelectorAll('.physical-port')).toHaveLength(0);
    expect(container.querySelector('.physical-modular-panel__module-panel')).toBeNull();
  });

  it('marca cada slot com ordinal e estado, em coordenadas normalizadas', () => {
    render();

    const slots = container.querySelectorAll('.physical-modular-panel__slot');
    const first = slots[0] as HTMLElement;
    expect(first.getAttribute('data-slot-key')).toBe('service-1');
    expect(first.getAttribute('data-slot-ordinal')).toBe('1');
    expect(first.getAttribute('data-slot-state')).toBe('EMPTY');
    expect(first.style.left).toBe('8%');
    expect(first.style.top).toBe('18%');
    expect(first.style.width).toBe('41.4%');
    expect(first.style.height).toBe('30.5%');
  });

  it('slot vazio não mostra módulo; ocupado mostra o nome da placa', () => {
    render({
      slots: slotViews().map((slot) =>
        slot.ordinal === 2
          ? { ...slot, occupied: true, moduleName: 'LPU de teste' }
          : slot,
      ),
    });

    const occupied = container.querySelector('[data-slot-ordinal="2"]')!;
    const empty = container.querySelector('[data-slot-ordinal="1"]')!;
    expect(occupied.getAttribute('data-slot-state')).toBe('OCCUPIED');
    expect(occupied.getAttribute('title')).toContain('LPU de teste');
    expect(empty.getAttribute('data-slot-state')).toBe('EMPTY');
    expect(empty.getAttribute('title')).toContain('vazio');
  });

  it('placa sem imagem usa o fallback geométrico recebendo a caixa do slot', () => {
    const renderModule = vi.fn();
    render({
      slots: slotViews().map((slot) =>
        slot.ordinal === 3 ? { ...slot, occupied: true, moduleName: 'LPU-3' } : slot,
      ),
      renderModule: (slot, slotBox) => {
        renderModule(slot, slotBox);
        return createElement('div', { className: 'modulo-geometrico' }, slot.moduleName ?? '');
      },
    });

    expect(renderModule).toHaveBeenCalledTimes(1);
    const [slot, box] = renderModule.mock.calls[0]!;
    expect(slot.slotId).toBe('slot-3');
    // caixa do slot em px: 0.08*828 / 0.515*276 com 0.414x0.305 (slot 3)
    expect(box.left).toBeCloseTo(0.08 * 828, 5);
    expect(box.top).toBeCloseTo(0.515 * 276, 5);
    expect(box.width).toBeCloseTo(0.414 * 828, 5);
    expect(box.height).toBeCloseTo(0.305 * 276, 5);
    expect(container.querySelector('[data-slot-ordinal="3"] .modulo-geometrico')).not.toBeNull();
  });

  it('placa com imagem própria é desenhada dentro do slot', () => {
    render({
      slots: slotViews().map((slot) =>
        slot.ordinal === 4
          ? { ...slot, occupied: true, moduleName: 'LPU-4', moduleImage: '/placa.png' }
          : slot,
      ),
    });

    const slot = container.querySelector('[data-slot-ordinal="4"]')!;
    expect(slot.querySelector('.physical-modular-panel__module-image')).not.toBeNull();
    expect(slot.getAttribute('data-slot-state')).toBe('OCCUPIED');
  });

  it('toggle "mostrar slots" desenha bbox + ordinal; desligado fica limpo', () => {
    render({ showSlots: true });
    expect(container.querySelector('.physical-modular-panel')?.className).toContain(
      'is-slots-visible',
    );
    expect(container.querySelectorAll('.physical-modular-panel__ordinal')).toHaveLength(4);
    act(() => root.unmount());

    root = createRoot(container);
    render();
    expect(container.querySelector('.physical-modular-panel')?.className).not.toContain(
      'is-slots-visible',
    );
    expect(container.querySelectorAll('.physical-modular-panel__ordinal')).toHaveLength(0);
  });

  it('clicar no slot seleciona o slot físico correspondente', () => {
    const onSelectSlot = vi.fn();
    render({ onSelectSlot });

    act(() => {
      (container.querySelector('[data-slot-ordinal="2"]') as HTMLElement).click();
    });

    expect(onSelectSlot).toHaveBeenCalledWith('slot-2');
  });

  it('chassi sem imagem usa moldura lógica (marcação is-logical)', () => {
    const logical = modularChassisMap('huawei-ne8000-m8-dc')!;
    act(() => {
      root.render(
        createElement(PhysicalModularPanel, {
          map: logical,
          slots: logical.slots.map((slot) => ({
            slotId: `slot-${slot.ordinal}`,
            ordinal: slot.ordinal,
            label: `Slot ${slot.ordinal}`,
            occupied: false,
          })),
          panelSize: { width: 828, height: 276 },
        }),
      );
    });

    expect(container.querySelector('.physical-modular-panel')?.className).toContain('is-logical');
    expect(container.querySelector('.physical-modular-panel__image')).toBeNull();
    expect(container.querySelectorAll('.physical-modular-panel__slot')).toHaveLength(8);
  });
});
