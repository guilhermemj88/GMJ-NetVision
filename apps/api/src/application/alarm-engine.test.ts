import { describe, expect, it, vi } from 'vitest';
import type { Alarm, NetworkInterface, OpticalRuleConfig } from '@gmj/shared';
import {
  AlarmEngine,
  consecutiveMatch,
  evaluateSamplePair,
  metricAlarmMessage,
  opticalLadderFor,
  opticalProximityPercent,
  opticalTrendDropDb,
  ruleMatchesInterface,
  thresholdTriggerPredicate,
} from './alarm-engine';
import type {
  AlarmRepository,
  MetricAlarmEscalationInput,
  MetricAlarmOpenInput,
} from '../infrastructure/alarms/alarm-repository';
import type {
  AlarmSuppressionRecord,
  AlarmSuppressionRepository,
} from '../infrastructure/alarms/alarm-suppression-repository';
import type { AlarmRuleRecord, AlarmRuleRepository } from '../infrastructure/alarms/alarm-rule-repository';
import type {
  HostRepository,
  InterfaceMetricWindowRow,
  InterfaceOpticalThresholdRecord,
  InterfaceOpticalWindowRow,
} from '../infrastructure/persistence/host-repository';

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
    managedKey: null,
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

function notifierMock() {
  return {
    notifyOpened: vi.fn().mockResolvedValue(undefined),
    notifyEscalated: vi.fn().mockResolvedValue(undefined),
    notifyResolved: vi.fn().mockResolvedValue(undefined),
  };
}

