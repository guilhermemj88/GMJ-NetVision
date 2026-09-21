import { describe, expect, it, vi } from 'vitest';
import type { BgpDashboardPeer, HostRecord } from '@gmj/shared';
import { makeHost } from '../../test-fixtures';
import { InMemoryBgpAdminAuditRepository } from './bgp-admin-audit';
import { BgpAdminActionError, BgpAdminService } from './bgp-admin-service';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { HostRepository } from '../persistence/host-repository';

function peer(overrides: Partial<BgpDashboardPeer> = {}): BgpDashboardPeer {
  return {
    id: 'peer-1',
    deviceId: 'ne8000-1',
    deviceHostname: 'NE-8000-1',
    deviceDisplayName: 'NE-8K POP CENTRO',
    bgpMonitoringEnabled: true,
    peerAddress: '10.200.200.10',
    displayName: 'CLIENTE XPTO',
    addressFamily: 'IPV4',
    localAs: '268568',
    remoteAs: '265424',
    role: 'OTHER',
    monitoringEnabled: true,
    stateCode: 6,
    state: 'ESTABLISHED',
    established: true,
    adminState: 'UNKNOWN',
    adminStateCheckedAt: null,
    receivedPrefixes: 10,
    establishedSince: null,
    lastPollingAt: null,
    lastDiscoveryAt: null,
    interface: null,
    ...overrides,
  };
}

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return makeHost({
    id: 'ne8000-1',
    hostname: 'NE-8000-1',
    sshEnabled: true,
    ssh: {
      host: '172.16.0.1',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
    },
    ...overrides,
  });
}

interface Harness {
  service: BgpAdminService;
  audit: InMemoryBgpAdminAuditRepository;
  applyAdminState: ReturnType<typeof vi.fn>;
  readAdminState: ReturnType<typeof vi.fn>;
  setPeerAdminState: ReturnType<typeof vi.fn>;
}

function harness(options: {
  peer?: BgpDashboardPeer;
  hostRecord?: HostRecord;
  localAs?: bigint | null;
  apply?: { success: boolean; errorSafe: string | null };
  read?: { state: 'IGNORED' | 'ENABLED' | 'UNKNOWN'; source: 'CONFIGURATION' | 'PEER_STATE' | null };
} = {}): Harness {
  const applyAdminState = vi.fn().mockResolvedValue(
    options.apply ?? { success: true, errorSafe: null },
  );
  const readAdminState = vi
    .fn()
    .mockResolvedValue(options.read ?? { state: 'IGNORED', source: 'CONFIGURATION' });
  const setPeerAdminState = vi.fn().mockResolvedValue(undefined);
  const bgp = {
    getPeerDetail: vi.fn().mockResolvedValue(options.peer ?? peer()),
    getDeviceLocalAs: vi.fn().mockResolvedValue(options.localAs === undefined ? 268568n : options.localAs),
    setPeerAdminState,
  } as unknown as BgpRepository;
  const hosts = {
    getHost: vi.fn().mockResolvedValue(options.hostRecord ?? host()),
  } as unknown as HostRepository;
  const audit = new InMemoryBgpAdminAuditRepository();
  const service = new BgpAdminService({
    bgp,
    hosts,
    ssh: { applyAdminState, readAdminState } as unknown as HuaweiBgpSshService,
    audit,
    now: () => new Date('2026-09-21T10:00:00.000Z'),
  });
  return { service, audit, applyAdminState, readAdminState, setPeerAdminState };
}

const admin = {
  id: 'user-1',
  username: 'admin',
  email: 'admin@netvision.local',
  name: 'Administrador',
  role: 'ADMIN' as const,
};

