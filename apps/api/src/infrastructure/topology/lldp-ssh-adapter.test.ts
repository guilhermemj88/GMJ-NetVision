import { describe, expect, it } from 'vitest';
import type { CommandResult, LldpSshSessionFactory, SshClient } from '../../domain/ports';
import type { Device } from '@gmj/shared';
import { HuaweiVrpDriver } from './huawei-vrp-driver';
import { LldpSshDiscoveryAdapter } from './lldp-ssh-adapter';

class FakeSshClient implements SshClient {
  readonly calls: Array<{ host: string; commands: string[] }> = [];

  constructor(private readonly responses: CommandResult[][]) {}

  async execute(host: string, commands: string[]): Promise<CommandResult[]> {
    this.calls.push({ host, commands });
    return this.responses.shift() ?? [];
  }
}

function result(stdout: string, exitCode = 0, stderr = ''): CommandResult[] {
  return [{ stdout, stderr, exitCode }];
}

function device(vendor = ''): Device {
  return {
    id: 'huawei-1',
    name: 'CORE-01',
    hostname: 'CORE-01',
    ip: '192.0.2.1',
    vendor,
    model: '',
    status: 'UNKNOWN',
    deviceType: 'switch',
    site: '',
    source: 'ZABBIX',
    discoveryMethod: 'SSH',
    uptimeSeconds: 0,
    updatedAt: '',
    interfaces: [],
  };
}

function adapter(client: SshClient): LldpSshDiscoveryAdapter {
  const sessions: LldpSshSessionFactory = {
    open: async () => ({ client, host: '198.51.100.10' }),
  };
  return new LldpSshDiscoveryAdapter([new HuaweiVrpDriver()], sessions);
}

describe('LldpSshDiscoveryAdapter Huawei command flow', () => {
  it('uses display lldp neighbor once when the primary output is usable', async () => {
    const client = new FakeSshClient([
      result(`
100GE0/0/1 has 1 neighbor(s):
Neighbor index : 1
Chassis ID : aaaa-bbbb-cccc
Port ID : Ethernet1/1
System name : REMOTE-SW-01
`),
    ]);

    const neighbors = await adapter(client).discoverNeighbors(device());

    expect(neighbors).toHaveLength(1);
    expect(client.calls).toEqual([
      {
        host: '198.51.100.10',
        commands: ['screen-length 0 temporary', 'display lldp neighbor'],
      },
    ]);
  });

  it('uses display lldp neighbor brief after an unsupported primary command', async () => {
    const client = new FakeSshClient([
      result("Error: Unrecognized command found at '^' position."),
      result(`
Local Intf    Neighbor Dev       Neighbor Intf      Exptime(s)
10GE1/0/1     REMOTE-SW-01       Ethernet1/1        105
`),
    ]);

    const neighbors = await adapter(client).discoverNeighbors(device('Huawei Technologies'));

    expect(neighbors[0]).toMatchObject({
      localPort: '10GE1/0/1',
      remoteSystemName: 'REMOTE-SW-01',
      remotePort: 'Ethernet1/1',
    });
    expect(client.calls.map((call) => call.commands)).toEqual([
      ['screen-length 0 temporary', 'display lldp neighbor'],
      ['screen-length 0 temporary', 'display lldp neighbor brief'],
    ]);
  });

  it('uses the brief fallback when the primary command returns empty output', async () => {
    const client = new FakeSshClient([result(''), result('Eth-Trunk1 REMOTE-SW-02 12 99')]);

    await expect(adapter(client).discoverNeighbors(device())).resolves.toHaveLength(1);
    expect(client.calls).toHaveLength(2);
  });

  it('does not run a needless fallback for an explicit zero-neighbor response', async () => {
    const client = new FakeSshClient([result('There is no LLDP neighbor.')]);

    await expect(adapter(client).discoverNeighbors(device())).resolves.toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it('does not send Huawei commands to a known non-Huawei vendor', async () => {
    const client = new FakeSshClient([]);

    await expect(adapter(client).discoverNeighbors(device('Cisco'))).rejects.toThrow(
      'No SSH driver configured for vendor Cisco',
    );
    expect(client.calls).toEqual([]);
  });

  it('preserves a clear missing-credentials error from the session factory', async () => {
    const sessions: LldpSshSessionFactory = {
      open: async () => {
        throw new Error('SSH credentials not configured');
      },
    };
    const discovery = new LldpSshDiscoveryAdapter([new HuaweiVrpDriver()], sessions);

    await expect(discovery.discoverNeighbors(device())).rejects.toThrow(
      'SSH credentials not configured',
    );
  });
});