function buildEngine(options: {
  rules: AlarmRuleRecord[];
  rows?: InterfaceMetricWindowRow[];
  open?: Alarm[];
  linked?: Set<string>;
  notifier?: ReturnType<typeof notifierMock>;
  suppressions?: AlarmSuppressionRecord[];
}) {
  const listEnabled = vi.fn().mockResolvedValue(options.rules);
  const openMetricAlarm = vi
    .fn()
    .mockImplementation(async (input: MetricAlarmOpenInput) => openedAlarm(input));
  const resolveMetricAlarm = vi.fn().mockResolvedValue(true);
  const listOpenMetricAlarms = vi.fn().mockResolvedValue(options.open ?? []);
  const findLinkedInterfaceIds = vi.fn().mockResolvedValue(options.linked ?? new Set<string>());
  const getRecentInterfaceMetricSamples = vi.fn().mockResolvedValue(options.rows ?? []);
  const notifier = options.notifier ?? notifierMock();
  const listActiveSuppressions = vi.fn().mockResolvedValue(options.suppressions ?? []);
  const clearSuppression = vi
    .fn()
    .mockImplementation(async () => options.suppressions?.[0] ?? null);
  const expireDue = vi.fn().mockResolvedValue(0);

  const engine = new AlarmEngine({
    hosts: { getRecentInterfaceMetricSamples } as unknown as HostRepository,
    alarms: {
      openMetricAlarm,
      resolveMetricAlarm,
      listOpenMetricAlarms,
      findLinkedInterfaceIds,
    } as unknown as AlarmRepository,
    rules: { listEnabled } as unknown as AlarmRuleRepository,
    suppressions: {
      listActive: listActiveSuppressions,
      clear: clearSuppression,
      expireDue,
    } as unknown as AlarmSuppressionRepository,
    notifier,
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
    notifier,
    listActiveSuppressions,
    clearSuppression,
    expireDue,
  };
}

/** Supressao ativa do fingerprint do alarme aberto pela janela de erros RX. */
function suppressionOf(overrides: Partial<AlarmSuppressionRecord> = {}): AlarmSuppressionRecord {
  return {
    id: 'sup-1',
    fingerprint: 'if-1|INTERFACE_ERRORS|rule-1|RX',
    deviceId: 'dev-1',
    interfaceId: 'if-1',
    type: 'INTERFACE_ERRORS',
    ruleId: 'rule-1',
    metricKey: 'RX',
    mode: 'UNTIL_CLEAR',
    reason: 'INTENTIONAL_SHUTDOWN',
    note: null,
    suppressedAt: NOW,
    suppressedBy: 'qa-preview',
    expiresAt: null,
    clearedAt: null,
    clearedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
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

const OPTICAL_RULE_ID = 'rule-opt';

function opticalConfig(overrides: Partial<OpticalRuleConfig> = {}): OpticalRuleConfig {
  return {
    warningProximityPercent: 90,
    majorProximityPercent: 95,
    criticalAtLowAlarm: true,
    warningTriggerSamples: 3,
    majorTriggerSamples: 2,
    criticalTriggerSamples: 1,
    warningMarginDb: 3,
    recoveryProximityPercent: 85,
    recoverySamples: 3,
    trendDropDb: 3,
    trendMajorDropDb: 5,
    trendWindowMinutes: 30,
    ...overrides,
  };
}

function opticalRuleOf(overrides: Partial<AlarmRuleRecord> = {}): AlarmRuleRecord {
  return {
    id: OPTICAL_RULE_ID,
    name: 'RX optico',
    type: 'OPTICAL_RX_DEGRADATION',
    enabled: true,
    severity: 'WARNING',
    mapLinkedOnly: false,
    mediaEnabled: false,
    scope: {},
    config: opticalConfig(),
    managedKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function opticalInterface(
  overrides: Partial<NetworkInterface> = {},
): NetworkInterface {
  return {
    ...networkInterfaceAt('if-1', 1, 100_000_000_000),
    rxPowerDbm: -12,
    opticalSource: 'SNMP',
    opticalUpdatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function opticalRow(
  minutesAgo: number,
  rxPowerDbm: number | null,
  interfaceId = 'if-1',
): InterfaceOpticalWindowRow {
  return {
    interfaceId,
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
    rxPowerDbm,
    txPowerDbm: null,
    opticalLanes: [],
  };
}

function laneRow(
  minutesAgo: number,
  lanePowers: Record<number, number | null>,
  interfaceId = 'if-1',
): InterfaceOpticalWindowRow {
  return {
    interfaceId,
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
    rxPowerDbm: null,
    txPowerDbm: null,
    opticalLanes: Object.entries(lanePowers).map(([lane, rxPowerDbm]) => ({
      lane: Number(lane),
      rxPowerDbm,
      txPowerDbm: null,
    })),
  };
}

function thresholdSide(low: number | null, high: number | null) {
  return {
    lowAlarmDbm: low,
    highAlarmDbm: high,
    lowSource: low === null ? null : ('DEVICE' as const),
    highSource: high === null ? null : ('DEVICE' as const),
  };
}

function thresholdRecord(
  low: number | null,
  high: number | null,
  lanes: Array<{ lane: number; low: number | null; high: number | null }> = [],
  interfaceId = 'if-1',
): InterfaceOpticalThresholdRecord {
  return {
    interfaceId,
    thresholds: {
      version: 1,
      scalar: { rx: thresholdSide(low, high), tx: thresholdSide(null, null) },
      lanes: lanes.map((lane) => ({
        lane: lane.lane,
        rx: thresholdSide(lane.low, lane.high),
        tx: thresholdSide(null, null),
      })),
    },
    source: 'DEVICE',
    updatedAt: NOW,
    refreshAfter: NOW,
  };
}

function existingOpticalAlarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    ...openedAlarm({
      deviceId: 'dev-1',
      interfaceId: 'if-1',
      ifIndex: 1,
      ruleId: OPTICAL_RULE_ID,
      type: 'OPTICAL_RX_DEGRADATION',
      severity: 'WARNING',
      metricKey: 'RX',
      currentValue: 90,
      thresholdValue: 90,
      unit: '%',
      metadata: {},
      message: 'RX optico com proximidade 90%',
      startedAt: NOW,
    }),
    ...overrides,
  };
}

function buildOpticalEngine(options: {
  rules?: AlarmRuleRecord[];
  rows?: InterfaceOpticalWindowRow[];
  thresholds?: InterfaceOpticalThresholdRecord[];
  open?: Alarm[];
  notifier?: ReturnType<typeof notifierMock>;
}) {
  const listEnabled = vi.fn().mockResolvedValue(options.rules ?? [opticalRuleOf()]);
  const openMetricAlarm = vi
    .fn()
    .mockImplementation(async (input: MetricAlarmOpenInput) => openedAlarm(input, 'alarm-opt'));
  const escalateMetricAlarm = vi.fn().mockImplementation(
    async (id: string, input: MetricAlarmEscalationInput) =>
      existingOpticalAlarm({ id, severity: input.severity }),
  );
  const resolveMetricAlarm = vi.fn().mockResolvedValue(true);
  const listOpenMetricAlarms = vi.fn().mockResolvedValue(options.open ?? []);
  const findLinkedInterfaceIds = vi.fn().mockResolvedValue(new Set<string>());
  const getRecentInterfaceOpticalSamples = vi.fn().mockResolvedValue(options.rows ?? []);
  const getInterfaceOpticalThresholds = vi.fn().mockResolvedValue(options.thresholds ?? []);
  const notifier = options.notifier ?? notifierMock();

  const engine = new AlarmEngine({
    hosts: {
      getRecentInterfaceOpticalSamples,
      getInterfaceOpticalThresholds,
    } as unknown as HostRepository,
    alarms: {
      openMetricAlarm,
      escalateMetricAlarm,
      resolveMetricAlarm,
      listOpenMetricAlarms,
      findLinkedInterfaceIds,
    } as unknown as AlarmRepository,
    rules: { listEnabled } as unknown as AlarmRuleRepository,
    notifier,
    now: () => NOW,
  });

  return {
    engine,
    openMetricAlarm,
    escalateMetricAlarm,
    resolveMetricAlarm,
    listOpenMetricAlarms,
    getRecentInterfaceOpticalSamples,
    getInterfaceOpticalThresholds,
    notifier,
  };
}

/** low -14 / high -1 => 13 dB de faixa: cada 1% de proximidade = 0.13 dB. */
function round2optical(value: number): number {
  return Math.round(value * 100) / 100;
}
const OPTICAL_THRESHOLDS = thresholdRecord(-14, -1);
const atProximity = (percent: number) => round2optical(-1 - percent * 0.13);

describe('motor optico (OPTICAL_RX_DEGRADATION)', () => {
  it('abre WARNING com 3 amostras opticas na proximidade de 90% e publica a formula real', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(10, atProximity(90)), opticalRow(5, atProximity(90)), opticalRow(0, atProximity(90))],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    });

    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      type: 'OPTICAL_RX_DEGRADATION',
      severity: 'WARNING',
      metricKey: 'RX',
      currentValue: 90,
      thresholdValue: 90,
      unit: '%',
      metadata: {
        direction: 'RX',
        rxPowerDbm: -12.7,
        rxLowAlarmDbm: -14,
        rxHighAlarmDbm: -1,
        marginDb: 1.3,
        proximityPercent: 90,
        currentPowerSource: 'SNMP',
        thresholdSource: 'DEVICE',
        trendDropDb: 0,
        trendWindowMinutes: 30,
        speedBps: 100_000_000_000,
      },
    });
  });

  it('nao dispara com 89% de proximidade (nunca usa low * 0.9 como threshold)', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(10, atProximity(89)), opticalRow(5, atProximity(89)), opticalRow(0, atProximity(89))],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(89) })],
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
  });

  it('escala para MAJOR com 2 amostras em 95% e para CRITICAL no Low Alarm com 1 amostra', async () => {
    const major = buildOpticalEngine({
      rows: [opticalRow(5, atProximity(95)), opticalRow(0, atProximity(95))],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await major.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(95) })],
    });
    expect(major.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'MAJOR', unit: '%', currentValue: 95, thresholdValue: 95,
    });

    const critical = buildOpticalEngine({
      rows: [opticalRow(0, -14.2)],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await critical.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -14.2 })],
    });
    expect(critical.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'CRITICAL', unit: 'dBm', currentValue: -14.2, thresholdValue: -14,
    });
  });

  it('resolve o alarme depois de 3 amostras com proximidade <= 85%', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(10, atProximity(84)), opticalRow(5, atProximity(84)), opticalRow(0, atProximity(84))],
      thresholds: [OPTICAL_THRESHOLDS],
      open: [existingOpticalAlarm({ severity: 'CRITICAL' })],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(84) })],
    });
    expect(built.resolveMetricAlarm).toHaveBeenCalledWith('if-1', 'OPTICAL_RX_DEGRADATION', 'RX', NOW);
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
    expect(built.escalateMetricAlarm).not.toHaveBeenCalled();
  });

  it('usa a margem quando o equipamento so informa o Low Alarm', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(10, -18), opticalRow(5, -18), opticalRow(0, -18)],
      thresholds: [thresholdRecord(-20, null)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -18 })],
    });
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'WARNING',
      unit: 'dB',
      currentValue: 2,
      thresholdValue: 3,
      metadata: { marginDb: 2, proximityPercent: null, rxLowAlarmDbm: -20, rxHighAlarmDbm: null },
    });
  });

  it('dispara por trend (queda >= 3 dB em 30 min) sem nenhum threshold', async () => {
    const built = buildOpticalEngine({
      rows: [
        opticalRow(25, -8),
        opticalRow(20, -9),
        opticalRow(15, -10),
        opticalRow(10, -11),
        opticalRow(5, -11.5),
        opticalRow(0, -11.6),
      ],
      thresholds: [],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -11.6 })],
    });
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'WARNING',
      unit: 'dB',
      currentValue: 3.6,
      thresholdValue: 3,
      metadata: {
        trendDropDb: 3.6,
        trendWindowMinutes: 30,
        thresholdSource: null,
      },
    });
    expect(built.openMetricAlarm.mock.calls[0]?.[0]?.message).toContain('caiu 3.6 dB em 30 min');
  });

  it('nao inventa alarme sem threshold e sem tendencia', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(10, -12), opticalRow(5, -12), opticalRow(0, -12)],
      thresholds: [],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -12 })],
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
    expect(built.getInterfaceOpticalThresholds).toHaveBeenCalled();
  });

  it('isola a lane degradada e nao duplica o scalar no modo lane', async () => {
    const built = buildOpticalEngine({
      rows: [
        laneRow(10, { 0: -4, 1: -4, 2: -13.5, 3: -4 }),
        laneRow(5, { 0: -4, 1: -4, 2: -13.5, 3: -4 }),
        laneRow(0, { 0: -4, 1: -4, 2: -13.5, 3: -4 }),
      ],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({
        rxPowerDbm: -4,
        opticalLaneSource: 'SNMP',
        opticalLanes: [
          { lane: 0, rxPowerDbm: -4, txPowerDbm: null },
          { lane: 1, rxPowerDbm: -4, txPowerDbm: null },
          { lane: 2, rxPowerDbm: -13.5, txPowerDbm: null },
          { lane: 3, rxPowerDbm: -4, txPowerDbm: null },
        ],
      })],
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    const input = built.openMetricAlarm.mock.calls[0]?.[0];
    expect(input).toMatchObject({ metricKey: 'RX_LANE_2', severity: 'MAJOR' });
    expect(input?.metadata).toMatchObject({ lane: 2, currentPowerSource: 'SNMP' });
    expect(built.openMetricAlarm.mock.calls.every(([item]) => item.metricKey !== 'RX')).toBe(true);
  });

  it('F1A: scalar AGREGADO nunca e avaliado contra thresholds por lane', async () => {
    // Modulo de 4 lanes com apenas UMA leitura de RX: o modo lane nao fecha e o
    // aggregate +6.01 dBm NAO pode virar serie comparavel a .13-.16/.20-.23.
    const moduleWithSparseLanes = opticalInterface({
      rxPowerDbm: 6.01,
      opticalLaneSource: 'SNMP',
      opticalLanes: [
        { lane: 0, rxPowerDbm: -11.5, txPowerDbm: null },
        { lane: 1, rxPowerDbm: null, txPowerDbm: null },
        { lane: 2, rxPowerDbm: null, txPowerDbm: null },
        { lane: 3, rxPowerDbm: null, txPowerDbm: null },
      ],
    });
    const built = buildOpticalEngine({
      rows: [opticalRow(10, -11.5), opticalRow(5, -11.5), opticalRow(0, -11.5)],
      thresholds: [thresholdRecord(-12.3, 3.39)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [moduleWithSparseLanes],
      scalarSemantics: 'AGGREGATED_LANES',
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();

    // Controle: sem a semantica declarada (LANE_0/legado) o mesmo tipo de cenario
    // segue alarmando pelo scalar — o guard nao altera plataforma nenhuma que
    // declare a lane 0.
    const legacy = buildOpticalEngine({
      rows: [opticalRow(10, -11.5), opticalRow(5, -11.5), opticalRow(0, -11.5)],
      thresholds: [thresholdRecord(-12.3, 3.39)],
    });
    await legacy.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'S6730',
      interfaces: [opticalInterface({ rxPowerDbm: -11.5 })],
    });
    expect(legacy.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(legacy.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({ metricKey: 'RX' });
  });

  it('F1A: modulo de UMA lane (agregado == lane) continua no modo scalar', async () => {
    const singleLane = opticalInterface({
      rxPowerDbm: -11.5,
      opticalLaneSource: 'SNMP',
      opticalLanes: [{ lane: 0, rxPowerDbm: -11.5, txPowerDbm: null }],
    });
    const built = buildOpticalEngine({
      rows: [opticalRow(10, -11.5), opticalRow(5, -11.5), opticalRow(0, -11.5)],
      thresholds: [thresholdRecord(-12.3, 3.39)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [singleLane],
      scalarSemantics: 'AGGREGATED_LANES',
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({ metricKey: 'RX' });
  });

  it('escala na MESMA linha (WARNING -> MAJOR -> CRITICAL) sem downgrade', async () => {
    const toMajor = buildOpticalEngine({
      rows: [opticalRow(5, atProximity(96)), opticalRow(0, atProximity(96))],
      thresholds: [OPTICAL_THRESHOLDS],
      open: [existingOpticalAlarm({ severity: 'WARNING' })],
    });
    await toMajor.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(96) })],
    });
    expect(toMajor.openMetricAlarm).not.toHaveBeenCalled();
    expect(toMajor.escalateMetricAlarm).toHaveBeenCalledTimes(1);
    expect(toMajor.escalateMetricAlarm.mock.calls[0]?.[0]).toBe('alarm-created');
    expect(toMajor.escalateMetricAlarm.mock.calls[0]?.[1]).toMatchObject({
      severity: 'MAJOR', unit: '%', thresholdValue: 95,
    });

    const toCritical = buildOpticalEngine({
      rows: [opticalRow(0, -14.5)],
      thresholds: [OPTICAL_THRESHOLDS],
      open: [existingOpticalAlarm({ severity: 'MAJOR' })],
    });
    await toCritical.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -14.5 })],
    });
    expect(toCritical.escalateMetricAlarm.mock.calls[0]?.[1]).toMatchObject({ severity: 'CRITICAL' });

    const noDowngrade = buildOpticalEngine({
      rows: [opticalRow(10, atProximity(91)), opticalRow(5, atProximity(91)), opticalRow(0, atProximity(91))],
      thresholds: [OPTICAL_THRESHOLDS],
      open: [existingOpticalAlarm({ severity: 'CRITICAL' })],
    });
    await noDowngrade.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(91) })],
    });
    expect(noDowngrade.escalateMetricAlarm).not.toHaveBeenCalled();
    expect(noDowngrade.resolveMetricAlarm).not.toHaveBeenCalled();
  });

  it('continua stateless: uma instancia nova decide igual a partir do banco', async () => {
    const rows = [opticalRow(10, atProximity(90)), opticalRow(5, atProximity(90)), opticalRow(0, atProximity(90))];
    const first = buildOpticalEngine({ rows, thresholds: [OPTICAL_THRESHOLDS] });
    const second = buildOpticalEngine({ rows, thresholds: [OPTICAL_THRESHOLDS] });
    const input = {
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    };
    await first.engine.processOpticalReadings(input);
    await second.engine.processOpticalReadings(input);

    expect(second.openMetricAlarm.mock.calls[0]?.[0]).toEqual(first.openMetricAlarm.mock.calls[0]?.[0]);
    expect(second.getRecentInterfaceOpticalSamples).toHaveBeenCalledWith(
      'dev-1',
      new Date(NOW.getTime() - 60 * 60_000),
    );
  });

  it('S6750-H real: avaliacao por lane contra o threshold do modulo (-12.31/+3.40)', async () => {
    // Thresholds reais .13/.14 do modulo (SNMP DEVICE) aplicados a cada lane.
    const moduleThresholds = thresholdRecord(-12.31, 3.4);
    const healthy = buildOpticalEngine({
      rows: [
        laneRow(10, { 0: 0.19, 1: 0.69, 2: 1.02, 3: 0.11 }),
        laneRow(5, { 0: 0.19, 1: 0.69, 2: 1.02, 3: 0.11 }),
        laneRow(0, { 0: 0.19, 1: 0.69, 2: 1.02, 3: 0.11 }),
      ],
      thresholds: [moduleThresholds],
    });
    await healthy.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({
        rxPowerDbm: 0.19,
        opticalLaneSource: 'SNMP',
        opticalLanes: [
          { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74 },
          { lane: 1, rxPowerDbm: 0.69, txPowerDbm: -0.69 },
          { lane: 2, rxPowerDbm: 1.02, txPowerDbm: -0.72 },
          { lane: 3, rxPowerDbm: 0.11, txPowerDbm: -0.76 },
        ],
      })],
    });
    expect(healthy.openMetricAlarm).not.toHaveBeenCalled();

    // Lane 3 degradada (~94% da faixa ate o Low Alarm) abre UM alarme de lane.
    const degraded = buildOpticalEngine({
      rows: [
        laneRow(10, { 0: 0.19, 1: 0.69, 2: 1.02, 3: -11.0 }),
        laneRow(5, { 0: 0.19, 1: 0.69, 2: 1.02, 3: -11.0 }),
        laneRow(0, { 0: 0.19, 1: 0.69, 2: 1.02, 3: -11.0 }),
      ],
      thresholds: [moduleThresholds],
    });
    await degraded.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({
        rxPowerDbm: 0.19,
        opticalLaneSource: 'SNMP',
        opticalLanes: [
          { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74 },
          { lane: 1, rxPowerDbm: 0.69, txPowerDbm: -0.69 },
          { lane: 2, rxPowerDbm: 1.02, txPowerDbm: -0.72 },
          { lane: 3, rxPowerDbm: -11.0, txPowerDbm: -0.76 },
        ],
      })],
    });
    expect(degraded.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(degraded.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      metricKey: 'RX_LANE_3',
      severity: 'WARNING',
      unit: '%',
      metadata: {
        lane: 3,
        rxLowAlarmDbm: -12.31,
        rxHighAlarmDbm: 3.4,
        thresholdSource: 'DEVICE',
        currentPowerSource: 'SNMP',
      },
    });
    expect(degraded.openMetricAlarm.mock.calls.every(([item]) => item.metricKey !== 'RX')).toBe(true);
  });

  it('S6730 real: modulo scalar usa current em dBm e thresholds do equipamento', async () => {
    // 65 uW => -11.87 dBm com thresholds -22.01/-2.00 (mesma coluna canonica).
    const built = buildOpticalEngine({
      rows: [opticalRow(10, -20.5), opticalRow(5, -20.5), opticalRow(0, -20.5)],
      thresholds: [thresholdRecord(-22.01, -2)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -20.5 })],
    });
    const input = built.openMetricAlarm.mock.calls[0]?.[0];
    expect(input).toMatchObject({ metricKey: 'RX', severity: 'WARNING' });
    expect(input?.metadata).toMatchObject({
      rxPowerDbm: -20.5,
      rxLowAlarmDbm: -22.01,
      rxHighAlarmDbm: -2,
      thresholdSource: 'DEVICE',
      proximityPercent: 92.45,
    });
  });
});

