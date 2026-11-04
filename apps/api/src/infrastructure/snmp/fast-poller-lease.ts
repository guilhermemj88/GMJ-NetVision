/**
 * Posse unica do coletor FAST entre processos (single-owner distribuido).
 *
 * O coletor embutido na API e o observador externo rodam em processos
 * diferentes e ambos podem apontar para o mesmo equipamento. Duas coletas
 * simultaneas do mesmo ifIndex produzem baselines independentes e, portanto,
 * taxas divergentes para o MESMO instante — o motor AUTO passaria a decidir
 * sobre numeros que ninguem consegue reproduzir. Esta lease elimina essa
 * possibilidade com um advisory lock de sessao do PostgreSQL.
 *
 * Regras:
 * - fail-closed: sem lease nao ha coleta (`acquire()` devolve false e quem
 *   chama NAO inicia o poller);
 * - o lock e de SESSAO: morre junto com a conexao, sem TTL para expirar
 *   sozinho e sem janela em que dois processos se considerem donos;
 * - `verify()` confere o backend PID: se o processo perdeu a conexao, perdeu a
 *   posse e o coletor precisa parar.
 */

/** Cliente minimo (Prisma ou fake) — uma conexao dedicada por lease. */
export interface FastPollerLeaseClient {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $disconnect(): Promise<void>;
}

export interface FastPollerLeaseStatus {
  enabled: boolean;
  key: string | null;
  acquired: boolean;
  holderBackendPid: number | null;
  acquiredAt: string | null;
  lastVerifiedAt: string | null;
  lost: boolean;
  lastError: string | null;
}

export interface FastPollerLease {
  /** Tenta a posse. `false` = outro processo e o dono (nao e erro). */
  acquire(): Promise<boolean>;
  /** Reconfirma a posse; `false` invalida a lease e exige parada da coleta. */
  verify(): Promise<boolean>;
  release(): Promise<void>;
  status(): FastPollerLeaseStatus;
}

export interface FastPollerLeaseOptions {
  /** `null` desabilita a lease (modo legado, um processo por instalacao). */
  client: FastPollerLeaseClient | null;
  /** Chave estavel por instalacao; nunca inclui credenciais. */
  key?: string;
  now?: () => Date;
}

export function fastPollerLeaseKey(installation: string | undefined): string {
  const id = (installation ?? '').trim();
  return `netvision:fast-poller:${id || 'unidentified'}`;
}

/**
 * O advisory lock e de SESSAO: a lease precisa de uma conexao dedicada e
 * exclusiva. Sem `connection_limit=1` o pool do Prisma poderia entregar outra
 * conexao no meio do caminho e o lock ficaria orfao.
 */
export function withSingleConnection(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', '1');
    if (!parsed.searchParams.has('pool_timeout')) parsed.searchParams.set('pool_timeout', '10');
    return parsed.toString();
  } catch {
    return url;
  }
}

const ACQUIRE_SQL = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok';
const PID_SQL = 'SELECT pg_backend_pid() AS pid';
const RELEASE_SQL = 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released';

export function createFastPollerLease(options: FastPollerLeaseOptions): FastPollerLease {
  const client = options.client;
  const key = client ? (options.key ?? fastPollerLeaseKey(process.env.NETVISION_INSTALLATION_ID)) : null;
  const now = options.now ?? (() => new Date());
  let state: FastPollerLeaseStatus = {
    enabled: client !== null,
    key,
    acquired: false,
    holderBackendPid: null,
    acquiredAt: null,
    lastVerifiedAt: null,
    lost: false,
    lastError: null,
  };

  const failure = (error: unknown): string =>
    error instanceof Error ? error.message.slice(0, 200) : 'LEASE_ERROR';

  return {
    async acquire(): Promise<boolean> {
      if (!client || !key) return false;
      if (state.acquired) return true;
      try {
        const rows = await client.$queryRawUnsafe<Array<{ ok: boolean }>>(ACQUIRE_SQL, key);
        if (rows[0]?.ok !== true) return false;
        const pid = await client.$queryRawUnsafe<Array<{ pid: number }>>(PID_SQL);
        state = {
          ...state,
          acquired: true,
          lost: false,
          lastError: null,
          holderBackendPid: Number(pid[0]?.pid ?? 0) || null,
          acquiredAt: now().toISOString(),
        };
        return true;
      } catch (error) {
        state = { ...state, acquired: false, lastError: failure(error) };
        return false;
      }
    },

    async verify(): Promise<boolean> {
      if (!client || !key || !state.acquired) return false;
      try {
        const pid = await client.$queryRawUnsafe<Array<{ pid: number }>>(PID_SQL);
        const current = Number(pid[0]?.pid ?? 0) || null;
        // O advisory lock pertence a sessao: PID diferente = sessao nova = sem posse.
        const held = current !== null && current === state.holderBackendPid;
        state = {
          ...state,
          acquired: held,
          lost: !held,
          lastVerifiedAt: now().toISOString(),
          lastError: held ? null : 'LEASE_LOST',
        };
        return held;
      } catch (error) {
        state = {
          ...state,
          acquired: false,
          lost: true,
          lastVerifiedAt: now().toISOString(),
          lastError: failure(error),
        };
        return false;
      }
    },

    async release(): Promise<void> {
      if (!client || !key || !state.acquired) return;
      try {
        await client.$queryRawUnsafe(RELEASE_SQL, key);
      } catch (error) {
        state = { ...state, lastError: failure(error) };
      } finally {
        state = { ...state, acquired: false };
      }
    },

    status: () => ({ ...state }),
  };
}
