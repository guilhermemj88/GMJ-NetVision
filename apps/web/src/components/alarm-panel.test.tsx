// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm, InterfaceOccurrence } from '@gmj/shared';
import { AlarmPanel, alarmDrawerSection, alarmFocusTarget } from './alarm-panel';

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

  function findScaleButton(container: HTMLElement, label: string): HTMLButtonElement {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('.alarm-panel__scale button'),
    ].find((item) => item.textContent === label);
    if (!button) throw new Error(`Scale button ${label} not found`);
    return button;
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

  it('moves the panel between the left and right sides', async () => {
    const container = await mount([makeAlarm()], vi.fn());
    expect(container.querySelector('.alarm-panel--left')).not.toBeNull();

    const move = findButtons(container).find((button) =>
      (button.getAttribute('aria-label') ?? '').includes('Mover'),
    );
    expect(move).toBeDefined();

    await act(async () => {
      move!.click();
    });
    expect(container.querySelector('.alarm-panel--right')).not.toBeNull();
    expect(container.querySelector('.alarm-panel--left')).toBeNull();
  });

  it('shows the panel on the left by default', async () => {
    const container = await mount([makeAlarm()], vi.fn());
    expect(container.querySelector('.alarm-panel--left')).not.toBeNull();
    expect(container.querySelector('.alarm-panel--right')).toBeNull();
  });

  it('respects a previously saved RIGHT position', async () => {
    window.localStorage.setItem('gmj:alarms:panel-position', 'RIGHT');
    const container = await mount([makeAlarm()], vi.fn());
    expect(container.querySelector('.alarm-panel--right')).not.toBeNull();
    expect(container.querySelector('.alarm-panel--left')).toBeNull();
  });

  it('respects a previously saved HIDDEN position', async () => {
    window.localStorage.setItem('gmj:alarms:panel-position', 'HIDDEN');
    const container = await mount([makeAlarm()], vi.fn());
    expect(container.querySelector('.alarm-panel')).toBeNull();
    expect(container.querySelector('.alarm-panel__reveal')).not.toBeNull();
  });

  it('defaults alarmScale to 125%', async () => {
    const container = await mount([makeAlarm()], vi.fn());
    const aside = container.querySelector<HTMLElement>('.alarm-panel');
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1.25');
  });

  it('offers Normal, Grande and Extra sizes and persists the choice', async () => {
    const container = await mount([makeAlarm()], vi.fn());
    const aside = container.querySelector<HTMLElement>('.alarm-panel');

    await act(async () => {
      findScaleButton(container, 'Normal').click();
    });
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1');
    expect(window.localStorage.getItem('gmj:alarms:panel-scale')).toBe('100');

    await act(async () => {
      findScaleButton(container, 'Grande').click();
    });
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1.25');
    expect(window.localStorage.getItem('gmj:alarms:panel-scale')).toBe('125');

    await act(async () => {
      findScaleButton(container, 'Extra').click();
    });
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1.5');
    expect(window.localStorage.getItem('gmj:alarms:panel-scale')).toBe('150');
  });

  it('restores a persisted alarmScale from localStorage', async () => {
    window.localStorage.setItem('gmj:alarms:panel-scale', '150');
    const container = await mount([makeAlarm()], vi.fn());
    const aside = container.querySelector<HTMLElement>('.alarm-panel');
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1.5');
    expect(findScaleButton(container, 'Extra').getAttribute('aria-pressed')).toBe('true');
  });

  it('scales both active and resolved alarm sections', async () => {
    const resolved = [makeResolvedAlarm({ id: 'r1' })];
    const container = await mount([makeAlarm()], vi.fn(), resolved);

    await act(async () => {
      findScaleButton(container, 'Extra').click();
    });

    const aside = container.querySelector<HTMLElement>('.alarm-panel');
    expect(aside!.style.getPropertyValue('--alarm-scale')).toBe('1.5');
    expect(aside!.querySelector('.alarm-panel__item')).not.toBeNull();
    expect(aside!.querySelector('.alarm-panel__resolved')).not.toBeNull();
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
      ...container.querySelectorAll<HTMLElement>(
        '.alarm-panel__resolved-body .alarm-panel__device',
      ),
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

describe('cards por tipo, ocorrencias e destino do clique (F8)', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  async function mount(
    alarms: Alarm[],
    options: {
      resolvedAlarms?: Alarm[];
      occurrences?: InterfaceOccurrence[];
      onFocus?: (alarm: Alarm) => void;
    } = {},
  ) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(
        <AlarmPanel
          alarms={alarms}
          resolvedAlarms={options.resolvedAlarms ?? []}
          occurrences={options.occurrences ?? []}
          onFocus={options.onFocus ?? vi.fn()}
        />,
      );
    });
    return container;
  }

  function makeOccurrence(overrides: Partial<InterfaceOccurrence> = {}): InterfaceOccurrence {
    return {
      kind: 'CRC',
      deviceId: 'device-1',
      deviceName: 'BHE-VTA-S6750-MPLS-01',
      interfaceId: 'iface-9',
      interfaceName: '100GE1/0/1',
      interfaceLabel: 'TO-CORE-01',
      ifIndex: 9,
      crcDelta: '4',
      rxDelta: '0',
      txDelta: '0',
      ratePerMinute: 0.27,
      lastOccurrenceAt: new Date(2026, 9, 7, 14, 32, 10).toISOString(),
      intervals: 1,
      windowMinutes: 15,
      ...overrides,
    };
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

  it('mostra o card de ERROS com taxa, limite e ativo desde', async () => {
    const container = await mount([
      makeAlarm({
        type: 'INTERFACE_ERRORS',
        severity: 'WARNING',
        metricKey: 'RX',
        currentValue: 18.4,
        thresholdValue: 10,
        metadata: { direction: 'RX', ratePerMinute: 18.4, thresholdPerMinute: 10 },
      }),
    ]);

    expect(container.textContent).toContain('ERROS');
    expect(container.textContent).toContain('RX 18.4 erros/min');
    expect(container.textContent).toContain('Limite 10/min');
    expect(container.textContent).toContain('Ativo desde 21:17:32');
    // Metricos usam "Ativo desde", nunca "Down desde".
    expect(container.textContent).not.toContain('Down desde');
  });

  it('mostra o card de CRC/FCS com taxa, limite e delta do periodo', async () => {
    const container = await mount([
      makeAlarm({
        type: 'INTERFACE_CRC',
        severity: 'MAJOR',
        metricKey: 'FCS',
        currentValue: 7.2,
        thresholdValue: 2,
        metadata: { direction: 'RX', ratePerMinute: 7.2, thresholdPerMinute: 2, delta: '36' },
      }),
    ]);

    expect(container.textContent).toContain('CRC/FCS');
    expect(container.textContent).toContain('RX 7.2 CRC/min');
    expect(container.textContent).toContain('Limite 2/min');
    expect(container.textContent).toContain('+36 no período');
  });

  it('card de CRC com threshold 0 mostra QUALQUER OCORRÊNCIA (preset delta > 0)', async () => {
    const container = await mount([
      makeAlarm({
        type: 'INTERFACE_CRC',
        severity: 'WARNING',
        metricKey: 'FCS',
        currentValue: 0.5,
        thresholdValue: 0,
        metadata: { direction: 'RX', ratePerMinute: 0.5, thresholdPerMinute: 0, delta: '1' },
      }),
    ]);

    expect(container.textContent).toContain('RX 0.5 CRC/min');
    expect(container.textContent).toContain('QUALQUER OCORRÊNCIA');
    expect(container.textContent).not.toContain('Limite 0/min');
  });

  it('mostra o card de DISCARDS com a taxa da direcao', async () => {
    const container = await mount([
      makeAlarm({
        type: 'INTERFACE_DISCARDS',
        severity: 'WARNING',
        metricKey: 'TX',
        currentValue: 42.1,
        thresholdValue: 20,
        metadata: { direction: 'TX', ratePerMinute: 42.1, thresholdPerMinute: 20 },
      }),
    ]);

    expect(container.textContent).toContain('DESCARTES');
    expect(container.textContent).toContain('TX 42.1 discards/min');
    expect(container.textContent).toContain('Limite 20/min');
  });

  it('card optico por proximidade mostra RX, LOW, margem e % do limite', async () => {
    const container = await mount([
      makeAlarm({
        type: 'OPTICAL_RX_DEGRADATION',
        severity: 'WARNING',
        metricKey: 'RX',
        metadata: {
          direction: 'RX',
          rxPowerDbm: -10.02,
          rxLowAlarmDbm: -18,
          marginDb: 7.98,
          proximityPercent: 91.3,
          trendDropDb: 0,
          triggerReasons: ['PROXIMITY'],
        },
      }),
    ]);

    expect(container.textContent).toContain('RX OPTICO');
    expect(container.textContent).toContain('RX atual -10.02 dBm · LOW -18.00 dBm');
    expect(container.textContent).toContain('Margem 8.0 dB');
    expect(container.textContent).toContain('91.3% do limite');
  });

  it('card optico por queda rapida mostra a queda na janela e nao esconde a lane', async () => {
    const container = await mount([
      makeAlarm({
        type: 'OPTICAL_RX_DEGRADATION',
        severity: 'MAJOR',
        metricKey: 'RX_LANE_2',
        metadata: {
          direction: 'RX',
          lane: 2,
          rxPowerDbm: -10.1,
          rxLowAlarmDbm: -20,
          marginDb: 9.9,
          proximityPercent: 54,
          trendDropDb: 5.1,
          trendWindowMinutes: 30,
          triggerReasons: ['RAPID_DROP'],
        },
      }),
    ]);

    expect(container.textContent).toContain('40GE0/0/1 · Lane 2');
    expect(container.textContent).toContain('↓ 5.1 dB em 30 min');
    expect(container.textContent).not.toContain('% do limite');
  });

  it('card optico com proximidade E queda mostra os DOIS motivos', async () => {
    const container = await mount([
      makeAlarm({
        type: 'OPTICAL_RX_DEGRADATION',
        severity: 'MAJOR',
        metadata: {
          direction: 'RX',
          rxPowerDbm: -12.83,
          rxLowAlarmDbm: -14,
          marginDb: 1.17,
          proximityPercent: 91,
          trendDropDb: 5.13,
          trendWindowMinutes: 30,
          triggerReasons: ['RAPID_DROP', 'PROXIMITY'],
        },
      }),
    ]);

    expect(container.textContent).toContain('91% do limite');
    expect(container.textContent).toContain('↓ 5.1 dB em 30 min');
  });

  it('mostra ocorrencias recentes de CRC e discards com ultima ocorrencia e taxa', async () => {
    const container = await mount([makeAlarm()], {
      occurrences: [
        makeOccurrence(),
        makeOccurrence({
          kind: 'DISCARDS',
          interfaceId: 'iface-10',
          interfaceName: '100GE1/0/2',
          crcDelta: '0',
          rxDelta: '23',
          txDelta: '0',
          ratePerMinute: 1.53,
          lastOccurrenceAt: new Date(2026, 9, 7, 14, 36, 20).toISOString(),
        }),
      ],
    });

    expect(container.textContent).toContain('Ocorrências recentes');
    expect(container.textContent).toContain('CRC/FCS · +4 CRC');
    expect(container.textContent).toContain('Última ocorrência 14:32:10');
    expect(container.textContent).toContain('DISCARDS · RX +23 · TX +0');
    expect(container.textContent).toContain('Última ocorrência 14:36:20');
  });

  it('sem ocorrencias recentes a secao nao aparece', async () => {
    const container = await mount([makeAlarm()]);
    expect(container.querySelector('.alarm-panel__list--occurrences')).toBeNull();
  });

  it('card resolvido optico mostra ultimo RX, LOW, queda e duracao', async () => {
    const startedAt = new Date(2026, 8, 16, 14, 15, 0);
    const container = await mount([], {
      resolvedAlarms: [
        makeResolvedAlarm({
          type: 'OPTICAL_RX_DEGRADATION',
          severity: 'MAJOR',
          startedAt: startedAt.toISOString(),
          endedAt: new Date(startedAt.getTime() + 17 * 60_000).toISOString(),
          metadata: {
            direction: 'RX',
            lane: 2,
            rxPowerDbm: -17.3,
            rxLowAlarmDbm: -18,
            trendDropDb: 4.8,
          },
        }),
      ],
    });

    expect(container.textContent).toContain('RESOLVIDO · RX OPTICO');
    expect(container.textContent).toContain('Último RX -17.30 dBm · LOW -18.00 dBm · Queda 4.8 dB');
    expect(container.textContent).toContain('Duração 17m00s');
  });

  it('card resolvido por regra desativada mostra o motivo administrativo', async () => {
    const container = await mount([], {
      resolvedAlarms: [
        makeResolvedAlarm({
          endedAt: new Date(2026, 8, 16, 21, 0, 0).toISOString(),
          metadata: { resolutionReason: 'RULE_DISABLED' },
        }),
      ],
    });

    expect(container.textContent).toContain('regra desativada');
  });

  it('mapeia o destino do clique por tipo (optico x metricas)', () => {
    expect(alarmDrawerSection(makeAlarm({ type: 'OPTICAL_RX_DEGRADATION' }))).toBe('OPTICAL');
    expect(alarmDrawerSection(makeAlarm({ type: 'INTERFACE_CRC' }))).toBe('METRICS');
    expect(alarmDrawerSection(makeAlarm({ type: 'INTERFACE_DISCARDS' }))).toBe('METRICS');
    expect(alarmDrawerSection(makeAlarm({ type: 'INTERFACE_ERRORS' }))).toBe('METRICS');
    expect(alarmDrawerSection(makeAlarm({ type: 'INTERFACE_DOWN' }))).toBeNull();
  });
});