describe('motor + notificacao de midia (NETWORK_ALARMS)', () => {
  it('notifica OPENED na abertura dos alarmes metricos e RESOLVED na recuperacao', async () => {
    const built = buildEngine({
      rules: [ruleOf({ mediaEnabled: true })],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
    });
    await built.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(built.notifier.notifyOpened).toHaveBeenCalledTimes(1);
    expect(built.notifier.notifyOpened.mock.calls[0]?.[0]).toMatchObject({
      id: 'alarm-created',
      type: 'INTERFACE_ERRORS',
      metricKey: 'RX',
    });
    expect(built.notifier.notifyOpened.mock.calls[0]?.[1]).toEqual({ mediaEnabled: true });

    const openAlarm: Alarm = {
      ...openedAlarm({
        deviceId: 'dev-1',
        interfaceId: 'if-1',
        ifIndex: 1,
        ruleId: 'rule-1',
        type: 'INTERFACE_ERRORS',
        severity: 'MAJOR',
        metricKey: 'RX',
        currentValue: 60,
        thresholdValue: 50,
        unit: 'per_min',
        metadata: {},
        message: 'erros',
        startedAt: NOW,
      }),
    };
    const recovering = buildEngine({
      rules: [ruleOf({ mediaEnabled: true })],
      rows: errorWindow('if-1', [0n, 0n, 0n]),
      open: [openAlarm],
    });
    await recovering.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(recovering.notifier.notifyResolved).toHaveBeenCalledTimes(1);
    expect(recovering.notifier.notifyResolved.mock.calls[0]?.[0]).toMatchObject({
      id: 'alarm-created',
      endedAt: NOW.toISOString(),
    });
    expect(recovering.notifier.notifyResolved.mock.calls[0]?.[1]).toEqual({ mediaEnabled: true });
  });

  it('notifica ESCALATED na mesma linha do alarme optico', async () => {
    const built = buildOpticalEngine({
      rules: [opticalRuleOf({ mediaEnabled: true })],
      rows: [opticalRow(5, atProximity(96)), opticalRow(0, atProximity(96))],
      thresholds: [OPTICAL_THRESHOLDS],
      open: [existingOpticalAlarm({ severity: 'WARNING' })],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(96) })],
    });
    expect(built.notifier.notifyEscalated).toHaveBeenCalledTimes(1);
    expect(built.notifier.notifyEscalated.mock.calls[0]?.[0]).toMatchObject({
      id: 'alarm-created',
      severity: 'MAJOR',
    });
    expect(built.notifier.notifyOpened).not.toHaveBeenCalled();
  });

  it('midia desligada na regra nao gera evento (o dedupe fica com o servico)', async () => {
    const built = buildOpticalEngine({
      rules: [opticalRuleOf({ mediaEnabled: false })],
      rows: [opticalRow(10, atProximity(90)), opticalRow(5, atProximity(90)), opticalRow(0, atProximity(90))],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    });
    expect(built.notifier.notifyOpened).toHaveBeenCalledTimes(1);
    expect(built.notifier.notifyOpened.mock.calls[0]?.[1]).toEqual({ mediaEnabled: false });
  });

  it('falha da notificacao nunca derruba o motor nem perde o alarme aberto', async () => {
    const notifier = notifierMock();
    notifier.notifyOpened.mockRejectedValue(new Error('midia fora do ar'));
    const built = buildOpticalEngine({
      rules: [opticalRuleOf({ mediaEnabled: true })],
      rows: [opticalRow(10, atProximity(90)), opticalRow(5, atProximity(90)), opticalRow(0, atProximity(90))],
      thresholds: [OPTICAL_THRESHOLDS],
      notifier,
    });
    await expect(built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    })).resolves.toBeUndefined();
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(notifier.notifyOpened).toHaveBeenCalledTimes(1);
  });

  it('MANUAL da regra so entra quando o equipamento nao tem threshold aplicavel', async () => {
    const rows = [opticalRow(10, atProximity(90)), opticalRow(5, atProximity(90)), opticalRow(0, atProximity(90))];
    const noEquipmentThreshold = buildOpticalEngine({
      rules: [opticalRuleOf({ config: opticalConfig({ manualRxLowAlarmDbm: -14, manualRxHighAlarmDbm: -1 }) })],
      rows,
      thresholds: [thresholdRecord(null, null)],
    });
    await noEquipmentThreshold.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    });
    expect(noEquipmentThreshold.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      metricKey: 'RX',
      metadata: { thresholdSource: 'MANUAL', rxLowAlarmDbm: -14, rxHighAlarmDbm: -1 },
    });

    const withEquipmentThreshold = buildOpticalEngine({
      rules: [opticalRuleOf({ config: opticalConfig({ manualRxLowAlarmDbm: -18, manualRxHighAlarmDbm: -5 }) })],
      rows,
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await withEquipmentThreshold.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: atProximity(90) })],
    });
    // O -14/-1 do equipamento vence o MANUAL -18/-5 da regra.
    expect(withEquipmentThreshold.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      metadata: { thresholdSource: 'DEVICE', rxLowAlarmDbm: -14, rxHighAlarmDbm: -1 },
    });
  });

  it('consome a mesma Interface.opticalThresholds mesclada: lane USER vence o scalar DEVICE', async () => {
    // Resultado do merge SNMP (scalar DEVICE -12.31/+3.40) + SSH (lane 3 USER).
    const merged = thresholdRecord(-12.31, 3.4, [{ lane: 3, low: -10.5, high: 3.4 }]);
    const lane3 = merged.thresholds?.lanes[0];
    if (lane3) {
      lane3.rx.lowSource = 'USER';
      lane3.rx.highSource = 'USER';
    }
    const built = buildOpticalEngine({
      rows: [
        laneRow(10, { 0: 0.19, 3: -10 }),
        laneRow(5, { 0: 0.19, 3: -10 }),
        laneRow(0, { 0: 0.19, 3: -10 }),
      ],
      thresholds: [merged],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({
        rxPowerDbm: 0.19,
        opticalLaneSource: 'SNMP',
        opticalLanes: [
          { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74 },
          { lane: 3, rxPowerDbm: -10, txPowerDbm: -0.76 },
        ],
      })],
    });

    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      metricKey: 'RX_LANE_3',
      severity: 'MAJOR',
      metadata: {
        lane: 3,
        rxLowAlarmDbm: -10.5,
        rxHighAlarmDbm: 3.4,
        thresholdSource: 'USER',
      },
    });
  });

  it('abre WARNING por queda de 3.2 dB em 30 min sem nenhum threshold', async () => {
    const built = buildOpticalEngine({
      rows: [
        opticalRow(25, -5),
        opticalRow(20, -6),
        opticalRow(15, -8.1),
        opticalRow(10, -8.2),
        opticalRow(5, -8.2),
        opticalRow(0, -8.2),
      ],
      thresholds: [],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -8.2 })],
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'WARNING',
      unit: 'dB',
      currentValue: 3.2,
      thresholdValue: 3,
      metadata: {
        triggerReasons: ['RAPID_DROP'],
        trendDropDb: 3.2,
        trendWindowMinutes: 30,
      },
    });
    expect(built.openMetricAlarm.mock.calls[0]?.[0]?.message).toContain('caiu 3.2 dB em 30 min');
  });

  it('escala para MAJOR com queda de 5.1 dB mesmo longe do LOW', async () => {
    const built = buildOpticalEngine({
      rows: [
        opticalRow(25, -5),
        opticalRow(20, -7),
        opticalRow(15, -10),
        opticalRow(10, -10.1),
        opticalRow(5, -10.1),
        opticalRow(0, -10.1),
      ],
      // LOW -20 / HIGH +3: o atual esta a 57% do limite, longe de qualquer alarme optico.
      thresholds: [thresholdRecord(-20, 3)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -10.1 })],
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'MAJOR',
      unit: 'dB',
      currentValue: 5.1,
      thresholdValue: 5,
      metadata: { triggerReasons: ['RAPID_DROP'] },
    });
  });

  it('nao abre alarme de trend depois que a potencia recuperou', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(20, -5), opticalRow(10, -10), opticalRow(0, -5)],
      thresholds: [],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -5 })],
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
  });

  it('pico isolado invalido/reset nao gera trend falso', async () => {
    const built = buildOpticalEngine({
      rows: [opticalRow(20, -5), opticalRow(10, 18), opticalRow(0, -5.4)],
      thresholds: [],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -5.4 })],
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
  });

  it('proximidade e queda no MESMO alarme: maior severidade e TODOS os motivos', async () => {
    // LOW -14 / HIGH -1: -12.83 dBm => 91% de proximidade (WARNING);
    // pico -7.7 => queda de 5.13 dB (MAJOR de trend, que domina).
    const built = buildOpticalEngine({
      rows: [
        opticalRow(25, -7.7),
        opticalRow(20, -9.5),
        opticalRow(15, -12.83),
        opticalRow(10, -12.83),
        opticalRow(5, -12.83),
        opticalRow(0, -12.83),
      ],
      thresholds: [OPTICAL_THRESHOLDS],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({ rxPowerDbm: -12.83 })],
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      severity: 'MAJOR',
      unit: 'dB',
      currentValue: 5.13,
      thresholdValue: 5,
      metadata: {
        triggerReasons: ['RAPID_DROP', 'PROXIMITY'],
        proximityPercent: 91,
        trendDropDb: 5.13,
      },
    });
  });

  it('queda em uma lane nao contamina as outras lanes', async () => {
    const built = buildOpticalEngine({
      rows: [
        laneRow(25, { 0: 0.19, 3: -5 }),
        laneRow(20, { 0: 0.19, 3: -7 }),
        laneRow(15, { 0: 0.19, 3: -10 }),
        laneRow(10, { 0: 0.19, 3: -10.1 }),
        laneRow(5, { 0: 0.19, 3: -10.1 }),
        laneRow(0, { 0: 0.19, 3: -10.1 }),
      ],
      thresholds: [thresholdRecord(-20, 3)],
    });
    await built.engine.processOpticalReadings({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [opticalInterface({
        rxPowerDbm: 0.19,
        opticalLaneSource: 'SNMP',
        opticalLanes: [
          { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74 },
          { lane: 3, rxPowerDbm: -10.1, txPowerDbm: -0.76 },
        ],
      })],
    });
    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      metricKey: 'RX_LANE_3',
      severity: 'MAJOR',
      unit: 'dB',
      metadata: { lane: 3, triggerReasons: ['RAPID_DROP'] },
    });
    expect(built.openMetricAlarm.mock.calls.every(([item]) => item.metricKey !== 'RX')).toBe(true);
  });
});

