import { PrismaClient } from '../../generated/prisma/index.js';
import { assertDisposable, loadConfig, saveEvidence } from './fixture';
import { withSingleConnection } from '../../infrastructure/snmp/fast-poller-lease';
const config = loadConfig();
assertDisposable(config, config.databaseUrl);
const cases = [
  ['short-idle', 'max_idle_connection_lifetime', '3'],
  ['no-idle', 'max_idle_connection_lifetime', '0'],
  ['short-lifetime', 'max_connection_lifetime', '3'],
] as const;
const results = await Promise.all(
  cases.map(async ([name, param, value]) => {
    const url = new URL(withSingleConnection(config.databaseUrl));
    url.searchParams.set(param, value);
    const db = new PrismaClient({ datasourceUrl: url.toString() }),
      samples: unknown[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const rows = await db.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pg_backend_pid() AS pid',
        );
        samples.push({ at: new Date().toISOString(), pid: rows[0]!.pid });
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { name, param, value, samples };
    } finally {
      await db.$disconnect();
    }
  }),
);
saveEvidence('session-pool-probe', { synthetic: true, readOnly: true, results });
console.log(JSON.stringify(results));
