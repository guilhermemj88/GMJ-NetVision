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

  it('builds and parses the per-interface 100GE diagnostic command flow', () => {
    const driver = new HuaweiVrpDriver();
    expect(driver.opticalEnrichmentCommands(['100GE 0/0/2'], false)).toEqual([
      'screen-length 0 temporary',
      'display transceiver diagnosis interface 100GE0/0/2',
    ]);
    expect(driver.parseOpticalPower(multiLaneDiagnostic('100GE0/0/2'))[0]).toMatchObject({
      name: '100GE0/0/2',
      opticalLanes: [
        { lane: 0, rxPowerDbm: -12.1, txPowerDbm: 0.2, biasCurrentMa: 60.1 },
        { lane: 1, rxPowerDbm: -12.2, txPowerDbm: 0.3, biasCurrentMa: 60.2 },
        { lane: 2, rxPowerDbm: -12.3, txPowerDbm: 0.4, biasCurrentMa: 60.3 },
        { lane: 3, rxPowerDbm: -12.4, txPowerDbm: 0.5, biasCurrentMa: 60.4 },
      ],
    });
  });

  it('builds and parses the equivalent per-interface 40GE diagnostic command flow', () => {
    const driver = new HuaweiVrpDriver();
    expect(driver.opticalEnrichmentCommands(['40GE0/0/1'], false)).toEqual([
      'screen-length 0 temporary',
      'display transceiver diagnosis interface 40GE0/0/1',
    ]);
    expect(driver.parseOpticalPower(multiLaneDiagnostic('40GE0/0/1'))[0]).toMatchObject({
      name: '40GE0/0/1',
      rxPowerDbm: -12.1,
      txPowerDbm: 0.2,
      opticalLanes: expect.arrayContaining([
        expect.objectContaining({ lane: 3, rxPowerDbm: -12.4, txPowerDbm: 0.5 }),
      ]),
    });
  });
});

function multiLaneDiagnostic(name: string): string {
  return `
<HUAWEI>display transceiver diagnosis interface ${name}
Port ${name} transceiver diagnostic information:
TxPower(dBm)        0.20 (lane0)
                    0.30 (lane1)
                    0.40 (lane2)
                    0.50 (lane3)
RxPower(dBm)      -12.10 (lane0)
                  -12.20 (lane1)
                  -12.30 (lane2)
                  -12.40 (lane3)
Current(mA)        60.10 (lane0)
                   60.20 (lane1)
                   60.30 (lane2)
                   60.40 (lane3)
`;
}
