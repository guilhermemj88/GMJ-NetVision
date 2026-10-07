import { describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type { AlarmSuppressionRepository } from '../infrastructure/alarms/alarm-suppression-repository';
import type { InterfaceStatusTransition } from '../infrastructure/persistence/host-repository';
import { AlarmService } from './alarm-service';

function transition(overrides: Partial<InterfaceStatusTransition> = {}): InterfaceStatusTransition {
  return {
    deviceId: 'device-1',
    interfaceId: 'iface-1',
    ifIndex: 1,
    previousStatus: 'UP',
    newStatus: 'DOWN',
    ...overrides,
  };
}

interface RepositoryMocks {
  repository: AlarmRepository;
  openInterfaceDownAlarms: ReturnType<typeof vi.fn>;
  resolveInterfaceDownAlarms: ReturnType<typeof vi.fn>;
  findLinkedInterfaceIds: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
  listHistory: ReturnType<typeof vi.fn>;
  closeOpenAlarmsForFingerprint: ReturnType<typeof vi.fn>;
}

function repository(overrides: Partial<AlarmRepository> = {}): RepositoryMocks {
  const merged: AlarmRepository = {
    listActive: vi.fn().mockResolvedValue([]),
    listHistory: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    acknowledge: vi.fn().mockResolvedValue(null),
    closeOpenAlarmsForFingerprint: vi.fn().mockResolvedValue(0),
    findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set<string>()),
    openInterfaceDownAlarms: vi.fn().mockResolvedValue([]),
    resolveInterfaceDownAlarms: vi.fn().mockResolvedValue(undefined),
    openMetricAlarm: vi.fn().mockResolvedValue(null),
    escalateMetricAlarm: vi.fn().mockResolvedValue(null),
    listOpenMetricAlarms: vi.fn().mockResolvedValue([]),
    resolveMetricAlarm: vi.fn().mockResolvedValue(false),
    resolveOpenMetricAlarmsForRule: vi.fn().mockResolvedValue(0),
    markAlarmNotified: vi.fn().mockResolvedValue(undefined),
    markAlarmResolutionNotified: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    repository: merged,
    openInterfaceDownAlarms: merged.openInterfaceDownAlarms as ReturnType<typeof vi.fn>,
    resolveInterfaceDownAlarms: merged.resolveInterfaceDownAlarms as ReturnType<typeof vi.fn>,
    findLinkedInterfaceIds: merged.findLinkedInterfaceIds as ReturnType<typeof vi.fn>,
    listActive: merged.listActive as ReturnType<typeof vi.fn>,
    listHistory: merged.listHistory as ReturnType<typeof vi.fn>,
    closeOpenAlarmsForFingerprint: merged.closeOpenAlarmsForFingerprint as ReturnType<typeof vi.fn>,
  };
}

describe('AlarmService.processTransitions', () => {
  it('opens an INTERFACE_DOWN alarm when a map-linked interface goes UP -> DOWN', async () => {
    const mocks = repository({ findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])) });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ previousStatus: 'UP', newStatus: 'DOWN' }),
    ]);

    expect(mocks.findLinkedInterfaceIds).toHaveBeenCalledWith(['iface-1']);
    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledTimes(1);
    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledWith([
      expect.objectContaining({
        deviceId: 'device-1',
        interfaceId: 'iface-1',
        ifIndex: 1,
        startedAt: expect.any(Date),
      }),
    ]);
    expect(mocks.resolveInterfaceDownAlarms).not.toHaveBeenCalled();
  });

  it('does not duplicate alarms while the interface remains DOWN', async () => {
    const mocks = repository();
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ previousStatus: 'DOWN', newStatus: 'DOWN' }),
      transition({ previousStatus: 'UNKNOWN', newStatus: 'DOWN' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).not.toHaveBeenCalled();
    expect(mocks.resolveInterfaceDownAlarms).not.toHaveBeenCalled();
  });

  it('resolves the open alarm when the interface goes DOWN -> UP', async () => {
    const mocks = repository();
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ previousStatus: 'DOWN', newStatus: 'UP' }),
    ]);

    expect(mocks.resolveInterfaceDownAlarms).toHaveBeenCalledTimes(1);
    expect(mocks.resolveInterfaceDownAlarms).toHaveBeenCalledWith(['iface-1'], expect.any(Date));
    expect(mocks.openInterfaceDownAlarms).not.toHaveBeenCalled();
  });

  it('ignores interfaces without a baseline (UNKNOWN -> DOWN)', async () => {
    const mocks = repository({ findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])) });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ previousStatus: 'UNKNOWN', newStatus: 'DOWN' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).not.toHaveBeenCalled();
    expect(mocks.resolveInterfaceDownAlarms).not.toHaveBeenCalled();
  });

  it('only opens alarms for interfaces that belong to a map link', async () => {
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-2'])),
    });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ interfaceId: 'iface-1' }),
      transition({ interfaceId: 'iface-2' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledTimes(1);
    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledWith([
      expect.objectContaining({ interfaceId: 'iface-2' }),
    ]);
  });

  it('opens and resolves different interfaces in the same cycle', async () => {
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1', 'iface-3'])),
    });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ interfaceId: 'iface-1', previousStatus: 'UP', newStatus: 'DOWN' }),
      transition({ interfaceId: 'iface-2', previousStatus: 'DOWN', newStatus: 'UP' }),
      transition({ interfaceId: 'iface-3', previousStatus: 'UP', newStatus: 'DOWN' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledWith([
      expect.objectContaining({ interfaceId: 'iface-1' }),
      expect.objectContaining({ interfaceId: 'iface-3' }),
    ]);
    expect(mocks.resolveInterfaceDownAlarms).toHaveBeenCalledWith(['iface-2'], expect.any(Date));
  });

  it('does nothing when there are no transitions', async () => {
    const mocks = repository();
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([]);

    expect(mocks.findLinkedInterfaceIds).not.toHaveBeenCalled();
    expect(mocks.openInterfaceDownAlarms).not.toHaveBeenCalled();
    expect(mocks.resolveInterfaceDownAlarms).not.toHaveBeenCalled();
  });

  it('returns alarms produced by the repository', async () => {
    const alarm: Alarm = {
      id: 'alarm-1',
      deviceId: 'device-1',
      deviceName: 'SW-CBF-01',
      interfaceId: 'iface-1',
      interfaceName: '40GE0/0/1',
      interfaceLabel: 'SW-SPA-SJO-5732-MPLS-01',
      ifIndex: 118,
      linkId: 'link-1',
      linkLabel: 'Backbone',
      type: 'INTERFACE_DOWN',
      severity: 'CRITICAL',
      startedAt: '2026-09-16T21:17:32.000Z',
      endedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      message: 'SW-CBF-01: SW-SPA-SJO-5732-MPLS-01 (40GE0/0/1) DOWN',
    };
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])),
      openInterfaceDownAlarms: vi.fn().mockResolvedValue([alarm]),
    });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([transition()]);

    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledTimes(1);
  });
});


