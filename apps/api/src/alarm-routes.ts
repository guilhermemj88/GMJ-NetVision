import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AlarmRuleDto, AuthUser, InterfaceOccurrence } from '@gmj/shared';
import type { AlarmRepository } from './infrastructure/alarms/alarm-repository';
import type { AlarmRuleRecord, AlarmRuleRepository } from './infrastructure/alarms/alarm-rule-repository';
import { createAlarmRuleSchema } from './infrastructure/alarms/alarm-rule-schema';
import {
  AlarmSuppressionError,
  type AlarmSuppressionService,
} from './application/alarm-suppression-service';

export interface AlarmRouteDependencies {
  alarms: AlarmRepository;
  /** CRUD de regras: registrado somente quando o repositorio esta disponivel. */
  rules?: AlarmRuleRepository;
  /** Read model das ocorrencias recentes (CRC/discards) derivado das amostras. */
  occurrences?: (windowMinutes: number, limit: number) => Promise<InterfaceOccurrence[]>;
  /** ACK e supressao operacional (F9.1). */
  suppressions?: AlarmSuppressionService;
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

function toRuleDto(record: AlarmRuleRecord): AlarmRuleDto {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    enabled: record.enabled,
    severity: record.severity,
    mapLinkedOnly: record.mapLinkedOnly,
    mediaEnabled: record.mediaEnabled,
    scope: record.scope,
    config: record.config,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Erro de dominio do ACK/supressao vira HTTP sem vazar detalhe interno. */
function sendSuppressionError(reply: FastifyReply, error: unknown) {
  if (error instanceof AlarmSuppressionError) {
    const status =
      error.code === 'INVALID_WINDOW'
        ? 400
        : error.code === 'ALARM_NOT_FOUND' || error.code === 'SUPPRESSION_NOT_FOUND'
          ? 404
          : 409;
    return reply.code(status).send({ message: error.message, code: error.code });
  }
  throw error;
}

const suppressionBodySchema = z
  .object({
    mode: z.enum(['UNTIL_CLEAR', 'UNTIL_TIME']),
    reason: z.enum(['INTENTIONAL_SHUTDOWN', 'MAINTENANCE', 'FALSE_POSITIVE', 'OTHER']),
    note: z.string().trim().max(280).nullish(),
    /** ISO 8601; obrigatorio em UNTIL_TIME. */
    expiresAt: z.string().min(4).nullish(),
  })
  .strict();

export function registerAlarmRoutes(
  app: FastifyInstance,
  dependencies: AlarmRouteDependencies,
): void {
  const { alarms, rules, occurrences, suppressions, currentUser } = dependencies;

  /** Leitura autenticada; escrita de regra apenas ADMIN (padrao da camada de midias). */
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

  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | null> => {
    const user = await requireUser(request, reply);
    if (!user) return null;
    if (user.role !== 'ADMIN') {
      reply.code(403).send({ message: 'Apenas administradores' });
      return null;
    }
    return user;
  };

  const idParams = z.object({ id: z.string().min(1).max(160) });

  app.get('/api/alarms', async () => alarms.listActive());

  /**
   * Ocorrencias recentes de CRC/FCS e discards: leitura derivada das amostras
   * persistidas, sem criar alarme e sem duplicar contador.
   */
  if (occurrences) {
    app.get('/api/alarms/occurrences', async (request) => {
      const { minutes, limit } = z
        .object({
          minutes: z.coerce.number().int().min(1).max(120).default(15),
          limit: z.coerce.number().int().min(1).max(50).default(12),
        })
        .parse(request.query);
      return occurrences(minutes, limit);
    });
  }

  app.get('/api/alarms/history', async (request) => {
    const { limit, resolved } = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        resolved: z.enum(['true', 'false']).default('false'),
      })
      .parse(request.query);
    return alarms.listHistory(limit, { resolvedOnly: resolved === 'true' });
  });

  if (suppressions) {
    /**
     * ACK: registra o operador e mantem o alarme ativo. Nao resolve, nao muda
     * endedAt, nao desativa regra e nao envia RESOLVED. Repetir e idempotente.
     */
    app.post('/api/alarms/:id/acknowledge', async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return undefined;
      const { id } = idParams.parse(request.params);
      try {
        return await suppressions.acknowledge(id, user);
      } catch (error) {
        return sendSuppressionError(reply, error);
      }
    });

    /**
     * Retirar/Suprimir: encerra o alarme aberto com motivo administrativo e
     * impede a reabertura do mesmo fingerprint enquanto a supressao valer.
     */
    app.post('/api/alarms/:id/suppress', async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return undefined;
      const { id } = idParams.parse(request.params);
      const body = suppressionBodySchema.parse(request.body ?? {});
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      try {
        return await suppressions.suppress(
          {
            alarmId: id,
            mode: body.mode,
            reason: body.reason,
            note: body.note ?? null,
            expiresAt,
          },
          user,
        );
      } catch (error) {
        return sendSuppressionError(reply, error);
      }
    });

    /** Historico de supressoes; `active=true` devolve apenas as que ainda valem. */
    app.get('/api/alarm-suppressions', async (request, reply) => {
      if (!(await requireUser(request, reply))) return undefined;
      const { active, limit } = z
        .object({
          active: z.enum(['true', 'false']).default('false'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      return active === 'true' ? suppressions.listActive() : suppressions.listRecent(limit);
    });

    /** Liberacao explicita: o fingerprint volta a poder abrir alarme. */
    app.delete('/api/alarm-suppressions/:id', async (request, reply) => {
      if (!(await requireUser(request, reply))) return undefined;
      const { id } = idParams.parse(request.params);
      try {
        return await suppressions.release(id);
      } catch (error) {
        return sendSuppressionError(reply, error);
      }
    });
  }

  if (!rules) return;

  const enabledSchema = z.object({ enabled: z.boolean() }).strict();

  app.get('/api/alarm-rules', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    return (await rules.list()).map(toRuleDto);
  });

  app.post('/api/alarm-rules', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const input = createAlarmRuleSchema.parse(request.body ?? {});
    return toRuleDto(await rules.create(input));
  });

  app.put('/api/alarm-rules/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = idParams.parse(request.params);
    const input = createAlarmRuleSchema.parse(request.body ?? {});
    const record = await rules.update(id, input);
    if (!record) return reply.code(404).send({ message: 'Regra de alarme não encontrada' });
    return toRuleDto(record);
  });

  app.patch('/api/alarm-rules/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = idParams.parse(request.params);
    const { enabled } = enabledSchema.parse(request.body ?? {});
    const record = await rules.setEnabled(id, enabled);
    if (!record) return reply.code(404).send({ message: 'Regra de alarme não encontrada' });
    // Regra desabilitada nao pode deixar alarme orfao aberto no painel.
    if (!enabled) await alarms.resolveOpenMetricAlarmsForRule(id, new Date(), 'RULE_DISABLED');
    return toRuleDto(record);
  });

  app.delete('/api/alarm-rules/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = idParams.parse(request.params);
    const removed = await rules.remove(id);
    if (!removed) return reply.code(404).send({ message: 'Regra de alarme não encontrada' });
    await alarms.resolveOpenMetricAlarmsForRule(id, new Date(), 'RULE_DELETED');
    return { removed: true };
  });
}