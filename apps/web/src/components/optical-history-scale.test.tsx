// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryPeriod, NetworkInterface, OpticalHistoryPoint } from '@gmj/shared';

// Stubs do recharts: o teste valida dominio/markers/dots sem canvas real.
vi.mock('recharts', async () => {
  const React = await import('react');
  const box = (testId: string, map?: (props: Record<string, unknown>) => Record<string, unknown>) =>
    (props: Record<string, unknown>) =>
      React.createElement(
        'div',
        { 'data-testid': testId, ...(map ? map(props) : {}) },
        (props.children as never) ?? null,
      );
  return {
    ResponsiveContainer: box('chart'),
    LineChart: box('linechart'),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: box('yaxis', (props) => ({ 'data-domain': JSON.stringify(props.domain ?? null) })),
    Tooltip: () => null,
    ReferenceLine: box('refline', (props) => ({ 'data-y': String(props.y) })),
    Line: box('line', (props) => ({
      'data-key': String(props.dataKey),
      'data-dot': props.dot === false ? 'false' : 'true',
    })),
  };
});

import { OpticalHistoryView } from './optical-history-charts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Canais clonados do preview: 4 lanes, thresholds DEVICE do 100GE0/0/2. */
const NETWORK_INTERFACE = {
  id: 'if-1',
  deviceId: 'dev-1',
  name: '100GE0/0/2',
  alias: '',
  description: '',
  ifIndex: 2,
  mac: '',
  mtu: 1500,
  speedBps: 100_000_000_000,
  adminStatus: 'UP',
  operStatus: 'UP',
  rxBps: 0,
  txBps: 0,
  rxUtilization: 0,
  txUtilization: 0,
  rxErrors: 0,
  txErrors: 0,
  rxDiscards: 0,
  txDiscards: 0,
  dataSources: ['SNMP'],
  opticalLanes: [0, 1, 2, 3].map((lane) => ({ lane })),
  opticalThresholds: {
    version: 1,
    scalar: {
      rx: { lowAlarmDbm: -21.48, highAlarmDbm: -2.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
      tx: { lowAlarmDbm: -2.5, highAlarmDbm: 6.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
    },
    lanes: [],
  },
} as unknown as NetworkInterface;

function sample(timestamp: string, lanes: number): OpticalHistoryPoint {
  return {
    timestamp,
    sampleCount: 1,
    rxAvg: -13.1,
    rxMin: -13.7,
    rxMax: -12.3,
    txAvg: 0.6,
    txMin: 0.4,
    txMax: 0.8,
    lanes: [0, 1, 2, 3].map((lane) => ({
      lane,
      sampleCount: 1,
      rxAvg: -13.7 + lane * 0.3,
      rxMin: -13.7 + lane * 0.3,
      rxMax: -13.7 + lane * 0.3,
      txAvg: 0.4 + lane * 0.1,
      txMin: 0.4 + lane * 0.1,
      txMax: 0.4 + lane * 0.1,
    })).slice(0, lanes),
  };
}

const TWO_SAMPLES = [sample('2026-10-07T12:00:00.000Z', 4), sample('2026-10-07T12:05:00.000Z', 4)];

let periodChanges = 0;

function Harness({
  points,
  networkInterface = NETWORK_INTERFACE,
}: {
  points: OpticalHistoryPoint[];
  networkInterface?: NetworkInterface;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('1h');
  const [scaleMode, setScaleMode] = useState<'AUTO' | 'LIMITS'>('AUTO');
  return (
    <OpticalHistoryView
      networkInterface={networkInterface}
      points={points}
      period={period}
      scaleMode={scaleMode}
      onPeriodChange={(next) => {
        periodChanges += 1;
        setPeriod(next);
      }}
      onScaleModeChange={setScaleMode}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

function domains(): number[][] {
  return Array.from(container.querySelectorAll('[data-testid="yaxis"]')).map(
    (node) => JSON.parse(node.getAttribute('data-domain') ?? 'null') as number[],
  );
}

function refLines(): number[] {
  return Array.from(container.querySelectorAll('[data-testid="refline"]')).map((node) =>
    Number(node.getAttribute('data-y')),
  );
}

function lineKeys(): string[] {
  return Array.from(container.querySelectorAll('[data-testid="line"]')).map(
    (node) => node.getAttribute('data-key') ?? '',
  );
}

function click(label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`botao ${label} nao encontrado`);
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  periodChanges = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('escala AUTO/LIMITES na tela do historico optico', () => {
  it('AUTO (default): dominio so dos dados, sem ReferenceLine e com chips direcionais', async () => {
    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });

    const [rx, tx] = domains();
    // RX real ~-13.7..-12.3: a janela NAO desce ate -21.48 nem sobe ate -2.50.
    expect(rx?.[0]).toBeGreaterThan(-21.48);
    expect(rx?.[1]).toBeLessThan(-2.5);
    expect(tx?.[0]).toBeGreaterThan(-2.5);
    expect(tx?.[1]).toBeLessThan(6.5);
    expect(refLines()).toHaveLength(0);
    expect(container.textContent).toContain('↓ abaixo da janela');
    expect(container.textContent).toContain('↑ acima da janela');
    expect(container.textContent).toContain('FONTE');
    // 4 chips (LOW/HIGH WARN + LOW/HIGH ALARM) + FONTE, em RX e TX.
    expect(container.querySelectorAll('.chart-thresholds__chip')).toHaveLength(10);
  });

  it('AUTO com threshold dentro da janela: linha de referencia real, sem hint', async () => {
    const insideInterface = {
      ...NETWORK_INTERFACE,
      opticalThresholds: {
        version: 1,
        scalar: {
          rx: { lowAlarmDbm: -13.75, highAlarmDbm: -12.75, lowSource: 'USER', highSource: 'USER' },
          tx: { lowAlarmDbm: 0.45, highAlarmDbm: 0.65, lowSource: 'USER', highSource: 'USER' },
        },
        lanes: [],
      },
    } as unknown as NetworkInterface;

    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} networkInterface={insideInterface} />);
    });

    // Duas linhas por grafico, dentro do dominio que continua vindo dos dados.
    expect(refLines()).toHaveLength(4);
    expect(refLines()).toContain(-13.75);
    expect(refLines()).toContain(-12.75);
    expect(container.textContent).not.toContain('abaixo da janela');
    expect(container.textContent).not.toContain('acima da janela');
    expect(container.textContent).toContain('USER');
  });

  it('LIMITES: dominios incluem LOW e HIGH e as duas linhas aparecem por grafico', async () => {
    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });
    await click('LIMITES');

    const [rx, tx] = domains();
    expect(rx?.[0]).toBeLessThan(-21.48);
    expect(rx?.[1]).toBeGreaterThan(-2.5);
    expect(tx?.[0]).toBeLessThan(-2.5);
    expect(tx?.[1]).toBeGreaterThan(6.5);

    const lines = refLines();
    expect(lines).toHaveLength(4);
    expect(lines).toContain(-21.48);
    expect(lines).toContain(-2.5);
    expect(lines).toContain(6.5);
    // Ambos visiveis: nenhum chip fala em janela.
    expect(container.textContent).not.toContain('janela');
  });

  it('alternar AUTO/LIMITES preserva periodo e dados (nada e refeito)', async () => {
    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });
    const before = lineKeys();
    expect(before.length).toBeGreaterThan(0);

    await click('LIMITES');
    expect(lineKeys()).toEqual(before);
    expect(periodChanges).toBe(0);
    const periodButton = Array.from(container.querySelectorAll('.period-picker button')).find(
      (item) => item.textContent?.trim() === '1h',
    );
    expect(periodButton?.className).toContain('is-active');
    const autoButton = Array.from(container.querySelectorAll('.scale-picker button')).find(
      (item) => item.textContent?.trim() === 'AUTO',
    );
    expect(autoButton?.getAttribute('aria-pressed')).toBe('false');

    await click('AUTO');
    expect(lineKeys()).toEqual(before);
    expect(periodChanges).toBe(0);
    expect(refLines()).toHaveLength(0);
  });

  it('trocar o periodo mantem a escala escolhida', async () => {
    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });
    await click('LIMITES');
    await click('24h');
    expect(periodChanges).toBe(1);
    const limitsButton = Array.from(container.querySelectorAll('.scale-picker button')).find(
      (item) => item.textContent?.trim() === 'LIMITES',
    );
    expect(limitsButton?.getAttribute('aria-pressed')).toBe('true');
    expect(refLines()).toHaveLength(4);
  });

  it('single sample desenha os pontos; com historico mantem a linha', async () => {
    await act(async () => {
      root.render(<Harness points={[sample('2026-10-07T12:00:00.000Z', 4)]} />);
    });
    const dots = Array.from(container.querySelectorAll('[data-testid="line"]')).map((node) =>
      node.getAttribute('data-dot'),
    );
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every((value) => value === 'true')).toBe(true);

    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });
    const lines = Array.from(container.querySelectorAll('[data-testid="line"]')).map((node) =>
      node.getAttribute('data-dot'),
    );
    expect(lines.every((value) => value === 'false')).toBe(true);
  });

  it('as lanes 0..3 continuam na legenda do grafico', async () => {
    await act(async () => {
      root.render(<Harness points={TWO_SAMPLES} />);
    });
    for (const lane of [0, 1, 2, 3]) {
      expect(container.textContent).toContain(`Lane ${lane}`);
    }
  });
});
