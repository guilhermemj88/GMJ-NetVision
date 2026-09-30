import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MITIGATION_COMMAND_ACTIONS,
  type MitigationCommandService,
} from './infrastructure/bgp/mitigation/mitigation-command-service';

// Canal INBOUND: n8n -> NetVision.
//
// Endpoint semantico dedicado: o n8n pede UMA acao de mitigacao por perfil.
// Nunca aceita CLI, policy, node, RT, host ou credencial - tudo isso e
// reconstruido internamente pelo NetVision a partir do profile persistido.

export const n8nCommandSchema = z
  .object({
    requestId: z.string().min(1).max(160),
    action: z.enum(MITIGATION_COMMAND_ACTIONS),
    profileId: z.string().min(1).max(160),
  })
  .strict();

/** Log operacional do inbound: NUNCA carrega o bearer token. */
export interface N8nInboundLog {
  requestId: string | null;
  action: string | null;
  profileId: string | null;
  status: string;
  httpStatus: number;
  ok: boolean;
  idempotent: boolean | null;
  safeError: string | null;
}

export interface N8nRouteDependencies {
  commands: MitigationCommandService;
  /** Secret do inbound (ENV NETVISION_N8N_COMMAND_TOKEN). Nunca logado. */
  commandToken: string | null;
  /**
   * Token persistido na camada de MIDIAS (Fase 9). Quando devolve um valor,
   * ele vence o ENV legado.
   */
  resolveCommandToken?: () => Promise<string | null>;
  /** Observabilidade: chamado apos cada requisicao (sem segredo). */
  onCommandResult?: (log: N8nInboundLog) => Promise<void> | void;
}

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** Comparacao em tempo constante: tamanho diferente nao vaza posicao. */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerN8nRoutes(app: FastifyInstance, dependencies: N8nRouteDependencies): void {
  const { commands, commandToken, resolveCommandToken, onCommandResult } = dependencies;

  const record = async (log: N8nInboundLog): Promise<void> => {
    if (!onCommandResult) return;
    try {
      await onCommandResult(log);
    } catch {
      // O log operacional nunca pode derrubar o canal de comando.
    }
  };

  const expectedToken = async (): Promise<string | null> => {
    if (resolveCommandToken) {
      try {
        const persisted = await resolveCommandToken();
        if (persisted) return persisted;
      } catch {
        // Falha na camada de midias cai para o ENV legado.
      }
    }
    return commandToken;
  };

  app.post('/api/integrations/n8n/mitigation-command', async (request, reply) => {
    const configured = await expectedToken();
    if (!configured) {
      await record({
        requestId: null,
        action: null,
        profileId: null,
        status: 'NOT_CONFIGURED',
        httpStatus: 503,
        ok: false,
        idempotent: null,
        safeError: 'Integração n8n não configurada neste ambiente',
      });
      return reply.code(503).send({
        ok: false,
        status: 'NOT_CONFIGURED',
        safeError: 'Integração n8n não configurada neste ambiente',
      });
    }

    const raw = request.body as { requestId?: unknown; action?: unknown; profileId?: unknown } | null;
    const rawId = typeof raw?.requestId === 'string' ? raw.requestId : null;
    const rawAction = typeof raw?.action === 'string' ? raw.action : null;
    const rawProfile = typeof raw?.profileId === 'string' ? raw.profileId : null;

    const token = readBearer(request.headers.authorization);
    if (!token || !safeEqual(token, configured)) {
      // resposta sem qualquer detalhe do secret
      await record({
        requestId: rawId,
        action: rawAction,
        profileId: rawProfile,
        status: 'UNAUTHORIZED',
        httpStatus: 401,
        ok: false,
        idempotent: null,
        safeError: 'Token ausente ou inválido',
      });
      return reply.code(401).send({
        ok: false,
        status: 'UNAUTHORIZED',
        safeError: 'Token ausente ou inválido',
      });
    }

    const parsed = n8nCommandSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const campos = parsed.error.issues
        .map((issue) => (issue.path.length ? issue.path.join('.') : 'body'))
        .join(', ');
      await record({
        requestId: rawId,
        action: rawAction,
        profileId: rawProfile,
        status: 'INVALID_REQUEST',
        httpStatus: 400,
        ok: false,
        idempotent: null,
        safeError: `Payload inválido (${campos})`,
      });
      return reply.code(400).send({
        ok: false,
        status: 'INVALID_REQUEST',
        safeError: `Payload inválido (${campos})`,
      });
    }

    const result = await commands.execute(parsed.data);
    await record({
      requestId: parsed.data.requestId,
      action: parsed.data.action,
      profileId: parsed.data.profileId,
      status: result.status,
      httpStatus: 200,
      ok: result.ok,
      idempotent: result.idempotent,
      safeError: result.safeError ?? null,
    });
    return result;
  });
}