describe('AlarmService com supressao operacional (F9.1)', () => {
  const NOW = new Date('2026-10-07T12:00:00.000Z');

  const asRepository = (stub: ReturnType<typeof suppressionRepository>) =>
    stub as unknown as AlarmSuppressionRepository;

  function suppressionRepository(rows: unknown[] = []) {
    return {
      listActive: vi.fn().mockResolvedValue(rows),
      clearRecovered: vi.fn().mockResolvedValue(rows.length),
      create: vi.fn().mockResolvedValue(null),
      listRecent: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      clear: vi.fn().mockResolvedValue(null),
      expireDue: vi.fn().mockResolvedValue(0),
    };
  }

  const activeSuppression = {
    id: 'sup-1',
    fingerprint: 'iface-1|INTERFACE_DOWN',
    deviceId: 'device-1',
    interfaceId: 'iface-1',
    type: 'INTERFACE_DOWN',
    ruleId: null,
    metricKey: null,
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
  };

  it('nao reabre alarme de interface suprimida', async () => {
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])),
    });
    const suppressions = suppressionRepository([activeSuppression]);
    const service = new AlarmService(mocks.repository, asRepository(suppressions));

    await service.processTransitions([
      transition({ previousStatus: 'UP', newStatus: 'DOWN' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).not.toHaveBeenCalled();
    expect(suppressions.listActive).toHaveBeenCalledWith(
      expect.any(Date),
      expect.objectContaining({ fingerprints: ['iface-1|INTERFACE_DOWN'], types: ['INTERFACE_DOWN'] }),
    );
  });

  it('abre alarme normalmente quando a supressao e de outra interface', async () => {
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])),
    });
    const suppressions = suppressionRepository([
      { ...activeSuppression, interfaceId: 'iface-2', fingerprint: 'iface-2|INTERFACE_DOWN' },
    ]);
    const service = new AlarmService(mocks.repository, asRepository(suppressions));

    await service.processTransitions([
      transition({ previousStatus: 'UP', newStatus: 'DOWN' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledTimes(1);
  });

  it('libera a supressao UNTIL_CLEAR quando a interface volta para UP', async () => {
    const mocks = repository();
    const suppressions = suppressionRepository([activeSuppression]);
    const service = new AlarmService(mocks.repository, asRepository(suppressions));

    await service.processTransitions([
      transition({ previousStatus: 'DOWN', newStatus: 'UP' }),
    ]);

    expect(mocks.resolveInterfaceDownAlarms).toHaveBeenCalledWith(['iface-1'], expect.any(Date));
    expect(suppressions.clearRecovered).toHaveBeenCalledWith(
      ['iface-1|INTERFACE_DOWN'],
      expect.any(Date),
    );
  });

  it('mantem o comportamento anterior quando nao ha repositorio de supressoes', async () => {
    const mocks = repository({
      findLinkedInterfaceIds: vi.fn().mockResolvedValue(new Set(['iface-1'])),
    });
    const service = new AlarmService(mocks.repository);

    await service.processTransitions([
      transition({ previousStatus: 'UP', newStatus: 'DOWN' }),
      transition({ interfaceId: 'iface-2', previousStatus: 'DOWN', newStatus: 'UP' }),
    ]);

    expect(mocks.openInterfaceDownAlarms).toHaveBeenCalledTimes(1);
    expect(mocks.resolveInterfaceDownAlarms).toHaveBeenCalledTimes(1);
  });
});