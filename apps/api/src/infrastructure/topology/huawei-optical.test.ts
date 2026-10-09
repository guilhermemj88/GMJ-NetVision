import { describe, expect, it } from 'vitest';
import {
  buildHuaweiDeviceThresholds,
  decodeOpticalBiasMa,
  decodeOpticalLaneDbm,
  decodeOpticalMinMaxDbm,
  decodeOpticalScalarDbm,
  decodeOpticalThresholdDbm,
  hasHuaweiMultiLaneCapability,
  parseHuaweiOpticalLaneCsv,
} from './huawei-optical';
import {
  huaweiMa5800Profile,
} from '../snmp/profiles/huawei/ma5800';
import { huaweiNe8000Profile } from '../snmp/profiles/huawei/ne8000';
import { huaweiS6730Profile } from '../snmp/profiles/huawei/s6730';
import { huaweiS6750Profile } from '../snmp/profiles/huawei/s6750';

/**
 * Fixtures REAIS da matriz modelo x versao x capability (2026-10-09), com os
 * raws exatamente como o equipamento publica. Os valores esperados sao os do
 * relatorio: preservam a resolucao do vendor (2 casas em centi-dBm = 4 em dBm).
 */
const F1A = {
  /** BHE-VTA-F1A-BGP-01 / 100GE0/1/48 (entPhysicalIndex 16847153). */
  scalarRxRaw: 601,
  scalarTxRaw: 586,
  rxLane: '29,-33,-14,14',
  txLane: '-58,-22,-12,27',
  bias: '',
  rxLow: -1230,
  rxHigh: 339,
  txLow: -1040,
  txHigh: 339,
  rxWarnLow: -1030,
  rxWarnHigh: 239,
  txWarnLow: -760,
  txWarnHigh: 239,
  maxRx: 29,
  minRx: -33,
  maxTx: 27,
  minTx: -58,
};

const S6730 = {
  /** SPO-EQUINIX-6730-MPLS-01 / 100GE0/0/1 (entPhysicalIndex 67502158). */
  scalarRxRaw: 665,
  scalarTxRaw: 1979,
  rxLane: '-176.79,-228.71,-221.85,-310.51',
  txLane: '296.45,223.29,181.53,288.43',
  bias: '42.76,42.76,42.76,42.76',
  rxLow: -1360,
  rxHigh: 550,
  txLow: -630,
  txHigh: 550,
  rxWarnLow: -1060,
  rxWarnHigh: 450,
  txWarnLow: -430,
  txWarnHigh: 450,
};

const S6750 = {
  /** BHE-VTA-S6750-MPLS-01 / 100GE1/0/1 (entPhysicalIndex 16850434). */
  scalarRxRaw: 1,
  scalarTxRaw: -74,
  rxLane: '0.01,0.72,1.05,0.15',
  txLane: '-0.74,-0.69,-0.72,-0.73',
  bias: '6.50,6.50,6.50,6.50',
  rxLow: -1231,
  rxHigh: 340,
  txLow: -1040,
  txHigh: 340,
};

