import { describe, expect, it } from 'vitest';
import {
  assignOpticalThresholdSide,
  emptyHuaweiOpticalThresholds,
  emptyOpticalThresholdSide,
  hasUsefulOpticalThresholds,
  mergeOpticalThresholds,
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

  it('merge preserva lado valido e nunca apaga com valor ausente/invalido', () => {
    const existing = opticalThresholdsV1FromHuawei(
      {
        scalar: {
          rx: { lowAlarmDbm: -12.31, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null },
          tx: { lowAlarmDbm: -10.4, highAlarmDbm: 3.4, lowSource: 'USER', highSource: 'USER' },
        },
        lanes: [{ lane: 0, rx: { lowAlarmDbm: -13, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null }, tx: emptyOpticalThresholdSide() }],
      },
      [],
    );
    const incoming = opticalThresholdsV1FromHuawei(
      {
        scalar: {
          rx: { lowAlarmDbm: null, highAlarmDbm: 3.4, lowSource: null, highSource: 'DEVICE' },
          tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        },
        lanes: [
          { lane: 0, rx: { lowAlarmDbm: null, highAlarmDbm: 3.4, lowSource: null, highSource: 'DEVICE' }, tx: emptyOpticalThresholdSide() },
          { lane: 1, rx: { lowAlarmDbm: -13.5, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null }, tx: emptyOpticalThresholdSide() },
        ],
      },
      [],
    );

    const merged = mergeOpticalThresholds(existing, incoming, 'PARTIAL');
    expect(merged.scalar.rx).toEqual({
      lowAlarmDbm: -12.31, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE',
    });
    expect(merged.scalar.tx).toEqual({
      lowAlarmDbm: -10.4, highAlarmDbm: 3.4, lowSource: 'USER', highSource: 'USER',
    });
    expect(merged.lanes.map((lane) => lane.lane)).toEqual([0, 1]);
    expect(merged.lanes[0]?.rx).toMatchObject({ lowAlarmDbm: -13, highAlarmDbm: 3.4 });
    expect(merged.lanes[1]?.rx).toMatchObject({ lowAlarmDbm: -13.5 });
    // Sem registro anterior o merge devolve o proprio incoming.
    expect(mergeOpticalThresholds(null, incoming, 'PARTIAL')).toEqual(incoming);
  });

  it('PARTIAL (SNMP) nao sobrescreve USER; AUTHORITATIVE (SSH) rebaixa o USER que sumiu', () => {
    const existing = opticalThresholdsV1FromHuawei(
      {
        scalar: {
          rx: { lowAlarmDbm: -12.31, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
          tx: { lowAlarmDbm: -10.4, highAlarmDbm: 3.4, lowSource: 'USER', highSource: 'USER' },
        },
        lanes: [],
      },
      [],
    );
    const side = (low: number | null, high: number | null, source: 'DEVICE' | 'DEFAULT' | 'USER') => ({
      lowAlarmDbm: low,
      highAlarmDbm: high,
      lowSource: low === null ? null : source,
      highSource: high === null ? null : source,
    });

    // SNMP (.13-.16) e leitura PARTIAL: renova DEVICE, nunca toca no USER.
    const snmpRead = opticalThresholdsV1FromHuawei({
      scalar: {
        rx: side(-12.5, 3.5, 'DEVICE'),
        tx: side(-11.1, 4.1, 'DEVICE'),
      },
      lanes: [],
    }, []);
    const afterSnmp = mergeOpticalThresholds(existing, snmpRead, 'PARTIAL');
    expect(afterSnmp.scalar.rx).toEqual(side(-12.5, 3.5, 'DEVICE'));
    expect(afterSnmp.scalar.tx).toEqual(existing.scalar.tx);

    // Um USER SET com valor novo continua vencendo (rank igual, leitura nova).
    const snmpNewerUserValues = mergeOpticalThresholds(
      existing,
      opticalThresholdsV1FromHuawei(
        { scalar: { rx: side(null, null, 'USER'), tx: side(-10.9, 3.9, 'USER') }, lanes: [] },
        [],
      ),
      'AUTHORITATIVE',
    );
    expect(snmpNewerUserValues.scalar.tx).toEqual(side(-10.9, 3.9, 'USER'));

    // SSH verboso e AUTHORITATIVE: o CLI provou que o User Set saiu do equipamento.
    const sshRead = opticalThresholdsV1FromHuawei({
      scalar: {
        // DEFAULT do CLI nao rebaixa um DEVICE valido vindo do SNMP...
        rx: side(-13, -1, 'DEFAULT'),
        // ...mas rebaixa o USER que desapareceu.
        tx: side(-10.4, 3.4, 'DEVICE'),
      },
      lanes: [],
    }, []);
    const afterSsh = mergeOpticalThresholds(existing, sshRead, 'AUTHORITATIVE');
    expect(afterSsh.scalar.rx).toEqual(side(-12.31, 3.4, 'DEVICE'));
    expect(afterSsh.scalar.tx).toEqual(side(-10.4, 3.4, 'DEVICE'));

    const sshDefaultAfterUser = mergeOpticalThresholds(
      existing,
      opticalThresholdsV1FromHuawei(
        { scalar: { rx: side(null, null, 'DEVICE'), tx: side(-10.4, 3.4, 'DEFAULT') }, lanes: [] },
        [],
      ),
      'AUTHORITATIVE',
    );
    expect(sshDefaultAfterUser.scalar.tx).toEqual(side(-10.4, 3.4, 'DEFAULT'));
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
