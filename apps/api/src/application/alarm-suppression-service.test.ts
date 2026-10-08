import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import {
  AlarmSuppressionError,
  AlarmSuppressionService,
  fingerprintForAlarm,
  indexActiveSuppressions,
} from './alarm-suppression-service';
import { DemoAlarmRepository } from '../infrastructure/alarms/demo-alarm-repository';
import { DemoAlarmSuppressionRepository } from '../infrastructure/alarms/demo-alarm-suppression-repository';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const OPERATOR = { id: 'u1', username: 'qa-preview', role: 'ADMIN' } as unknown as AuthUser;
const OTHER = { id: 'u2', username: 'plantao', role: 'VIEWER' } as unknown as AuthUser;

function build() {
  const alarms = new DemoAlarmRepository();
  const suppressions = new DemoAlarmSuppressionRepository();
  const service = new AlarmSuppressionService(alarms, suppressions, () => NOW);
  return { alarms, suppressions, service };
}

/** Alarme INTERFACE_DOWN aberto (o caso classico: "desliguei a porta de proposito"). */
async function seedDownAlarm(alarms: DemoAlarmRepository) {
  const [alarm] = await alarms.openInterfaceDownAlarms([
    { deviceId: 'dev-1', interfaceId: 'iface-1', ifIndex: 3, startedAt: NOW },
  ]);
  return alarm!;
}

describe('ACK de alarme', () => {
  let context: ReturnType<typeof build>;
  beforeEach(() => {
    context = build();
  });

  it('registra usuario e horario sem resolver o alarme', async () => {
    const alarm = await seedDownAlarm(context.alarms);

    const acked = await context.service.acknowledge(alarm.id, OPERATOR);

    expect(acked.acknowledgedAt).toBe(NOW.toISOString());
    expect(acked.acknowledgedBy).toBe('qa-preview');
    // ACK nao resolve, nao encerra e nao desativa regra.
    expect(acked.endedAt).toBeNull();
    expect((await context.alarms.listActive()).map((item) => item.id)).toEqual([alarm.id]);
  });

  it('e idempotente: o primeiro reconhecimento permanece', async () => {
    const alarm = await seedDownAlarm(context.alarms);

    await context.service.acknowledge(alarm.id, OPERATOR);
    const again = await context.service.acknowledge(alarm.id, OTHER);

    expect(again.acknowledgedBy).toBe('qa-preview');
    expect(again.acknowledgedAt).toBe(NOW.toISOString());
  });

  it('recusa ACK em alarme ja encerrado e em id inexistente', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    await context.service.suppress(
      { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'INTENTIONAL_SHUTDOWN' },
      OPERATOR,
    );

    await expect(context.service.acknowledge(alarm.id, OPERATOR)).rejects.toMatchObject({
      code: 'ALARM_NOT_ACTIVE',
    });
    await expect(context.service.acknowledge('missing', OPERATOR)).rejects.toBeInstanceOf(
      AlarmSuppressionError,
    );
  });
});

