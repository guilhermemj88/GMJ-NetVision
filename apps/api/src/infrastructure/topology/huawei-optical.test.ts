import { describe, expect, it } from 'vitest';
import {
  hasHuaweiMultiLaneCapability,
  parseHuaweiOpticalLaneCsv,
} from './huawei-optical';

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
