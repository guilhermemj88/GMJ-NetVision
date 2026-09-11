import { describe, expect, it, vi } from 'vitest';
import {
  automaticLinkCapacity,
  aggregateLinkMetrics,
  linkStatusFromInterfaceGroups,
  singleEndedMonitoredSide,
  directionalLinkMetrics,
  linkStatusFromInterfaces,
  trafficConsistency,
} from './link-telemetry';
import type { NetworkInterface, NetworkLink } from './types';

function networkInterface(id: string, partial: Partial<NetworkInterface> = {}): NetworkInterface {
  return {
    id,
    deviceId: `${id}-device`,
    name: id,
    alias: '',
    description: '',
    ifIndex: 1,
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
    telemetryAvailable: true,
    ...partial,
  };
}

describe.each(['SOURCE', 'TARGET'] as const)('SINGLE_ENDED with %s monitored and a conceptual endpoint', (side) => {
  const monitored = networkInterface('real', { deviceId: 'device', rxBps: 2000, txBps: 5000, rxErrors: 2, txErrors: 3 });
  const link = {
    sourceDeviceId: side === 'SOURCE' ? 'device' : null,
    targetDeviceId: side === 'TARGET' ? 'device' : null,
    sourceNodeId: side === 'TARGET' ? 'carrier' : null,
    targetNodeId: side === 'SOURCE' ? 'carrier' : null,
    sourceInterfaceId: side === 'SOURCE' ? 'real' : null,
    targetInterfaceId: side === 'TARGET' ? 'real' : null,
    trafficMode: 'SINGLE_ENDED' as const,
    aggregationMode: 'NONE' as const,
    metricSources: [], capacityBps: 10000,
  };

  it.each(['UP', 'DOWN', 'DISABLED', 'UNKNOWN'] as const)('derives %s only from the monitored interface', (operStatus) => {
    const real = { ...monitored, operStatus };
    const resolve = vi.fn((_deviceId, interfaceId) => interfaceId === 'real' ? real : undefined);
    const metrics = aggregateLinkMetrics(link, resolve);
    const status = operStatus === 'DISABLED' ? 'DOWN' : operStatus;
    expect(metrics.status).toBe(status);
    expect(linkStatusFromInterfaces(side === 'SOURCE' ? real : undefined, side === 'TARGET' ? real : undefined, 'SINGLE_ENDED')).toBe(status);
    expect(linkStatusFromInterfaceGroups(side === 'SOURCE' ? [real] : [], side === 'TARGET' ? [real] : [], 'SINGLE_ENDED')).toBe(status);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('device', 'real');
    expect(metrics).toMatchObject({ rxBps: 2000, txBps: 5000, rxErrors: 2, txErrors: 3 });
    expect(metrics.directions.A_TO_B).toMatchObject(side === 'SOURCE'
      ? { bps: 5000, txBps: 5000, observedRxBps: null }
      : { bps: 2000, txBps: null, observedRxBps: 2000 });
    expect(metrics.directions.B_TO_A).toMatchObject(side === 'SOURCE'
      ? { bps: 2000, txBps: null, observedRxBps: 2000 }
      : { bps: 5000, txBps: 5000, observedRxBps: null });
  });

  it('keeps SUM on one side, including links without a reference interface', () => {
    const sum = { ...link, sourceInterfaceId: null, targetInterfaceId: null, aggregationMode: 'SUM' as const,
      metricSources: [{ interfaceId: 'real', side }, { interfaceId: 'second', side }] };
    const metrics = aggregateLinkMetrics(sum, (_deviceId, id) => id ? monitored : undefined);
    expect(singleEndedMonitoredSide(sum)).toBe(side);
    expect(metrics).toMatchObject({ status: 'UP', rxBps: 4000, txBps: 10000, rxErrors: 4, txErrors: 6 });
    expect(metrics.directions.A_TO_B.bps).toBe(side === 'SOURCE' ? 10000 : 4000);
    expect(metrics.directions.B_TO_A.bps).toBe(side === 'SOURCE' ? 4000 : 10000);
  });

  it.each(['NONE', 'SUM'] as const)('ignores stale interface references on the generic side in %s', (aggregationMode) => {
    const conceptual = side === 'SOURCE' ? 'TARGET' : 'SOURCE';
    const edited = { ...link, aggregationMode,
      ...(side === 'SOURCE' ? { targetInterfaceId: 'stale' } : { sourceInterfaceId: 'stale' }),
      metricSources: [{ side, interfaceId: 'real' }, { side: conceptual as 'SOURCE' | 'TARGET', interfaceId: 'stale' }] };
    const resolve = vi.fn((_deviceId, id) => id === 'stale' ? { ...monitored, operStatus: 'DOWN' as const } : monitored);
    expect(singleEndedMonitoredSide(edited)).toBe(side);
    expect(aggregateLinkMetrics(edited, resolve)).toMatchObject({ status: 'UP', rxBps: 2000, txBps: 5000 });
    expect(resolve.mock.calls.every(([, id]) => id !== 'stale')).toBe(true);
  });

  it('returns UNKNOWN with unavailable interface and does not invent telemetry', () => {
    expect(aggregateLinkMetrics(link, () => undefined)).toMatchObject({ status: 'UNKNOWN', rxBps: 0, txBps: 0 });
    const metrics = aggregateLinkMetrics(link, () => ({ ...monitored, telemetryAvailable: false }));
    expect(metrics).toMatchObject({ status: 'UP', rxBps: 0, txBps: 0 });
    expect(metrics.directions.A_TO_B).toMatchObject({ txBps: null, observedRxBps: null });
  });
});