describe('criterios opticos puros', () => {
  const criteria = (overrides: Partial<Parameters<typeof opticalLadderFor>[0]> = {}) => ({
    currentPowerDbm: -12,
    lowAlarmDbm: -14,
    highAlarmDbm: -1,
    warningProximityPercent: 90,
    majorProximityPercent: 95,
    criticalAtLowAlarm: true,
    warningMarginDb: 3,
    trendDropObservedDb: 0,
    trendDropThresholdDb: 3,
    trendMajorDropThresholdDb: 5,
    ...overrides,
  });

  it('calcula proximidade na faixa real com clamp 0..100', () => {
    expect(opticalProximityPercent(-14, -14, -1)).toBe(100);
    expect(opticalProximityPercent(-1, -14, -1)).toBe(0);
    expect(opticalProximityPercent(-12.7, -14, -1)).toBeCloseTo(90, 6);
    expect(opticalProximityPercent(-20, -14, -1)).toBe(100);
    expect(opticalProximityPercent(5, -14, -1)).toBe(0);
    expect(opticalProximityPercent(-5, -1, -14)).toBeNull();
  });

  it('mede a queda ate a amostra ATUAL e tolera poll irregular', () => {
    expect(opticalTrendDropDb([-8, -9.5, -11, -12, -12.2])).toBe(4.2);
    expect(opticalTrendDropDb([-12, -8])).toBe(0);
    // Queda antiga ja recuperada nao existe: o gatilho e o estado ATUAL.
    expect(opticalTrendDropDb([-5, -10, -5])).toBe(0);
    // Pico isolado acima dos vizinhos e glitch/reset, nunca referencia de queda.
    expect(opticalTrendDropDb([-8, -1, -9])).toBe(1);
    expect(opticalTrendDropDb([-5, 20, -6])).toBe(1);
  });

  it('mantem o trend como WARNING/MAJOR independente de threshold', () => {
    expect(opticalLadderFor(criteria({
      lowAlarmDbm: null,
      highAlarmDbm: null,
      trendDropObservedDb: 3.5,
    }))).toBe('WARNING');
    expect(opticalLadderFor(criteria({
      lowAlarmDbm: null,
      highAlarmDbm: null,
      trendDropObservedDb: 5.2,
    }))).toBe('MAJOR');
    expect(opticalLadderFor(criteria({
      lowAlarmDbm: null,
      highAlarmDbm: null,
      trendDropObservedDb: 2.9,
    }))).toBe('NONE');
    expect(opticalLadderFor(criteria({ currentPowerDbm: -14.5 }))).toBe('CRITICAL');
  });
});

