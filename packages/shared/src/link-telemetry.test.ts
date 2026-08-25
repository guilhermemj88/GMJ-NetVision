import { describe, expect, it } from 'vitest';
import {
  automaticLinkCapacity,
  directionalLinkMetrics,
  linkStatusFromInterfaces,
  trafficConsistency,
} from './link-telemetry';
import type { NetworkInterface } from './types';

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
