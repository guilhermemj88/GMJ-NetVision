import { describe, expect, it } from 'vitest';
import type { HistoryPeriod, InterfaceOpticalSample, NetworkInterface } from './types';
import { aggregateOpticalHistory, opticalSampleFromInterface } from './optical-history';

function sample(
  timestamp: string,
  rxPowerDbm: number | null,
  txPowerDbm: number | null,
  opticalLanes: InterfaceOpticalSample['opticalLanes'] = [],
): InterfaceOpticalSample {
  return { timestamp, rxPowerDbm, txPowerDbm, opticalLanes };
}

function fourLanes(offset = 0): InterfaceOpticalSample['opticalLanes'] {
  return [0, 1, 2, 3].map((lane) => ({
    lane,
    rxPowerDbm: -12 - lane + offset,
    txPowerDbm: 0.2 + lane + offset,
  }));
}

describe('optical history', () => {
  it('keeps a single-lane 15m sample raw', () => {
    const result = aggregateOpticalHistory([
      sample('2026-08-23T12:00:05.123Z', -12.01, 0.17),
    ], '15m');

    expect(result).toEqual([{
      timestamp: '2026-08-23T12:00:05.123Z',
      sampleCount: 1,
      rxAvg: -12.01, rxMin: -12.01, rxMax: -12.01,
      txAvg: 0.17, txMin: 0.17, txMax: 0.17,
      lanes: [],
    }]);
  });

  it('keeps four lanes separate in the same optical sample', () => {
    const [result] = aggregateOpticalHistory([
      sample('2026-08-23T12:00:05.000Z', -12.01, 0.17, fourLanes()),
    ], '15m');

    expect(result?.lanes).toHaveLength(4);
    expect(result?.lanes[3]).toMatchObject({
      lane: 3,
      sampleCount: 1,
      rxAvg: -15,
      txAvg: 3.2,
    });
  });

  it('builds one combined persisted sample from fresh SNMP scalar and SSH lanes', () => {
    const collectedAfter = new Date('2026-08-23T12:00:00.000Z');
    const networkInterface = {
      id: 'if-1', deviceId: 'device-1', name: '40GE0/0/1',
      rxPowerDbm: -12.01, txPowerDbm: 0.17,
      opticalSource: 'SNMP', opticalUpdatedAt: '2026-08-23T12:00:01.000Z',
      opticalLaneSource: 'SSH', opticalLanesUpdatedAt: '2026-08-23T12:00:02.000Z',
      opticalLanes: fourLanes(),
    } as NetworkInterface;

    expect(opticalSampleFromInterface(
      networkInterface,
      new Date('2026-08-23T12:00:03.000Z'),
      collectedAfter,
    )).toMatchObject({
      timestamp: '2026-08-23T12:00:03.000Z',
      rxPowerDbm: -12.01,
      txPowerDbm: 0.17,
      opticalLanes: expect.arrayContaining([expect.objectContaining({ lane: 3 })]),
    });
  });

  it('calculates scalar and per-lane avg/min/max inside a bucket', () => {
    const [result] = aggregateOpticalHistory([
      sample('2026-08-23T12:00:05.000Z', -12, 0.2, fourLanes()),
      sample('2026-08-23T12:00:45.000Z', -10, 0.6, fourLanes(2)),
    ], '1h');

    expect(result).toMatchObject({
      timestamp: '2026-08-23T12:00:00.000Z',
      sampleCount: 2,
      rxAvg: -11, rxMin: -12, rxMax: -10,
      txAvg: 0.4, txMin: 0.2, txMax: 0.6,
    });
    expect(result?.lanes[0]).toMatchObject({
      sampleCount: 2,
      rxAvg: -11, rxMin: -12, rxMax: -10,
      txMin: 0.2, txMax: 2.2,
    });
    expect(result?.lanes[0]?.txAvg).toBeCloseTo(1.2);
  });

  it('does not invent a missing lane in a collection', () => {
    const lanesWithoutTwo = fourLanes().filter((lane) => lane.lane !== 2);
    const [result] = aggregateOpticalHistory([
      sample('2026-08-23T12:00:05.000Z', -12, 0.2, fourLanes()),
      sample('2026-08-23T12:00:45.000Z', -10, 0.6, lanesWithoutTwo),
    ], '1h');

    expect(result?.lanes.find((lane) => lane.lane === 2)).toMatchObject({
      sampleCount: 1,
      rxAvg: -14,
      txAvg: 2.2,
    });
  });

  it('preserves empty time buckets instead of interpolating them', () => {
    const result = aggregateOpticalHistory([
      sample('2026-08-23T12:00:05.000Z', -12, 0.2),
      sample('2026-08-23T12:05:05.000Z', -10, 0.6),
    ], '1h');

    expect(result.map((point) => point.timestamp)).toEqual([
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:05:00.000Z',
    ]);
  });

  it.each<[HistoryPeriod, string]>([
    ['15m', '2026-08-23T12:07:31.000Z'],
    ['1h', '2026-08-23T12:07:00.000Z'],
    ['6h', '2026-08-23T12:05:00.000Z'],
    ['24h', '2026-08-23T12:00:00.000Z'],
    ['7d', '2026-08-23T12:00:00.000Z'],
  ])('uses the expected bucket scale for %s', (period, expectedTimestamp) => {
    const [result] = aggregateOpticalHistory([
      sample('2026-08-23T12:07:31.000Z', -12, 0.2),
    ], period);
    expect(result?.timestamp).toBe(expectedTimestamp);
  });
});
