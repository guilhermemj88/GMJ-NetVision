import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { readObserverHealth } from './prisma-fast-bridge-reader';

it('uses only loopback GET health, rejects redirects and collector failure, times out safely', async () => {
  let status = 200,
    delay = false;
  const server = createServer((_, res) => {
    if (delay) return;
    res.writeHead(
      status,
      status === 302 ? { Location: '/other' } : { 'Content-Type': 'application/json' },
    );
    res.end(
      JSON.stringify({
        observationOnly: true,
        executionAvailable: false,
        healthy: true,
        mode: 'OBSERVE',
        running: true,
        entries: [],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
  try {
    expect((await readObserverHealth(base)).running).toBe(true);
    status = 503;
    await expect(readObserverHealth(base)).rejects.toThrow('unavailable');
    status = 302;
    await expect(readObserverHealth(base)).rejects.toThrow();
    await expect(readObserverHealth('http://45.163.144.1/health')).rejects.toThrow('loopback');
    await expect(readObserverHealth(base + '?secret=value')).rejects.toThrow('loopback');
    delay = true;
    await expect(readObserverHealth(base)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
