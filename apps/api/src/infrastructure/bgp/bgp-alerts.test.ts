import { describe, expect, it } from 'vitest';
import { computeBgpAlerts, type BgpAlertEventInput, type BgpAlertPeerInput } from './bgp-alerts';

function peer(overrides: Partial<BgpAlertPeerInput> = {}): BgpAlertPeerInput {
  return {
    id: 'p1',
    deviceId: 'd1',
    deviceName: 'NE-8K POP CENTRO',
    peerAddress: '200.150.1.193',
    displayName: 'TRANSITO XYZ',
    state: 'ESTABLISHED',
    established: true,
    lastStateChangedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<BgpAlertEventInput> = {}): BgpAlertEventInput {
  return {
    bgpPeerId: 'p1',
    previousState: 'ESTABLISHED',
    previousStateCode: 6,
    currentState: 'ACTIVE',
    currentStateCode: 3,
    occurredAt: new Date('2026-09-20T09:42:00.000Z'),
    ...overrides,
  };
}

const WINDOW = new Date(Date.parse('2026-09-20T12:00:00.000Z') - 48 * 60 * 60_000);

describe('computeBgpAlerts', () => {
  it('lists every currently down peer as active, regardless of age', () => {
    const down = peer({ established: false, state: 'ACTIVE', lastStateChangedAt: new Date('2026-09-17T00:00:00.000Z') });
    const result = computeBgpAlerts([down], [], WINDOW);
    expect(result.active).toHaveLength(1);
    expect(result.active[0]).toMatchObject({
      peerAddress: '200.150.1.193',
      currentState: 'ACTIVE',
      previousState: null,
      startedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(result.resolved).toHaveLength(0);
  });

  it('keeps a peer down for more than 48h in the active list', () => {
    const down = peer({
      established: false,
      state: 'ACTIVE',
      lastStateChangedAt: new Date(Date.parse('2026-09-20T12:00:00.000Z') - 72 * 60 * 60_000),
    });
    const result = computeBgpAlerts([down], [], WINDOW);
    expect(result.active).toHaveLength(1);
  });

  it('reports an ESTABLISHED to ACTIVE transition with its previous state', () => {
    const down = peer({
      established: false,
      state: 'ACTIVE',
      lastStateChangedAt: new Date('2026-09-20T09:42:00.000Z'),
    });
    const events = [event()];
    const result = computeBgpAlerts([down], events, WINDOW);
    expect(result.active[0]).toMatchObject({
      previousState: 'ESTABLISHED',
      currentState: 'ACTIVE',
      startedAt: '2026-09-20T09:42:00.000Z',
    });
  });

  it('reports an ACTIVE to ESTABLISHED resolution within 48h with duration', () => {
    const downAt = new Date('2026-09-20T10:13:00.000Z');
    const resolvedAt = new Date('2026-09-20T10:17:12.000Z');
    const events = [
      event({ previousState: 'ESTABLISHED', previousStateCode: 6, currentState: 'ACTIVE', currentStateCode: 3, occurredAt: downAt }),
      event({ previousState: 'ACTIVE', previousStateCode: 3, currentState: 'ESTABLISHED', currentStateCode: 6, occurredAt: resolvedAt }),
    ];
    const result = computeBgpAlerts([peer()], events, WINDOW);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      previousState: 'ACTIVE',
      currentState: 'ESTABLISHED',
      resolvedAt: resolvedAt.toISOString(),
      durationSeconds: 252,
    });
  });

  it('excludes resolutions older than the 48h window', () => {
    const oldResolvedAt = new Date(Date.parse('2026-09-20T12:00:00.000Z') - 48 * 60 * 60_000 - 1000);
    const events = [
      event({ previousState: 'ACTIVE', previousStateCode: 3, currentState: 'ESTABLISHED', currentStateCode: 6, occurredAt: oldResolvedAt }),
    ];
    const result = computeBgpAlerts([peer()], events, WINDOW);
    expect(result.resolved).toHaveLength(0);
  });

  it('does not invent a duration when the down transition is unknown', () => {
    const resolvedAt = new Date('2026-09-20T10:17:12.000Z');
    const events = [
      event({ previousState: 'ACTIVE', previousStateCode: 3, currentState: 'ESTABLISHED', currentStateCode: 6, occurredAt: resolvedAt }),
    ];
    const result = computeBgpAlerts([peer()], events, WINDOW);
    expect(result.resolved[0]!.durationSeconds).toBeNull();
    expect(result.resolved[0]!.startedAt).toBeNull();
  });

  it('ignores ESTABLISHED to ESTABLISHED and ESTABLISHED to DOWN self-transitions', () => {
    const events = [
      event({ previousState: 'ESTABLISHED', previousStateCode: 6, currentState: 'ESTABLISHED', currentStateCode: 6, occurredAt: new Date('2026-09-20T10:00:00.000Z') }),
    ];
    const result = computeBgpAlerts([], events, WINDOW);
    expect(result.resolved).toHaveLength(0);
  });
});
