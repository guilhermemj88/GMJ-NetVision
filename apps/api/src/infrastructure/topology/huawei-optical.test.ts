import { describe, expect, it } from 'vitest';
import {
  buildHuaweiDeviceThresholds,
  decodeHuaweiLanePowerDbm,
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
      'DBM',
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
      'DBM',
    );
    expect(lanes).toHaveLength(2);
    expect(hasHuaweiMultiLaneCapability(lanes)).toBe(true);
  });

  it('keeps TX and bias when the RX string is empty', () => {
    expect(parseHuaweiOpticalLaneCsv('', '0.1,0.2', '50,51', 'DBM')).toEqual([
      { lane: 0, rxPowerDbm: null, txPowerDbm: 0.1, biasCurrentMa: 50 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.2, biasCurrentMa: 51 },
    ]);
  });

  it('keeps RX-only lanes when TX and bias are absent', () => {
    expect(parseHuaweiOpticalLaneCsv('-3.1,-3.2', undefined, undefined, 'DBM')).toEqual([
      { lane: 0, rxPowerDbm: -3.1, txPowerDbm: null },
      { lane: 1, rxPowerDbm: -3.2, txPowerDbm: null },
    ]);
  });

  it('ignores each invalid field independently without shifting later lanes', () => {
    expect(parseHuaweiOpticalLaneCsv(
      '-3.1,invalid,-3.3,-3.4',
      '0.1,0.2,invalid,0.4',
      '50,invalid,52,',
      'DBM',
    )).toEqual([
      { lane: 0, rxPowerDbm: -3.1, txPowerDbm: 0.1, biasCurrentMa: 50 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.2 },
      { lane: 2, rxPowerDbm: -3.3, txPowerDbm: null, biasCurrentMa: 52 },
      { lane: 3, rxPowerDbm: -3.4, txPowerDbm: 0.4 },
    ]);
  });

  it('preserves -40 dBm and removes a completely empty lane', () => {
    expect(parseHuaweiOpticalLaneCsv('-40,,bad', ',,bad', ',,bad', 'DBM')).toEqual([
      { lane: 0, rxPowerDbm: -40, txPowerDbm: null },
    ]);
  });
});

