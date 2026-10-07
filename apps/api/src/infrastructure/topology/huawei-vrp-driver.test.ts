import { describe, expect, it } from 'vitest';
import {
  HuaweiVrpDriver,
  huaweiInterfaceTransceiverVerboseCommand,
  huaweiVerboseInterfaceName,
} from './huawei-vrp-driver';
import { emptyHuaweiOpticalThresholds } from './optical-thresholds';

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
      {
        name: '100GE 0/0/1',
        rxPowerDbm: -3.42,
        txPowerDbm: -2.11,
        opticalLanes: [],
        thresholds: emptyHuaweiOpticalThresholds(),
      },
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
        thresholds: {
          scalar: {
            rx: { lowAlarmDbm: -23.1, highAlarmDbm: -6, lowSource: 'DEVICE', highSource: 'DEVICE' },
            tx: { lowAlarmDbm: -2, highAlarmDbm: 5, lowSource: 'DEVICE', highSource: 'DEVICE' },
          },
          lanes: [],
        },
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

  it('parses pipe-delimited verbose lanes and continuation lines by explicit lane id', () => {
    const output = `
100GE1/0/24 transceiver information:
Diagnostic information:
   Temperature (Celsius)                 :51.30
   Voltage (V)                           :3.27
   Bias Current (mA)                     :61.05|59.48  (Lane0|Lane1)
                                          63.05|52.59  (Lane2|Lane3)

   Current RX Power (dBm)                :-3.71|-3.31  (Lane0|Lane1)
                                          -3.07|-2.98  (Lane2|Lane3)

   Current TX Power (dBm)                :0.78|1.26    (Lane0|Lane1)
                                          0.63|1.20    (Lane2|Lane3)
`;
    expect(new HuaweiVrpDriver().parseOpticalPower(output)).toEqual([{
      name: '100GE1/0/24',
      rxPowerDbm: -3.71,
      txPowerDbm: 0.78,
      opticalLanes: [
        { lane: 0, rxPowerDbm: -3.71, txPowerDbm: 0.78, biasCurrentMa: 61.05 },
        { lane: 1, rxPowerDbm: -3.31, txPowerDbm: 1.26, biasCurrentMa: 59.48 },
        { lane: 2, rxPowerDbm: -3.07, txPowerDbm: 0.63, biasCurrentMa: 63.05 },
        { lane: 3, rxPowerDbm: -2.98, txPowerDbm: 1.2, biasCurrentMa: 52.59 },
      ],
      thresholds: emptyHuaweiOpticalThresholds(),
    }]);
  });

  it('parses scalar verbose thresholds with USER SET winning over DEFAULT', () => {
    const output = `
100GE0/0/5 transceiver information:
Diagnostic information:
   Current RX Power (dBm)                :-5.00
   Current TX Power (dBm)                :0.10

   User Set Thresholds:
     Rx Power High Alarm Threshold : -2.00
     Rx Power Low Alarm Threshold  : -13.00
     Tx Power High Alarm Threshold : 1.50
     Tx Power Low Alarm Threshold  : -8.50

   Default Thresholds:
     Rx Power High Alarm Threshold : -1.00
     Rx Power Low Alarm Threshold  : -14.00
     Tx Power High Alarm Threshold : 2.00
     Tx Power Low Alarm Threshold  : -9.00
`;
    const reading = new HuaweiVrpDriver().parseOpticalPower(output)[0];
    expect(reading?.thresholds.scalar.rx).toEqual({
      lowAlarmDbm: -13, highAlarmDbm: -2, lowSource: 'USER', highSource: 'USER',
    });
    expect(reading?.thresholds.scalar.tx).toEqual({
      lowAlarmDbm: -8.5, highAlarmDbm: 1.5, lowSource: 'USER', highSource: 'USER',
    });
    expect(reading?.thresholds.lanes).toEqual([]);
  });

  it('keeps DEFAULT source when only default thresholds are printed', () => {
    const output = `
100GE0/0/6 transceiver information:
   (Default) Rx Power High Alarm Threshold : -1.00
   (Default) Rx Power Low Alarm Threshold  : -14.00
`;
    const reading = new HuaweiVrpDriver().parseOpticalPower(output)[0];
    expect(reading?.thresholds.scalar.rx).toEqual({
      lowAlarmDbm: -14, highAlarmDbm: -1, lowSource: 'DEFAULT', highSource: 'DEFAULT',
    });
    expect(reading?.thresholds.scalar.tx).toEqual({
      lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null,
    });
  });

  it('parses per-lane thresholds only when the output annotates the lane', () => {
    const output = `
40GE0/0/7 transceiver information:
   Rx Power High Alarm Threshold (lane 1): -2.00
   Rx Power High Alarm Threshold (lane 3): -2.50
   Rx Power Low Alarm Threshold (lane 1) : -13.20
`;
    const reading = new HuaweiVrpDriver().parseOpticalPower(output)[0];
    expect(reading?.thresholds.lanes).toEqual([
      {
        lane: 1,
        rx: { lowAlarmDbm: -13.2, highAlarmDbm: -2, lowSource: 'DEVICE', highSource: 'DEVICE' },
        tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      },
      {
        lane: 3,
        rx: { lowAlarmDbm: null, highAlarmDbm: -2.5, lowSource: null, highSource: 'DEVICE' },
        tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      },
    ]);
    expect(reading?.thresholds.scalar).toEqual({
      rx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
    });
  });

  it('keeps a reading that carries only thresholds and no usable power', () => {
    const output = `
100GE0/0/8 transceiver information:
   Rx Power High Alarm Threshold : -1.00
   Rx Power Low Alarm Threshold  : -14.00
`;
    expect(new HuaweiVrpDriver().parseOpticalPower(output)).toEqual([{
      name: '100GE0/0/8',
      rxPowerDbm: null,
      txPowerDbm: null,
      opticalLanes: [],
      thresholds: {
        scalar: {
          rx: { lowAlarmDbm: -14, highAlarmDbm: -1, lowSource: 'DEVICE', highSource: 'DEVICE' },
          tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        },
        lanes: [],
      },
    }]);
  });

  it('accepts sparse lanes, spaces in lane labels and individual invalid fields', () => {
    const output = `
40GE0/0/7 transceiver information:
   Bias Current (mA)       :55.1|56.2|57.3 (Lane 3|Lane 1|Lane 5)
   Current RX Power (dBm)  :invalid|-5.2|invalid (Lane 3|Lane 1|Lane 5)
   Current TX Power (dBm)  :0.3|invalid|invalid (Lane 3|Lane 1|Lane 5)
`;
    expect(new HuaweiVrpDriver().parseOpticalPower(output)[0]?.opticalLanes).toEqual([
      { lane: 1, rxPowerDbm: -5.2, txPowerDbm: null, biasCurrentMa: 56.2 },
      { lane: 3, rxPowerDbm: null, txPowerDbm: 0.3, biasCurrentMa: 55.1 },
      { lane: 5, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 57.3 },
    ]);
  });

  it('formats only the CLI command name without changing the persisted interface name', () => {
    expect(huaweiVerboseInterfaceName('100GE1/0/24')).toBe('100GE 1/0/24');
    expect(huaweiInterfaceTransceiverVerboseCommand('100GE1/0/24')).toBe(
      'display interface 100GE 1/0/24 transceiver verbose',
    );
    expect(huaweiInterfaceTransceiverVerboseCommand('40GE 0/0/1')).toBe(
      'display interface 40GE 0/0/1 transceiver verbose',
    );
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
