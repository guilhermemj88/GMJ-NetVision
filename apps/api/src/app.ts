import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerRoutes } from './routes';

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
    app.log.error(error);
    return reply.code(500).send({ message: 'Internal server error' });
  });
  return app;
}
