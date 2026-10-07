import { describe, expect, it } from 'vitest';
import {
  assignOpticalThresholdSide,
  emptyHuaweiOpticalThresholds,
  emptyOpticalThresholdSide,
  hasUsefulOpticalThresholds,
  opticalThresholdsLayoutChanged,
  opticalThresholdsV1FromHuawei,
  parseOpticalThresholdsV1,
  summaryOpticalThresholdSource,
} from './optical-thresholds';

describe('canonical optical thresholds', () => {
  it('applies USER SET > DEVICE > DEFAULT without overwriting an equal source', () => {
    const side = emptyOpticalThresholdSide();
    assignOpticalThresholdSide(side, 'low', -14, 'DEFAULT');
    expect(side).toEqual({ lowAlarmDbm: -14, highAlarmDbm: null, lowSource: 'DEFAULT', highSource: null });

    assignOpticalThresholdSide(side, 'low', -13, 'USER');
    expect(side.lowAlarmDbm).toBe(-13);
    expect(side.lowSource).toBe('USER');

    // DEFAULT nao rebaixa um valor de USER ja lido.
    assignOpticalThresholdSide(side, 'low', -15, 'DEFAULT');
    expect(side.lowAlarmDbm).toBe(-13);
    expect(side.lowSource).toBe('USER');

    const device = emptyOpticalThresholdSide();
    assignOpticalThresholdSide(device, 'high', -1, 'DEVICE');
    assignOpticalThresholdSide(device, 'high', -2, 'DEVICE');
    expect(device.highAlarmDbm).toBe(-1);
  });

  it('builds the versioned structure keeping observed lane layout', () => {
    const parsed = emptyHuaweiOpticalThresholds();
    assignOpticalThresholdSide(parsed.scalar.rx, 'low', -14, 'DEVICE');
    parsed.lanes.push({
      lane: 2,
      rx: { lowAlarmDbm: -15, highAlarmDbm: -2, lowSource: 'USER', highSource: 'USER' },
      tx: emptyOpticalThresholdSide(),
    });

    const thresholds = opticalThresholdsV1FromHuawei(parsed, [0, 1, 2]);
    expect(thresholds.version).toBe(1);
    expect(thresholds.lanes.map((lane) => lane.lane)).toEqual([0, 1, 2]);
    expect(thresholds.lanes[2]?.rx.lowSource).toBe('USER');
    expect(thresholds.lanes[0]?.rx).toEqual({
      lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null,
    });
    expect(summaryOpticalThresholdSource(thresholds)).toBe('USER');
    expect(hasUsefulOpticalThresholds(parsed)).toBe(true);
  });

  it('detects layout change only when the stored record already has lanes', () => {
    expect(opticalThresholdsLayoutChanged(null, [0, 1, 2, 3])).toBe(false);
    const scalarOnly = opticalThresholdsV1FromHuawei(emptyHuaweiOpticalThresholds(), []);
    expect(opticalThresholdsLayoutChanged(scalarOnly, [0, 1, 2, 3])).toBe(false);
    const withLanes = opticalThresholdsV1FromHuawei(emptyHuaweiOpticalThresholds(), [0, 1]);
    expect(opticalThresholdsLayoutChanged(withLanes, [0, 1])).toBe(false);
    expect(opticalThresholdsLayoutChanged(withLanes, [0, 1, 2, 3])).toBe(true);
    expect(opticalThresholdsLayoutChanged(withLanes, [])).toBe(false);
  });

  it('rejects malformed or future JSON versions from the database column', () => {
    const valid = opticalThresholdsV1FromHuawei(emptyHuaweiOpticalThresholds(), []);
    expect(parseOpticalThresholdsV1(valid)).toEqual(valid);
    expect(parseOpticalThresholdsV1(null)).toBeNull();
    expect(parseOpticalThresholdsV1({ version: 2 })).toBeNull();
    expect(parseOpticalThresholdsV1({ version: 1, scalar: {}, lanes: [] })).toBeNull();
    expect(parseOpticalThresholdsV1({ ...valid, lanes: [{ lane: -1, rx: valid.scalar.rx, tx: valid.scalar.tx }] }))
      .toBeNull();
  });
});
