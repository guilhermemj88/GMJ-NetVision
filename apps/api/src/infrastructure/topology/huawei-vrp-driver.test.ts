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
      { name: '100GE 0/0/1', rxPowerDbm: -3.42, txPowerDbm: -2.11, opticalLanes: [] },
    ]);
  });

  it('parses Huawei QSFP multi-lane diagnostic power and bias current', () => {
    const output = `
Port 100GE0/0/2 transceiver diagnostic information:
Parameter        Current      Low Alarm    High Alarm
  Type             Value       Threshold     Threshold    Status
---------------------------------------------------------------
TxPower(dBm)       1.50 (lane0)   -2.00        5.00       normal
                   2.14 (lane1)
                   2.01 (lane2)
                   1.97 (lane3)
RxPower(dBm)     -18.12 (lane0)  -23.10       -6.00       abnormal
                 -16.95 (lane1)
                 -16.25 (lane2)
                  -2.17 (lane3)
Current(mA)       62.07 (lane0)   10.00      110.00       normal
                  63.05 (lane1)
                  62.72 (lane2)
                  63.05 (lane3)
Temp(C)           51.30           -5.00       90.00       normal
Voltage(V)         3.24            2.80        3.70       normal
`;
    expect(new HuaweiVrpDriver().parseOpticalPower(output)).toEqual([
      {
        name: '100GE0/0/2',
        rxPowerDbm: -18.12,
        txPowerDbm: 1.5,
        opticalLanes: [
          { lane: 0, rxPowerDbm: -18.12, txPowerDbm: 1.5, biasCurrentMa: 62.07 },
          { lane: 1, rxPowerDbm: -16.95, txPowerDbm: 2.14, biasCurrentMa: 63.05 },
          { lane: 2, rxPowerDbm: -16.25, txPowerDbm: 2.01, biasCurrentMa: 62.72 },
          { lane: 3, rxPowerDbm: -2.17, txPowerDbm: 1.97, biasCurrentMa: 63.05 },
        ],
      },
    ]);
  });
});