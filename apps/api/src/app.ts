import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerRoutes } from './routes';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import { Prisma } from './generated/prisma';

export interface BuildAppOptions {
  credentialEncryptionKey?: string | null;
  requireAuth?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  registerRoutes(app, options);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: 'Invalid request', issues: error.issues });
    }
    if (error instanceof PhysicalInventoryError) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.code(409).send({ message: 'Já existe um registro físico com esses dados' });
      }
      if (error.code === 'P2003' || error.code === 'P2004' || error.code === 'P2014') {
        return reply.code(409).send({ message: 'O registro físico ainda possui dependências' });
      }
    }
    app.log.error(error);
    return reply.code(500).send({ message: 'Internal server error' });
  });
  return app;
}
