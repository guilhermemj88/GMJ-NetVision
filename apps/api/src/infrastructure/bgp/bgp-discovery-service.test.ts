import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, NetworkInterface } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import { makeHost, makeInterface } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { BgpDiscoveryService } from './bgp-discovery-service';
import type { BgpRepository } from './bgp-repository';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';

function host(interfaces: NetworkInterface[] = []): HostRecord {
  return makeHost({
    id: 'ne8000-1',
    hostname: 'NE-8K POP CENTRO',
    vendor: 'Huawei',
    interfaces,
    sshEnabled: true,
    ssh: {
      host: '172.16.0.1',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
  });
}

function networkInterface(): NetworkInterface {
  return makeInterface({
    id: 'abc123',
    deviceId: 'ne8000-1',
    name: '100GE1/0/3',
    alias: 'TRANSITO XYZ',
    description: 'UPSTREAM TRANSITO XYZ',
    ifIndex: 103,
  });
}

function repository(): HostRepository {
  return {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'protected-password' }),
  } as unknown as HostRepository;
}

function bgpRepository(): BgpRepository {
  return {
    saveCollection: vi.fn(),
    saveDiscovery: vi.fn(),
    saveDeviceLocalAs: vi.fn(),
    getDeviceLocalAs: vi.fn().mockResolvedValue(null),
    setPeerAdminState: vi.fn(),
    listDashboardPeers: vi.fn(),
    getPeerDetail: vi.fn(),
    getPeerHistory: vi.fn(),
    listAlerts: vi.fn().mockResolvedValue({ active: [], resolved: [] }),
  };
}

const BGP_CONFIG = `
#
bgp 268568
 router-id 45.163.144.1
 peer 10.200.200.10 as-number 265424
#
return
`;

/** Responds per last command; null emulates an unsupported command. */
function simulator(responses: Record<string, string | null>, fallback = 'Summary Count : 0') {
  return vi.fn(async (_host: string, commands: string[]) => {
    const command = commands.at(-1) ?? '';
    const response = command in responses ? responses[command] : fallback;
    return [
      {
        stdout: response ?? "Error: Unrecognized command found at '^' position.",
        stderr: '',
        exitCode: 0,
      },
    ];
  });
}

function sshWith(execute: ReturnType<typeof vi.fn>): HuaweiBgpSshService {
  return new HuaweiBgpSshService(repository(), () => ({ execute } as unknown as SshClient));
}

