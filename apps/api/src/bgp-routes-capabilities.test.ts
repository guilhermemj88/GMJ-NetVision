import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthUser } from '@gmj/shared';
import { registerBgpRoutes } from './bgp-routes';
import { BgpAdminService } from './infrastructure/bgp/bgp-admin-service';
import { InMemoryBgpAdminAuditRepository } from './infrastructure/bgp/bgp-admin-audit';
import { DemoBgpRepository } from './infrastructure/bgp/demo-bgp-repository';
import type { HuaweiBgpSshService } from './infrastructure/bgp/huawei-bgp-ssh';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { HuaweiBgpCollection } from './infrastructure/bgp/huawei-bgp-snmp';

const ADMIN: AuthUser = {
  id: 'u1',
  username: 'admin',
  email: 'admin@netvision.local',
  name: 'Administrador',
  role: 'ADMIN',
} as AuthUser;

function collection(peers: Array<{ peerAddress: string }>): HuaweiBgpCollection {
  return {
    collectedAt: new Date('2026-11-18T12:00:00.000Z'),
    errors: [],
    peers: peers.map((peer) => ({
      peerAddress: peer.peerAddress,
      addressFamily: peer.peerAddress.includes(':') ? ('IPV6' as const) : ('IPV4' as const),
      stateCode: 6,
      state: 'ESTABLISHED' as const,
      established: true,
      receivedPrefixes: 10,
    })),
  };
}

/**
 * M3: contrato observado pelo cliente HTTP. A matriz API/Web e exercitada no
 * servidor — a UI antiga (RC13) nao conhece `capabilities`, entao o servidor
 * precisa recusar sozinho a acao indevida.
 */
async function buildApp(): Promise<{
  app: FastifyInstance;
  applyAdminState: ReturnType<typeof vi.fn>;
}> {
  const repo = new DemoBgpRepository();
  repo.setDevice({ id: 'mx-1', hostname: 'MX204-EDGE', displayName: 'MX204 EDGE', bgpMonitoringEnabled: true });
  repo.setDevice({ id: 'ne8000-1', hostname: 'NE8000', displayName: 'NE8000', bgpMonitoringEnabled: true });
  await repo.saveCollection('mx-1', collection([{ peerAddress: '200.150.9.9' }]));
  await repo.saveCollection('ne8000-1', collection([{ peerAddress: '200.150.1.193' }]));
  repo.setPeerOptions('mx-1', '200.150.9.9', { remoteAs: 64500n });
  repo.setPeerOptions('ne8000-1', '200.150.1.193', { remoteAs: 12345n });
  await repo.saveDeviceLocalAs('mx-1', 64500n, new Date('2026-11-18T12:00:00.000Z'));
  await repo.saveDeviceLocalAs('ne8000-1', 268568n, new Date('2026-11-18T12:00:00.000Z'));

  const hosts = {
    getHost: vi.fn(async (id: string) =>
      id === 'mx-1'
        ? { id: 'mx-1', vendor: 'Juniper', model: 'MX204', sshEnabled: true, ssh: { host: '10.0.0.9', username: 'u' }, deviceType: 'router' }
        : { id: 'ne8000-1', vendor: 'Huawei', model: 'NE8000', sshEnabled: true, ssh: { host: '10.0.0.1', username: 'u' }, deviceType: 'router' },
    ),
  } as unknown as HostRepository;

  const applyAdminState = vi.fn().mockResolvedValue({ success: true, errorSafe: null });
  const readAdminState = vi.fn().mockResolvedValue({ state: 'IGNORED', source: 'CONFIGURATION' });
  const admin = new BgpAdminService({
    bgp: repo,
    hosts,
    ssh: { applyAdminState, readAdminState } as unknown as HuaweiBgpSshService,
    audit: new InMemoryBgpAdminAuditRepository(),
    now: () => new Date('2026-11-18T12:00:00.000Z'),
  });

  const app = Fastify();
  registerBgpRoutes(app, {
    bgp: repo,
    hosts,
    admin,
    currentUser: async () => ADMIN,
  });
  await app.ready();
  return { app, applyAdminState };
}

describe('M3 — contrato /api/bgp com capabilities (matriz API x Web)', () => {
  it('expoe capabilities por equipamento, com Juniper somente leitura', async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      devices: Array<{ id: string; capabilities: { adminActions: boolean; mitigation: boolean } }>;
    };
    const juniper = body.devices.find((device) => device.id === 'mx-1');
    const huawei = body.devices.find((device) => device.id === 'ne8000-1');
    expect(juniper?.capabilities).toMatchObject({ adminActions: false, mitigation: false });
    expect(huawei?.capabilities).toMatchObject({ adminActions: true, mitigation: true });
    await app.close();
  });

  it('recusa a acao administrativa no servidor mesmo se o cliente ignorar capabilities', async () => {
    const { app, applyAdminState } = await buildApp();
    const list = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = list.json() as {
      devices: Array<{ id: string; peers: Array<{ id: string; peerAddress: string }> }>;
    };
    const juniperPeer = body.devices.find((device) => device.id === 'mx-1')?.peers[0];
    expect(juniperPeer).toBeTruthy();

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/peers/${juniperPeer!.id}/admin-state`,
      payload: { action: 'DISABLE' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ message: expect.stringMatching(/Junos/) });
    expect(applyAdminState).not.toHaveBeenCalled();
    await app.close();
  });

  it('mantem a acao administrativa no Huawei (Web antiga + API nova)', async () => {
    const { app, applyAdminState } = await buildApp();
    const list = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = list.json() as {
      devices: Array<{ id: string; peers: Array<{ id: string }> }>;
    };
    const huaweiPeer = body.devices.find((device) => device.id === 'ne8000-1')?.peers[0];

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/peers/${huaweiPeer!.id}/admin-state`,
      payload: { action: 'DISABLE' },
    });

    expect(response.statusCode).toBe(200);
    expect(applyAdminState).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
