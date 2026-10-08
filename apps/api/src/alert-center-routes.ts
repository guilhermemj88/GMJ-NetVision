import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ALERT_CENTER_CATEGORIES,
  ALERT_CENTER_MAX_LIMIT,
  ALERT_CENTER_PERIODS,
  ALERT_CENTER_STATE_FILTERS,
  ALERT_CENTER_TYPE_OPTIONS,
  type AuthUser,
} from '@gmj/shared';
import type { AlertCenterService } from './application/alert-center-service';

export interface AlertCenterRouteDependencies {
  alertCenter: AlertCenterService;
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

const typeValues = ALERT_CENTER_TYPE_OPTIONS.map((option) => option.value) as [string, ...string[]];

const listQuerySchema = z
  .object({
    state: z.enum(ALERT_CENTER_STATE_FILTERS).optional(),
    category: z.enum(ALERT_CENTER_CATEGORIES).optional(),
    /** Repetido (`?type=A&type=B`) ou unico; vazio = todos. */
    type: z.union([z.string(), z.array(z.string())]).optional(),
    severity: z
      .union([z.enum(['CRITICAL', 'MAJOR', 'WARNING', 'INFO']), z.array(z.enum(['CRITICAL', 'MAJOR', 'WARNING', 'INFO']))])
      .optional(),
    period: z.enum(ALERT_CENTER_PERIODS).optional(),
    search: z.string().trim().max(120).optional(),
    deviceId: z.string().min(1).max(160).optional(),
    interfaceId: z.string().min(1).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(ALERT_CENTER_MAX_LIMIT).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const filtered = list.filter((item) => item.length > 0);
  return filtered.length ? filtered : undefined;
}

/** Registra o read model da Central de Alertas (F9.3). */
export function registerAlertCenterRoutes(
  app: FastifyInstance,
  dependencies: AlertCenterRouteDependencies,
): void {
  const { alertCenter, currentUser } = dependencies;

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
   * Pagina unica de alarmes + ocorrencias, com resumo operacional junto (o
   * painel nao precisa de uma segunda chamada so para os cards).
   */
  app.get('/api/alert-center', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const query = listQuerySchema.parse(request.query);
    const types = asArray(query.type);
    if (types) {
      const unknown = types.filter((type) => !typeValues.includes(type));
      if (unknown.length) {
        return reply.code(400).send({ message: `Tipo desconhecido: ${unknown.join(', ')}` });
      }
    }
    return alertCenter.list({
      state: query.state,
      category: query.category,
      types,
      severities: asArray(query.severity) as never,
      period: query.period,
      search: query.search,
      deviceId: query.deviceId,
      interfaceId: query.interfaceId,
      limit: query.limit,
      offset: query.offset,
    });
  });

  /** Resumo leve (badge da TopBar) sem carregar itens. */
  app.get('/api/alert-center/summary', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    return { summary: await alertCenter.summary() };
  });
}