describe('supressao de alarme', () => {
  let context: ReturnType<typeof build>;
  beforeEach(() => {
    context = build();
  });

  it('encerra o alarme com motivo administrativo e bloqueia a reabertura', async () => {
    const alarm = await seedDownAlarm(context.alarms);

    const result = await context.service.suppress(
      {
        alarmId: alarm.id,
        mode: 'UNTIL_CLEAR',
        reason: 'INTENTIONAL_SHUTDOWN',
        note: 'porta desligada para manutencao do cliente',
      },
      OPERATOR,
    );

    expect(result.closedAlarms).toBe(1);
    expect(result.suppression).toMatchObject({
      fingerprint: 'iface-1|INTERFACE_DOWN',
      mode: 'UNTIL_CLEAR',
      reason: 'INTENTIONAL_SHUTDOWN',
      suppressedBy: 'qa-preview',
      clearedAt: null,
    });

    const history = await context.alarms.listHistory(10, { resolvedOnly: true });
    expect(history[0]?.endedAt).toBe(NOW.toISOString());
    // Nunca como recuperacao tecnica: o motivo administrativo fica explicito.
    expect(history[0]?.metadata).toMatchObject({ resolutionReason: 'INTENTIONAL_SHUTDOWN' });
    expect(await context.alarms.listActive()).toHaveLength(0);
  });

  it('grava MANUAL_SUPPRESSION quando o motivo e OTHER', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    await context.service.suppress(
      { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'OTHER' },
      OPERATOR,
    );

    const history = await context.alarms.listHistory(10, { resolvedOnly: true });
    expect(history[0]?.metadata).toMatchObject({ resolutionReason: 'MANUAL_SUPPRESSION' });
  });

  it('recusa supressao duplicada do mesmo fingerprint', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    await context.service.suppress(
      { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
      OPERATOR,
    );

    await expect(
      context.service.suppress(
        { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: 'SUPPRESSION_CONFLICT' });
    expect(await context.service.listActive()).toHaveLength(1);
  });

  it('exige janela futura em UNTIL_TIME', async () => {
    const alarm = await seedDownAlarm(context.alarms);

    await expect(
      context.service.suppress({ alarmId: alarm.id, mode: 'UNTIL_TIME', reason: 'MAINTENANCE' }, OPERATOR),
    ).rejects.toMatchObject({ code: 'INVALID_WINDOW' });

    await expect(
      context.service.suppress(
        {
          alarmId: alarm.id,
          mode: 'UNTIL_TIME',
          reason: 'MAINTENANCE',
          expiresAt: new Date(NOW.getTime() - 60_000),
        },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WINDOW' });

    const result = await context.service.suppress(
      {
        alarmId: alarm.id,
        mode: 'UNTIL_TIME',
        reason: 'MAINTENANCE',
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
      OPERATOR,
    );
    expect(result.suppression.expiresAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });

  it('libera a supressao manualmente e nunca duas vezes', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    const { suppression } = await context.service.suppress(
      { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'FALSE_POSITIVE' },
      OPERATOR,
    );

    const released = await context.service.release(suppression.id);
    expect(released.clearedReason).toBe('MANUAL');
    expect(released.clearedAt).toBe(NOW.toISOString());
    expect(await context.service.listActive()).toHaveLength(0);

    await expect(context.service.release(suppression.id)).rejects.toMatchObject({
      code: 'SUPPRESSION_NOT_FOUND',
    });
  });

  it('expira a janela UNTIL_TIME e mantem o historico visivel', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    await context.service.suppress(
      {
        alarmId: alarm.id,
        mode: 'UNTIL_TIME',
        reason: 'MAINTENANCE',
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
      OPERATOR,
    );

    const later = new AlarmSuppressionService(
      context.alarms,
      context.suppressions,
      () => new Date(NOW.getTime() + 120_000),
    );
    expect(await later.listActive()).toHaveLength(0);
    expect(await later.expireDue()).toBe(1);

    const recent = await later.listRecent(10);
    expect(recent[0]).toMatchObject({ clearedReason: 'EXPIRED' });
  });
});

describe('fingerprint e indice de supressoes', () => {
  let context: ReturnType<typeof build>;
  beforeEach(() => {
    context = build();
  });

  it('usa o mesmo fingerprint do alarme metrico (regra + metrica)', async () => {
    const created = await context.alarms.openMetricAlarm({
      deviceId: 'dev-1',
      interfaceId: 'iface-9',
      ifIndex: 9,
      ruleId: 'rule-7',
      type: 'INTERFACE_CRC',
      severity: 'WARNING',
      metricKey: 'FCS',
      currentValue: 12,
      thresholdValue: 0,
      unit: 'per_min',
      metadata: {},
      message: 'CRC',
      startedAt: NOW,
    });
    if (!created) throw new Error('alarme nao criado');

    expect(fingerprintForAlarm(created)).toBe('iface-9|INTERFACE_CRC|rule-7|FCS');

    await context.service.suppress(
      { alarmId: created.id, mode: 'UNTIL_CLEAR', reason: 'FALSE_POSITIVE' },
      OPERATOR,
    );
    const active = await context.service.listActive();
    expect(active[0]?.fingerprint).toBe('iface-9|INTERFACE_CRC|rule-7|FCS');
  });

  it('indexa as supressoes ativas pelo fingerprint', async () => {
    const alarm = await seedDownAlarm(context.alarms);
    await context.service.suppress(
      { alarmId: alarm.id, mode: 'UNTIL_CLEAR', reason: 'FALSE_POSITIVE' },
      OPERATOR,
    );

    const active = await context.suppressions.listActive(NOW);
    expect(indexActiveSuppressions(active).get('iface-1|INTERFACE_DOWN')).toMatchObject({
      id: active[0]!.id,
      reason: 'FALSE_POSITIVE',
    });
  });

  it('clearRecovered libera apenas supressoes UNTIL_CLEAR', async () => {
    const [first] = await context.alarms.openInterfaceDownAlarms([
      { deviceId: 'dev-1', interfaceId: 'iface-1', ifIndex: 3, startedAt: NOW },
    ]);
    const [second] = await context.alarms.openInterfaceDownAlarms([
      { deviceId: 'dev-1', interfaceId: 'iface-2', ifIndex: 4, startedAt: NOW },
    ]);
    await context.service.suppress(
      { alarmId: first!.id, mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
      OPERATOR,
    );
    await context.service.suppress(
      {
        alarmId: second!.id,
        mode: 'UNTIL_TIME',
        reason: 'MAINTENANCE',
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
      OPERATOR,
    );

    const cleared = await context.suppressions.clearRecovered(
      ['iface-1|INTERFACE_DOWN', 'iface-2|INTERFACE_DOWN'],
      NOW,
    );

    expect(cleared).toBe(1);
    const active = await context.service.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ interfaceId: 'iface-2', mode: 'UNTIL_TIME' });
  });
});