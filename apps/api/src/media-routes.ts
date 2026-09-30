import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '@gmj/shared';
import {
  MediaIntegrationService,
  MediaSecretUnavailableError,
} from './infrastructure/media/media-integration-service';
import {
  MEDIA_DIRECTIONS,
  MEDIA_INTEGRATION_PURPOSES,
  MEDIA_INTEGRATION_TYPES,
} from './infrastructure/media/media-types';

// API administrativa da camada de MIDIAS (Fase 9).
//
// Nenhum endpoint devolve segredo: a resposta traz apenas
// `outboundTokenConfigured` / `inboundTokenConfigured`. O valor em texto claro
// aparece UMA vez, e somente no retorno da rotacao do token de entrada.

const integrationParams = z.object({ id: z.string().min(1).max(160) });

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.enum(MEDIA_INTEGRATION_TYPES).optional(),
    purpose: z.enum(MEDIA_INTEGRATION_PURPOSES),
    enabled: z.boolean().optional(),
    outboundUrl: z.string().url().max(500).nullable().optional(),
    outboundToken: z.string().min(1).max(500).optional(),
    inboundEnabled: z.boolean().optional(),
    importFromEnv: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    outboundUrl: z.string().url().max(500).nullable().optional(),
    outboundToken: z.string().min(1).max(500).optional(),
    clearOutboundToken: z.boolean().optional(),
    inboundEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

const logsQuery = z.object({
  direction: z.enum(MEDIA_DIRECTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface MediaRouteDependencies {
  media: MediaIntegrationService;
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  dependencies: MediaRouteDependencies,
): void {
  const { media, currentUser } = dependencies;

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

  /** Escrita (URL/token/teste/rotacao) exige administrador. */
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

  app.get('/api/media/integrations', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    return media.overview();
  });

  app.get('/api/media/integrations/:id', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    const { id } = integrationParams.parse(request.params);
    const integration = await media.get(id);
    if (!integration) {
      return reply.code(404).send({ message: 'Integração de mídia não encontrada' });
    }
    return integration;
  });

  app.post('/api/media/integrations', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const input = createSchema.parse(request.body ?? {});
    return media.create(input);
  });

  const notFound = async (
    id: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await media.get(id)) return false;
    reply.code(404).send({ message: 'Integração de mídia não encontrada' });
    return true;
  };

  app.patch('/api/media/integrations/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = integrationParams.parse(request.params);
    const input = updateSchema.parse(request.body ?? {});
    if (await notFound(id, reply)) return undefined;
    return media.update(id, input);
  });

  app.post('/api/media/integrations/:id/rotate-inbound-token', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = integrationParams.parse(request.params);
    if (await notFound(id, reply)) return undefined;
    const rotated = await media.rotateInboundToken(id);
    // Unica resposta da API que carrega o token em texto claro: mostrada uma vez.
    return {
      token: rotated.token,
      integration: rotated.integration,
      warning: 'Este token não será exibido novamente. Atualize o n8n.',
    };
  });

  app.post('/api/media/integrations/:id/test', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return undefined;
    const { id } = integrationParams.parse(request.params);
    if (await notFound(id, reply)) return undefined;
    return media.testWebhook(id);
  });

  app.get('/api/media/integrations/:id/logs', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    const { id } = integrationParams.parse(request.params);
    const query = logsQuery.parse(request.query ?? {});
    return media.listLogs({
      mediaIntegrationId: id,
      direction: query.direction,
      limit: query.limit,
    });
  });

  /**
   * Log operacional global (inclui entregas feitas pelo ENV legado, que nao
   * pertencem a nenhuma integracao persistida).
   */
  app.get('/api/media/logs', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    const query = logsQuery.parse(request.query ?? {});
    return media.listLogs({ direction: query.direction, limit: query.limit });
  });

  /**
   * Resumo usado pelo drawer da mitigacao: apenas "n8n configurado?" + status.
   * Nunca devolve URL/token.
   */
  app.get('/api/media/summary', async (request, reply) => {
    if (!(await requireUser(request, reply))) return undefined;
    const overview = await media.overview();
    const integration = overview.integration;
    const outboundConfigured = Boolean(
      (integration?.enabled && integration.outboundConfigured) ||
        overview.legacyEnv.outboundUrlConfigured,
    );
    const inboundConfigured = Boolean(
      (integration?.inboundEnabled && integration.inboundTokenConfigured) ||
        overview.legacyEnv.inboundTokenConfigured,
    );
    return {
      configured: outboundConfigured,
      outboundConfigured,
      inboundConfigured,
      status: integration?.status ?? (outboundConfigured ? 'NEVER_TESTED' : 'NOT_CONFIGURED'),
      configSource: integration?.configSource ?? (outboundConfigured ? 'ENV' : 'NONE'),
      repositoryKind: overview.repositoryKind,
      migrationReady: overview.migrationReady,
      lastOutboundAt: integration?.lastOutboundAttemptAt ?? null,
      lastOutboundStatusCode: integration?.lastOutboundStatusCode ?? null,
      lastInboundAt: integration?.lastInboundAt ?? null,
      lastInboundAction: integration?.lastInboundAction ?? null,
    };
  });
}

export { MediaSecretUnavailableError };