/**
 * Janela com intervalos ARBITRARIOS (segundos) entre amostras consecutivas:
 * `deltas[i]` e o delta do intervalo que termina na amostra i+1.
 */
function intervalWindow(
  interfaceId: string,
  intervalSeconds: number,
  deltas: bigint[],
): InterfaceMetricWindowRow[] {
  const rows: InterfaceMetricWindowRow[] = [];
  let raw = 1_000n;
  let elapsedSeconds = 0;
  rows.push(
    rowAt(interfaceId, (deltas.length * intervalSeconds) / 60, {
      fcsErrors: raw,
      fcsErrorsDelta: 0n,
    }),
  );
  deltas.forEach((delta) => {
    raw += delta;
    elapsedSeconds += intervalSeconds;
    rows.push(
      rowAt(interfaceId, (deltas.length * intervalSeconds - elapsedSeconds) / 60, {
        fcsErrors: raw,
        fcsErrorsDelta: delta,
      }),
    );
  });
  return rows;
}

const asDiscardRows = (rows: InterfaceMetricWindowRow[]): InterfaceMetricWindowRow[] =>
  rows.map((row) => ({
    ...row,
    inDiscards: row.fcsErrors ?? 0n,
    inDiscardsDelta: row.fcsErrorsDelta ?? 0n,
  }));

