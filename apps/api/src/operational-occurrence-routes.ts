import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OPERATIONAL_OCCURRENCE_TYPES, type AuthUser } from '@gmj/shared';
import {
  OperationalOccurrenceError,
  type OperationalOccurrenceService,
} from './application/operational-occurrence-service';

export interface OperationalOccurrenceRouteDependencies {
  occurrences: OperationalOccurrenceService;
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

/** Erro de dominio da ocorrencia vira HTTP sem vazar detalhe interno. */
function sendOccurrenceError(reply: FastifyReply, error: unknown) {
  if (error instanceof OperationalOccurrenceError) {
    const status = error.code === 'OCCURRENCE_NOT_FOUND' ? 404 : 409;
    return reply.code(status).send({ message: error.message, code: error.code });
  }
  throw error;
}

const listQuerySchema = z
  .object({
    active: z.enum(['true', 'false']).optional(),
    unacknowledged: z.enum(['true', 'false']).optional(),
    type: z.enum(OPERATIONAL_OCCURRENCE_TYPES).optional(),
    deviceId: z.string().min(1).max(160).optional(),
    interfaceId: z.string().min(1).max(160).optional(),
    /** ISO 8601; data invalida vira 400, nunca filtro ignorado em silencio. */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const idParams = z.object({ id: z.string().min(1).max(160) });

export function registerOperationalOccurrenceRoutes(
  app: FastifyInstance,
  dependencies: OperationalOccurrenceRouteDependencies,
): void {
  const { occurrences, currentUser } = dependencies;

  const requireUser = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | null> => {
    const user = currentUser ? await currentUser(request) : null;
    if (!user) {
      reply.code(401).send({ message: 'Sessão obrigatória' });
      return null;
    }
    return user;
  };

  /**
   * Ocorrencias persistentes (CRC/FCS e discards) com filtros operacionais.
   * Leitura autenticada: dados de interface nao sao publicos.
   */
  app.get('/api/operational-occurrences', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const query = listQuerySchema.parse(request.query);
    return occurrences.list({
      active: query.active === undefined ? undefined : query.active === 'true',
      unacknowledged:
        query.unacknowledged === undefined ? undefined : query.unacknowledged === 'true',
      type: query.type,
      deviceId: query.deviceId,
      interfaceId: query.interfaceId,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
  });

  /**
   * ACK da ocorrencia: encerra o episodio atual sem apagar historico e sem
   * tocar em nenhum alarme. Repetir e idempotente (primeiro operador fica).
   */
  app.post('/api/operational-occurrences/:id/acknowledge', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const { id } = idParams.parse(request.params);
    try {
      return await occurrences.acknowledge(id, user);
    } catch (error) {
      return sendOccurrenceError(reply, error);
    }
  });
}
