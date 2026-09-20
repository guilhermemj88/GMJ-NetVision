import { describe, expect, it } from 'vitest';
import { DemoBgpRepository } from './demo-bgp-repository';
import type { BgpDiscoveryPeerInput } from './bgp-repository';
import type { BgpPeerState } from './bgp4-peer-parser';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';

const deviceId = 'ne8000-1';
const peerAddress = '200.150.1.193';

function collection(
  stateCode: number,
  receivedPrefixes: number | null,
  collectedAt: string,
): HuaweiBgpCollection {
  const states: Record<number, BgpPeerState> = {
    1: 'IDLE',
    2: 'CONNECT',
    3: 'ACTIVE',
    4: 'OPENSENT',
    5: 'OPENCONFIRM',
    6: 'ESTABLISHED',
  };
  return {
    collectedAt: new Date(collectedAt),
    errors: [],
    peers: [
      {
        peerAddress,
        stateCode,
        state: states[stateCode] ?? 'UNKNOWN',
        established: stateCode === 6,
        receivedPrefixes,
      },
    ],
  };
}

function discovery(overrides: Partial<BgpDiscoveryPeerInput> = {}): BgpDiscoveryPeerInput {
  return {
    peerAddress,
    remoteAs: 64500n,
    stateCode: 6,
    state: 'ESTABLISHED',
    sessionUptimeSeconds: 3600,
    interfaceId: 'interface-1',
    correlationStatus: 'MATCHED',
    ...overrides,
  };
}

describe('DemoBgpRepository', () => {
  it('upserts a peer idempotently and keeps a sample for each monitored poll', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveCollection(deviceId, collection(6, 1_099_912, '2026-09-19T12:00:00.000Z'));
    await repository.saveCollection(deviceId, collection(6, 1_099_913, '2026-09-19T12:01:00.000Z'));

    expect(repository.listPeers()).toHaveLength(1);
    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      receivedPrefixes: 1_099_913n,
      state: 'ESTABLISHED',
      role: 'OTHER',
      monitoringEnabled: true,
    });
    expect(repository.samples).toHaveLength(2);
    expect(repository.stateEvents).toHaveLength(0);
  });

  it('persists prefixes only while BGP4-MIB state is ESTABLISHED', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveCollection(deviceId, collection(3, 0, '2026-09-19T12:00:00.000Z'));

    expect(repository.getPeer(deviceId, peerAddress)?.receivedPrefixes).toBeNull();
    expect(repository.samples[0]?.receivedPrefixes).toBeNull();
  });

  it('records one event per real state transition and manages establishedSince', async () => {
    const repository = new DemoBgpRepository();
    const first = new Date('2026-09-19T12:00:00.000Z');
    const down = new Date('2026-09-19T12:01:00.000Z');
    const reconnecting = new Date('2026-09-19T12:02:00.000Z');
    const restored = new Date('2026-09-19T12:03:00.000Z');

    await repository.saveCollection(deviceId, collection(6, 100, first.toISOString()));
    await repository.saveCollection(deviceId, collection(3, 100, down.toISOString()));
    await repository.saveCollection(deviceId, collection(2, 100, reconnecting.toISOString()));
    await repository.saveCollection(deviceId, collection(6, 200, restored.toISOString()));

    expect(repository.stateEvents).toEqual([
      expect.objectContaining({ previousStateCode: 6, currentStateCode: 3, occurredAt: down }),
      expect.objectContaining({
        previousStateCode: 3,
        currentStateCode: 2,
        occurredAt: reconnecting,
      }),
      expect.objectContaining({ previousStateCode: 2, currentStateCode: 6, occurredAt: restored }),
    ]);
    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      established: true,
      establishedSince: restored,
      lastStateChangedAt: restored,
      receivedPrefixes: 200n,
    });
  });

  it('does not create a transition event or change timestamps for an unchanged state', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveCollection(deviceId, collection(6, 100, '2026-09-19T12:00:00.000Z'));
    const establishedSince = repository.getPeer(deviceId, peerAddress)?.establishedSince;
    await repository.saveCollection(deviceId, collection(6, 101, '2026-09-19T12:01:00.000Z'));

    expect(repository.stateEvents).toHaveLength(0);
    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      establishedSince,
      lastStateChangedAt: null,
    });
  });

  it('updates current state but skips samples when monitoring is disabled', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveCollection(deviceId, collection(6, 100, '2026-09-19T12:00:00.000Z'));
    repository.setPeerOptions(deviceId, peerAddress, { monitoringEnabled: false });
    await repository.saveCollection(deviceId, collection(3, 100, '2026-09-19T12:01:00.000Z'));

    expect(repository.samples).toHaveLength(1);
    expect(repository.stateEvents).toHaveLength(1);
    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      stateCode: 3,
      established: false,
      receivedPrefixes: null,
      monitoringEnabled: false,
    });
  });

  it('enriches an SNMP peer via SSH without duplicates or overwriting user options', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveCollection(deviceId, collection(6, 100, '2026-09-19T12:00:00.000Z'));
    repository.setPeerOptions(deviceId, peerAddress, {
      role: 'UPSTREAM',
      monitoringEnabled: false,
    });
    await repository.saveDiscovery(deviceId, [discovery()], new Date('2026-09-19T12:10:00.000Z'));

    expect(repository.listPeers()).toHaveLength(1);
    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      remoteAs: 64500n,
      interfaceId: 'interface-1',
      role: 'UPSTREAM',
      monitoringEnabled: false,
      stateCode: 6,
    });
  });

  it('derives establishedSince from SSH uptime when discovery creates the peer', async () => {
    const repository = new DemoBgpRepository();
    const discoveredAt = new Date('2026-09-19T12:00:00.000Z');
    await repository.saveDiscovery(deviceId, [discovery()], discoveredAt);

    expect(repository.getPeer(deviceId, peerAddress)).toMatchObject({
      establishedSince: new Date('2026-09-19T11:00:00.000Z'),
      lastDiscoveryAt: discoveredAt,
    });
  });

  it('does not duplicate a peer when discovery is repeated', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveDiscovery(deviceId, [discovery()], new Date('2026-09-19T12:00:00.000Z'));
    await repository.saveDiscovery(
      deviceId,
      [discovery({ remoteAs: 64501n })],
      new Date('2026-09-19T12:01:00.000Z'),
    );

    expect(repository.listPeers()).toHaveLength(1);
    expect(repository.getPeer(deviceId, peerAddress)?.remoteAs).toBe(64501n);
  });

  it('clears an old interface after a conclusive but unsafe correlation', async () => {
    const repository = new DemoBgpRepository();
    const first = new Date('2026-09-19T12:00:00.000Z');
    await repository.saveDiscovery(deviceId, [discovery()], first);
    await repository.saveDiscovery(
      deviceId,
      [discovery({ interfaceId: null, correlationStatus: 'AMBIGUOUS' })],
      new Date('2026-09-19T12:01:00.000Z'),
    );

    expect(repository.getPeer(deviceId, peerAddress)?.interfaceId).toBeNull();
  });

  it('preserves an old interface when the route command itself failed', async () => {
    const repository = new DemoBgpRepository();
    await repository.saveDiscovery(deviceId, [discovery()], new Date('2026-09-19T12:00:00.000Z'));
    await repository.saveDiscovery(
      deviceId,
      [discovery({ interfaceId: null, correlationStatus: 'COMMAND_FAILED' })],
      new Date('2026-09-19T12:01:00.000Z'),
    );

    expect(repository.getPeer(deviceId, peerAddress)?.interfaceId).toBe('interface-1');
  });
});