describe('QUALQUER CRC / QUALQUER DISCARD (threshold 0 = delta > 0)', () => {
  const anyCrcRule = ruleOf({
    type: 'INTERFACE_CRC',
    severity: 'WARNING',
    mapLinkedOnly: false,
    config: {
      thresholdPerMinute: 0,
      recoveryThresholdPerMinute: 0,
      triggerSamples: 1,
      recoverySamples: 1,
    },
  });
  const anyDiscardsRule = ruleOf({
    type: 'INTERFACE_DISCARDS',
    severity: 'WARNING',
    mapLinkedOnly: false,
    config: {
      direction: 'BOTH',
      thresholdPerMinute: 0,
      recoveryThresholdPerMinute: 0,
      triggerSamples: 1,
      recoverySamples: 1,
    },
  });

  it('dispara com 1 CRC em 60 s', async () => {
    const built = buildEngine({
      rules: [anyCrcRule],
      rows: intervalWindow('if-1', 60, [0n, 1n]),
    });
    await built.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });

    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      type: 'INTERFACE_CRC',
      metricKey: 'FCS',
      thresholdValue: 0,
      metadata: { delta: '1', thresholdPerMinute: 0, sampleIntervalSeconds: 60 },
    });
    expect(built.openMetricAlarm.mock.calls[0]?.[0]?.message).toContain('qualquer ocorrência');
  });

  it('dispara com 1 CRC em 120 s (poll irregular nao muda a semantica)', async () => {
    const built = buildEngine({
      rules: [anyCrcRule],
      rows: intervalWindow('if-1', 120, [0n, 1n]),
    });
    await built.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });

    expect(built.openMetricAlarm).toHaveBeenCalledTimes(1);
    // A taxa cai pela metade, mas o criterio e delta > 0.
    expect(built.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      currentValue: 0.5,
      thresholdValue: 0,
      metadata: { delta: '1', sampleIntervalSeconds: 120 },
    });
  });

  it('delta 0 nao dispara', async () => {
    const built = buildEngine({
      rules: [anyCrcRule],
      rows: intervalWindow('if-1', 60, [0n, 0n]),
    });
    await built.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(built.openMetricAlarm).not.toHaveBeenCalled();
  });

  it('QUALQUER DISCARD dispara com 1 discard em qualquer intervalo', async () => {
    const rx = buildEngine({
      rules: [anyDiscardsRule],
      rows: asDiscardRows(intervalWindow('if-1', 120, [0n, 1n])),
    });
    await rx.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(rx.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(rx.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({
      type: 'INTERFACE_DISCARDS',
      metricKey: 'RX',
      thresholdValue: 0,
    });

    // TX com delta > 0 tambem dispara (direcao BOTH), sem alarme duplicado no RX.
    const txRows = intervalWindow('if-1', 60, [0n, 0n]).map((row) => ({
      ...row,
      outDiscards: row.fcsErrors ?? 0n,
      outDiscardsDelta: row.fcsErrorsDelta ?? 0n,
    }));
    const tx = buildEngine({ rules: [anyDiscardsRule], rows: txRows });
    await tx.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(tx.openMetricAlarm).not.toHaveBeenCalled();

    const txWithDelta = buildEngine({
      rules: [anyDiscardsRule],
      rows: intervalWindow('if-1', 60, [0n, 1n]).map((row) => ({
        ...row,
        outDiscards: row.fcsErrors ?? 0n,
        outDiscardsDelta: row.fcsErrorsDelta ?? 0n,
      })),
    });
    await txWithDelta.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(txWithDelta.openMetricAlarm).toHaveBeenCalledTimes(1);
    expect(txWithDelta.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({ metricKey: 'TX' });
  });

  it('regra rate/min existente continua igual (1 CRC em 120s nao passa de 2/min)', async () => {
    const rateRule = ruleOf({
      type: 'INTERFACE_CRC',
      mapLinkedOnly: false,
      config: {
        thresholdPerMinute: 2,
        recoveryThresholdPerMinute: 0,
        triggerSamples: 1,
        recoverySamples: 1,
      },
    });
    const below = buildEngine({ rules: [rateRule], rows: intervalWindow('if-1', 120, [0n, 1n]) });
    await below.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(below.openMetricAlarm).not.toHaveBeenCalled();

    const above = buildEngine({ rules: [rateRule], rows: intervalWindow('if-1', 30, [0n, 2n]) });
    await above.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(above.openMetricAlarm).toHaveBeenCalledTimes(1);
    // 2 CRC em 30s = 4/min.
    expect(above.openMetricAlarm.mock.calls[0]?.[0]).toMatchObject({ currentValue: 4 });
  });

  it('recupera quando o intervalo volta a ter delta 0', async () => {
    const open = openedAlarm({
      deviceId: 'dev-1',
      interfaceId: 'if-1',
      ifIndex: 1,
      ruleId: 'rule-1',
      type: 'INTERFACE_CRC',
      severity: 'WARNING',
      metricKey: 'FCS',
      currentValue: 1,
      thresholdValue: 0,
      unit: 'per_min',
      metadata: {},
      message: 'aberto',
      startedAt: new Date(NOW.getTime() - 300_000),
    });
    const built = buildEngine({
      rules: [anyCrcRule],
      rows: intervalWindow('if-1', 60, [0n, 0n]),
      open: [open],
    });
    await built.engine.processDeviceMetrics({
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaces: [IFACE],
    });
    expect(built.resolveMetricAlarm).toHaveBeenCalledTimes(1);
  });

  it('thresholdTriggerPredicate distingue qualquer ocorrencia de taxa', () => {
    const any = thresholdTriggerPredicate(0);
    expect(any(0)).toBe(false);
    expect(any(0.5)).toBe(true);
    const rate = thresholdTriggerPredicate(2);
    expect(rate(1.99)).toBe(false);
    expect(rate(2)).toBe(true);
  });
});


describe('supressao operacional no motor metrico (F9.1)', () => {
  const evaluating = () => ({
    deviceId: 'dev-1',
    deviceName: 'F1A',
    interfaces: [IFACE],
  });

  it('nao reabre o alarme do fingerprint suprimido enquanto a condicao segue ruim', async () => {
    const { engine, openMetricAlarm, clearSuppression } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
      suppressions: [suppressionOf()],
    });

    await engine.processDeviceMetrics(evaluating());

    expect(openMetricAlarm).not.toHaveBeenCalled();
    expect(clearSuppression).not.toHaveBeenCalled();
  });

  it('libera a supressao UNTIL_CLEAR quando a condicao normaliza', async () => {
    const { engine, openMetricAlarm, clearSuppression } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [0n, 0n, 0n]),
      suppressions: [suppressionOf()],
    });

    await engine.processDeviceMetrics(evaluating());

    expect(clearSuppression).toHaveBeenCalledWith('sup-1', NOW, 'RECOVERED');
    expect(openMetricAlarm).not.toHaveBeenCalled();
  });

  it('mantem a janela UNTIL_TIME mesmo com a condicao recuperada', async () => {
    const { engine, openMetricAlarm, clearSuppression } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [0n, 0n, 0n]),
      suppressions: [
        suppressionOf({ mode: 'UNTIL_TIME', expiresAt: new Date(NOW.getTime() + 3_600_000) }),
      ],
    });

    await engine.processDeviceMetrics(evaluating());

    expect(clearSuppression).not.toHaveBeenCalled();
    expect(openMetricAlarm).not.toHaveBeenCalled();
  });

  it('supressao de outro fingerprint/regra nao bloqueia o alarme', async () => {
    const { engine, openMetricAlarm } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n, 300n, 300n]),
      suppressions: [suppressionOf({ fingerprint: 'if-1|INTERFACE_ERRORS|rule-9|RX' })],
    });

    await engine.processDeviceMetrics(evaluating());

    expect(openMetricAlarm).toHaveBeenCalledTimes(1);
  });

  it('consulta as supressoes do equipamento e roda o housekeeping de expiradas', async () => {
    const { engine, listActiveSuppressions, expireDue } = buildEngine({
      rules: [ruleOf()],
      rows: errorWindow('if-1', [300n]),
    });

    await engine.processDeviceMetrics(evaluating());

    expect(listActiveSuppressions).toHaveBeenCalledWith(NOW, { deviceId: 'dev-1' });
    expect(expireDue).toHaveBeenCalledTimes(1);
  });
});
describe('proximidade com janela WARNING (Fase WARNING optico)', () => {
  const base = {
    currentPowerDbm: -21,
    lowAlarmDbm: -23.1,
    highAlarmDbm: -6,
    warningProximityPercent: 80,
    majorProximityPercent: 90,
    criticalAtLowAlarm: true,
    warningMarginDb: 3,
    trendDropObservedDb: 0,
    trendDropThresholdDb: 3,
    trendMajorDropThresholdDb: 6,
  };

  it('com WARNING publicado a proximidade usa a janela WARNING', () => {
    // ((-7 - (-21)) / (-7 - (-22.07))) = 92.9% -> MAJOR na janela WARNING;
    expect(opticalLadderFor({
      ...base,
      lowWarningDbm: -22.07,
      highWarningDbm: -7,
    })).toBe('MAJOR');
  });

  it('sem WARNING o fallback e a janela HARD (comportamento historico)', () => {
    // ((-6 - (-21)) / (-6 - (-23.1))) = 87.7% -> WARNING na janela HARD
    expect(opticalLadderFor({
      ...base,
      lowWarningDbm: null,
      highWarningDbm: null,
    })).toBe('WARNING');
  });

  it('LOW WARNING nunca promove para CRITICAL; CRITICAL exige o HARD LOW', () => {
    const criteria = {
      ...base,
      currentPowerDbm: -22.5,
      lowWarningDbm: -22.07,
      highWarningDbm: -7,
    };
    expect(opticalLadderFor(criteria)).not.toBe('CRITICAL');
    expect(opticalLadderFor({ ...criteria, currentPowerDbm: -23.5 })).toBe('CRITICAL');
  });

  it('par WARNING incompleto nao forma janela: cai para o HARD', () => {
    expect(opticalLadderFor({
      ...base,
      lowWarningDbm: -22.07,
      highWarningDbm: null,
    })).toBe('WARNING');
  });
});
