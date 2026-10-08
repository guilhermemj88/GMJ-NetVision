import { PrismaClient } from '../../generated/prisma/index.js';

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
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __netvisionPrismaClient?: PrismaClient;
};

export const prismaClient: PrismaClient =
  globalForPrisma.__netvisionPrismaClient ?? new PrismaClient();

globalForPrisma.__netvisionPrismaClient = prismaClient;

/** Fecha o pool unico do processo (idempotente). */
export async function disconnectPrismaClient(): Promise<void> {
  await prismaClient.$disconnect();
}
