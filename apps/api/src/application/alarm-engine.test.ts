import { describe, expect, it, vi } from 'vitest';
import type { Alarm, NetworkInterface } from '@gmj/shared';
import {
  AlarmEngine,
  consecutiveMatch,
  evaluateSamplePair,
  metricAlarmMessage,
  ruleMatchesInterface,
} from './alarm-engine';
import type { AlarmRepository, MetricAlarmOpenInput } from '../infrastructure/alarms/alarm-repository';
import type { AlarmRuleRecord, AlarmRuleRepository } from '../infrastructure/alarms/alarm-rule-repository';
import type { HostRepository, InterfaceMetricWindowRow } from '../infrastructure/persistence/host-repository';

const NOW = new Date('2026-10-07T12:00:00.000Z');

function networkInterfaceAt(
  id: string,
  ifIndex: number,
  speedBps = 10_000_000_000,
): NetworkInterface {
  return {
    id,
    deviceId: 'dev-1',
    name: `GE${ifIndex}`,
    alias: 'CLIENTE-X',
    description: '',
    ifIndex,
    mac: '',
    mtu: 1500,
    speedBps,
    adminStatus: 'UP',
    operStatus: 'UP',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    dataSources: ['SNMP'],
  };
}

function ruleOf(overrides: Partial<AlarmRuleRecord> = {}): AlarmRuleRecord {
  return {
    id: 'rule-1',
    name: 'Erros RX',
    type: 'INTERFACE_ERRORS',
    enabled: true,
    severity: 'MAJOR',
    mapLinkedOnly: false,
    mediaEnabled: false,
    scope: {},
    config: {
      direction: 'RX',
      thresholdPerMinute: 50,
      recoveryThresholdPerMinute: 10,
      triggerSamples: 3,
      recoverySamples: 3,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rowAt(
  interfaceId: string,
  minutesAgo: number,
  overrides: Partial<InterfaceMetricWindowRow> = {},
): InterfaceMetricWindowRow {
  return {
    interfaceId,
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
    inErrors: 0n,
    outErrors: 0n,
    inDiscards: 0n,
    outDiscards: 0n,
    inErrorsDelta: 0n,
    outErrorsDelta: 0n,
    inDiscardsDelta: 0n,
    outDiscardsDelta: 0n,
    fcsErrors: null,
    fcsErrorsDelta: null,
    ...overrides,
  };
}

/** 4 amostras (3 pares) de 1 min com os deltas informados, contador sempre subindo. */
function errorWindow(interfaceId: string, deltas: bigint[]): InterfaceMetricWindowRow[] {
  const rows: InterfaceMetricWindowRow[] = [];
  let raw = 1_000n;
  rows.push(rowAt(interfaceId, deltas.length, { inErrors: raw, inErrorsDelta: 0n }));
  deltas.forEach((delta, index) => {
    raw += delta;
    rows.push(
      rowAt(interfaceId, deltas.length - 1 - index, {
        inErrors: raw,
        inErrorsDelta: delta,
      }),
    );
  });
  return rows;
}

function openedAlarm(input: MetricAlarmOpenInput, id = 'alarm-created'): Alarm {
  return {
    id,
    deviceId: input.deviceId,
    deviceName: 'F1A',
    interfaceId: input.interfaceId,
    interfaceName: 'GE1',
    interfaceLabel: 'CLIENTE-X',
    ifIndex: input.ifIndex,
    linkId: null,
    linkLabel: null,
    type: input.type,
    severity: input.severity,
    startedAt: input.startedAt.toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    message: input.message,
    ruleId: input.ruleId,
    metricKey: input.metricKey,
    currentValue: input.currentValue,
    thresholdValue: input.thresholdValue,
    unit: input.unit,
    metadata: input.metadata,
  };
}

function buildEngine(options: {
  rules: AlarmRuleRecord[];
  rows?: InterfaceMetricWindowRow[];
  open?: Alarm[];
  linked?: Set<string>;
}) {
  const listEnabled = vi.fn().mockResolvedValue(options.rules);
  const openMetricAlarm = vi
    .fn()
    .mockImplementation(async (input: MetricAlarmOpenInput) => openedAlarm(input));
  const resolveMetricAlarm = vi.fn().mockResolvedValue(true);
  const listOpenMetricAlarms = vi.fn().mockResolvedValue(options.open ?? []);
  const findLinkedInterfaceIds = vi.fn().mockResolvedValue(options.linked ?? new Set<string>());
  const getRecentInterfaceMetricSamples = vi.fn().mockResolvedValue(options.rows ?? []);

  const engine = new AlarmEngine({
    hosts: { getRecentInterfaceMetricSamples } as unknown as HostRepository,
    alarms: {
      openMetricAlarm,
      resolveMetricAlarm,
      listOpenMetricAlarms,
      findLinkedInterfaceIds,
    } as unknown as AlarmRepository,
    rules: { listEnabled } as unknown as AlarmRuleRepository,
    now: () => NOW,
  });

  return {
    engine,
    listEnabled,
    openMetricAlarm,
    resolveMetricAlarm,
    listOpenMetricAlarms,
    findLinkedInterfaceIds,
    getRecentInterfaceMetricSamples,
  };
}

const IFACE = networkInterfaceAt('if-1', 1);

describe('avaliacao de uma transicao (evaluateSamplePair)', () => {
  it('normaliza a taxa pelo intervalo real', () => {
    const evaluation = evaluateSamplePair(
      { timestampMs: NOW.getTime() - 60_000, value: 100n, delta: 0n },
      { timestampMs: NOW.getTime(), value: 400n, delta: 300n },
    );
    expect(evaluation).toMatchObject({ valid: true, reason: 'OK', intervalSeconds: 60 });
    expect(evaluation.ratePerMinute).toBe(300);
  });

  it('ignora intervalo nao positivo', () => {
    const evaluation = evaluateSamplePair(
      { timestampMs: NOW.getTime(), value: 100n, delta: 0n },
      { timestampMs: NOW.getTime(), value: 400n, delta: 300n },
    );
    expect(evaluation).toMatchObject({ valid: false, reason: 'INVALID_INTERVAL' });
  });

  it('ignora reset/descontinuidade (contador voltando sem wrap plausivel)', () => {
    const evaluation = evaluateSamplePair(
      { timestampMs: NOW.getTime() - 60_000, value: 7_054n, delta: 0n },
      { timestampMs: NOW.getTime(), value: 4n, delta: 4n },
    );
    expect(evaluation).toMatchObject({ valid: false, reason: 'RESET_OR_DISCONTINUITY' });
  });

  it('aceita wrap plausivel de Counter32 usando o delta persistido', () => {
    const evaluation = evaluateSamplePair(
      { timestampMs: NOW.getTime() - 60_000, value: 0xffff_ffe0n, delta: 0n },
      { timestampMs: NOW.getTime(), value: 5n, delta: 37n },
    );
    expect(evaluation).toMatchObject({ valid: true, reason: 'OK' });
    expect(evaluation.ratePerMinute).toBe(37);
  });

  it('ignora quando o delta nao foi coletado', () => {
    const evaluation = evaluateSamplePair(
      { timestampMs: NOW.getTime() - 60_000, value: 100n, delta: null },
      { timestampMs: NOW.getTime(), value: 400n, delta: null },
    );
    expect(evaluation).toMatchObject({ valid: false, reason: 'NO_DELTA' });
  });
});

describe('consecutiveMatch (anti-flap)', () => {
  const valid = (rate: number) => ({
    valid: true,
    reason: 'OK' as const,
    intervalSeconds: 60,
    delta: BigInt(rate),
    ratePerMinute: rate,
  });

  it('exige a cauda inteira valida e acima do limiar', () => {
    expect(consecutiveMatch([valid(60), valid(70), valid(80)], (rate) => rate >= 50, 3)).toBe(true);
    expect(consecutiveMatch([valid(80), valid(80)], (rate) => rate >= 50, 3)).toBe(false);
    expect(consecutiveMatch([valid(80), valid(20), valid(80)], (rate) => rate >= 50, 3)).toBe(false);
  });

  it('quebra a sequencia quando ha amostra invalida na cauda', () => {
    const invalid = {
      valid: false,
      reason: 'RESET_OR_DISCONTINUITY' as const,
      intervalSeconds: 60,
      delta: 0n,
      ratePerMinute: 0,
    };
    expect(consecutiveMatch([valid(80), valid(80), invalid], (rate) => rate >= 50, 2)).toBe(false);
  });
});

describe('ruleMatchesInterface', () => {
  it('respeita devices, interfaces, velocidade e mapLinkedOnly', () => {
    expect(ruleMatchesInterface(ruleOf({ scope: { devices: ['outro'] } }), 'dev-1', IFACE, null)).toBe(false);
    expect(ruleMatchesInterface(ruleOf({ scope: { devices: ['dev-1'] } }), 'dev-1', IFACE, null)).toBe(true);
    expect(ruleMatchesInterface(ruleOf({ scope: { interfaces: ['if-9'] } }), 'dev-1', IFACE, null)).toBe(false);
    expect(
      ruleMatchesInterface(ruleOf({ scope: { speedsBps: [1_000_000_000] } }), 'dev-1', IFACE, null),
    ).toBe(false);
    expect(
      ruleMatchesInterface(
        ruleOf({ scope: { speedsBps: [10_000_000_000] } }),
        'dev-1',
        IFACE,
        null,
      ),
    ).toBe(true);
    expect(ruleMatchesInterface(ruleOf({ mapLinkedOnly: true }), 'dev-1', IFACE, new Set())).toBe(false);
    expect(
      ruleMatchesInterface(ruleOf({ mapLinkedOnly: true }), 'dev-1', IFACE, new Set(['if-1'])),
    ).toBe(true);
  });
});

describe('mensagem do alarme', () => {
  it('descreve metrica, taxa e limite', () => {
    expect(
      metricAlarmMessage({
        deviceName: 'F1A',
        interfaceLabel: 'CLIENTE-X',
        interfaceName: 'GE1/0/1',
        type: 'INTERFACE_ERRORS',
        direction: 'RX',
        ratePerMinute: 62.5,
        thresholdPerMinute: 50,
      }),
    ).toBe('F1A: CLIENTE-X (GE1/0/1) — RX errors 62.5/min (limite 50/min)');
    expect(
      metricAlarmMessage({
        deviceName: 'F1A',
        interfaceLabel: 'CLIENTE-X',
        interfaceName: 'GE1/0/1',
        type: 'INTERFACE_CRC',
        direction: 'RX',
        ratePerMinute: 3,
        thresholdPerMinute: 1,
      }),
    ).toBe('F1A: CLIENTE-X (GE1/0/1) — CRC/FCS 3/min (limite 1/min)');
  });
});

describe('AlarmEngine — trigger/recovery/dedupe', () => {
  it('abre apos triggerSamples amostras acima do limiar, com fingerprint e metadata', async () => {
    const { engine, openMetricAlarm } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
    });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });

    expect(openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(openMetricAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        type: 'INTERFACE_ERRORS',
        metricKey: 'RX',
        severity: 'MAJOR',
        unit: 'per_min',
        currentValue: 300,
        thresholdValue: 50,
        startedAt: NOW,
      }),
    );
    const input = openMetricAlarm.mock.calls[0]?.[0] as MetricAlarmOpenInput;
    expect(input.metadata).toMatchObject({
      direction: 'RX',
      ratePerMinute: 300,
      thresholdPerMinute: 50,
      sampleIntervalSeconds: 60,
    });
    expect(input.message).toContain('RX errors 300/min (limite 50/min)');
    expect(input.message).toContain('CLIENTE-X');
  });

  it('nao abre com menos amostras que o triggerSamples', async () => {
    const { engine, openMetricAlarm } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n, 300n]),
    });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });
    expect(openMetricAlarm).not.toHaveBeenCalled();
  });

  it('nao duplica quando ja existe alarme aberto do mesmo fingerprint', async () => {
    const open = openedAlarm({
      deviceId: 'dev-1',
      interfaceId: 'if-1',
      ifIndex: 1,
      ruleId: 'rule-1',
      type: 'INTERFACE_ERRORS',
      severity: 'MAJOR',
      metricKey: 'RX',
      currentValue: 300,
      thresholdValue: 50,
      unit: 'per_min',
      metadata: {},
      message: 'aberto',
      startedAt: new Date(NOW.getTime() - 300_000),
    });
    const { engine, openMetricAlarm, resolveMetricAlarm } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
      open: [open],
    });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });
    expect(openMetricAlarm).not.toHaveBeenCalled();
    expect(resolveMetricAlarm).not.toHaveBeenCalled();
  });

  it('resolve apos recoverySamples amostras abaixo do limiar de recuperacao', async () => {
    const open = openedAlarm({
      deviceId: 'dev-1',
      interfaceId: 'if-1',
      ifIndex: 1,
      ruleId: 'rule-1',
      type: 'INTERFACE_ERRORS',
      severity: 'MAJOR',
      metricKey: 'RX',
      currentValue: 300,
      thresholdValue: 50,
      unit: 'per_min',
      metadata: {},
      message: 'aberto',
      startedAt: new Date(NOW.getTime() - 300_000),
    });
    const { engine, openMetricAlarm, resolveMetricAlarm } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [5n, 2n, 0n]),
      open: [open],
    });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });

    expect(resolveMetricAlarm).toHaveBeenCalledWith('if-1', 'INTERFACE_ERRORS', 'RX', NOW);
    expect(openMetricAlarm).not.toHaveBeenCalled();
  });

  it('reset no meio da janela quebra a sequencia e nao abre', async () => {
    const rows = [
      rowAt('if-1', 3, { inErrors: 100n, inErrorsDelta: 0n }),
      rowAt('if-1', 2, { inErrors: 400n, inErrorsDelta: 300n }),
      rowAt('if-1', 1, { inErrors: 50n, inErrorsDelta: 50n }),
      rowAt('if-1', 0, { inErrors: 350n, inErrorsDelta: 300n }),
    ];
    const { engine, openMetricAlarm } = buildEngine({ rules: [ruleOf()], rows });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });
    expect(openMetricAlarm).not.toHaveBeenCalled();
  });

  it('aceita wrap de 32 bits dentro da janela (nao trata como reset)', async () => {
    const rows = [
      rowAt('if-1', 3, { inErrors: 0xffff_fff0n, inErrorsDelta: 0n }),
      rowAt('if-1', 2, { inErrors: 0xffff_ffffn, inErrorsDelta: 15n }),
      rowAt('if-1', 1, { inErrors: 5n, inErrorsDelta: 6n }),
      rowAt('if-1', 0, { inErrors: 25n, inErrorsDelta: 20n }),
    ];
    const rule = ruleOf({
      config: {
        direction: 'RX',
        thresholdPerMinute: 5,
        recoveryThresholdPerMinute: 1,
        triggerSamples: 3,
        recoverySamples: 3,
      },
    });
    const { engine, openMetricAlarm } = buildEngine({ rules: [rule], rows });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });
    expect(openMetricAlarm).toHaveBeenCalledTimes(1);
  });

  it('direction BOTH abre um alarme por direcao', async () => {
    const rows = errorWindow('if-1', [300n, 300n, 300n]).map((row) => ({
      ...row,
      outErrors: row.inErrors,
      outErrorsDelta: row.inErrorsDelta,
    }));
    const rule = ruleOf({
      config: {
        direction: 'BOTH',
        thresholdPerMinute: 50,
        recoveryThresholdPerMinute: 10,
        triggerSamples: 3,
        recoverySamples: 3,
      },
    });
    const { engine, openMetricAlarm } = buildEngine({ rules: [rule], rows });

    await engine.processDeviceMetrics({ deviceId: 'dev-1', deviceName: 'F1A', interfaces: [IFACE] });

    expect(openMetricAlarm).toHaveBeenCalledTimes(2);
    const keys = openMetricAlarm.mock.calls.map(
      (call) => (call[0] as MetricAlarmOpenInput).metricKey,
    );
    expect(keys).toEqual(['RX', 'TX']);
  });

  it('CRC so avalia quando fcsErrors foi coletado (null = sem suporte)', async () => {
    const crcRule = ruleOf({
      type: 'INTERFACE_CRC',
      config: {
        thresholdPerMinute: 50,
        recoveryThresholdPerMinute: 10,
        triggerSamples: 3,
        recoverySamples: 3,
      },
    });
    const withoutFcs = buildEngine({
      rules: [crcRule],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
    });
    await withoutFcs.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(withoutFcs.openMetricAlarm).not.toHaveBeenCalled();

    const withFcs = buildEngine({
      rules: [crcRule],
      rows: errorWindow('if-1', [300n, 300n, 300n]).map((row) => ({
        ...row,
        fcsErrors: row.inErrors,
        fcsErrorsDelta: row.inErrorsDelta,
      })),
    });
    await withFcs.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(withFcs.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect((withFcs.openMetricAlarm.mock.calls[0]?.[0] as MetricAlarmOpenInput).metricKey).toBe('FCS');
  });

  it('mapLinkedOnly respeita os links do mapa', async () => {
    const linkedRule = ruleOf({ mapLinkedOnly: true });
    const unlinked = buildEngine({ rules: [linkedRule], rows: errorWindow('if-1', [300n, 300n, 300n]) });
    await unlinked.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(unlinked.findLinkedInterfaceIds).toHaveBeenCalledWith(['if-1']);
    expect(unlinked.openMetricAlarm).not.toHaveBeenCalled();

    const linked = buildEngine({
      rules: [linkedRule],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
      linked: new Set(['if-1']),
    });
    await linked.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(linked.openMetricAlarm).toHaveBeenCalledTimes(1);
  });

  it('sem regras aplicaveis nao le amostras nem alarmes', async () => {
    const none = buildEngine({ rules: [] });
    await none.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(none.getRecentInterfaceMetricSamples).not.toHaveBeenCalled();
    expect(none.listOpenMetricAlarms).not.toHaveBeenCalled();
  });
});
