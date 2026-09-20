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
  };
}

describe('BGP SSH discovery service', () => {
  it('discovers, correlates and names a peer without unnecessary verbose', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => [
      {
        stdout: commands.includes('display bgp peer')
          ? '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912'
          : `Summary Count : 1
200.150.1.192/30 Direct 0 0 D 200.150.1.194 HundredGigabitEthernet 1/0/3`,
        stderr: '',
        exitCode: 0,
      },
    ]);
    const client = { execute } as SshClient;
    const ssh = new HuaweiBgpSshService(repository(), () => client);

    const persistence = bgpRepository();
    const discoveredAt = new Date('2026-09-19T12:00:00.000Z');
    const result = await new BgpDiscoveryService(ssh, persistence, () => discoveredAt).discover(
      host([networkInterface()]),
    );

    expect(result).toEqual([
      expect.objectContaining({
        peerAddress: '200.150.1.193',
        remoteAs: 12345n,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 1569600,
        cliReceivedPrefixes: 1099912n,
        interfaceId: 'abc123',
        displayName: 'TRANSITO XYZ',
        correlationStatus: 'MATCHED',
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.flatMap((call) => call[1])).not.toContain('display bgp peer verbose');
    expect(persistence.saveDiscovery).toHaveBeenCalledWith('ne8000-1', result, discoveredAt);
  });

  it('uses verbose once only when an established summary peer lacks uptime', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => {
      const command = commands[1];
      if (command === 'display bgp peer') {
        return [
          {
            stdout: '200.150.1.193 4 12345 10 10 0 - Established',
            stderr: '',
            exitCode: 0,
          },
        ];
      }
      if (command === 'display bgp peer verbose') {
        return [
          {
            stdout: `BGP Peer is 200.150.1.193, remote AS 12345
BGP current state: Established, Up for 1d02h
Prefixes current: 1099912`,
            stderr: '',
            exitCode: 0,
          },
        ];
      }
      return [{ stdout: 'Summary Count : 0', stderr: '', exitCode: 0 }];
    });
    const ssh = new HuaweiBgpSshService(repository(), () => ({ execute }));

    const result = await new BgpDiscoveryService(ssh, bgpRepository()).discover(host());

    expect(result[0]).toMatchObject({
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
      if (commands[1] === 'display bgp peer') {
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
    const ssh = new HuaweiBgpSshService(repository(), () => ({ execute }));

    const result = await new BgpDiscoveryService(ssh, bgpRepository()).discover(host());

    expect(result[0]).toMatchObject({
      interfaceId: null,
      displayName: '200.150.1.193',
      correlationStatus: 'COMMAND_FAILED',
      correlationError: 'SSH connection timeout',
    });
    expect(result[0]?.correlationError).not.toContain('protected-password');
  });

  it('runs manual discovery even when bgpMonitoringEnabled is false', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => {
      if (commands.includes('display bgp peer')) {
        return [
          {
            stdout: '200.150.1.193 4 12345 10 10 0 18d04h Established 1099912',
            stderr: '',
            exitCode: 0,
          },
        ];
      }
      return [{ stdout: 'Summary Count : 0', stderr: '', exitCode: 0 }];
    });
    const ssh = new HuaweiBgpSshService(repository(), () => ({ execute }));
    const persistence = bgpRepository();
    const device = host();
    device.bgpMonitoringEnabled = false;

    const result = await new BgpDiscoveryService(ssh, persistence).discover(device);

    expect(result).toHaveLength(1);
    expect(persistence.saveDiscovery).toHaveBeenCalledWith('ne8000-1', result, expect.any(Date));
  });

  it('does not change bgpMonitoringEnabled during manual discovery', async () => {
    const execute = vi.fn(async () => [
      { stdout: 'Summary Count : 0', stderr: '', exitCode: 0 },
    ]);
    const ssh = new HuaweiBgpSshService(repository(), () => ({ execute }));
    const device = host();
    device.bgpMonitoringEnabled = false;

    await new BgpDiscoveryService(ssh, bgpRepository()).discover(device);

    expect(device.bgpMonitoringEnabled).toBe(false);
  });
});
