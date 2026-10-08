import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SnapshotRendererConfig } from './config.js';
import { isAllowedSnapshotPath, isAllowedTarget } from './allowlist.js';
import { createRenderQueue } from './render-queue.js';

export interface SnapshotServerDeps {
  config: SnapshotRendererConfig;
  render: (request: { url: string; width: number; height: number; timeoutMs: number }) => Promise<Buffer>;
  browserVersion?: (() => string | null) | undefined;
  startedAt?: number;
  /** Limite de requisicoes aguardando na fila antes de responder 503. */
  maxQueue?: number;
}

const MAX_BODY_BYTES = 8 * 1024;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface RenderBody {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  timeoutMs?: unknown;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/**
 * Servico HTTP minimo (sem dependencias novas) que expoe:
 *  - GET  /health -> estado do browser e estatisticas de render
 *  - POST /render -> PNG do snapshot (allowlist de origem + token local)
 */
export function createSnapshotServer(deps: SnapshotServerDeps): Server {
  const queue = createRenderQueue({ concurrency: deps.config.maxConcurrent });
  const maxQueue = deps.maxQueue ?? 8;
  const startedAt = deps.startedAt ?? Date.now();

  const json = (response: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, code: number, body: unknown): void => {
    response.writeHead(code, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  return createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && (url === '/health' || url === '/healthz')) {
      return json(response, 200, {
        ok: true,
        browser: deps.browserVersion?.() ?? null,
        uptimeMs: Date.now() - startedAt,
        queue: { active: queue.active(), pending: queue.pending() },
        ...readStats(deps),
      });
    }
    if (request.method !== 'POST' || url !== '/render') {
      return json(response, 404, { message: 'Rota não encontrada' });
    }
    if (deps.config.renderToken && !safeEqual(request.headers['x-netvision-render-token']?.toString() ?? '', deps.config.renderToken)) {
      return json(response, 403, { message: 'Token de render inválido' });
    }
    if (queue.pending() > maxQueue) {
      return json(response, 503, { message: 'Renderizador ocupado' });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        json(response, 413, { message: 'Corpo grande demais' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      let body: RenderBody;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RenderBody;
      } catch {
        return json(response, 400, { message: 'JSON inválido' });
      }
      const target = typeof body.url === 'string' ? body.url : '';
      if (!isAllowedTarget(target, deps.config.allowedOrigin) || !isAllowedSnapshotPath(target)) {
        return json(response, 400, { message: 'Destino não permitido' });
      }
      const renderRequest = {
        url: target,
        width: positiveInt(body.width, 1200, 2400),
        height: positiveInt(body.height, 720, 2400),
        timeoutMs: positiveInt(body.timeoutMs, deps.config.timeoutMs, 60_000),
      };
      void queue
        .run(() => deps.render(renderRequest))
        .then((png) => {
          response.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(png.length),
          });
          response.end(png);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'falha desconhecida';
          json(response, 500, { message: `Falha ao renderizar: ${message}` });
        });
    });
  });
}

function readStats(deps: SnapshotServerDeps): Record<string, unknown> {
  const renderer = deps.render as unknown as { stats?: () => Record<string, unknown> };
  return renderer.stats ? { render: renderer.stats() } : {};
}
