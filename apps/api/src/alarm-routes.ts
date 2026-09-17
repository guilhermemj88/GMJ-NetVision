import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlarmRepository } from './infrastructure/alarms/alarm-repository';

export function registerAlarmRoutes(
  app: FastifyInstance,
  dependencies: { alarms: AlarmRepository },
): void {
  const { alarms } = dependencies;

  app.get('/api/alarms', async () => alarms.listActive());

  app.get('/api/alarms/history', async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return alarms.listHistory(limit);
  });
}
