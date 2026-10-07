import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { registerAlarmRoutes } from './alarm-routes';
import { AlarmSuppressionService } from './application/alarm-suppression-service';
import { DemoAlarmRepository } from './infrastructure/alarms/demo-alarm-repository';
import { DemoAlarmSuppressionRepository } from './infrastructure/alarms/demo-alarm-suppression-repository';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const ADMIN = { id: 'u1', username: 'qa-preview', role: 'ADMIN' } as unknown as AuthUser;

let alarms: DemoAlarmRepository;
let suppressions: DemoAlarmSuppressionRepository;
let alarmId: string;

beforeEach(async () => {
  alarms = new DemoAlarmRepository();
  suppressions = new DemoAlarmSuppressionRepository();
  const [alarm] = await alarms.openInterfaceDownAlarms([
    { deviceId: 'dev-1', interfaceId: 'iface-1', ifIndex: 3, startedAt: NOW },
  ]);
  alarmId = alarm!.id;
});

async function buildApp(user: AuthUser | null = ADMIN): Promise<FastifyInstance> {
  const app = Fastify();
  registerAlarmRoutes(app, {
    alarms,
    suppressions: new AlarmSuppressionService(alarms, suppressions, () => NOW),
    currentUser: async () => user,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

describe('API de ACK e supressao (F9.1)', () => {
  it('exige sessao em todas as rotas operacionais', async () => {
    const app = await buildApp(null);

    for (const call of [
      { method: 'POST' as const, url: `/api/alarms/${alarmId}/acknowledge` },
      { method: 'POST' as const, url: `/api/alarms/${alarmId}/suppress`, payload: { mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' } },
      { method: 'GET' as const, url: '/api/alarm-suppressions?active=true' },
      { method: 'DELETE' as const, url: '/api/alarm-suppressions/sup-1' },
    ]) {
      const response = await app.inject(call);
      expect(response.statusCode).toBe(401);
    }

    // Leitura de alarmes continua publica (comportamento preservado).
    expect((await app.inject({ method: 'GET', url: '/api/alarms' })).statusCode).toBe(200);
    await app.close();
  });

  it('reconhece o alarme mantendo-o ativo e sem gerar RESOLVED', async () => {
    const app = await buildApp();

    const acked = await app.inject({ method: 'POST', url: `/api/alarms/${alarmId}/acknowledge` });
    expect(acked.statusCode).toBe(200);
    expect(acked.json()).toMatchObject({
      id: alarmId,
      acknowledgedBy: 'qa-preview',
      acknowledgedAt: NOW.toISOString(),
      endedAt: null,
    });
    // ACK nunca marca RESOLVED (nenhuma midia de encerramento e disparada).
    expect(acked.json().resolutionNotifiedAt).toBeFalsy();

    const active = await app.inject({ method: 'GET', url: '/api/alarms' });
    expect(active.json()).toHaveLength(1);

    const again = await app.inject({ method: 'POST', url: `/api/alarms/${alarmId}/acknowledge` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ acknowledgedBy: 'qa-preview' });
    await app.close();
  });

  it('retira o alarme com motivo estruturado e libera na sequencia', async () => {
    const app = await buildApp();

    const suppressed = await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_CLEAR', reason: 'INTENTIONAL_SHUTDOWN', note: 'porta do cliente' },
    });
    expect(suppressed.statusCode).toBe(200);
    const body = suppressed.json();
    expect(body.closedAlarms).toBe(1);
    expect(body.suppression).toMatchObject({
      fingerprint: 'iface-1|INTERFACE_DOWN',
      mode: 'UNTIL_CLEAR',
      reason: 'INTENTIONAL_SHUTDOWN',
      suppressedBy: 'qa-preview',
      clearedAt: null,
    });

    const active = await app.inject({ method: 'GET', url: '/api/alarm-suppressions?active=true' });
    expect(active.json()).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/api/alarm-suppressions' });
    expect(list.json()[0]).toMatchObject({ id: body.suppression.id, mode: 'UNTIL_CLEAR' });

    const released = await app.inject({
      method: 'DELETE',
      url: `/api/alarm-suppressions/${body.suppression.id}`,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ clearedReason: 'MANUAL' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/alarm-suppressions?active=true' })).json(),
    ).toHaveLength(0);
    await app.close();
  });

  it('responde 409 em supressao duplicada e 400 em janela invalida', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
    });
    const duplicated = await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
    });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json()).toMatchObject({ code: 'SUPPRESSION_CONFLICT' });

    // Janela invalida e validada antes do conflito de fingerprint.
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_TIME', reason: 'MAINTENANCE' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_WINDOW' });

    // Corpo invalido (motivo fora do enum) continua 400 do Zod.
    const malformed = await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_CLEAR', reason: 'WHATEVER' },
    });
    expect(malformed.statusCode).toBe(400);
    await app.close();
  });

  it('responde 404 para alarme/supressao inexistente e 409 para alarme encerrado', async () => {
    const app = await buildApp();

    expect(
      (await app.inject({ method: 'POST', url: '/api/alarms/missing/acknowledge' })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/alarms/missing/suppress',
          payload: { mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/alarm-suppressions/missing' })).statusCode,
    ).toBe(404);

    await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/suppress`,
      payload: { mode: 'UNTIL_CLEAR', reason: 'MAINTENANCE' },
    });
    const ackClosed = await app.inject({
      method: 'POST',
      url: `/api/alarms/${alarmId}/acknowledge`,
    });
    expect(ackClosed.statusCode).toBe(409);
    expect(ackClosed.json()).toMatchObject({ code: 'ALARM_NOT_ACTIVE' });
    await app.close();
  });
});