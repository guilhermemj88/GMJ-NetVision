import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../generated/prisma/index.js';
import { createFastPollerLease, withSingleConnection } from './fast-poller-lease';
import { assertDisposable, loadConfig } from '../../scripts/homolog/fixture';

const url = process.env.HOMOLOG_LEASE_DATABASE_URL;
it.skipIf(!url)(
  'dedicated PostgreSQL session survives pool recycling settings, excludes a second owner, and fails closed on backend loss',
  async () => {
    assertDisposable(loadConfig(), url!);
    const configured = new URL(url!);
    configured.searchParams.set('connection_limit', '3');
    configured.searchParams.set('max_idle_connection_lifetime', '3');
    configured.searchParams.set('max_connection_lifetime', '3');
    const a = new PrismaClient({ datasourceUrl: withSingleConnection(configured.toString()) }),
      b = new PrismaClient({ datasourceUrl: withSingleConnection(configured.toString()) }),
      control = new PrismaClient({ datasourceUrl: url! });
    const key = 'synthetic-homolog-lease-' + randomUUID(),
      first = createFastPollerLease({ client: a, key }),
      second = createFastPollerLease({ client: b, key });
    try {
      expect(await first.acquire()).toBe(true);
      const pid = first.status().holderBackendPid;
      expect(await second.acquire()).toBe(false);
      await new Promise((r) => setTimeout(r, 4200));
      expect(await first.verify()).toBe(true);
      expect(first.status().holderBackendPid).toBe(pid);
      expect(await second.acquire()).toBe(false);
      const stopped = await control.$queryRawUnsafe<Array<{ stopped: boolean }>>(
        'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user',
        pid,
      );
      expect(stopped[0]?.stopped).toBe(true);
      expect(await first.verify()).toBe(false);
      expect(first.status().lost).toBe(true);
      expect(await second.acquire()).toBe(true);
    } finally {
      await first.release();
      await second.release();
      await Promise.all([a.$disconnect(), b.$disconnect(), control.$disconnect()]);
    }
  },
  20000,
);
