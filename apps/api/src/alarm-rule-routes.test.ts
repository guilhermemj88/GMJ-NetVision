import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { registerAlarmRoutes } from './alarm-routes';
import type { AlarmRepository } from './infrastructure/alarms/alarm-repository';
import { DemoAlarmRuleRepository } from './infrastructure/alarms/demo-alarm-rule-repository';

const ADMIN = { id: 'u1', username: 'admin', role: 'ADMIN' } as unknown as AuthUser;
const VIEWER = { id: 'u2', username: 'viewer', role: 'VIEWER' } as unknown as AuthUser;

const resolveOpenMetricAlarmsForRule = vi.fn().mockResolvedValue(0);

const alarmRepository = {
  listActive: async () => [],
  listHistory: async () => [],
  resolveOpenMetricAlarmsForRule,
} as unknown as AlarmRepository;

beforeEach(() => {
  resolveOpenMetricAlarmsForRule.mockClear();
});

async function buildApp(user: AuthUser | null = ADMIN): Promise<FastifyInstance> {
  const app = Fastify();
  registerAlarmRoutes(app, {
    alarms: alarmRepository,
    rules: new DemoAlarmRuleRepository(),
    currentUser: async () => user,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

const validRule = {
  name: 'Erros RX',
  type: 'INTERFACE_ERRORS',
  severity: 'MAJOR',
  config: {
    direction: 'RX',
    thresholdPerMinute: 50,
    recoveryThresholdPerMinute: 10,
    triggerSamples: 3,
    recoverySamples: 3,
  },
};

describe('API de regras de alarme', () => {
  it('preserva /api/alarms sem sessao e exige sessao para as regras', async () => {
    const app = await buildApp(null);
    const alarms = await app.inject({ method: 'GET', url: '/api/alarms' });
    expect(alarms.statusCode).toBe(200);
    const rules = await app.inject({ method: 'GET', url: '/api/alarm-rules' });
    expect(rules.statusCode).toBe(401);
    await app.close();
  });

  it('exige administrador para escrever', async () => {
    const app = await buildApp(VIEWER);
    const response = await app.inject({ method: 'POST', url: '/api/alarm-rules', payload: validRule });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('cria, lista, atualiza, desabilita e exclui regra', async () => {
    const app = await buildApp();

    const created = await app.inject({ method: 'POST', url: '/api/alarm-rules', payload: validRule });
    expect(created.statusCode).toBe(200);
    const rule = created.json();
    expect(rule).toMatchObject({
      name: 'Erros RX',
      type: 'INTERFACE_ERRORS',
      enabled: true,
      mapLinkedOnly: true,
      mediaEnabled: false,
      scope: {},
      severity: 'MAJOR',
    });
    expect(rule.config.thresholdPerMinute).toBe(50);

    const list = await app.inject({ method: 'GET', url: '/api/alarm-rules' });
    expect(list.json()).toHaveLength(1);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/alarm-rules/${rule.id}`,
      payload: { ...validRule, severity: 'CRITICAL', config: { ...validRule.config, thresholdPerMinute: 80, recoveryThresholdPerMinute: 20 } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ severity: 'CRITICAL' });
    expect(updated.json().config.thresholdPerMinute).toBe(80);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/alarm-rules/${rule.id}`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);
    expect(resolveOpenMetricAlarmsForRule).toHaveBeenCalledWith(
      rule.id,
      expect.any(Date),
      'RULE_DISABLED',
    );

    const removed = await app.inject({ method: 'DELETE', url: `/api/alarm-rules/${rule.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });
    expect(resolveOpenMetricAlarmsForRule).toHaveBeenCalledTimes(2);
    expect(resolveOpenMetricAlarmsForRule).toHaveBeenLastCalledWith(
      rule.id,
      expect.any(Date),
      'RULE_DELETED',
    );
    const after = await app.inject({ method: 'GET', url: '/api/alarm-rules' });
    expect(after.json()).toHaveLength(0);

    await app.close();
  });

  it('rejeita corpo invalido com 400', async () => {
    const app = await buildApp();
    const badThresholds = await app.inject({
      method: 'POST',
      url: '/api/alarm-rules',
      payload: {
        ...validRule,
        config: { ...validRule.config, recoveryThresholdPerMinute: 60 },
      },
    });
    expect(badThresholds.statusCode).toBe(400);

    const legacyType = await app.inject({
      method: 'POST',
      url: '/api/alarm-rules',
      payload: { name: 'Down', type: 'INTERFACE_DOWN', severity: 'CRITICAL', config: {} },
    });
    expect(legacyType.statusCode).toBe(400);
    await app.close();
  });

  it('devolve 404 para regra inexistente', async () => {
    const app = await buildApp();
    const put = await app.inject({ method: 'PUT', url: '/api/alarm-rules/missing', payload: validRule });
    expect(put.statusCode).toBe(404);
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/alarm-rules/missing',
      payload: { enabled: true },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/alarm-rules/missing' });
    expect(del.statusCode).toBe(404);
    await app.close();
  });
});
