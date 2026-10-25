import { PrismaClient } from '../../generated/prisma/index.js';
import { isReadOnlyMode, readOnlyPrismaExtension } from '../../read-only';

/**
 * Um unico PrismaClient por processo.
 *
 * Cada `new PrismaClient()` abre o PROPRIO pool (`connection_limit` default
 * `cpus*2+1`), entao uma API com dezenas de repositorios abertos chega ao
 * `max_connections` do Postgres sem ninguem notar. O cliente compartilhado
 * mantem UM pool, UM conjunto de metricas e UM `$disconnect` no shutdown.
 *
 * `globalThis` evita segundo pool quando o modulo e avaliado duas vezes
 * (hot reload / bundle duplicado).
 *
 * Fase D: em `NETVISION_READ_ONLY=1` o cliente recebe a extensao que barra
 * qualquer escrita antes de chegar ao banco (previews isolados).
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __netvisionPrismaClient?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient();
  if (!isReadOnlyMode()) return client;
  // O cast mantem o tipo publico intacto: a extensao so troca o runtime.
  return client.$extends(readOnlyPrismaExtension()) as unknown as PrismaClient;
}

export const prismaClient: PrismaClient =
  globalForPrisma.__netvisionPrismaClient ?? createPrismaClient();

globalForPrisma.__netvisionPrismaClient = prismaClient;

/** Fecha o pool unico do processo (idempotente). */
export async function disconnectPrismaClient(): Promise<void> {
  await prismaClient.$disconnect();
}