describe('aggregate bidirectional compatibility', () => {
  it.each(['NONE', 'SUM'] as const)('continues considering both sides in %s', (aggregationMode) => {
    const link = { sourceDeviceId: 'a', targetDeviceId: 'b', sourceInterfaceId: 'a', targetInterfaceId: 'b',
      aggregationMode, metricSources: [], trafficMode: 'BIDIRECTIONAL' as const, capacityBps: 10000 };
    const a = networkInterface('a', { rxBps: 2000, txBps: 5000 });
    const b = networkInterface('b', { rxBps: 4800, txBps: 1900 });
    const metrics = aggregateLinkMetrics(link, (_deviceId, id) => id === 'a' ? a : b);
    expect(metrics.status).toBe('UP');
    expect(metrics.directions).toEqual(directionalLinkMetrics(a, b, link.capacityBps));
    for (const status of ['DOWN', 'DISABLED', 'UNKNOWN'] as NetworkInterface['operStatus'][]) {
      expect(aggregateLinkMetrics(link, (_deviceId, id) => id === 'a' ? a : { ...b, operStatus: status }).status)
        .toBe(status === 'DISABLED' ? 'DOWN' : status as NetworkLink['status']);
    }
  });
});

describe('bidirectional link telemetry', () => {
  it('uses A TX for A -> B and validates it against B RX', () => {
    const source = networkInterface('a', { txBps: 9_100_000_000, rxBps: 2_000_000_000 });
    const target = networkInterface('b', { rxBps: 9_000_000_000, txBps: 3_000_000_000 });
    const directions = directionalLinkMetrics(source, target, 100_000_000_000);

    expect(directions.A_TO_B).toMatchObject({
      bps: 9_100_000_000,
      txBps: 9_100_000_000,
      observedRxBps: 9_000_000_000,
      consistency: 'CONSISTENT',
    });
    expect(directions.A_TO_B.deltaPercent).toBeCloseTo(1.0989, 3);
    expect(directions.B_TO_A.bps).toBe(3_000_000_000);
    expect(directions.B_TO_A.observedRxBps).toBe(2_000_000_000);
  });

  it('marks traffic above the tolerance as divergent without changing link status', () => {
    const source = networkInterface('a', { txBps: 9_100_000_000 });
    const target = networkInterface('b', { rxBps: 4_000_000_000 });

    expect(directionalLinkMetrics(source, target, 100_000_000_000).A_TO_B.consistency).toBe(
      'DIVERGENT',
    );
    expect(linkStatusFromInterfaces(source, target)).toBe('UP');
  });

  it('falls back to the known source side and does not flag missing telemetry', () => {
    const source = networkInterface('a', { rxBps: 2_000, txBps: 3_000 });
    const directions = directionalLinkMetrics(source, undefined, 10_000);

    expect(directions.A_TO_B).toMatchObject({
      bps: 3_000,
      txBps: 3_000,
      observedRxBps: null,
      deltaPercent: null,
      consistency: 'UNKNOWN',
    });
    expect(directions.B_TO_A).toMatchObject({
      bps: 2_000,
      txBps: null,
      observedRxBps: 2_000,
      consistency: 'UNKNOWN',
    });
  });

  it('keeps DOWN, UP and missing-data status semantics', () => {
    const up = networkInterface('up');
    const down = networkInterface('down', { operStatus: 'DOWN' });
    const disabled = networkInterface('disabled', { operStatus: 'DISABLED' });

    expect(linkStatusFromInterfaces(up, up)).toBe('UP');
    expect(linkStatusFromInterfaces(up, down)).toBe('DOWN');
    expect(linkStatusFromInterfaces(up, disabled)).toBe('DOWN');
    expect(linkStatusFromInterfaces(up, undefined)).toBe('UNKNOWN');
    expect(linkStatusFromInterfaces(undefined, undefined)).toBe('UNKNOWN');
  });

  it('handles zero traffic without division by zero', () => {
    expect(trafficConsistency(0, 0)).toEqual({
      deltaPercent: 0,
      consistency: 'CONSISTENT',
    });
  });

  it('uses only the monitored source interface for single-ended traffic and status', () => {
    const source = networkInterface('a', {
      speedBps: 40_000_000_000,
      rxBps: 2_000,
      txBps: 3_000,
    });
    const directions = directionalLinkMetrics(source, undefined, 40_000_000_000, 'SINGLE_ENDED');

    expect(directions.A_TO_B).toMatchObject({
      bps: 3_000,
      txBps: 3_000,
      observedRxBps: null,
      consistency: 'UNKNOWN',
    });
    expect(directions.B_TO_A).toMatchObject({
      bps: 2_000,
      txBps: null,
      observedRxBps: 2_000,
      consistency: 'UNKNOWN',
    });
    expect(linkStatusFromInterfaces(source, undefined, 'SINGLE_ENDED')).toBe('UP');
    expect(automaticLinkCapacity(source, undefined, 'SINGLE_ENDED', 1)).toBe(40_000_000_000);
  });

  it('uses only the monitored target interface for single-ended traffic and status', () => {
    const target = networkInterface('b', {
      speedBps: 10_000_000_000,
      rxBps: 5_000,
      txBps: 7_000,
      operStatus: 'DOWN',
    });
    const directions = directionalLinkMetrics(undefined, target, 10_000_000_000, 'SINGLE_ENDED');

    expect(directions.A_TO_B).toMatchObject({ bps: 5_000, txBps: null, observedRxBps: 5_000 });
    expect(directions.B_TO_A).toMatchObject({ bps: 7_000, txBps: 7_000, observedRxBps: null });
    expect(linkStatusFromInterfaces(undefined, target, 'SINGLE_ENDED')).toBe('DOWN');
    expect(automaticLinkCapacity(undefined, target, 'SINGLE_ENDED', 1)).toBe(10_000_000_000);
  });

  it('keeps the minimum endpoint speed for bidirectional AUTO capacity', () => {
    const source = networkInterface('a', { speedBps: 100_000_000_000 });
    const target = networkInterface('b', { speedBps: 40_000_000_000 });

    expect(automaticLinkCapacity(source, target, 'BIDIRECTIONAL', 1)).toBe(40_000_000_000);
  });
});
