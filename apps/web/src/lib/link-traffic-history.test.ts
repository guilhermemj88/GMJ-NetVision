import { describe, expect, it } from 'vitest';
import type {
  LinkInterfaceResolver,
  MetricPoint,
  NetworkInterface,
  NetworkLink,
} from '@gmj/shared';
import {
  buildLinkCounterRecords,
  buildLinkHistorySeries,
  linkHistoryPlans,
  seriesStats,
  utilizationPercent,
} from './link-traffic-history';

function networkInterface(id: string, deviceId: string): NetworkInterface {
  return {
    id,
    deviceId,
    name: id,
    alias: '',
    description: '',
    ifIndex: 1,
    mac: '',
    mtu: 9000,
    speedBps: 10_000_000_000,
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
    opticalLanes: [],
  } as unknown as NetworkInterface;
}

const IF_A = networkInterface('if-a', 'dev-a');
const IF_A2 = networkInterface('if-a2', 'dev-a');
const IF_B = networkInterface('if-b', 'dev-b');

const resolver: LinkInterfaceResolver = (_deviceId, interfaceId) =>
  [IF_A, IF_A2, IF_B].find((item) => item.id === interfaceId);

function link(overrides: Partial<NetworkLink> = {}): NetworkLink {
  return {
    sourceDeviceId: 'dev-a',
    targetDeviceId: 'dev-b',
    sourceNodeId: null,
    targetNodeId: null,
    sourceInterfaceId: 'if-a',
    targetInterfaceId: 'if-b',
    trafficMode: 'BIDIRECTIONAL',
    aggregationMode: 'NONE',
    metricSources: [],
    capacityBps: 10_000_000_000,
    ...overrides,
  } as unknown as NetworkLink;
}

function point(
  timestamp: string,
  rxBps: number,
  txBps: number,
  counters: Partial<MetricPoint> = {},
): MetricPoint {
  return {
    timestamp,
    rxBps,
    txBps,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    ...counters,
  };
}

describe('linkHistoryPlans — orientacao A→B/B→A', () => {
  it('bidirecional: A→B usa TX da ponta A (canonico) e RX da ponta B como fallback', () => {
    const [aToB, bToA] = linkHistoryPlans(link(), resolver);
    expect(aToB).toMatchObject({
      direction: 'A_TO_B',
      primary: { field: 'tx', label: 'TX ponta A' },
      fallback: { field: 'rx', label: 'RX ponta B' },
    });
    expect(aToB?.primary?.interfaces.map((item) => item.id)).toEqual(['if-a']);
    expect(aToB?.fallback?.interfaces.map((item) => item.id)).toEqual(['if-b']);
    expect(bToA).toMatchObject({
      direction: 'B_TO_A',
      primary: { field: 'tx', label: 'TX ponta B' },
      fallback: { field: 'rx', label: 'RX ponta A' },
    });
  });

  it('unilateral SOURCE: A→B é o TX local e B→A é o RX local, sem fallback', () => {
    const [aToB, bToA] = linkHistoryPlans(
      link({ trafficMode: 'SINGLE_ENDED', targetInterfaceId: null, targetDeviceId: null, targetNodeId: 'node-b' }),
      resolver,
    );
    expect(aToB).toMatchObject({ primary: { field: 'tx', label: 'TX local' }, fallback: null });
    expect(bToA).toMatchObject({ primary: { field: 'rx', label: 'RX local' }, fallback: null });
    expect(aToB?.primary?.interfaces.map((item) => item.id)).toEqual(['if-a']);
    expect(bToA?.primary?.interfaces.map((item) => item.id)).toEqual(['if-a']);
  });

  it('unilateral TARGET: A→B é o RX local e B→A é o TX local', () => {
    const [aToB, bToA] = linkHistoryPlans(
      link({ trafficMode: 'SINGLE_ENDED', sourceInterfaceId: null, sourceDeviceId: null, sourceNodeId: 'node-a' }),
      resolver,
    );
    expect(aToB).toMatchObject({ primary: { field: 'rx', label: 'RX local' }, fallback: null });
    expect(bToA).toMatchObject({ primary: { field: 'tx', label: 'TX local' }, fallback: null });
  });

  it('unilateral com as DUAS pontas reais cai no mapa bidirecional (mesma semantica ao vivo)', () => {
    const [aToB] = linkHistoryPlans(link({ trafficMode: 'SINGLE_ENDED' }), resolver);
    expect(aToB).toMatchObject({ primary: { field: 'tx', label: 'TX ponta A' } });
  });

  it('SUM usa TODAS as interfaces de cada lado (metricSources)', () => {
    const [aToB] = linkHistoryPlans(
      link({
        aggregationMode: 'SUM',
        metricSources: [
          { side: 'SOURCE', interfaceId: 'if-a' },
          { side: 'SOURCE', interfaceId: 'if-a2' },
        ],
      }),
      resolver,
    );
    expect(aToB?.primary?.interfaces.map((item) => item.id)).toEqual(['if-a', 'if-a2']);
  });
});

