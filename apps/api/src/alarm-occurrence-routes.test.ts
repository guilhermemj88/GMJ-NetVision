import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser, InterfaceOccurrence } from '@gmj/shared';
import { registerAlarmRoutes } from './alarm-routes';
import type { AlarmRepository } from './infrastructure/alarms/alarm-repository';

const alarmRepository = {
  listActive: async () => [],
  listHistory: async () => [],
} as unknown as AlarmRepository;

const occurrence: InterfaceOccurrence = {
  kind: 'CRC',
  deviceId: 'dev-1',
  deviceName: 'BHE-VTA-S6750-MPLS-01',
  interfaceId: 'if-1',
  interfaceName: '100GE1/0/1',
  interfaceLabel: 'TO-CORE-01',
  ifIndex: 12,
  crcDelta: '4',
  rxDelta: '0',
  txDelta: '0',
  ratePerMinute: 0.27,
  lastOccurrenceAt: '2026-10-07T12:00:00.000Z',
  intervals: 1,
  windowMinutes: 15,
};

async function buildApp(
  occurrences?: (windowMinutes: number, limit: number) => Promise<InterfaceOccurrence[]>,
): Promise<FastifyInstance> {
  const app = Fastify();
  registerAlarmRoutes(app, {
    alarms: alarmRepository,
    ...(occurrences ? { occurrences } : {}),
    currentUser: async () => ({ id: 'u1', username: 'admin', role: 'ADMIN' }) as unknown as AuthUser,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

describe('API de ocorrencias recentes', () => {
  it('responde leitura publica com a janela padrao', async () => {
    const provider = vi.fn().mockResolvedValue([occurrence]);
    const app = await buildApp(provider);

    const response = await app.inject({ method: 'GET', url: '/api/alarms/occurrences' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({ kind: 'CRC', crcDelta: '4' });
    expect(provider).toHaveBeenCalledWith(15, 12);
    await app.close();
  });

  it('aceita minutos/limite validos e rejeita fora da faixa', async () => {
    const provider = vi.fn().mockResolvedValue([]);
    const app = await buildApp(provider);

    await app.inject({ method: 'GET', url: '/api/alarms/occurrences?minutes=30&limit=5' });
    expect(provider).toHaveBeenCalledWith(30, 5);

    const invalid = await app.inject({ method: 'GET', url: '/api/alarms/occurrences?minutes=0' });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('nao registra a rota quando o read model nao esta disponivel', async () => {
    const app = await buildApp(undefined);
    const response = await app.inject({ method: 'GET', url: '/api/alarms/occurrences' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
