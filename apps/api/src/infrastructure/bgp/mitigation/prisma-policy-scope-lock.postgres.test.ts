import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { PrismaPolicyScopeLock } from './prisma-policy-scope-lock';
import { PolicyScopeBusyError, PolicyScopeLostError } from './mitigation-policy-lock';

/**
 * Lock de escopo por policy com PostgreSQL REAL (pg_try_advisory_xact_lock + transacao interativa do Prisma).
 * Prova o que os fakes nao provam: o prazo da lease e o fechamento real da transacao, a exclusao entre conexoes
 * distintas (equivalente a processos distintos) e a liberacao quando o dono morre.
 * Somente em banco DESCARTAVEL local (mesmo banco/porta dos demais testes de baseline).
 */
const url = process.env.MITIGATION_BASELINE_TEST_DATABASE_URL;
if (url) {
  const p = new URL(url);
  if (
    p.hostname !== '127.0.0.1' ||
    p.port !== '55077' ||
    p.pathname !== '/mitigation_baseline_test'
  )
    throw Error('DISPOSABLE_BASELINE_DATABASE_REQUIRED');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const scope = () => ({ deviceId: 'dev-lock-test', policyName: `POLICY-${Date.now()}-${++n}` });

describe.skipIf(!url)('PrismaPolicyScopeLock com PostgreSQL real', () => {
  const dbA = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
  const dbB = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
  const admin = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
  afterAll(async () => {
    await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), admin.$disconnect()]);
  });

  it('exclusao entre conexoes distintas: a segunda recebe POLICY_BUSY sem esperar e, liberada a primeira, entra', async () => {
    const a = new PrismaPolicyScopeLock(dbA, 30_000);
    const b = new PrismaPolicyScopeLock(dbB, 30_000);
    const s = scope();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = a.run(s, async () => {
      entered();
      await gate;
      return 'A';
    });
    await inside;
    const started = Date.now();
    await expect(b.run(s, async () => 'B')).rejects.toBeInstanceOf(PolicyScopeBusyError);
    expect(Date.now() - started).toBeLessThan(1500); // try-lock: nunca fica na fila
    release();
    await expect(holder).resolves.toBe('A');
    await expect(b.run(s, async () => 'B')).resolves.toBe('B');
  });

  it('16 tentativas simultaneas na MESMA policy, de duas conexoes: exatamente UMA entra', async () => {
    const locks = [new PrismaPolicyScopeLock(dbA, 30_000), new PrismaPolicyScopeLock(dbB, 30_000)];
    const s = scope();
    let inside = 0;
    let maxInside = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        locks[i % 2]!.run(s, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(400);
          inside -= 1;
          return i;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const busy = results.filter(
      (r) => r.status === 'rejected' && (r.reason as Error) instanceof PolicyScopeBusyError,
    );
    expect(busy).toHaveLength(15);
  });

  it('policies DIFERENTES nao se bloqueiam (exclusao por device+policy, nao global)', async () => {
    const a = new PrismaPolicyScopeLock(dbA, 30_000);
    const b = new PrismaPolicyScopeLock(dbB, 30_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = a.run(scope(), async () => {
      entered();
      await gate;
    });
    await inside;
    await expect(b.run(scope(), async () => 'outra-policy')).resolves.toBe('outra-policy');
    release();
    await holder;
  });

  it('TIMEOUT REAL da lease: depois do prazo remainingMs<=0, assertHeld lanca PolicyScopeLostError e o Postgres libera a policy', async () => {
    const timeoutMs = 1500;
    const a = new PrismaPolicyScopeLock(dbA, timeoutMs);
    const b = new PrismaPolicyScopeLock(dbB, 30_000);
    const s = scope();
    const observed: { early?: number; lateRemaining?: number; lateError?: unknown } = {};
    let acquiredByOther: string | null = null;
    const op = a.run(s, async (lease) => {
      await lease.assertHeld(); // dentro do prazo: ok
      observed.early = lease.remainingMs();
      await sleep(timeoutMs + 900); // ultrapassa o prazo da transacao
      observed.lateRemaining = lease.remainingMs();
      try {
        await lease.assertHeld();
      } catch (e) {
        observed.lateError = e;
      }
      // A transacao do Prisma ja foi fechada pelo timeout: outra conexao consegue a policy.
      acquiredByOther = await b.run(s, async () => 'B assumiu').catch((e) => `ERRO ${String(e)}`);
      return 'resultado-da-operacao';
    });
    // A operacao conclui (o veredito ja produzido nao e perdido) mesmo com o fechamento da tx tardio.
    await expect(op).resolves.toBe('resultado-da-operacao');
    expect(observed.early).toBeGreaterThan(0);
    expect(observed.early).toBeLessThanOrEqual(timeoutMs);
    expect(observed.lateRemaining).toBeLessThanOrEqual(0);
    expect(observed.lateError).toBeInstanceOf(PolicyScopeLostError);
    expect(acquiredByOther).toBe('B assumiu');
  }, 15_000);

  it('o dono morre (conexao terminada): a transacao cai, o lock e liberado e a operacao nao devolve veredito falso', async () => {
    const a = new PrismaPolicyScopeLock(dbA, 60_000);
    const b = new PrismaPolicyScopeLock(dbB, 30_000);
    const s = scope();
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const op = a.run(s, async (lease) => {
      entered();
      await sleep(1200); // da tempo do teste derrubar o backend dono
      await lease.assertHeld(); // a transacao morreu: tem de lancar, nunca devolver veredito
      return 'nao-deveria-chegar';
    });
    await inside;
    // derruba o backend que segura o advisory lock (equivale a morte do processo/queda de rede)
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid()`,
    );
    await expect(op).rejects.toBeDefined();
    await expect(b.run(s, async () => 'B depois da queda')).resolves.toBe('B depois da queda');
  }, 15_000);

  it('erro dentro da operacao libera a policy (nada fica preso)', async () => {
    const a = new PrismaPolicyScopeLock(dbA, 30_000);
    const b = new PrismaPolicyScopeLock(dbB, 30_000);
    const s = scope();
    await expect(
      a.run(s, async () => {
        throw new Error('falha da operacao');
      }),
    ).rejects.toThrow('falha da operacao');
    await expect(b.run(s, async () => 'ok')).resolves.toBe('ok');
  });
});