describe('buildLinkHistorySeries — fidelidade das series', () => {
  const history = new Map<string, MetricPoint[]>([
    ['if-a', [point('2026-10-15T12:00:00.000Z', 10, 100), point('2026-10-15T12:05:00.000Z', 10, 200)]],
    ['if-b', [point('2026-10-15T12:00:00.000Z', 50, 5), point('2026-10-15T12:05:00.000Z', 60, 6)]],
  ]);
  const historyFor = (interfaceId: string) => history.get(interfaceId);

  it('usa o TX da origem e NUNCA soma com o RX do destino', () => {
    const [planA, planB] = linkHistoryPlans(link(), resolver);
    const aToB = buildLinkHistorySeries(planA!, historyFor);
    const bToA = buildLinkHistorySeries(planB!, historyFor);
    expect(aToB.points.map((item) => item.value)).toEqual([100, 200]);
    expect(aToB.used?.label).toBe('TX ponta A');
    expect(aToB.usedFallback).toBe(false);
    expect(bToA.points.map((item) => item.value)).toEqual([5, 6]);
    expect(bToA.used?.label).toBe('TX ponta B');
  });

  it('sem NENHUM TX na janela usa o RX observado do destino (fallback comprovado)', () => {
    const sparseHistory = new Map<string, MetricPoint[]>([
      ['if-a', []],
      ['if-b', [point('2026-10-15T12:00:00.000Z', 50, 0), point('2026-10-15T12:05:00.000Z', 60, 0)]],
    ]);
    const [planA] = linkHistoryPlans(link(), resolver);
    const aToB = buildLinkHistorySeries(planA!, (interfaceId) => sparseHistory.get(interfaceId));
    expect(aToB.points.map((item) => item.value)).toEqual([50, 60]);
    expect(aToB.used?.label).toBe('RX ponta B');
    expect(aToB.usedFallback).toBe(true);
  });

  it('TX presente (mesmo zerado) veta o fallback: zero e leitura, nao ausencia', () => {
    const zeroHistory = new Map<string, MetricPoint[]>([
      ['if-a', [point('2026-10-15T12:00:00.000Z', 0, 0)]],
      ['if-b', [point('2026-10-15T12:00:00.000Z', 50, 0)]],
    ]);
    const [planA] = linkHistoryPlans(link(), resolver);
    const aToB = buildLinkHistorySeries(planA!, (interfaceId) => zeroHistory.get(interfaceId));
    expect(aToB.points.map((item) => item.value)).toEqual([0]);
    expect(aToB.usedFallback).toBe(false);
  });

  it('SUM soma por bucket as interfaces do MESMO lado; bucket sem leitura fica null', () => {
    const sumHistory = new Map<string, MetricPoint[]>([
      ['if-a', [point('2026-10-15T12:00:00.000Z', 0, 100), point('2026-10-15T12:05:00.000Z', 0, 150)]],
      ['if-a2', [point('2026-10-15T12:00:00.000Z', 0, 50), point('2026-10-15T12:10:00.000Z', 0, 10)]],
    ]);
    const [planA] = linkHistoryPlans(
      link({
        aggregationMode: 'SUM',
        metricSources: [
          { side: 'SOURCE', interfaceId: 'if-a' },
          { side: 'SOURCE', interfaceId: 'if-a2' },
        ],
      }),
      resolver,
    );
    const aToB = buildLinkHistorySeries(planA!, (interfaceId) => sumHistory.get(interfaceId));
    expect(aToB.points.map((item) => [item.timestamp, item.value])).toEqual([
      ['2026-10-15T12:00:00.000Z', 150],
      ['2026-10-15T12:05:00.000Z', 150],
      ['2026-10-15T12:10:00.000Z', 10],
    ]);
  });

  it('sem nenhuma amostra a serie fica vazia e used é null (nada inventado)', () => {
    const [planA] = linkHistoryPlans(link(), resolver);
    const aToB = buildLinkHistorySeries(planA!, () => []);
    expect(aToB.points).toEqual([]);
    expect(aToB.used).toBeNull();
  });
});

