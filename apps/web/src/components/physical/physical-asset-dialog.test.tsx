/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CreatePhysicalAssetInput } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalAssetDialog, type PhysicalAssetDialogResult } from './physical-asset-dialog';
import { catalogEntry, physicalAsset, physicalRack } from './physical-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rack = physicalRack({
  units: 42,
  assets: [physicalAsset({ id: 'asset-taken', name: 'SW-ANTIGO', startU: 10, heightU: 2 })],
});

const catalog = [
  catalogEntry({
    catalogKey: 'mikrotik-crs305-1g-4s-in',
    name: 'MikroTik CRS305-1G-4S+IN',
    category: 'SWITCH',
    manufacturer: 'MikroTik',
    heightU: 1,
    ports: [
      { name: 'Ethernet 1', label: '', order: 1, side: 'DEVICE', type: 'RJ45' },
      { name: 'SFP+ 1', label: '', order: 2, side: 'DEVICE', type: 'SFP_PLUS' },
    ],
  }),
  catalogEntry({
    catalogKey: 'generic-switch-1u',
    name: 'Switch genérico 1U',
    category: 'SWITCH',
    manufacturer: 'Genérico',
    vendorVerified: false,
    heightU: 1,
    ports: [],
  }),
  catalogEntry({
    catalogKey: 'zte-c320',
    name: 'ZTE C320',
    category: 'OLT',
    manufacturer: 'ZTE',
    family: 'C320',
    vendorVerified: false,
    structureConfirmed: false,
    ports: [],
  }),
];

interface Rendered {
  container: HTMLDivElement;
  root: Root;
  submitted: PhysicalAssetDialogResult[];
}

function render(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const submitted: PhysicalAssetDialogResult[] = [];
  act(() => {
    root.render(
      createElement(PhysicalAssetDialog, {
        rack,
        hosts: [{ id: 'host-1', hostname: 'sw-pop01', displayName: 'SW POP 01' }],
        catalog,
        busy: false,
        canSync: true,
        onCancel: vi.fn(),
        onSubmit: (result: PhysicalAssetDialogResult) => submitted.push(result),
      }),
    );
  });
  return { container, root, submitted };
}

function select(container: HTMLElement, label: string, value: string): void {
  const field = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const element = field?.querySelector('select');
  if (!element) throw new Error(`select não encontrado: ${label}`);
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function input(container: HTMLElement, label: string): HTMLInputElement {
  const field = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const element = field?.querySelector('input');
  if (!element) throw new Error(`input não encontrado: ${label}`);
  return element;
}

function type(element: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

let rendered: Rendered | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  act(() => rendered?.root.unmount());
  rendered = null;
});

describe('PhysicalAssetDialog', () => {
  it('starts from the catalog with the verified structure locked', () => {
    rendered = render();
    const { container } = rendered;
    expect(container.textContent).toContain('VERIFICADO NO FABRICANTE');
    expect(container.textContent).toContain('MikroTik CRS305-1G-4S+IN');
    const height = input(container, 'Altura U');
    expect(height.disabled).toBe(true);
    expect(height.value).toBe('1');
    expect(container.textContent).toContain('Ocupado em U10, U11');
  });

  it('keeps the submit button as a real form submitter', () => {
    rendered = render();
    const submit = rendered.container.querySelector('button[type="submit"]');
    expect(submit?.textContent).toContain('Adicionar ao rack');
    expect(rendered.container.querySelector('button[type="button"]')?.textContent).toContain(
      'Cancelar',
    );
  });

  it('switches the model list when the manufacturer changes and lets generic models be completed', () => {
    rendered = render();
    const { container } = rendered;
    select(container, 'Fabricante', 'Genérico');
    expect(container.textContent).toContain('Switch genérico 1U');
    expect(container.textContent).toContain('TEMPLATE GENÉRICO');
    // generic template without ports: the operator informs the port block
    expect(container.textContent).toContain('Portas a criar');
    type(input(container, 'Portas a criar'), '8');
    type(input(container, 'Prefixo'), 'LAN');
    type(input(container, 'Nome no rack'), 'SW-GEN-01');
    act(() => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(rendered.submitted).toHaveLength(1);
    const sent: CreatePhysicalAssetInput = rendered.submitted[0]!.input;
    expect(sent.catalogKey).toBe('generic-switch-1u');
    expect(sent.genericPorts).toEqual({ count: 8, prefix: 'LAN', type: 'RJ45' });
    expect(sent.name).toBe('SW-GEN-01');
  });

  it('asks for the real structure when the vendor data was not confirmed', () => {
    rendered = render();
    const { container } = rendered;
    select(container, 'Categoria', 'OLT');
    expect(container.textContent).toContain('ESTRUTURA NÃO CONFIRMADA');
    const height = input(container, 'Altura U');
    expect(height.disabled).toBe(false);
    expect(container.textContent).toContain('não foram confirmadas em documentação oficial');
    type(height, '10');
    act(() => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(rendered.submitted[0]!.input.catalogKey).toBe('zte-c320');
    expect(rendered.submitted[0]!.input.heightU).toBe(10);
  });

  it('never disables the catalog template itself', () => {
    rendered = render();
    const inputElement = input(rendered.container, 'Altura U');
    expect(inputElement.disabled).toBe(true);
    expect(rendered.container.textContent).not.toContain('Estrutura não confirmada');
  });
});
