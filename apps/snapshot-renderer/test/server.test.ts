import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotServer } from '../src/server.js';
import type { SnapshotRendererConfig } from '../src/config.js';

const ORIGIN = 'http://127.0.0.1:3005';
const TOKEN = 'b'.repeat(40);
const PAGE = `${ORIGIN}/snapshot/${TOKEN}`;

const config: SnapshotRendererConfig = {
  port: 0,
  host: '127.0.0.1',
  allowedOrigin: ORIGIN,
  renderToken: 'render-token-de-teste',
  cacheDir: '/tmp',
  maxConcurrent: 1,
  timeoutMs: 5_000,
  navTimeoutMs: 5_000,
};

let close: (() => Promise<void>) | null = null;

async function start(render: (request: { url: string }) => Promise<Buffer>) {
  const server = createSnapshotServer({ config, render: render as never, browserVersion: () => '156.0' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe('servidor do renderer', () => {
  it('GET /health informa browser e estatisticas', async () => {
    const base = await start(async () => Buffer.from([1]));
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { ok: boolean; browser: string };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.browser).toBe('156.0');
  });

  it('POST /render exige o token local', async () => {
    const render = vi.fn(async () => Buffer.from([1, 2, 3]));
    const base = await start(render);
    const withoutToken = await fetch(`${base}/render`, {
      method: 'POST',
      body: JSON.stringify({ url: PAGE }),
    });
    expect(withoutToken.status).toBe(403);
    expect(render).not.toHaveBeenCalled();

    const withToken = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netvision-render-token': config.renderToken! },
      body: JSON.stringify({ url: PAGE, width: 1200, height: 720 }),
    });
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await withToken.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE, width: 1200, height: 720 }));
  });

  it('recusa destino fora da allowlist (SSRF) e JSON invalido', async () => {
    const render = vi.fn(async () => Buffer.from([1]));
    const base = await start(render);
    const headers = { 'content-type': 'application/json', 'x-netvision-render-token': config.renderToken! };
    for (const url of ['http://169.254.169.254/latest', 'http://127.0.0.1:3000/api/maps', `http://127.0.0.1:3005/login`]) {
      const response = await fetch(`${base}/render`, { method: 'POST', headers, body: JSON.stringify({ url }) });
      expect(response.status).toBe(400);
    }
    const bad = await fetch(`${base}/render`, { method: 'POST', headers, body: '{' });
    expect(bad.status).toBe(400);
    expect(render).not.toHaveBeenCalled();
  });

  it('falha de render vira 500 com mensagem segura', async () => {
    const base = await start(async () => {
      throw new Error('timeout ao carregar página');
    });
    const response = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netvision-render-token': config.renderToken! },
      body: JSON.stringify({ url: PAGE }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Falha ao renderizar');
  });

  it('rota desconhecida responde 404', async () => {
    const base = await start(async () => Buffer.from([1]));
    expect((await fetch(`${base}/outra`)).status).toBe(404);
  });
});