describe('seriesStats e utilizacao', () => {
  it('atual é a última leitura, média e pico ignoram lacunas', () => {
    const stats = seriesStats([
      { timestamp: 't1', value: 100 },
      { timestamp: 't2', value: null },
      { timestamp: 't3', value: 300 },
      { timestamp: 't4', value: null },
    ]);
    expect(stats).toEqual({ current: 300, average: 200, peak: 300, samples: 2 });
  });

  it('utilizacao percentual com uma casa; capacité inexistente vira null', () => {
    expect(utilizationPercent(2_000_000_000, 10_000_000_000)).toBe(20);
    expect(utilizationPercent(7_200_000_000, 10_000_000_000)).toBe(72);
    expect(utilizationPercent(null, 10_000_000_000)).toBeNull();
    expect(utilizationPercent(1, 0)).toBeNull();
  });
});

describe('buildLinkCounterRecords — contadores na MESMA orientacao', () => {
  it('TX da origem alimenta erros/discards do transmissor; RX observado, do receptor', () => {
    const [planA, planB] = linkHistoryPlans(link(), resolver);
    const counterHistory = new Map<string, MetricPoint[]>([
      ['if-a', [point('t1', 99, 100, { txErrors: 3, rxErrors: 9, txDiscards: 1, rxDiscards: 8 })]],
      ['if-b', [point('t1', 50, 5, { rxErrors: 7, txErrors: 4, rxDiscards: 2, txDiscards: 6 })]],
    ]);
    const historyFor = (interfaceId: string) => counterHistory.get(interfaceId);
    const series = [
      buildLinkHistorySeries(planA!, historyFor),
      buildLinkHistorySeries(planB!, historyFor),
    ];
    const records = buildLinkCounterRecords(series, historyFor);
    expect(records).toHaveLength(1);
    // A→B (TX de if-a): txErrors/txDiscards — nunca os contadores de RX.
    expect(records[0]).toMatchObject({ aToBErrors: 3, aToBDiscards: 1, bToAErrors: 4, bToADiscards: 6 });
  });

  it('fallback troca tambem os contadores para o lado observado', () => {
    const [planA, planB] = linkHistoryPlans(link(), resolver);
    const counterHistory = new Map<string, MetricPoint[]>([
      ['if-a', []],
      ['if-b', [point('t1', 50, 5, { rxErrors: 7, txErrors: 4, rxDiscards: 2, txDiscards: 6 })]],
    ]);
    const historyFor = (interfaceId: string) => counterHistory.get(interfaceId);
    const series = [
      buildLinkHistorySeries(planA!, historyFor),
      buildLinkHistorySeries(planB!, historyFor),
    ];
    const records = buildLinkCounterRecords(series, historyFor);
    // A→B agora observa RX de if-b: rxErrors/rxDiscards daquela interface.
    expect(records[0]).toMatchObject({ aToBErrors: 7, aToBDiscards: 2, bToAErrors: 4, bToADiscards: 6 });
  });
});
