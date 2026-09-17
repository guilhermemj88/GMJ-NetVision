// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import { AlarmPanel, alarmFocusTarget } from './alarm-panel';

function makeAlarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: 'alarm-1',
    deviceId: 'device-1',
    deviceName: 'SW-CBF-01',
    interfaceId: 'iface-1',
    interfaceName: '40GE0/0/1',
    interfaceLabel: 'SW-SPA-SJO-5732-MPLS-01',
    ifIndex: 118,
    linkId: 'link-1',
    linkLabel: 'Backbone',
    type: 'INTERFACE_DOWN',
    severity: 'CRITICAL',
    startedAt: new Date(2026, 8, 16, 21, 17, 32).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    message: 'SW-CBF-01: SW-SPA-SJO-5732-MPLS-01 (40GE0/0/1) DOWN',
    ...overrides,
  };
}

describe('alarmFocusTarget', () => {
  it('focuses the link that owns the interface when there is one', () => {
    expect(alarmFocusTarget(makeAlarm({ linkId: 'link-7' }))).toEqual({
      kind: 'link',
      deviceId: 'device-1',
      linkId: 'link-7',
    });
  });

  it('focuses the device when the alarm has no link', () => {
    expect(alarmFocusTarget(makeAlarm({ linkId: null }))).toEqual({
      kind: 'device',
      deviceId: 'device-1',
    });
  });
});

describe('AlarmPanel', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  async function mount(alarms: Alarm[], onFocus: (alarm: Alarm) => void) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(<AlarmPanel alarms={alarms} onFocus={onFocus} />);
    });
    return container;
  }

  function findButtons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button')];
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
  });

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    window.localStorage.clear();
  });

  it('lists active alarms with severity, device, interface and down-since time', async () => {
    const container = await mount([makeAlarm()], vi.fn());

    expect(container.querySelector('.alarm-panel')).not.toBeNull();
    expect(container.textContent).toContain('LINK DOWN');
    expect(container.textContent).toContain('SW-CBF-01');
    expect(container.textContent).toContain('SW-SPA-SJO-5732-MPLS-01 — 40GE0/0/1');
    expect(container.textContent).toContain('CRIT');
    expect(container.textContent).toContain('Down desde 21:17:32');
  });

  it('shows an empty state when there are no active alarms', async () => {
    const container = await mount([], vi.fn());
    expect(container.textContent).toContain('Sem alarmes ativos');
  });

  it('clicking an alarm asks the map to focus the correct device or link', async () => {
    const onFocus = vi.fn();
    const withLink = makeAlarm({ id: 'alarm-link' });
    const withoutLink = makeAlarm({ id: 'alarm-device', linkId: null, interfaceId: 'iface-2' });
    const container = await mount([withLink, withoutLink], onFocus);

    const items = [
      ...container.querySelectorAll<HTMLButtonElement>('.alarm-panel__item'),
    ];
    expect(items).toHaveLength(2);

    await act(async () => {
      items[0]!.click();
    });
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(withLink);
    expect(alarmFocusTarget(withLink).kind).toBe('link');

    await act(async () => {
      items[1]!.click();
    });
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus).toHaveBeenCalledWith(withoutLink);
    expect(alarmFocusTarget(withoutLink)).toEqual({ kind: 'device', deviceId: 'device-1' });
  });

  it('hides the panel and reveals it again through the floating badge', async () => {
    const container = await mount([makeAlarm(), makeAlarm({ id: 'alarm-2' })], vi.fn());
    const hide = findButtons(container).find((button) =>
      (button.getAttribute('aria-label') ?? '').includes('Ocultar'),
    );
    expect(hide).toBeDefined();

    await act(async () => {
      hide!.click();
    });
    expect(container.querySelector('.alarm-panel')).toBeNull();
    const reveal = container.querySelector<HTMLButtonElement>('.alarm-panel__reveal');
    expect(reveal).not.toBeNull();
    expect(reveal!.textContent).toBe('⚠ 2');

    await act(async () => {
      reveal!.click();
    });
    expect(container.querySelector('.alarm-panel')).not.toBeNull();
  });

  it('moves the panel between the right and left sides', async () => {
    const container = await mount([makeAlarm()], vi.fn());
    expect(container.querySelector('.alarm-panel--right')).not.toBeNull();

    const move = findButtons(container).find((button) =>
      (button.getAttribute('aria-label') ?? '').includes('Mover'),
    );
    expect(move).toBeDefined();

    await act(async () => {
      move!.click();
    });
    expect(container.querySelector('.alarm-panel--left')).not.toBeNull();
    expect(container.querySelector('.alarm-panel--right')).toBeNull();
  });
});