describe('Lane encoding por profile (evidencia real S6730 100G)', () => {
  /** Fixture REAL obrigatoria: CEM-CEN-6730-MPLS-01 / 100GE0/0/2 (index 67502222). */
  const S6730 = {
    scalarRxRaw: 42,
    scalarTxRaw: 1191,
    bias: '47.89,67.46,47.90,51.08',
    rx: '-1372.63,-1226.95,-1311.58,-1294.14',
    tx: '76.06,76.68,66.62,43.72',
  };

  /** Fixture real S6750-H (BHE-VTA-S6750-MPLS-01 / 100GE1/0/8) — nao regride. */
  const S6750 = {
    rx: '0.19,0.69,1.02,0.11',
    tx: '-0.74,-0.69,-0.72,-0.76',
  };

  it('decodifica o CSV do S6730 em CENTI_DBM (raw / 100)', () => {
    expect(decodeHuaweiLanePowerDbm('-1372.63', 'CENTI_DBM')).toBe(-13.73);
    expect(decodeHuaweiLanePowerDbm('76.06', 'CENTI_DBM')).toBe(0.76);
    expect(decodeHuaweiLanePowerDbm('-250', 'CENTI_DBM')).toBe(-2.5);
  });

  it('mantem DBM cru no S6750 e nao divide por 100', () => {
    expect(decodeHuaweiLanePowerDbm('0.19', 'DBM')).toBe(0.19);
    expect(decodeHuaweiLanePowerDbm('-0.74', 'DBM')).toBe(-0.74);
    expect(decodeHuaweiLanePowerDbm('1.02', 'DBM')).toBe(1.02);
  });

  it('UNKNOWN nao adivinha potencia (bias e thresholds seguem valendo)', () => {
    expect(decodeHuaweiLanePowerDbm('-1372.63', 'UNKNOWN')).toBeNull();
    expect(parseHuaweiOpticalLaneCsv(S6730.rx, S6730.tx, S6730.bias, 'UNKNOWN')).toEqual([
      { lane: 0, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 47.89 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 67.46 },
      { lane: 2, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 47.9 },
      { lane: 3, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 51.08 },
    ]);
  });

  it('as 4 lanes REAIS do S6730 fecham com o scalar (centi-dBm)', () => {
    // Scalar: 42 uW = -13.77 dBm / 1191 uW = +0.76 dBm (MICRO_WATTS).
    expect(decodeHuaweiScalarPowerDbm(S6730.scalarRxRaw, 'MICRO_WATTS')).toBeCloseTo(-13.77, 2);
    expect(decodeHuaweiScalarPowerDbm(S6730.scalarTxRaw, 'MICRO_WATTS')).toBeCloseTo(0.76, 2);

    expect(parseHuaweiOpticalLaneCsv(S6730.rx, S6730.tx, S6730.bias, 'CENTI_DBM')).toEqual([
      { lane: 0, rxPowerDbm: -13.73, txPowerDbm: 0.76, biasCurrentMa: 47.89 },
      { lane: 1, rxPowerDbm: -12.27, txPowerDbm: 0.77, biasCurrentMa: 67.46 },
      { lane: 2, rxPowerDbm: -13.12, txPowerDbm: 0.67, biasCurrentMa: 47.9 },
      { lane: 3, rxPowerDbm: -12.94, txPowerDbm: 0.44, biasCurrentMa: 51.08 },
    ]);
  });

  it('nao regride o S6750 (lanes ja em dBm)', () => {
    const lanes = parseHuaweiOpticalLaneCsv(S6750.rx, S6750.tx, undefined, 'DBM');
    expect(lanes).toEqual([
      { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74 },
      { lane: 1, rxPowerDbm: 0.69, txPowerDbm: -0.69 },
      { lane: 2, rxPowerDbm: 1.02, txPowerDbm: -0.72 },
      { lane: 3, rxPowerDbm: 0.11, txPowerDbm: -0.76 },
    ]);
    expect(hasHuaweiMultiLaneCapability(lanes)).toBe(true);
  });

  it('valor invalido nao quebra o poll e a lane continua sparse', () => {
    const lanes = parseHuaweiOpticalLaneCsv(
      '-1372.63,bad,-1311.58',
      '76.06,76.68,66.62',
      '47.89,67.46,47.90',
      'CENTI_DBM',
    );
    expect(lanes).toEqual([
      { lane: 0, rxPowerDbm: -13.73, txPowerDbm: 0.76, biasCurrentMa: 47.89 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.77, biasCurrentMa: 67.46 },
      { lane: 2, rxPowerDbm: -13.12, txPowerDbm: 0.67, biasCurrentMa: 47.9 },
    ]);
  });

  it('fora da faixa optica o RX e descartado mas o bias permanece', () => {
    expect(parseHuaweiOpticalLaneCsv('99999,-1372.63', '', '47.89,51.08', 'CENTI_DBM')).toEqual([
      { lane: 0, rxPowerDbm: null, txPowerDbm: null, biasCurrentMa: 47.89 },
      { lane: 1, rxPowerDbm: -13.73, txPowerDbm: null, biasCurrentMa: 51.08 },
    ]);
  });
});
describe('thresholds WARNING (.20-.23) do transceiver', () => {
  it('mantem ALARM e WARNING como pares independentes', () => {
    const thresholds = buildHuaweiDeviceThresholds({
      rx: { low: -23.1, high: -6 },
      tx: { low: -2, high: 5 },
      rxWarning: { low: -22.07, high: -7 },
      txWarning: { low: -1, high: 4 },
    });
    expect(thresholds?.scalar.rx.lowAlarmDbm).toBe(-23.1);
    expect(thresholds?.scalar.rx.lowWarningDbm).toBe(-22.07);
    expect(thresholds?.scalar.rx.highWarningDbm).toBe(-7);
    expect(thresholds?.scalar.rx.lowSource).toBe('DEVICE');
    expect(thresholds?.scalar.tx.highWarningDbm).toBe(4);
  });

  it('familia sem WARNING (YunShan) fica null, nunca copiando o ALARM', () => {
    const thresholds = buildHuaweiDeviceThresholds({
      rx: { low: -13.6, high: 5.5 },
      tx: { low: -6.3, high: 5.5 },
    });
    expect(thresholds?.scalar.rx.lowWarningDbm).toBeUndefined();
    expect(thresholds?.scalar.rx.highWarningDbm).toBeUndefined();
  });

  it('WARNING fora da janela HARD e descartado inteiro', () => {
    const thresholds = buildHuaweiDeviceThresholds({
      rx: { low: -23.1, high: -6 },
      tx: { low: -2, high: 5 },
      rxWarning: { low: -24.9, high: -7 },
    });
    expect(thresholds?.scalar.rx.lowWarningDbm).toBeNull();
    expect(thresholds?.scalar.rx.highWarningDbm).toBe(-7);
    expect(thresholds?.scalar.tx.lowWarningDbm).toBeUndefined();
  });

  it('so WARNING (sem ALARM valido) ainda produz estrutura com source DEVICE', () => {
    const thresholds = buildHuaweiDeviceThresholds({
      rx: { low: null, high: null },
      tx: { low: null, high: null },
      rxWarning: { low: -20.51, high: -7 },
    });
    expect(thresholds?.scalar.rx.lowWarningDbm).toBe(-20.51);
    expect(thresholds?.scalar.rx.lowSource).toBe('DEVICE');
    expect(thresholds?.scalar.tx.lowSource).toBeNull();
  });
});