describe('decoders opticos Huawei por capability (fixtures reais da matriz)', () => {
  it('F1A: scalar .8/.9 em centi-dBm (601 => +6.01; -326 => -3.26)', () => {
    expect(decodeOpticalScalarDbm(F1A.scalarRxRaw, 'CENTI_DBM')).toBe(6.01);
    expect(decodeOpticalScalarDbm(F1A.scalarTxRaw, 'CENTI_DBM')).toBe(5.86);
    expect(decodeOpticalScalarDbm(-326, 'CENTI_DBM')).toBe(-3.26);
    // Nunca decodifica como uW (seria +6.01 dBm virando -2.21 dBm).
    expect(decodeOpticalScalarDbm(F1A.scalarRxRaw, 'MICRO_WATTS')).not.toBe(6.01);
  });

  it('F1A: lanes .32/.33 em CSV de INTEIROS centi-dBm', () => {
    expect(parseHuaweiOpticalLaneCsv(F1A.rxLane, F1A.txLane, F1A.bias, 'INT_CENTI_DBM', 'UNSUPPORTED'))
      .toEqual([
        { lane: 0, rxPowerDbm: 0.29, txPowerDbm: -0.58 },
        { lane: 1, rxPowerDbm: -0.33, txPowerDbm: -0.22 },
        { lane: 2, rxPowerDbm: -0.14, txPowerDbm: -0.12 },
        { lane: 3, rxPowerDbm: 0.14, txPowerDbm: 0.27 },
      ]);
    expect(decodeOpticalLaneDbm('-66', 'INT_CENTI_DBM')).toBe(-0.66);
    expect(decodeOpticalLaneDbm('15', 'INT_CENTI_DBM')).toBe(0.15);
    // Porta de UMA lane vem como valor unico (sem virgula).
    expect(parseHuaweiOpticalLaneCsv('-326', '-201', '', 'INT_CENTI_DBM', 'UNSUPPORTED'))
      .toEqual([{ lane: 0, rxPowerDbm: -3.26, txPowerDbm: -2.01 }]);
  });

  it('F1A: .31 nao implementado nao inventa bias (UNSUPPORTED)', () => {
    expect(decodeOpticalBiasMa('', 'UNSUPPORTED')).toBeNull();
    expect(decodeOpticalBiasMa('6.5', 'UNSUPPORTED')).toBeNull();
    expect(parseHuaweiOpticalLaneCsv(F1A.rxLane, F1A.txLane, '', 'INT_CENTI_DBM', 'UNSUPPORTED')[0])
      .not.toHaveProperty('biasCurrentMa');
  });

  it('F1A: thresholds ALARM e WARNING em centi-dBm (CLI Rx Warning [-10.301, 2.399])', () => {
    expect(decodeOpticalThresholdDbm(F1A.rxLow, 'CENTI_DBM')).toBe(-12.3);
    expect(decodeOpticalThresholdDbm(F1A.rxHigh, 'CENTI_DBM')).toBe(3.39);
    expect(decodeOpticalThresholdDbm(F1A.rxWarnLow, 'CENTI_DBM')).toBe(-10.3);
    expect(decodeOpticalThresholdDbm(F1A.rxWarnHigh, 'CENTI_DBM')).toBe(2.39);
    expect(decodeOpticalThresholdDbm(F1A.txWarnLow, 'CENTI_DBM')).toBe(-7.6);
  });

  it('F1A: min/max .38-.41 em centi-dBm', () => {
    expect(decodeOpticalMinMaxDbm(F1A.maxRx, 'CENTI_DBM')).toBe(0.29);
    expect(decodeOpticalMinMaxDbm(F1A.minRx, 'CENTI_DBM')).toBe(-0.33);
    expect(decodeOpticalMinMaxDbm(F1A.maxTx, 'CENTI_DBM')).toBe(0.27);
    expect(decodeOpticalMinMaxDbm(F1A.minTx, 'CENTI_DBM')).toBe(-0.58);
  });

  it('F1A: scalars .8/.9 NAO entram em validacao de faixa antes do decode', () => {
    // -326 cru como dBm seria descartado? Nao: aqui e leitura legitima apos /100.
    expect(decodeOpticalScalarDbm(-326, 'CENTI_DBM')).toBe(-3.26);
    // Fora da faixa optica real continua sendo descartado DEPOIS do decode.
    expect(decodeOpticalScalarDbm(-9999, 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalScalarDbm(9999, 'CENTI_DBM')).toBeNull();
  });

  it('S6730: scalar .8/.9 em micro-watts (665 uW => -1.77 dBm)', () => {
    expect(decodeOpticalScalarDbm(S6730.scalarRxRaw, 'MICRO_WATTS')).toBe(-1.77);
    expect(decodeOpticalScalarDbm(S6730.scalarTxRaw, 'MICRO_WATTS')).toBe(2.96);
    // Mesmo raw como centi-dBm daria outro valor (prova de que a unidade e do profile).
    expect(decodeOpticalScalarDbm(S6730.scalarRxRaw, 'CENTI_DBM')).toBe(6.65);
    // Sem luz (0 uW) nao vira leitura.
    expect(decodeOpticalScalarDbm(0, 'MICRO_WATTS')).toBeNull();
  });

  it('S6730: lanes .32/.33 em CSV DECIMAL de centi-dBm (raw / 100)', () => {
    expect(parseHuaweiOpticalLaneCsv(S6730.rxLane, S6730.txLane, S6730.bias, 'DECIMAL_CENTI_DBM', 'DECIMAL_MA'))
      .toEqual([
        { lane: 0, rxPowerDbm: -1.7679, txPowerDbm: 2.9645, biasCurrentMa: 42.76 },
        { lane: 1, rxPowerDbm: -2.2871, txPowerDbm: 2.2329, biasCurrentMa: 42.76 },
        { lane: 2, rxPowerDbm: -2.2185, txPowerDbm: 1.8153, biasCurrentMa: 42.76 },
        { lane: 3, rxPowerDbm: -3.1051, txPowerDbm: 2.8843, biasCurrentMa: 42.76 },
      ]);
    // Fixture historica do CEM-CEN-6730 (index 67502222) continua valida.
    expect(decodeOpticalLaneDbm('-1372.63', 'DECIMAL_CENTI_DBM')).toBe(-13.7263);
    expect(decodeOpticalLaneDbm('-1226.95', 'DECIMAL_CENTI_DBM')).toBe(-12.2695);
    expect(decodeOpticalLaneDbm('76.06', 'DECIMAL_CENTI_DBM')).toBe(0.7606);
  });

  it('S6730: thresholds e bias reais (ALARM .13-.16 e WARNING .20-.23 centi-dBm)', () => {
    expect(decodeOpticalThresholdDbm(S6730.rxLow, 'CENTI_DBM')).toBe(-13.6);
    expect(decodeOpticalThresholdDbm(S6730.rxHigh, 'CENTI_DBM')).toBe(5.5);
    expect(decodeOpticalThresholdDbm(S6730.rxWarnLow, 'CENTI_DBM')).toBe(-10.6);
    expect(decodeOpticalThresholdDbm(S6730.rxWarnHigh, 'CENTI_DBM')).toBe(4.5);
    expect(decodeOpticalBiasMa('42.76', 'DECIMAL_MA')).toBe(42.76);
    expect(decodeOpticalBiasMa('42757', 'MICRO_AMPS')).toBe(42.757);
    expect(decodeOpticalBiasMa('-1', 'DECIMAL_MA')).toBeNull();
    expect(decodeOpticalBiasMa('9999', 'DECIMAL_MA')).toBeNull();
  });

  it('S6750: scalar .8/.9 em centi-dBm (1 => +0.01 dBm)', () => {
    expect(decodeOpticalScalarDbm(S6750.scalarRxRaw, 'CENTI_DBM')).toBe(0.01);
    expect(decodeOpticalScalarDbm(S6750.scalarTxRaw, 'CENTI_DBM')).toBe(-0.74);
  });

  it('S6750: lanes .32/.33 ja em dBm (sem /100)', () => {
    expect(parseHuaweiOpticalLaneCsv(S6750.rxLane, S6750.txLane, S6750.bias, 'DECIMAL_DBM', 'DECIMAL_MA'))
      .toEqual([
        { lane: 0, rxPowerDbm: 0.01, txPowerDbm: -0.74, biasCurrentMa: 6.5 },
        { lane: 1, rxPowerDbm: 0.72, txPowerDbm: -0.69, biasCurrentMa: 6.5 },
        { lane: 2, rxPowerDbm: 1.05, txPowerDbm: -0.72, biasCurrentMa: 6.5 },
        { lane: 3, rxPowerDbm: 0.15, txPowerDbm: -0.73, biasCurrentMa: 6.5 },
      ]);
    // Sem luz: -40.00 dBm continua sendo LEITURA (o alarme LOW precisa dela).
    expect(decodeOpticalLaneDbm('-40.00', 'DECIMAL_DBM')).toBe(-40);
  });

  it('S6750: WARNING inexistente nunca e inventado e min/max fica UNSUPPORTED', () => {
    expect(decodeOpticalThresholdDbm(null, 'UNSUPPORTED')).toBeNull();
    expect(decodeOpticalThresholdDbm(-1030, 'UNSUPPORTED')).toBeNull();
    expect(decodeOpticalMinMaxDbm(29, 'UNSUPPORTED')).toBeNull();
    const thresholds = buildHuaweiDeviceThresholds({
      rx: { low: -12.31, high: 3.4 },
      tx: { low: -10.4, high: 3.4 },
    });
    expect(thresholds?.scalar.rx.lowWarningDbm).toBeUndefined();
    expect(thresholds?.scalar.rx.highWarningDbm).toBeUndefined();
  });

  it('sentinela de porta vazia (-1/-255/2^31-1/vazio) nunca vira threshold', () => {
    expect(decodeOpticalThresholdDbm(-1, 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm(-255, 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm(2_147_483_647, 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm(999_999, 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm('', 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm('abc', 'CENTI_DBM')).toBeNull();
    expect(decodeOpticalThresholdDbm(null, 'CENTI_DBM')).toBeNull();
  });

  it('monta o JSON canonico (DEVICE) com ALARM + WARNING do F1A', () => {
    expect(buildHuaweiDeviceThresholds({
      rx: { low: -12.3, high: 3.39 },
      tx: { low: -10.4, high: 3.39 },
      rxWarning: { low: -10.3, high: 2.39 },
      txWarning: { low: -7.6, high: 2.39 },
    })).toEqual({
      version: 1,
      scalar: {
        rx: {
          lowAlarmDbm: -12.3,
          highAlarmDbm: 3.39,
          lowWarningDbm: -10.3,
          highWarningDbm: 2.39,
          lowSource: 'DEVICE',
          highSource: 'DEVICE',
        },
        tx: {
          lowAlarmDbm: -10.4,
          highAlarmDbm: 3.39,
          lowWarningDbm: -7.6,
          highWarningDbm: 2.39,
          lowSource: 'DEVICE',
          highSource: 'DEVICE',
        },
      },
      lanes: [],
    });
  });

  it('mantem rejeicao de par incoerente e aceita ausencia parcial', () => {
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

  it('lane invalida nao quebra o poll e nao desloca as lanes seguintes', () => {
    const lanes = parseHuaweiOpticalLaneCsv(
      '-1372.63,bad,-1311.58',
      '76.06,76.68,66.62',
      '47.89,67.46,47.90',
      'DECIMAL_CENTI_DBM',
      'DECIMAL_MA',
    );
    expect(lanes).toEqual([
      { lane: 0, rxPowerDbm: -13.7263, txPowerDbm: 0.7606, biasCurrentMa: 47.89 },
      { lane: 1, rxPowerDbm: null, txPowerDbm: 0.7668, biasCurrentMa: 67.46 },
      { lane: 2, rxPowerDbm: -13.1158, txPowerDbm: 0.6662, biasCurrentMa: 47.9 },
    ]);
    expect(hasHuaweiMultiLaneCapability(lanes)).toBe(true);
  });

  it('abaixo de 2 lanes uteis o modo multi-lane e falso', () => {
    expect(hasHuaweiMultiLaneCapability([{ lane: 0, rxPowerDbm: 0.29, txPowerDbm: null }])).toBe(false);
    expect(hasHuaweiMultiLaneCapability([])).toBe(false);
  });
});

describe('capability declarada nos profiles (fonte unica)', () => {
  it('F1A agrega lanes e nao publica bias', () => {
    expect(huaweiNe8000Profile.optical?.scalarSemantics).toBe('AGGREGATED_LANES');
    expect(huaweiNe8000Profile.optical?.capabilities.laneBias).toBe(false);
    expect(huaweiNe8000Profile.optical?.capabilities.minMax).toBe(true);
  });

  it('S6730 publica bias e WARNING, mas nao min/max', () => {
    expect(huaweiS6730Profile.optical?.capabilities).toMatchObject({
      laneBias: true,
      warnings: true,
      minMax: false,
    });
  });

  it('S6750 nao publica WARNING nem min/max', () => {
    expect(huaweiS6750Profile.optical?.capabilities).toMatchObject({
      laneBias: true,
      warnings: false,
      minMax: false,
    });
  });

  it('MA5800 nao tem tabela optica (todos os walks opticos desligados)', () => {
    expect(huaweiMa5800Profile.optical?.capabilities).toMatchObject({
      table: false,
      scalarPower: false,
      alarmThresholds: false,
      laneBias: false,
      lanes: false,
      warnings: false,
      minMax: false,
    });
  });
});