describe('BGP SSH discovery service', () => {
  it('discovers, correlates and names a peer without unnecessary verbose', async () => {
    const execute = simulator({
      'display current-configuration configuration bgp': BGP_CONFIG,
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
      'display ip routing-table 200.150.1.193': `Summary Count : 1
200.150.1.192/30 Direct 0 0 D 200.150.1.194 HundredGigabitEthernet 1/0/3`,
    });

    const persistence = bgpRepository();
    const discoveredAt = new Date('2026-09-19T12:00:00.000Z');
    const result = await new BgpDiscoveryService(sshWith(execute), persistence, () => discoveredAt).discover(
      host([networkInterface()]),
    );

    expect(result.peers).toEqual([
      expect.objectContaining({
        peerAddress: '200.150.1.193',
        addressFamily: 'IPV4',
        remoteAs: 12345n,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 1569600,
        cliReceivedPrefixes: 1099912n,
        interfaceId: 'abc123',
        displayName: 'TRANSITO XYZ',
        correlationStatus: 'MATCHED',
      }),
    ]);
    expect(result.localAs).toBe(268568n);
    expect(persistence.saveDeviceLocalAs).toHaveBeenCalledWith('ne8000-1', 268568n, discoveredAt);
    expect(persistence.saveDiscovery).toHaveBeenCalledWith('ne8000-1', result.peers, discoveredAt);
    expect(execute.mock.calls.flatMap((call) => call[1])).not.toContain('display bgp peer verbose');
  });

  it('uses verbose once only when an established summary peer lacks uptime', async () => {
    const execute = simulator({
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 - Established',
      'display bgp peer verbose': `BGP Peer is 200.150.1.193, remote AS 12345
BGP current state: Established, Up for 1d02h
Prefixes current: 1099912`,
    });

    const result = await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(host());

    expect(result.peers[0]).toMatchObject({
      sessionUptimeSeconds: 93600,
      cliReceivedPrefixes: 1099912n,
      correlationStatus: 'NO_ROUTE',
    });
    expect(
      execute.mock.calls.filter((call) => call[1][1] === 'display bgp peer verbose'),
    ).toHaveLength(1);
  });

  it('returns COMMAND_FAILED with a safe message when a route lookup times out', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => {
      if ((commands.at(-1) ?? '') === 'display bgp peer') {
        return [
          {
            stdout: '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
            stderr: '',
            exitCode: 0,
          },
        ];
      }
      throw new Error('timeout containing protected-password');
    });

    const result = await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(host());

    expect(result.peers[0]).toMatchObject({
      interfaceId: null,
      displayName: '200.150.1.193',
      correlationStatus: 'COMMAND_FAILED',
      correlationError: 'SSH connection timeout',
    });
    expect(result.peers[0]?.correlationError).not.toContain('protected-password');
  });

  it('runs manual discovery even when bgpMonitoringEnabled is false', async () => {
    const execute = simulator({
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
    });
    const persistence = bgpRepository();
    const device = host();
    device.bgpMonitoringEnabled = false;

    const result = await new BgpDiscoveryService(sshWith(execute), persistence).discover(device);

    expect(result.peers).toHaveLength(1);
    expect(persistence.saveDiscovery).toHaveBeenCalledWith(
      'ne8000-1',
      result.peers,
      expect.any(Date),
    );
  });

  it('does not change bgpMonitoringEnabled during manual discovery', async () => {
    const execute = simulator({});
    const device = host();
    device.bgpMonitoringEnabled = false;

    await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(device);

    expect(device.bgpMonitoringEnabled).toBe(false);
  });

  it('prioritizes the BGP peer description from verbose over the interface alias', async () => {
    const execute = simulator({
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 - Established',
      'display bgp peer verbose': `BGP Peer is 200.150.1.193, remote AS 12345
Peer Description: TRANSITO LEVEL3
BGP current state: Established, Up for 18d04h
Prefixes current: 1099912`,
    });

    const result = await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(
      host([networkInterface()]),
    );

    expect(result.peers[0]).toMatchObject({
      bgpPeerDescription: 'TRANSITO LEVEL3',
      displayName: 'TRANSITO LEVEL3',
    });
  });

  it('learns the local AS of another operator without reusing the peer remote AS', async () => {
    const execute = simulator({
      'display current-configuration configuration bgp': 'bgp 273003\n router-id 10.0.0.1',
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 18d04h Established 10',
    });
    const persistence = bgpRepository();

    const result = await new BgpDiscoveryService(sshWith(execute), persistence).discover(
      host([networkInterface()]),
    );

    expect(result.localAs).toBe(273003n);
    expect(result.peers[0]?.remoteAs).toBe(12345n);
    expect(persistence.saveDeviceLocalAs).toHaveBeenCalledWith(
      'ne8000-1',
      273003n,
      expect.any(Date),
    );
  });

  it('never erases a persisted local AS when discovery cannot read it', async () => {
    const execute = simulator({ 'display current-configuration configuration bgp': null });
    const persistence = bgpRepository();

    const result = await new BgpDiscoveryService(sshWith(execute), persistence).discover(host());

    expect(result.localAs).toBeNull();
    expect(persistence.saveDeviceLocalAs).not.toHaveBeenCalled();
  });

  it('does not persist an ambiguous local AS when the context exposes two BGP processes', async () => {
    const execute = simulator({
      'display current-configuration configuration bgp':
        'bgp 268568\n router-id 1.1.1.1\nbgp 273003\n router-id 2.2.2.2',
    });
    const persistence = bgpRepository();

    const result = await new BgpDiscoveryService(sshWith(execute), persistence).discover(host());

    expect(result.localAs).toBeNull();
    expect(result.localAsAmbiguous).toBe(true);
    expect(persistence.saveDeviceLocalAs).not.toHaveBeenCalled();
  });

  it('learns the local AS inside the configured SSH context', async () => {
    const execute = simulator({
      'display current-configuration configuration bgp': BGP_CONFIG,
      'display bgp peer': '10.200.200.10 4 265424 10 10 0 18d04h Established 100',
    });
    const factory = vi.fn(() => ({ execute } as unknown as SshClient));
    const ssh = new HuaweiBgpSshService(repository(), factory);
    const device = host();
    device.ssh = { ...device.ssh!, contextCommand: 'switch virtual-system IMPLANTAR-IXBR' };

    const result = await new BgpDiscoveryService(ssh, bgpRepository()).discover(device);

    expect(result.localAs).toBe(268568n);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ contextCommand: 'switch virtual-system IMPLANTAR-IXBR' }),
    );
  });

  it('discovers IPv4 and IPv6 peers together using per-family commands', async () => {
    const execute = simulator({
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
      'display bgp ipv6 peer': '2001:0DB8:0:0::1 4 65001 12 12 0 1d02h Established 42',
    });

    const result = await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(host());

    expect(result.peers).toEqual([
      expect.objectContaining({ peerAddress: '200.150.1.193', addressFamily: 'IPV4' }),
      expect.objectContaining({
        peerAddress: '2001:db8::1',
        addressFamily: 'IPV6',
        remoteAs: 65001n,
        cliReceivedPrefixes: 42n,
      }),
    ]);
    expect(result.ipv6Supported).toBe(true);
    expect(execute.mock.calls.flatMap((call) => call[1])).toContain(
      'display ipv6 routing-table 2001:db8::1',
    );
  });

  it('degrades IPv6 alone when the device does not support the IPv6 command', async () => {
    const execute = simulator({
      'display bgp peer': '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
      'display bgp ipv6 peer': null,
    });

    const result = await new BgpDiscoveryService(sshWith(execute), bgpRepository()).discover(host());

    expect(result.ipv6Supported).toBe(false);
    expect(result.warnings[0]).toContain('IPv6');
    expect(result.peers).toEqual([
      expect.objectContaining({ peerAddress: '200.150.1.193', addressFamily: 'IPV4' }),
    ]);
  });

  it('passes the host SSH context command to the BGP SSH client', async () => {
    const execute = simulator({});
    const factory = vi.fn(() => ({ execute } as unknown as SshClient));
    const ssh = new HuaweiBgpSshService(repository(), factory);
    const device = host();
    device.ssh = {
      ...device.ssh!,
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
    };

    await new BgpDiscoveryService(ssh, bgpRepository()).discover(device);

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ contextCommand: 'switch virtual-system IMPLANTAR-IXBR' }),
    );
  });

  it('omits the context command for a normal host', async () => {
    const execute = simulator({});
    const factory = vi.fn(() => ({ execute } as unknown as SshClient));
    const ssh = new HuaweiBgpSshService(repository(), factory);

    await new BgpDiscoveryService(ssh, bgpRepository()).discover(host());

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ contextCommand: null }));
  });
});
