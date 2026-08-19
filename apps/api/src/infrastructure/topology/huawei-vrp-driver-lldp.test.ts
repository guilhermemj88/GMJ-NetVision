import { describe, expect, it } from 'vitest';
import { HuaweiVrpDriver } from './huawei-vrp-driver';

describe('HuaweiVrpDriver LLDP parsing', () => {
  it('uses the verbose command first and keeps brief as the fallback', () => {
    const driver = new HuaweiVrpDriver();
    expect(driver.neighborCommands()).toEqual([
      'screen-length 0 temporary',
      'display lldp neighbor',
    ]);
    expect(driver.neighborFallbackCommands()).toEqual([
      'screen-length 0 temporary',
      'display lldp neighbor brief',
    ]);
  });

  it('parses a real display lldp neighbor block', () => {
    const output = `
100GE0/0/1 has 1 neighbor(s):

Neighbor index :1
Chassis type   :MAC address
Chassis ID     :2cdd-e94a-a3c3
Port ID type   :Interface name
Port ID        :Ethernet29/1
Port description    :C-AS267357-LIVENET
System name         :SW02-SP4-270735
System description  :Arista Networks EOS version 4.31.1F
System capabilities supported   :bridge router
System capabilities enabled     :bridge router
Management address type  :ipv4
Management address value :198.19.12.20
`;
    const neighbors = new HuaweiVrpDriver().parseNeighbors('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      localPort: '100GE0/0/1',
      remoteSystemName: 'SW02-SP4-270735',
      remoteChassisId: '2cdd-e94a-a3c3',
      remoteManagementAddress: '198.19.12.20',
      remotePort: 'Ethernet29/1',
      remotePortDescription: 'C-AS267357-LIVENET',
      systemDescription: 'Arista Networks EOS version 4.31.1F',
      capabilities: ['bridge', 'router'],
    });
    expect(neighbors[0]?.localIfIndex).toBeUndefined();
  });

  it('parses multiple neighbors and preserves their local interfaces', () => {
    const output = `
GigabitEthernet0/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaaa-bbbb-0001
Port ID :GigabitEthernet0/0/10
System name :ACCESS-SW-01

XGigabitEthernet0/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaaa-bbbb-0002
Port ID :10GE1/0/1
System name :AGG-SW-02
`;
    const neighbors = new HuaweiVrpDriver().parseNeighbors('huawei-1', output);
    expect(neighbors).toHaveLength(2);
    expect(
      neighbors.map((neighbor) => ({
        localPort: neighbor.localPort,
        remoteSystemName: neighbor.remoteSystemName,
        remotePort: neighbor.remotePort,
      })),
    ).toEqual([
      {
        localPort: 'GigabitEthernet0/0/1',
        remoteSystemName: 'ACCESS-SW-01',
        remotePort: 'GigabitEthernet0/0/10',
      },
      {
        localPort: 'XGigabitEthernet0/0/1',
        remoteSystemName: 'AGG-SW-02',
        remotePort: '10GE1/0/1',
      },
    ]);
  });

  it('keeps a neighbor when optional fields and the system name are absent', () => {
    const output = `
Local interface : Eth-Trunk1
Neighbor index : 1
Chassis ID : aaaa-bbbb-cccc
Port ID : 12
`;
    const neighbors = new HuaweiVrpDriver().parseNeighbors('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      localPort: 'Eth-Trunk1',
      remoteSystemName: 'aaaa-bbbb-cccc',
      remoteChassisId: 'aaaa-bbbb-cccc',
      remotePort: '12',
      capabilities: [],
    });
    expect(neighbors[0]?.remoteManagementAddress).toBeUndefined();
    expect(neighbors[0]?.remotePortDescription).toBeUndefined();
  });

  it.each([
    'GigabitEthernet0/0/1',
    'GigabitEthernet0/0/10',
    'XGigabitEthernet0/0/1',
    '10GE1/0/1',
    'Eth-Trunk1',
  ])('accepts the local interface name %s', (localPort) => {
    const output = `
Local interface : ${localPort}
Chassis ID : aaaa-bbbb-cccc
Port ID : Ethernet1/1
System name : NEIGHBOR-WITH-HYPHEN
`;
    expect(new HuaweiVrpDriver().parseNeighbors('huawei-1', output)[0]).toMatchObject({
      localPort,
      remoteSystemName: 'NEIGHBOR-WITH-HYPHEN',
    });
  });

  it('tolerates label casing and spacing differences', () => {
    const output = `
  local INTERFACE:10GE1/0/1
  chassis id : 00-11-22-33-44-55
  PORT id:10GE1/0/2
  system NAME    : CORE-WITH-HYPHEN
  management ADDRESS value: 192.0.2.10
  system CAPABILITIES: Bridge, Router
`;
    expect(new HuaweiVrpDriver().parseNeighbors('huawei-1', output)[0]).toMatchObject({
      localPort: '10GE1/0/1',
      remoteSystemName: 'CORE-WITH-HYPHEN',
      remotePort: '10GE1/0/2',
      remoteManagementAddress: '192.0.2.10',
      capabilities: ['bridge', 'router'],
    });
  });

  it('returns no neighbors for empty or unsupported command output', () => {
    const driver = new HuaweiVrpDriver();
    expect(driver.parseNeighbors('huawei-1', '')).toEqual([]);
    expect(
      driver.parseNeighbors('huawei-1', "Error: Unrecognized command found at '^' position."),
    ).toEqual([]);
    expect(driver.shouldFallbackNeighborCommand('')).toBe(true);
    expect(
      driver.shouldFallbackNeighborCommand("Error: Unrecognized command found at '^' position."),
    ).toBe(true);
  });

  it('does not request fallback when VRP explicitly reports zero neighbors', () => {
    const driver = new HuaweiVrpDriver();
    expect(driver.shouldFallbackNeighborCommand('Total entries displayed: 0 neighbors')).toBe(
      false,
    );
    expect(driver.shouldFallbackNeighborCommand('There is no LLDP neighbor.')).toBe(false);
  });

  it('parses display lldp neighbor brief rows', () => {
    const output = `
Local Intf    Neighbor Dev       Neighbor Intf      Exptime(s)
GE0/0/1       BHE-VTA-6730       100GE0/0/1         105
XGE0/0/2      SW-ACCESS-01       GE0/0/1            99
`;
    const neighbors = new HuaweiVrpDriver().parseNeighborsBrief('huawei-1', output);
    expect(neighbors).toHaveLength(2);
    expect(neighbors[0]).toMatchObject({
      localDeviceId: 'huawei-1',
      localPort: 'GE0/0/1',
      remoteSystemName: 'BHE-VTA-6730',
      remotePort: '100GE0/0/1',
      source: 'LLDP_SSH',
    });
    expect(neighbors[1]).toMatchObject({ localPort: 'XGE0/0/2', remoteSystemName: 'SW-ACCESS-01' });
  });

  it('falls back to brief parsing when no verbose block is present', () => {
    const output = `
Local Intf    Neighbor Dev       Neighbor Intf      Exptime(s)
100GE1/0/1    BHE-VTA-6730       100GE0/0/1         105
`;
    const neighbors = new HuaweiVrpDriver().parseNeighbors('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({ localPort: '100GE1/0/1', remotePort: '100GE0/0/1' });
  });

  it('prefers verbose blocks over the brief table', () => {
    const output = `
Local Intf    Neighbor Dev       Neighbor Intf      Exptime(s)
GE0/0/1       SW-BRIEF           100GE0/0/1         105
------------------------------------------------------------------------
 GigabitEthernet0/0/1 has 1 neighbor(s):
 Neighbor index: 1
 Local interface   : GE0/0/1
 System name       : SW-VERBOSE
 Port ID           : GE0/0/2
 Chassis ID        : a0:3d:6f:00:00:01
 Port description  : to-verbose
`;
    const neighbors = new HuaweiVrpDriver().parseNeighbors('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      localPort: 'GE0/0/1',
      remoteSystemName: 'SW-VERBOSE',
      remotePort: 'GE0/0/2',
      remoteChassisId: 'a0:3d:6f:00:00:01',
    });
  });

  it('keeps a fully numeric remotePort', () => {
    const output = `
Local Intf    Neighbor Dev       Neighbor Intf      Exptime(s)
GE0/0/1       SW-NUMERIC         12                 105
`;
    const neighbors = new HuaweiVrpDriver().parseNeighborsBrief('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({ remotePort: '12' });
  });

  it('tolerates variable spacing and long neighbor names', () => {
    const output = '100GE1/0/1   BHE-VTA-CORE-S6750-MPLS-AGGREGATION-01     100GE0/0/48   105\n';
    const neighbors = new HuaweiVrpDriver().parseNeighborsBrief('huawei-1', output);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      localPort: '100GE1/0/1',
      remoteSystemName: 'BHE-VTA-CORE-S6750-MPLS-AGGREGATION-01',
      remotePort: '100GE0/0/48',
    });
  });

  it('skips header and separator lines from different VRP versions', () => {
    const output = `
Local Interface  Neighbor Device        Neighbor Interface  Exptime(s)
----------------------------------------------------------------------------
GE0/0/1          SW-ONE                 GE0/0/1             100
GE0/0/2          SW-TWO                 10GE1/0/1           0
`;
    const neighbors = new HuaweiVrpDriver().parseNeighborsBrief('huawei-1', output);
    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((item) => item.remoteSystemName)).toEqual(['SW-ONE', 'SW-TWO']);
  });
});
