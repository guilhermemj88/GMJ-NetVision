import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { makeHost } from '../../test-fixtures';
import { InMemoryBgpAdminAuditRepository } from './bgp-admin-audit';
import { BgpAdminActionError, BgpAdminService } from './bgp-admin-service';
import type { BgpDashboardPeer } from '@gmj/shared';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { HostRepository } from '../persistence/host-repository';
import { bgpCapabilitiesFor, bgpPlatformFor, isHuaweiVrpDevice } from './bgp-vendor';

function peer(overrides: Partial<BgpDashboardPeer> = {}): BgpDashboardPeer {
  return {
    id: 'peer-1',
    deviceId: 'host-1',
    deviceHostname: 'HOST-1',
    deviceDisplayName: 'HOST-1',
    bgpMonitoringEnabled: true,
    peerAddress: '10.200.200.10',
    displayName: null,
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
  } as BgpDashboardPeer;
}

function hostRecord(overrides: Partial<HostRecord> = {}): HostRecord {
  return makeHost({
    id: 'host-1',
    hostname: 'HOST-1',
    sshEnabled: true,
    ssh: {
      host: '10.0.0.1',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  });
}

function service(host: HostRecord) {
  const applyAdminState = vi
    .fn()
    .mockResolvedValue({ success: true, errorSafe: null } as never);
  const readAdminState = vi.fn().mockResolvedValue({ state: 'IGNORED', source: 'CONFIGURATION' });
  const audit = new InMemoryBgpAdminAuditRepository();
  return {
    applyAdminState,
    audit,
    admin: new BgpAdminService({
      bgp: {
        getPeerDetail: vi.fn().mockResolvedValue(peer()),
        getDeviceLocalAs: vi.fn().mockResolvedValue(268568n),
        setPeerAdminState: vi.fn(),
      } as unknown as BgpRepository,
      hosts: { getHost: vi.fn().mockResolvedValue(host) } as unknown as HostRepository,
      ssh: { applyAdminState, readAdminState } as unknown as HuaweiBgpSshService,
      audit,
      now: () => new Date('2026-11-18T12:00:00.000Z'),
    }),
  };
}

const ADMIN = { id: 'u1', username: 'admin', email: 'a@b.c', name: 'Admin', role: 'ADMIN' } as const;

describe('M2 — identificacao de plataforma', () => {
  it('vendor ausente, desconhecido ou contraditorio resulta em UNSUPPORTED', () => {
    expect(bgpPlatformFor('', '')).toBe('UNSUPPORTED');
    expect(bgpPlatformFor(null, null)).toBe('UNSUPPORTED');
    expect(bgpPlatformFor(null, 'MX204')).toBe('UNSUPPORTED');
    expect(bgpPlatformFor('ZTE', 'C320')).toBe('UNSUPPORTED');
    expect(bgpPlatformFor('Huawei', 'MX204')).toBe('UNSUPPORTED');
    expect(bgpPlatformFor('Juniper', 'NE8000')).toBe('UNSUPPORTED');
  });

  it('Huawei valido continua reconhecido', () => {
    expect(bgpPlatformFor('Huawei', 'S6730-H48X6C')).toBe('HUAWEI_VRP');
    expect(bgpPlatformFor('HUAWEI', 'NE40E-X8A')).toBe('HUAWEI_VRP');
    expect(bgpPlatformFor('Huawei Technologies', 'CE6865')).toBe('HUAWEI_VRP');
    expect(bgpCapabilitiesFor('Huawei', 'S6730-H48X6C').adminActions).toBe(true);
  });

  it('isHuaweiVrpDevice exclui OLT e modelo nao-VRP', () => {
    expect(isHuaweiVrpDevice({ vendor: 'Huawei', model: 'S6730' })).toBe(true);
    expect(isHuaweiVrpDevice({ vendor: 'Huawei', model: 'S6730', deviceType: 'olt' })).toBe(false);
    expect(isHuaweiVrpDevice({ vendor: 'Huawei', model: 'MA5800-X7' })).toBe(false);
    expect(isHuaweiVrpDevice({ vendor: '', model: '' })).toBe(false);
  });
});

describe('M2 — administracao BGP fail-closed', () => {
  it('bloqueia acao administrativa quando o fabricante nao foi identificado', async () => {
    const { admin, applyAdminState, audit } = service(hostRecord({ vendor: '', model: '' }));

    const failure = await admin.execute({ peerId: 'peer-1', action: 'DISABLE', user: ADMIN }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BgpAdminActionError);
    expect((failure as BgpAdminActionError).statusCode).toBe(409);
    expect((failure as BgpAdminActionError).message).toMatch(/não identificada/);
    expect(applyAdminState).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([]);
  });

  it('bloqueia quando fabricante e modelo se contradizem', async () => {
    const { admin, applyAdminState } = service(
      hostRecord({ vendor: 'Huawei', model: 'MX204' }),
    );

    await expect(
      admin.execute({ peerId: 'peer-1', action: 'DISABLE', user: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(applyAdminState).not.toHaveBeenCalled();
  });

  it('mantem a administracao normal no Huawei VRP', async () => {
    const { admin, applyAdminState } = service(
      hostRecord({ vendor: 'Huawei', model: 'S6730-H48X6C' }),
    );

    const result = await admin.execute({ peerId: 'peer-1', action: 'DISABLE', user: ADMIN });

    expect(result.success).toBe(true);
    expect(applyAdminState).toHaveBeenCalledTimes(1);
  });
});
