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

function makeResolvedAlarm(overrides: Partial<Alarm> = {}): Alarm {
  const startedAt = new Date(2026, 8, 16, 20, 0, 0);
  return makeAlarm({
    id: 'resolved-1',
    deviceName: 'SW-JDM-01',
    interfaceLabel: 'PE-SP',
    interfaceName: '100GE0/0/1',
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + 218_000).toISOString(),
    ...overrides,
  });
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

  async function mount(
    alarms: Alarm[],
    onFocus: (alarm: Alarm) => void,
    resolvedAlarms: Alarm[] = [],
  ) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(
        <AlarmPanel alarms={alarms} resolvedAlarms={resolvedAlarms} onFocus={onFocus} />,
      );
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

  it('shows at most the 3 most recent resolved alarms', async () => {
    const resolved = [
      makeResolvedAlarm({ id: 'r1' }),
      makeResolvedAlarm({ id: 'r2' }),
      makeResolvedAlarm({ id: 'r3' }),
      makeResolvedAlarm({ id: 'r4' }),
      makeResolvedAlarm({ id: 'r5' }),
    ];
    const container = await mount([], vi.fn(), resolved);

    const items = [
      ...container.querySelectorAll<HTMLButtonElement>('.alarm-panel__resolved'),
    ];
    expect(items).toHaveLength(3);
    expect(container.querySelectorAll('.alarm-panel__resolved-body')).toHaveLength(3);
  });

  it('orders resolved alarms by endedAt descending', async () => {
    const resolved = [
      makeResolvedAlarm({
        id: 'oldest',
        deviceName: 'OLDEST',
        endedAt: new Date(2026, 8, 16, 8, 0, 0).toISOString(),
      }),
      makeResolvedAlarm({
        id: 'newest',
        deviceName: 'NEWEST',
        endedAt: new Date(2026, 8, 16, 12, 0, 0).toISOString(),
      }),
      makeResolvedAlarm({
        id: 'middle',
        deviceName: 'MIDDLE',
        endedAt: new Date(2026, 8, 16, 10, 0, 0).toISOString(),
      }),
    ];
    const container = await mount([], vi.fn(), resolved);

    const names = [
      ...container.querySelectorAll<HTMLElement>('.alarm-panel__resolved-body strong'),
    ].map((node) => node.textContent);
    expect(names).toEqual(['NEWEST', 'MIDDLE', 'OLDEST']);
  });

  it('does not count resolved alarms in the ALARMES badge', async () => {
    const resolved = [
      makeResolvedAlarm({ id: 'r1' }),
      makeResolvedAlarm({ id: 'r2' }),
      makeResolvedAlarm({ id: 'r3' }),
    ];
    const container = await mount(
      [makeAlarm(), makeAlarm({ id: 'alarm-2' })],
      vi.fn(),
      resolved,
    );

    const count = container.querySelector('.alarm-panel__count');
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe('2');
    expect(container.textContent).toContain('Resolvidos recentemente');
  });

  it('does not show the resolved section when there are no resolved alarms', async () => {
    const container = await mount([makeAlarm()], vi.fn(), []);
    expect(container.querySelector('.alarm-panel__section--resolved')).toBeNull();
    expect(container.querySelector('.alarm-panel__resolved')).toBeNull();
  });

  it('shows resolved alarms even when there are no active alarms', async () => {
    const resolved = [makeResolvedAlarm({ id: 'r1' })];
    const container = await mount([], vi.fn(), resolved);

    expect(container.textContent).toContain('Sem alarmes ativos');
    expect(container.textContent).toContain('Resolvidos recentemente');
    expect(container.textContent).toContain('SW-JDM-01');
  });

  it('renders resolved duration and resolution time', async () => {
    const startedAt = new Date(2026, 8, 16, 8, 37, 43);
    const resolved = [
      makeResolvedAlarm({
        id: 'r1',
        startedAt: startedAt.toISOString(),
        endedAt: new Date(startedAt.getTime() + 3 * 60_000 + 27_000).toISOString(),
      }),
    ];
    const container = await mount([], vi.fn(), resolved);

    expect(container.textContent).toContain('Duração 3m27s');
    expect(container.textContent).toContain('Resolvido às');
  });

  it('clicking a resolved alarm asks the map to focus it', async () => {
    const onFocus = vi.fn();
    const resolved = makeResolvedAlarm({ id: 'resolved-click' });
    const container = await mount([makeAlarm()], onFocus, [resolved]);

    const resolvedItems = [
      ...container.querySelectorAll<HTMLButtonElement>('.alarm-panel__resolved'),
    ];
    expect(resolvedItems).toHaveLength(1);

    await act(async () => {
      resolvedItems[0]!.click();
    });
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(resolved);
  });
});
