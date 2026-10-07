import { describe, expect, it } from 'vitest';
import {
  buildHuaweiDeviceThresholds,
  decodeHuaweiScalarPowerDbm,
  decodeHuaweiThresholdDbm,
  hasHuaweiMultiLaneCapability,
  parseHuaweiOpticalLaneCsv,
} from './huawei-optical';

describe('SNMP optico Huawei — fixtures REAIS e decode por profile (F7.5)', () => {
  it('S6730 (BHE-VTA-6730-MPLS-01 / index 67469390): uW no current e centi-dBm nos thresholds', () => {
    expect(decodeHuaweiScalarPowerDbm(65, 'MICRO_WATTS')).toBeCloseTo(-11.87, 2);
    expect(decodeHuaweiScalarPowerDbm(271, 'MICRO_WATTS')).toBeCloseTo(-5.67, 2);
    expect(decodeHuaweiThresholdDbm(-2201)).toBe(-22.01);
    expect(decodeHuaweiThresholdDbm(-200)).toBe(-2);
    expect(decodeHuaweiThresholdDbm(-1000)).toBe(-10);
  });

  it('S6750-H (BHE-VTA-S6750-MPLS-01 / index 16850434): centi-dBm no current e nos thresholds', () => {
    expect(decodeHuaweiScalarPowerDbm(18, 'CENTI_DBM')).toBe(0.18);
    expect(decodeHuaweiScalarPowerDbm(-74, 'CENTI_DBM')).toBe(-0.74);
    expect(decodeHuaweiThresholdDbm(-1231)).toBe(-12.31);
    expect(decodeHuaweiThresholdDbm(340)).toBe(3.4);
    expect(decodeHuaweiThresholdDbm(-1040)).toBe(-10.4);
  });

  it('mesmo raw tem leituras diferentes por profile e UNKNOWN nao decodifica', () => {
    expect(decodeHuaweiScalarPowerDbm(18, 'MICRO_WATTS')).toBe(-17.45);
    expect(decodeHuaweiScalarPowerDbm(18, 'CENTI_DBM')).toBe(0.18);
    expect(decodeHuaweiScalarPowerDbm(18, 'UNKNOWN')).toBeNull();
  });

  it('descarta sentinela/unsupported e valores invalidos sem inventar limite', () => {
    expect(decodeHuaweiThresholdDbm(-1)).toBeNull();
    expect(decodeHuaweiThresholdDbm(2_147_483_647)).toBeNull();
    expect(decodeHuaweiThresholdDbm(999_999)).toBeNull();
    expect(decodeHuaweiThresholdDbm('')).toBeNull();
    expect(decodeHuaweiThresholdDbm('abc')).toBeNull();
    expect(decodeHuaweiThresholdDbm(null)).toBeNull();
  });

  it('monta o JSON canonico (DEVICE), aceita ausencia parcial e rejeita low >= high', () => {
    expect(buildHuaweiDeviceThresholds({
      rx: { low: -12.31, high: 3.4 },
      tx: { low: -10.4, high: 3.4 },
    })).toEqual({
      version: 1,
      scalar: {
        rx: { lowAlarmDbm: -12.31, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
        tx: { lowAlarmDbm: -10.4, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
      },
      lanes: [],
    });

    expect(buildHuaweiDeviceThresholds({
      rx: { low: -12.31, high: null },
      tx: { low: null, high: null },
    })?.scalar.rx).toEqual({
      lowAlarmDbm: -12.31, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null,
    });

    // Par incoerente e descartado inteiro; o outro lado continua valido.
    expect(buildHuaweiDeviceThresholds({
      rx: { low: -12.31, high: null },
      tx: { low: 3.4, high: -10.4 },
    })?.scalar).toEqual({
      rx: { lowAlarmDbm: -12.31, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null },
      tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
    });

    expect(buildHuaweiDeviceThresholds({
      rx: { low: null, high: null },
      tx: { low: null, high: null },
    })).toBeNull();
  });
});

describe('Huawei ENTITY-EXTENT multi-lane CSV', () => {
  it('parses four RX, TX and bias readings while preserving lane numbers', () => {
    expect(parseHuaweiOpticalLaneCsv(
      '-3.71,-3.31,-3.09,-2.98',
      '0.77,1.27,0.62,1.19',
      '61.00,59.36,63.05,52.57',
    )).toEqual([
      { lane: 0, rxPowerDbm: -3.71, txPowerDbm: 0.77, biasCurrentMa: 61 },
      { lane: 1, rxPowerDbm: -3.31, txPowerDbm: 1.27, biasCurrentMa: 59.36 },
      { lane: 2, rxPowerDbm: -3.09, txPowerDbm: 0.62, biasCurrentMa: 63.05 },
      { lane: 3, rxPowerDbm: -2.98, txPowerDbm: 1.19, biasCurrentMa: 52.57 },
    ]);
  });

  it('accepts two lanes, surrounding spaces and Uint8Array SNMP text', () => {
    const lanes = parseHuaweiOpticalLaneCsv(
      new Uint8Array(Buffer.from(' -4.00, -5.00 ')),
      ' 0.10, 0.20 ',
      ' 55, 56 ',
    );
    expect(lanes).toHaveLength(2);
    expect(hasHuaweiMultiLaneCapability(lanes)).toBe(true);
  });

  it('keeps TX and bias when the RX string is empty', () => {
    expect(parseHuaweiOpticalLaneCsv('', '0.1,0.2', '50,51')).toEqual([
      { lane: 0, rxPowerDbm: null, txPowerDbm: 0.1, biasCurrentMa: 50 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.2, biasCurrentMa: 51 },
    ]);
  });

  it('keeps RX-only lanes when TX and bias are absent', () => {
    expect(parseHuaweiOpticalLaneCsv('-3.1,-3.2', undefined, undefined)).toEqual([
      { lane: 0, rxPowerDbm: -3.1, txPowerDbm: null },
      { lane: 1, rxPowerDbm: -3.2, txPowerDbm: null },
    ]);
  });

  it('ignores each invalid field independently without shifting later lanes', () => {
    expect(parseHuaweiOpticalLaneCsv(
      '-3.1,invalid,-3.3,-3.4',
      '0.1,0.2,invalid,0.4',
      '50,invalid,52,',
    )).toEqual([
      { lane: 0, rxPowerDbm: -3.1, txPowerDbm: 0.1, biasCurrentMa: 50 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.2 },
      { lane: 2, rxPowerDbm: -3.3, txPowerDbm: null, biasCurrentMa: 52 },
      { lane: 3, rxPowerDbm: -3.4, txPowerDbm: 0.4 },
    ]);
  });

  it('preserves -40 dBm and removes a completely empty lane', () => {
    expect(parseHuaweiOpticalLaneCsv('-40,,bad', ',,bad', ',,bad')).toEqual([
      { lane: 0, rxPowerDbm: -40, txPowerDbm: null },
    ]);
  });
});
