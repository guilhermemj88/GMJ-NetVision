import { describe, expect, it } from 'vitest';
import { HuaweiVrpDriver } from './huawei-vrp-driver';

describe('HuaweiVrpDriver display interface description', () => {
  it('parses technical names, physical/protocol state and configured descriptions', () => {
    const output = `
Interface                         PHY   Protocol Description
100GE0/0/1                       up    up       BHE-LIKEE-6730-MPLS-01
XGigabitEthernet0/0/1            *down down     ITOP TELECOM
Eth-Trunk3                       down  down
`;
    const interfaces = new HuaweiVrpDriver().parseInterfaces('huawei-1', output);
    expect(interfaces).toHaveLength(3);
    expect(interfaces[0]).toMatchObject({
      name: '100GE0/0/1', alias: 'BHE-LIKEE-6730-MPLS-01',
      adminStatus: 'UP', operStatus: 'UP', dataSources: ['SSH'],
    });
    expect(interfaces[1]).toMatchObject({
      name: 'XGigabitEthernet0/0/1', alias: 'ITOP TELECOM',
      adminStatus: 'DOWN', operStatus: 'DISABLED',
    });
    expect(interfaces[2]).toMatchObject({ name: 'Eth-Trunk3', alias: '', operStatus: 'DOWN' });
  });

  it('parses common VRP optical labels and rejects implausible dBm values', () => {
    const output = `
100GE 0/0/1 transceiver information:
  Current RX Power (dBm) : -3.42
  TxPower(dBm) = -2.11
XGigabitEthernet0/0/2 transceiver information:
  RxPower (dBm): -120
  Current TX Power (dBm): 99
`;
    expect(new HuaweiVrpDriver().parseOpticalPower(output)).toEqual([
      { name: '100GE 0/0/1', rxPowerDbm: -3.42, txPowerDbm: -2.11 },
    ]);
  });
});
