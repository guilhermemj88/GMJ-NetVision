import { describe, expect, it } from 'vitest';
import {
  createFastPollerLease,
  fastPollerLeaseKey,
  withSingleConnection,
  type FastPollerLeaseClient,
} from './fast-poller-lease';

/** Prisma fake com advisory lock de sessao: o "servidor" e o proprio fake. */
function fakeClient(options: { lockHeldElsewhere?: boolean } = {}) {
  const calls: string[] = [];
  let held = false;
  let pid = 4242;
  const client: FastPollerLeaseClient = {
    async $queryRawUnsafe<T>(sql: string): Promise<T> {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_lock')) {
        if (held) return [{ ok: true }] as unknown as T;
        if (options.lockHeldElsewhere) return [{ ok: false }] as unknown as T;
        held = true;
        return [{ ok: true }] as unknown as T;
      }
      if (sql.includes('pg_backend_pid')) return [{ pid }] as unknown as T;
      if (sql.includes('pg_advisory_unlock')) {
        held = false;
        return [{ released: true }] as unknown as T;
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async $disconnect(): Promise<void> {},
  };
  return {
    client,
    calls,
    /** Simula reconexao do pool: nova sessao, portanto sem o lock antigo. */
    newSession(nextPid: number) {
      pid = nextPid;
      held = false;
    },
  };
}

describe('posse unica do coletor FAST (advisory lock de sessao)', () => {
  it('lease desabilitada nao adquire e nao finge posse', async () => {
    const lease = createFastPollerLease({ client: null });
    expect(lease.status().enabled).toBe(false);
    await expect(lease.acquire()).resolves.toBe(false);
    await expect(lease.verify()).resolves.toBe(false);
    expect(lease.status().acquired).toBe(false);
  });

  it('primeiro processo adquire e registra o backend PID', async () => {
    const { client } = fakeClient();
    const lease = createFastPollerLease({ client, key: 'k' });
    await expect(lease.acquire()).resolves.toBe(true);
    const status = lease.status();
    expect(status.acquired).toBe(true);
    expect(status.holderBackendPid).toBe(4242);
    expect(status.acquiredAt).not.toBeNull();
  });

  it('segundo processo NAO adquire enquanto o primeiro e dono', async () => {
    const { client } = fakeClient({ lockHeldElsewhere: true });
    const lease = createFastPollerLease({ client, key: 'k' });
    await expect(lease.acquire()).resolves.toBe(false);
    expect(lease.status().acquired).toBe(false);
    expect(lease.status().lost).toBe(false);
  });

  it('perda de sessao invalida a posse (fail-closed)', async () => {
    const fake = fakeClient();
    const lease = createFastPollerLease({ client: fake.client, key: 'k' });
    await lease.acquire();
    await expect(lease.verify()).resolves.toBe(true);

    fake.newSession(9999);
    await expect(lease.verify()).resolves.toBe(false);
    expect(lease.status().acquired).toBe(false);
    expect(lease.status().lost).toBe(true);
    expect(lease.status().lastError).toBe('LEASE_LOST');
  });

  it('release devolve o lock e permite nova aquisicao', async () => {
    const fake = fakeClient();
    const lease = createFastPollerLease({ client: fake.client, key: 'k' });
    await lease.acquire();
    await lease.release();
    expect(lease.status().acquired).toBe(false);
    expect(fake.calls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
    await expect(lease.acquire()).resolves.toBe(true);
  });

  it('erro de banco nunca vira posse otimista', async () => {
    const client: FastPollerLeaseClient = {
      async $queryRawUnsafe<T>(): Promise<T> {
        throw new Error('connection refused');
      },
      async $disconnect(): Promise<void> {},
    };
    const lease = createFastPollerLease({ client, key: 'k' });
    await expect(lease.acquire()).resolves.toBe(false);
    expect(lease.status().acquired).toBe(false);
    expect(lease.status().lastError).toContain('connection refused');
  });

  it('chave e estavel por instalacao e nao vaza credencial', () => {
    expect(fastPollerLeaseKey('IMPLANTAR')).toBe('netvision:fast-poller:IMPLANTAR');
    expect(fastPollerLeaseKey(undefined)).toBe('netvision:fast-poller:unidentified');
  });

  it('URL da lease fica presa a UMA conexao sem perder os demais parametros', () => {
    const url = withSingleConnection('postgresql://u:p@db:5432/netvision?schema=public');
    expect(url).toContain('connection_limit=1');
    expect(url).toContain('pool_timeout=10');
    expect(url).toContain('schema=public');
    // Idempotente: nao sobrescreve o que o operador ja definiu.
    const custom = withSingleConnection('postgresql://u:p@db:5432/nv?connection_limit=3');
    expect(custom).toContain('connection_limit=3');
  });
});
