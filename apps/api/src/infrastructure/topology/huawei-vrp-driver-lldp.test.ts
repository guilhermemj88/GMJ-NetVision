import { describe, expect, it } from 'vitest';
import { HuaweiVrpDriver } from './huawei-vrp-driver';

describe('HuaweiVrpDriver LLDP parsing', () => {
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
