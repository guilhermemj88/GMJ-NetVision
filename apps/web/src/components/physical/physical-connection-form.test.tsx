/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhysicalInventory } from '@gmj/shared';
import { PhysicalConnectionForm } from './physical-connection-form';
import {
  physicalAsset,
  physicalInventory,
  physicalPort,
  physicalRack,
} from './physical-fixtures';

/**
 * Criação manual de conexão: cascata Site → Rack → Equipamento → Porta,
 * independente do LLDP. Portas livres primeiro; ocupadas só aparecem com o
 * toggle. A origem nunca é oferecida como destino.
 */
describe('PhysicalConnectionForm', () => {
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

  const inventory = (): PhysicalInventory =>
    physicalInventory({
      sites: [
        {
          id: 'site-a',
          name: 'POP Vista Alegre',
          code: 'VTA',
          description: '',
          createdAt: '2026-09-21T12:00:00.000Z',
          updatedAt: '2026-09-21T12:00:00.000Z',
          racks: [
            physicalRack({
              id: 'rack-a',
              siteId: 'site-a',
              name: 'RACK 01',
              assets: [
                physicalAsset({
                  id: 'asset-local',
                  name: 'BHE-VTA-F1A-BGP',
                  ports: [
                    physicalPort({
                      id: 'port-source',
                      assetId: 'asset-local',
                      name: '100GE-1',
                      connectionId: 'conn-1',
                      state: 'CONNECTED',
                    }),
                    physicalPort({
                      id: 'port-free',
                      assetId: 'asset-local',
                      name: '100GE-2',
                      order: 2,
                    }),
                    physicalPort({
                      id: 'port-occupied',
                      assetId: 'asset-local',
                      name: '100GE-3',
                      order: 3,
                      connectionId: 'conn-2',
                      state: 'CONNECTED',
                    }),
                  ],
                }),
              ],
            }),
          ],
        },
        {
          id: 'site-b',
          name: 'POP Cabo Frio',
          code: 'CBF',
          description: '',
          createdAt: '2026-09-21T12:00:00.000Z',
          updatedAt: '2026-09-21T12:00:00.000Z',
          racks: [
            physicalRack({
              id: 'rack-b',
              siteId: 'site-b',
              name: 'RACK 01',
              assets: [
                physicalAsset({
                  id: 'asset-remote',
                  name: 'SW-CBF-MPLS-01',
                  ports: [
                    physicalPort({
                      id: 'port-remote',
                      assetId: 'asset-remote',
                      name: '100GE-2',
                    }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });

  function renderForm(sourcePortId: string) {
    const onSubmit = vi.fn();
    act(() => {
      root.render(
        createElement(PhysicalConnectionForm, {
          inventory: inventory(),
          sourcePortId,
          busy: false,
          onSubmit,
        }),
      );
    });
    return { container, onSubmit };
  }

  function select(selectElement: HTMLSelectElement, value: string): void {
    act(() => {
      selectElement.value = value;
      selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function pick(aria: string): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>(`[aria-label="${aria}"]`)!;
  }

  it('exige a cascata completa Site → Rack → Equipamento → Porta', () => {
    const { onSubmit } = renderForm('port-source');
    const site = pick('POP de destino');
    const rack = pick('Rack de destino');
    const asset = pick('Equipamento de destino');
    const port = pick('Porta de destino');
    expect(rack.disabled).toBe(true);
    expect(asset.disabled).toBe(true);
    expect(port.disabled).toBe(true);

    select(site, 'site-a');
    expect(rack.disabled).toBe(false);
    select(rack, 'rack-a');
    expect(asset.disabled).toBe(false);
    select(asset, 'asset-local');
    expect(port.disabled).toBe(false);

    // a origem nunca é destino; portas ocupadas ficam ocultas por padrão
    const optionValues = [...port.options].map((option) => option.value);
    expect(optionValues).toContain('port-free');
    expect(optionValues).not.toContain('port-source');
    expect(optionValues).not.toContain('port-occupied');

    select(port, 'port-free');
    const submit = container.querySelector<HTMLButtonElement>('button');
    act(() => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith('port-free', 'UNKNOWN', '');
  });

  it('mostra portas ocupadas apenas com o toggle e as mantém desabilitadas', () => {
    const { onSubmit } = renderForm('port-source');
    const site = pick('POP de destino');
    const rack = pick('Rack de destino');
    const asset = pick('Equipamento de destino');
    const port = pick('Porta de destino');
    select(site, 'site-a');
    select(rack, 'rack-a');
    select(asset, 'asset-local');

    expect([...port.options].map((option) => option.value)).not.toContain('port-occupied');
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      toggle.click();
    });
    const values = [...port.options].map((option) => option.value);
    expect(values).toContain('port-occupied');
    expect(port.options[values.indexOf('port-occupied')]!.disabled).toBe(true);
    void onSubmit;
  });

  it('deixa claro quando o destino está em outro POP', () => {
    const { container: rendered } = renderForm('port-source');
    const site = pick('POP de destino');
    const rack = pick('Rack de destino');
    const asset = pick('Equipamento de destino');
    const port = pick('Porta de destino');
    select(site, 'site-b');
    expect(rendered.textContent).toContain('Destino em outro POP');
    select(rack, 'rack-b');
    select(asset, 'asset-remote');
    select(port, 'port-remote');
    const submit = rendered.querySelector<HTMLButtonElement>('button');
    act(() => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
});
