/**
 * MAP-VISUAL-V2 — Fase D: modo SOMENTE LEITURA para previews isolados.
 *
 * A instância de preview consome dados REAIS da API de produção. Para que ela
 * seja read-only de fato (e não apenas "com botões desabilitados"), este módulo
 * aplica três travas independentes, todas do lado do servidor:
 *
 *  1. HTTP: qualquer requisição que não seja GET/HEAD/OPTIONS é recusada com
 *     403 — exceto o login (autenticação, nenhum dado operacional é alterado).
 *  2. Prisma: qualquer operação de escrita (create/update/delete/upsert/
 *     executeRaw…) lança `ReadOnlyViolationError` antes de chegar ao banco,
 *     mesmo que alguma rota escape da trava HTTP.
 *  3. Processo: nenhum upgrade de WebSocket é aceito e os jobs de background
 *     (polling SNMP, sweep de DESCRIPTION, motor de mitigação) não são
 *     iniciados.
 *
 * Ativação: variável de ambiente `NETVISION_READ_ONLY=1`. Sem ela o
 * comportamento é exatamente o de hoje (produção não é afetada).
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from './generated/prisma';

export const READ_ONLY_ENV = 'NETVISION_READ_ONLY';

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'sim']);

export function parseReadOnlyFlag(value: string | null | undefined): boolean {
  return TRUTHY.has((value ?? '').trim().toLowerCase());
}

export function isReadOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseReadOnlyFlag(env[READ_ONLY_ENV]);
}

/** Únicas escritas toleradas no modo read-only: o login do operador. */
export const READ_ONLY_WRITE_ALLOWLIST: readonly RegExp[] = [
  /^\/api\/auth\/login\/?$/,
  /^\/api\/auth\/logout\/?$/,
];

export function readOnlyPathOf(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  return withoutQuery.split('#')[0] ?? '';
}

/** Deve a requisição ser recusada nesta instância? */
export function isReadOnlyRequestBlocked(method: string, url: string): boolean {
  const normalized = method.trim().toUpperCase();
  if (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') return false;
  const path = readOnlyPathOf(url);
  return !READ_ONLY_WRITE_ALLOWLIST.some((pattern) => pattern.test(path));
}

/** Operações do Prisma que alteram estado. */
export const READ_ONLY_WRITE_OPERATIONS: readonly string[] = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'executeRaw',
  'executeRawUnsafe',
  'runCommandRaw',
  'findRaw',
];

const WRITE_OPERATION_SET = new Set(READ_ONLY_WRITE_OPERATIONS);

/**
 * Único modelo cuja escrita é tolerada: a SESSÃO de autenticação do preview.
 *
 * Sem isso o operador não consegue nem entrar (o login persiste um token), e a
 * tabela `Session` guarda apenas `tokenHash`, `userId` e `expiresAt` — nada de
 * mapa, enlace, equipamento, métrica, alarme, mitigação ou configuração.
 */
export const READ_ONLY_WRITE_ALLOWED_MODELS: readonly string[] = ['Session'];

const ALLOWED_MODEL_SET = new Set(READ_ONLY_WRITE_ALLOWED_MODELS);

export class ReadOnlyViolationError extends Error {
  readonly operation: string;
  readonly model: string | undefined;

  constructor(operation: string, model?: string) {
    super(
      `Instância read-only: a operação "${operation}"${model ? ` em ${model}` : ''} foi bloqueada antes de chegar ao banco.`,
    );
    this.name = 'ReadOnlyViolationError';
    this.operation = operation;
    this.model = model;
  }
}

/** Usado pela extensão do Prisma — puro e testável. */
export function assertOperationAllowed(operation: string, model?: string): void {
  if (!WRITE_OPERATION_SET.has(operation)) return;
  if (model !== undefined && ALLOWED_MODEL_SET.has(model)) return;
  throw new ReadOnlyViolationError(operation, model);
}

/**
 * Extensão aplicada ao PrismaClient do processo: barra escritas em QUALQUER
 * model, inclusive dentro de `$transaction` e de SQL cru de escrita.
 */
export function readOnlyPrismaExtension() {
  return Prisma.defineExtension({
    name: 'netvision-read-only',
    query: {
      $allOperations({ model, operation, query, args }) {
        assertOperationAllowed(operation, model);
        return query(args);
      },
    },
  });
}

/**
 * Registra a trava HTTP (e recusa upgrades de WebSocket) quando o modo está
 * ativo. Devolve `true` quando o processo está em read-only, para o chamador
 * poder pular jobs de background.
 */
export function registerReadOnlyGuard(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isReadOnlyMode(env)) return false;

  app.addHook('onRequest', async (request, reply) => {
    if (!isReadOnlyRequestBlocked(request.method, request.url)) return;
    app.log.warn(
      { method: request.method, url: request.url },
      'read-only: requisição de escrita bloqueada',
    );
    return reply.code(403).send({
      message: 'Instância de preview em modo somente leitura: escrita bloqueada.',
      readOnly: true,
    });
  });

  // Não há WebSocket na aplicação hoje; se algum upgrade aparecer, é recusado.
  app.server.on('upgrade', (request, socket) => {
    app.log.warn({ url: request.url }, 'read-only: upgrade de WebSocket recusado');
    socket.destroy();
  });

  app.log.warn(
    'NETVISION_READ_ONLY ativo: escritas HTTP e WebSocket bloqueadas e jobs de background desligados',
  );
  return true;
}
