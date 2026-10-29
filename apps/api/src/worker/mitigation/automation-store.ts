import type { PrismaClient } from '../../generated/prisma/index.js';

export interface AutomationTx {
  get<T>(id: string): Promise<T | null>;
  put(id: string, kind: string, status: string, payload: unknown): Promise<void>;
  list<T>(kind: string, statuses?: readonly string[], limit?: number): Promise<T[]>;
  dueOutbox<T>(now: number, limit?: number): Promise<T[]>;
}
export interface AutomationStore {
  transaction<T>(work: (tx: AutomationTx) => Promise<T>): Promise<T>;
}

/** Short state transactions only; never hold this database lock over SSH/HTTP. */
export class PrismaAutomationStore implements AutomationStore {
  constructor(private readonly db: PrismaClient) {}
  transaction<T>(work: (tx: AutomationTx) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (db) => {
        await db.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(793710029)`;
        return work({
          dueOutbox: async <R>(now: number, limit = 1000) => {
            const where = {
              kind: 'outbox',
              status: { in: ['PENDING', 'SENDING'] },
              AND: [
                { payload: { path: ['nextAt'], lte: now } },
                { payload: { path: ['leaseUntil'], lte: now } },
              ],
            };
            const controls = await db.mitigationAutomationRecord.findMany({
              where: {
                ...where,
                payload: { path: ['event'], not: 'MITIGATION_DETECTION_BLOCKED' },
              },
              orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
              take: limit,
            });
            const detections =
              controls.length < limit
                ? await db.mitigationAutomationRecord.findMany({
                    where: {
                      ...where,
                      payload: { path: ['event'], equals: 'MITIGATION_DETECTION_BLOCKED' },
                    },
                    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
                    take: limit - controls.length,
                  })
                : [];
            return [...controls, ...detections].map((row) => row.payload as R);
          },
          get: async <R>(id: string) => {
            const row = await db.mitigationAutomationRecord.findUnique({ where: { id } });
            return row ? (row.payload as R) : null;
          },
          put: async (id, kind, status, payload) => {
            const data = { kind, status, payload: JSON.parse(JSON.stringify(payload)) };
            await db.mitigationAutomationRecord.upsert({
              where: { id },
              create: { id, ...data },
              update: data,
            });
          },
          list: async <R>(kind: string, statuses?: readonly string[], limit = 1000) => {
            const rows = await db.mitigationAutomationRecord.findMany({
              where: { kind, ...(statuses ? { status: { in: [...statuses] } } : {}) },
              orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
              take: limit,
            });
            return rows.map((row) => row.payload as R);
          },
        });
      },
      { timeout: 10000, maxWait: 2000 },
    );
  }
}

/** Test adapter. Reusing the instance models process restart; failures roll back. */
export class MemoryAutomationStore implements AutomationStore {
  private rows = new Map<string, { kind: string; status: string; payload: unknown }>();
  private chain: Promise<unknown> = Promise.resolve();
  transaction<T>(work: (tx: AutomationTx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const draft = structuredClone(this.rows);
      const value = await work({
        dueOutbox: async <R>(now: number, limit = 1000) =>
          [...draft.values()]
            .filter((r) => {
              const p = r.payload as { nextAt: number; leaseUntil: number };
              return (
                r.kind === 'outbox' &&
                ['PENDING', 'SENDING'].includes(r.status) &&
                p.nextAt <= now &&
                p.leaseUntil <= now
              );
            })
            .sort(
              (a, b) =>
                Number((a.payload as { event: string }).event === 'MITIGATION_DETECTION_BLOCKED') -
                Number((b.payload as { event: string }).event === 'MITIGATION_DETECTION_BLOCKED'),
            )
            .slice(0, limit)
            .map((r) => structuredClone(r.payload) as R),
        get: async <R>(id: string) => structuredClone(draft.get(id)?.payload ?? null) as R | null,
        put: async (id, kind, status, payload) => {
          draft.set(id, { kind, status, payload: structuredClone(payload) });
        },
        list: async <R>(kind: string, statuses?: readonly string[], limit = 1000) =>
          [...draft.values()]
            .filter((r) => r.kind === kind && (!statuses || statuses.includes(r.status)))
            .slice(0, limit)
            .map((r) => structuredClone(r.payload) as R),
      });
      this.rows = draft;
      return value;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
