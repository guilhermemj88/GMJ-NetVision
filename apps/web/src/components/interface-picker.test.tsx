/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { cloneDemoMaps, type NetworkInterface } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterAndSortInterfaces,
  InterfacePicker,
} from './interface-picker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const template = cloneDemoMaps()[0]!.devices[0]!.interfaces[0]!;

function networkInterface(
  name: string,
  ifIndex: number,
  partial: Partial<NetworkInterface> = {},
): NetworkInterface {
  return {
    ...structuredClone(template),
    id: `if-${ifIndex}`,
    name,
    ifIndex,
    ...partial,
  };
}

describe('InterfacePicker helpers', () => {
  it('applies type priority and natural sorting to common interface names', () => {
    const interfaces = [
      networkInterface('LoopBack0', 90),
      networkInterface('GE0/0/10', 10),
      networkInterface('Vlanif230', 80),
      networkInterface('Port-Channel12', 70),
      networkInterface('GE0/0/2.230', 60),
      networkInterface('100GE1/0/2', 2),
      networkInterface('GE0/0/2', 3),
      networkInterface('GE0/0/1', 1),
      networkInterface('Tunnel10', 100),
    ];

    expect(filterAndSortInterfaces(interfaces, '', 'ALL').map((item) => item.name)).toEqual([
      '100GE1/0/2',
      'GE0/0/1',
      'GE0/0/2',
      'GE0/0/10',
      'Port-Channel12',
      'GE0/0/2.230',
      'Vlanif230',
      'LoopBack0',
      'Tunnel10',
    ]);
  });

  it('searches case-insensitively by name, alias, description and ifIndex', () => {
    const interfaces = [
      networkInterface('100GE1/0/2', 2002, { alias: 'UPLINK-CLIENTE' }),
      networkInterface('Eth-Trunk12.230', 230, { description: 'Transporte IX-SP' }),
    ];

    expect(filterAndSortInterfaces(interfaces, 'uplink-cliente', 'ALL')[0]?.ifIndex).toBe(2002);
    expect(filterAndSortInterfaces(interfaces, 'IX-sp', 'ALL')[0]?.name).toBe('Eth-Trunk12.230');
    expect(filterAndSortInterfaces(interfaces, '2002', 'ALL')[0]?.id).toBe('if-2002');
  });

  it('filters UP and DOWN without removing other statuses from the source list', () => {
    const interfaces = [
      networkInterface('GE0/0/1', 1, { operStatus: 'UP' }),
      networkInterface('GE0/0/2', 2, { operStatus: 'DOWN' }),
      networkInterface('GE0/0/3', 3, { operStatus: 'UNKNOWN' }),
    ];

    expect(filterAndSortInterfaces(interfaces, '', 'UP').map((item) => item.id)).toEqual(['if-1']);
    expect(filterAndSortInterfaces(interfaces, '', 'DOWN').map((item) => item.id)).toEqual(['if-2']);
    expect(interfaces).toHaveLength(3);
  });
});

describe('InterfacePicker selection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('returns the real interfaceId selected by the user', async () => {
    const onChange = vi.fn();
    const interfaces = [
      networkInterface('GE0/0/1', 1),
      networkInterface('GE0/0/10', 10),
    ];
    await act(async () => {
      root.render(createElement(InterfacePicker, {
        interfaces,
        value: interfaces[0]!.id,
        onChange,
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.interface-picker__trigger')!.click();
    });
    const option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((item) => item.textContent?.includes('GE0/0/10'))!;
    await act(async () => option.click());

    expect(onChange).toHaveBeenCalledWith('if-10');
  });
});
