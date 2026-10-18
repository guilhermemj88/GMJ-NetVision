import { createServer } from 'node:http';
import type { FastTrafficPoller } from './fast-traffic-poller';

/** Loopback-only diagnostics; no command routes, no engine and no mutation endpoints. */
export function fastObserverServer(poller: FastTrafficPoller, release: string) {
  const startedAt = new Date().toISOString();
  return createServer((req, res) => {
    if (req.method !== 'GET' || !['/health', '/metrics'].includes(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const status = poller.status();
    const healthy =
      status.running &&
      status.monitoredDevices > 0 &&
      status.lastError === null &&
      status.entries.length > 0 &&
      status.entries.every(
        (e) =>
          e.lastCollectedAt &&
          Date.now() - Date.parse(e.lastCollectedAt) <= 45000 &&
          ![
            'SNMP_ERROR',
            'SNMP_TIMEOUT',
            'PERSISTENCE_ERROR',
            'PERSISTENCE_REJECTED',
            'OUT_OF_ORDER',
          ].includes(e.quality),
      );
    res.writeHead(req.url === '/health' && !healthy ? 503 : 200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        release,
        startedAt,
        observationOnly: true,
        executionAvailable: false,
        healthy,
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        ...status,
      }),
    );
  });
}
