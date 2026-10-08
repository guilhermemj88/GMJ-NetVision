import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HistoryPeriod } from '@gmj/shared';
import { verifyMediaToken, verifySnapshotToken, type SnapshotSpec } from './snapshot-token';

/**
 * Pagina interna do snapshot (dados do gráfico) e entrega do PNG.
 *
 * As duas rotas sao publicas apenas porque o que as protege e um token
 * ASSINADO, de escopo minimo e curto: leitura de UMA interface, por UM
 * periodo. Nao existe credencial reutilizavel e nao ha escrita, SNMP nem
 * acesso a configuracoes por aqui.
 */
export interface SnapshotRouteDeps {
  getInterfaceHistory(interfaceId: string, period: HistoryPeriod): Promise<unknown[]>;
  getInterfaceOpticalHistory(interfaceId: string, period: HistoryPeriod): Promise<unknown[]>;
  signingKey: string | null;
  cacheDir: string;
  ttlSeconds: number;
  now?: () => Date;
}

const tokenParam = z.object({ token: z.string().min(1).max(4096) });
const CACHE_KEY_PATTERN = /^[0-9a-f]{8,64}$/;

export function registerSnapshotRoutes(app: FastifyInstance, deps: SnapshotRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  app.get('/api/public/snapshot/:token', async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    if (!deps.signingKey) {
      return reply.code(503).send({ message: 'Snapshot desabilitado' });
    }
    const spec = verifySnapshotToken(token, deps.signingKey, now().getTime());
    if (!spec) {
      return reply.code(404).send({ message: 'Snapshot expirado ou inválido' });
    }
    const points =
      spec.kind === 'OPTICAL'
        ? await deps.getInterfaceOpticalHistory(spec.interfaceId, spec.period)
        : await deps.getInterfaceHistory(spec.interfaceId, spec.period);
    return { spec: publicSpec(spec), points } satisfies SnapshotPayload;
  });

  app.get('/media/snapshot/:token', async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    if (!deps.signingKey) {
      return reply.code(503).send({ message: 'Snapshot desabilitado' });
    }
    const fileName = token.endsWith('.png') ? token.slice(0, -4) : token;
    const media = verifyMediaToken(fileName, deps.signingKey, now().getTime());
    if (!media || !CACHE_KEY_PATTERN.test(media.cacheKey)) {
      return reply.code(404).send({ message: 'Imagem expirada ou inválida' });
    }
    const path = join(deps.cacheDir, `${media.cacheKey}.png`);
    try {
      const info = await stat(path);
      if (now().getTime() - info.mtimeMs > deps.ttlSeconds * 1000 + 60_000) {
        return reply.code(404).send({ message: 'Imagem expirada' });
      }
      const png = await readFile(path);
      return reply
        .type('image/png')
        .header('cache-control', `private, max-age=${deps.ttlSeconds}`)
        .header('content-length', String(png.length))
        .send(png);
    } catch {
      return reply.code(404).send({ message: 'Imagem indisponível' });
    }
  });
}

/** Snapshot publico: sem chaves internas, so o que a pagina desenha. */
function publicSpec(spec: SnapshotSpec) {
  return {
    kind: spec.kind,
    period: spec.period,
    header: spec.header,
    metric: spec.metric,
    optical: spec.optical,
  };
}

export type SnapshotPayload = {
  spec: ReturnType<typeof publicSpec>;
  points: unknown[];
};
