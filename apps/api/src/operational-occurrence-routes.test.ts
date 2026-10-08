import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { registerOperationalOccurrenceRoutes } from './operational-occurrence-routes';
import { OperationalOccurrenceService } from './application/operational-occurrence-service';
import { DemoOperationalOccurrenceRepository } from './infrastructure/alarms/demo-operational-occurrence-repository';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const ADMIN = {
  id: 'u1',
  username: 'qa-preview',
  email: 'qa@preview.local',
  name: 'QA',
  role: 'ADMIN',
} as AuthUser;

let service: OperationalOccurrenceService;
let repository: DemoOperationalOccurrenceRepository;

async function seedCrc(timestampMs: number = NOW, delta = 3n): Promise<string> {
  await service.processSamples({
    deviceId: 'dev-1',
    samples: [
      {
        interfaceId: 'iface-1',
        timestampMs,
        fcsErrorsDelta: delta,
        inDiscardsDelta: 0n,
        outDiscardsDelta: 0n,
      },
    ],
  });
  const { items } = await service.list();
  return items[0]!.id;
}

beforeEach(() => {
  repository = new DemoOperationalOccurrenceRepository((interfaceId) => ({
    deviceName: 'CEM-CEN-6730-MPLS-01',
    interfaceName: interfaceId === 'iface-1' ? '100GE0/0/2' : interfaceId,
    ifIndex: 67502222,
  }));
  service = new OperationalOccurrenceService(repository, { now: () => NOW });
});

async function buildApp(user: AuthUser | null = ADMIN): Promise<FastifyInstance> {
  const app = Fastify();
  registerOperationalOccurrenceRoutes(app, { occurrences: service, currentUser: async () => user });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

describe('API de ocorrencias operacionais (F9.2)', () => {
  it('exige sessao na leitura e no ACK', async () => {
    const app = await buildApp(null);
    const id = await seedCrc();
    expect((await app.inject({ method: 'GET', url: '/api/operational-occurrences' })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: `/api/operational-occurrences/${id}/acknowledge` }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });

  it('lista as ocorrencias com o payload completo do painel', async () => {
    const app = await buildApp();
    await seedCrc();
    const response = await app.inject({ method: 'GET', url: '/api/operational-occurrences' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
      items: [
        {
          type: 'CRC_FCS',
          fingerprint: 'iface-1|CRC_FCS',
          deviceName: 'CEM-CEN-6730-MPLS-01',
          interfaceName: '100GE0/0/2',
          ifIndex: 67502222,
          crcDeltaTotal: 3,
          occurrenceCount: 1,
          acknowledgedAt: null,
          closedAt: null,
          severity: 'WARNING',
        },
      ],
    });
    await app.close();
  });

  it('aplica filtros e devolve 400 em query invalida', async () => {
    const app = await buildApp();
    await seedCrc();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/operational-occurrences?active=true&type=CRC_FCS&limit=10&offset=0',
        })
      ).json().total,
    ).toBe(1);
    expect(
      (await app.inject({ method: 'GET', url: '/api/operational-occurrences?active=false' })).json()
        .total,
    ).toBe(1);
    expect(
      (await app.inject({ method: 'GET', url: '/api/operational-occurrences?type=NAO_EXISTE' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/operational-occurrences?from=nao-e-data' }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  it('reconhece a ocorrencia encerrando o episodio e mantendo o historico', async () => {
    const app = await buildApp();
    const id = await seedCrc();

    const acked = await app.inject({
      method: 'POST',
      url: `/api/operational-occurrences/${id}/acknowledge`,
    });
    expect(acked.statusCode).toBe(200);
    expect(acked.json()).toMatchObject({
      acknowledged: true,
      occurrence: {
        id,
        acknowledgedBy: 'qa-preview',
        acknowledgedAt: new Date(NOW).toISOString(),
        closeReason: 'ACKNOWLEDGED',
      },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/api/operational-occurrences?active=true' })).json()
        .total,
    ).toBe(0);
    expect(
      (await app.inject({ method: 'GET', url: '/api/operational-occurrences' })).json().total,
    ).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/operational-occurrences/${id}/acknowledge`,
    });
    expect(again.json()).toMatchObject({ acknowledged: false });
    expect(again.json().occurrence.acknowledgedBy).toBe('qa-preview');
    await app.close();
  });

  it('devolve 404 ao reconhecer ocorrencia inexistente', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/operational-occurrences/nao-existe/acknowledge',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'OCCURRENCE_NOT_FOUND' });
    await app.close();
  });
});