describe('BGP admin service', () => {
  it('resolves the peer, the device and the persisted local AS from the peerId', async () => {
    const { service, applyAdminState, audit } = harness();

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(applyAdminState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ne8000-1' }),
      { peerAddress: '10.200.200.10', localAs: 268568n, action: 'DISABLE' },
    );
    expect(result).toMatchObject({
      peerId: 'peer-1',
      deviceId: 'ne8000-1',
      peerAddress: '10.200.200.10',
      addressFamily: 'IPV4',
      action: 'DISABLE',
      success: true,
      adminState: 'IGNORED',
      verified: true,
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        peerId: 'peer-1',
        deviceId: 'ne8000-1',
        username: 'admin',
        userId: 'user-1',
        action: 'DISABLE',
        success: true,
        verified: true,
        errorSafe: null,
        localAs: 268568n,
        remoteAs: 265424n,
        addressFamily: 'IPV4',
      }),
    ]);
  });

  it('generates the enable flow and confirms ENABLED by read-back', async () => {
    const { service, applyAdminState } = harness({
      read: { state: 'ENABLED', source: 'CONFIGURATION' },
    });

    const result = await service.execute({ peerId: 'peer-1', action: 'ENABLE', user: admin });

    expect(applyAdminState).toHaveBeenCalledWith(expect.anything(), {
      peerAddress: '10.200.200.10',
      localAs: 268568n,
      action: 'ENABLE',
    });
    expect(result).toMatchObject({ success: true, adminState: 'ENABLED', verified: true });
  });

  it('keeps the IPv6 peer address and family untouched', async () => {
    const { service, applyAdminState, readAdminState } = harness({
      peer: peer({ peerAddress: '2001:db8::10', addressFamily: 'IPV6' }),
      read: { state: 'IGNORED', source: 'PEER_STATE' },
    });

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(applyAdminState).toHaveBeenCalledWith(expect.anything(), {
      peerAddress: '2001:db8::10',
      localAs: 268568n,
      action: 'DISABLE',
    });
    expect(readAdminState).toHaveBeenCalledWith(expect.anything(), {
      peerAddress: '2001:db8::10',
      addressFamily: 'IPV6',
    });
    expect(result).toMatchObject({ addressFamily: 'IPV6', success: true, adminState: 'IGNORED' });
  });

  it('blocks the action when the local ASN was never identified', async () => {
    const { service, applyAdminState } = harness({ localAs: null });

    await expect(
      service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('ASN local do processo BGP ainda não foi identificado'),
    });
    expect(applyAdminState).not.toHaveBeenCalled();
  });

  it('blocks the action when SSH is not enabled for the device', async () => {
    const { service, applyAdminState } = harness({
      hostRecord: host({ sshEnabled: false, ssh: null }),
    });

    await expect(
      service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin }),
    ).rejects.toBeInstanceOf(BgpAdminActionError);
    expect(applyAdminState).not.toHaveBeenCalled();
  });

  it('blocks the action when the persisted address does not match its family', async () => {
    const { service, applyAdminState } = harness({
      peer: peer({ peerAddress: '999.1.1.1' }),
    });

    await expect(
      service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(applyAdminState).not.toHaveBeenCalled();
  });

  it('never reports success when the SSH command fails', async () => {
    const { service, setPeerAdminState, audit } = harness({
      apply: { success: false, errorSafe: 'SSH command failed' },
      read: { state: 'UNKNOWN', source: null },
    });

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(setPeerAdminState).not.toHaveBeenCalled();
    expect(audit.entries[0]).toMatchObject({ success: false, errorSafe: 'SSH command failed' });
  });

  it('does not report success when the commit fails even if the read-back shows the new state', async () => {
    const { service } = harness({ apply: { success: false, errorSafe: 'SSH command failed' } });

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(result.success).toBe(false);
    expect(result.adminState).toBe('IGNORED');
    expect(result.message).toContain('read-back');
  });

  it('requires the read-back before persisting the administrative state', async () => {
    const { service, setPeerAdminState, audit } = harness({
      read: { state: 'UNKNOWN', source: null },
    });

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(setPeerAdminState).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, verified: false, adminState: 'UNKNOWN' });
    expect(audit.entries[0]).toMatchObject({ verified: false, success: false });
  });

  it('does not flip the admin state when the read-back contradicts the action', async () => {
    const { service, setPeerAdminState } = harness({
      read: { state: 'ENABLED', source: 'CONFIGURATION' },
    });

    const result = await service.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(setPeerAdminState).toHaveBeenCalledWith(
      'peer-1',
      'ENABLED',
      new Date('2026-09-21T10:00:00.000Z'),
    );
    expect(result).toMatchObject({ success: false, adminState: 'ENABLED', verified: true });
  });

  it('sanitizes SSH transport errors and keeps the audit free of credentials', async () => {
    const { service, audit } = harness();
    const failing = new BgpAdminService({
      bgp: {
        getPeerDetail: vi.fn().mockResolvedValue(peer()),
        getDeviceLocalAs: vi.fn().mockResolvedValue(268568n),
        setPeerAdminState: vi.fn(),
      } as unknown as BgpRepository,
      hosts: { getHost: vi.fn().mockResolvedValue(host()) } as unknown as HostRepository,
      ssh: {
        applyAdminState: vi.fn().mockRejectedValue(new Error('SSH authentication failed')),
        readAdminState: vi.fn().mockResolvedValue({ state: 'UNKNOWN', source: null }),
      } as unknown as HuaweiBgpSshService,
      audit,
    });

    const result = await failing.execute({ peerId: 'peer-1', action: 'DISABLE', user: admin });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/password|credential|switch virtual-system/i);
    expect(audit.entries[0]?.errorSafe).toBe('SSH authentication failed');
    expect(service).toBeDefined();
  });

  it('returns 404 for an unknown peer', async () => {
    const { service } = harness();
    const missing = new BgpAdminService({
      bgp: {
        getPeerDetail: vi.fn().mockResolvedValue(null),
        getDeviceLocalAs: vi.fn(),
        setPeerAdminState: vi.fn(),
      } as unknown as BgpRepository,
      hosts: { getHost: vi.fn() } as unknown as HostRepository,
      ssh: {} as HuaweiBgpSshService,
      audit: new InMemoryBgpAdminAuditRepository(),
    });

    await expect(
      missing.execute({ peerId: 'missing', action: 'DISABLE', user: admin }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(service).toBeDefined();
  });
});
