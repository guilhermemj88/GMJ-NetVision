import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore } from './automation-store';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';
import { PrismaPolicyScopeLock } from '../../infrastructure/bgp/mitigation/prisma-policy-scope-lock';

/**
 * ENSAIO DE LABORATORIO do encerramento (A-E) com sinais REAIS (SIGTERM/SIGKILL) em Linux, PostgreSQL 16 descartavel.
 * Nenhum equipamento: o ACTIVATE e simulado (segura o lock advisory da policy) e o piloto usa SSH falso.
 * Roda so com SHUTDOWN_LAB_DATABASE_URL (banco `shutdown_lab_test`, host local/descartavel) e fora do Windows
 * (o Windows nao entrega SIGTERM real a processos Node).
 */
const url = process.env.SHUTDOWN_LAB_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (u.pathname !== '/shutdown_lab_test' || !['127.0.0.1', 'nvlabpg'].includes(u.hostname))
    throw Error('DISPOSABLE_SHUTDOWN_LAB_DATABASE_REQUIRED');
}
const enabled = !!url && process.platform !== 'win32';
const tsx = path.resolve(process.cwd(), '../../node_modules/tsx/dist/cli.mjs');
const lab = (f: string) => path.resolve(process.cwd(), 'src/testing/shutdown-lab', f);

interface Line {
  m: string;
  t: number;
  [k: string]: unknown;
}

function run(file: string, env: Record<string, string>) {
  const lines: Line[] = [];
  const child: ChildProcess = spawn(process.execPath, [tsx, lab(file)], {
    env: { ...process.env, SHUTDOWN_LAB_DATABASE_URL: url!, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        lines.push(JSON.parse(l) as Line);
      } catch {
        /* ruido do tsx */
      }
      i = buf.indexOf('\n');
    }
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const until = async (pred: () => boolean, ms = 60_000) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms)
        throw Error('timeout aguardando marcador; linhas=' + JSON.stringify(lines));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const count = (m: string) => lines.filter((l) => l.m === m).length;
  const at = (m: string) => lines.find((l) => l.m === m)?.t ?? Number.NaN;
  return { child, lines, exited, until, count, at };
}

describe.skipIf(!enabled)(
  'ensaio de encerramento (Linux, sinais reais, PostgreSQL descartavel)',
  () => {
    const db = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
    beforeEach(async () => {
      await db.mitigationAutomationRecord.deleteMany();
    });
    afterAll(async () => {
      await db.$disconnect();
    });
    const advisoryLocks = async () =>
      Number(
        (
          await db.$queryRaw<
            Array<{ n: bigint }>
          >`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid()`
        )[0]!.n,
      );
    const waitNoLocks = async () => {
      const start = Date.now();
      while ((await advisoryLocks()) > 0 && Date.now() - start < 30_000)
        await new Promise((x) => setTimeout(x, 200));
      return advisoryLocks();
    };

    it('A: SIGTERM sem operacao em andamento: encerra rapido, exit 0, settle antes de desconectar', async () => {
      const r = run('child-engine.ts', {
        LAB_PROFILES: '1',
        LAB_ACTIVATE_MS: '100',
        MITIGATION_SHUTDOWN_SETTLE_MS: '20000',
      });
      await r.until(() => r.count('ACTIVATE_END') === 1 && r.count('READY') === 1);
      const t0 = Date.now();
      r.child.kill('SIGTERM');
      const { code } = await r.exited;
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(r.at('SETTLE_BEGIN')).toBeLessThanOrEqual(r.at('PRISMA_DISCONNECT'));
      expect(r.lines.find((l) => l.m === 'SETTLE_END')).toMatchObject({ timedOut: false });
      expect(await waitNoLocks()).toBe(0);
    }, 90_000);

    it('B: SIGTERM com ACTIVATE em andamento: a operacao TERMINA (banco de pe), so depois desconecta, exit 0', async () => {
      const r = run('child-engine.ts', {
        LAB_PROFILES: '1',
        LAB_ACTIVATE_MS: '3000',
        MITIGATION_SHUTDOWN_SETTLE_MS: '30000',
      });
      await r.until(() => r.count('ACTIVATE_START') === 1);
      expect(await advisoryLocks()).toBeGreaterThan(0);
      r.child.kill('SIGTERM');
      const { code } = await r.exited;
      expect(code).toBe(0);
      expect(r.count('ACTIVATE_END')).toBe(1);
      expect(r.at('ACTIVATE_END')).toBeLessThanOrEqual(r.at('SETTLE_END'));
      expect(r.at('SETTLE_END')).toBeLessThanOrEqual(r.at('PRISMA_DISCONNECT'));
      expect(r.lines.find((l) => l.m === 'SETTLE_BEGIN')?.inFlight).toEqual(['P0']);
      expect(r.count('FATAL')).toBe(0);
      expect(await waitNoLocks()).toBe(0);
    }, 90_000);

    it('C: SIGTERM com DUAS execucoes concorrentes: as duas terminam antes de qualquer desconexao', async () => {
      const r = run('child-engine.ts', {
        LAB_PROFILES: '2',
        LAB_ACTIVATE_MS: '3000',
        MITIGATION_SHUTDOWN_SETTLE_MS: '30000',
      });
      await r.until(() => r.count('ACTIVATE_START') === 2);
      r.child.kill('SIGTERM');
      const { code } = await r.exited;
      expect(code).toBe(0);
      expect(r.count('ACTIVATE_END')).toBe(2);
      const lastEnd = Math.max(...r.lines.filter((l) => l.m === 'ACTIVATE_END').map((l) => l.t));
      expect(lastEnd).toBeLessThanOrEqual(r.at('PRISMA_DISCONNECT'));
      const inFlight = r.lines.find((l) => l.m === 'SETTLE_BEGIN')?.inFlight as string[];
      expect([...inFlight].sort()).toEqual(['P0', 'P1']);
      expect(await waitNoLocks()).toBe(0);
    }, 90_000);

    it('D: timeout durante o shutdown: o teto e respeitado, o timeout e registrado, exit 0 e o lock cai com a conexao', async () => {
      const r = run('child-engine.ts', {
        LAB_PROFILES: '1',
        LAB_ACTIVATE_MS: '15000',
        MITIGATION_SHUTDOWN_SETTLE_MS: '1500',
      });
      await r.until(() => r.count('ACTIVATE_START') === 1);
      const t0 = Date.now();
      r.child.kill('SIGTERM');
      const { code } = await r.exited;
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(12_000);
      expect(JSON.stringify(r.lines.find((l) => l.m === 'LOG_ERROR'))).toContain(
        'SHUTDOWN_SETTLE_TIMEOUT',
      );
      expect(r.lines.find((l) => l.m === 'SETTLE_END')).toMatchObject({ timedOut: true });
      expect(r.count('ACTIVATE_END')).toBe(0);
      expect(await waitNoLocks()).toBe(0);
    }, 90_000);

    it('E1: SIGKILL no meio do ACTIVATE: o lock advisory cai sozinho e uma nova instancia assume a policy', async () => {
      const r = run('child-engine.ts', {
        LAB_PROFILES: '1',
        LAB_ACTIVATE_MS: '20000',
        MITIGATION_SHUTDOWN_SETTLE_MS: '30000',
      });
      await r.until(() => r.count('ACTIVATE_START') === 1);
      expect(await advisoryLocks()).toBeGreaterThan(0);
      r.child.kill('SIGKILL');
      const { signal } = await r.exited;
      expect(signal).toBe('SIGKILL');
      expect(r.count('ACTIVATE_END')).toBe(0);
      expect(await waitNoLocks()).toBe(0);
      const next = new PrismaPolicyScopeLock(db, 30_000);
      await expect(
        next.run({ deviceId: 'lab-device', policyName: 'LAB-POLICY-0' }, async () => 'assumiu'),
      ).resolves.toBe('assumiu');
    }, 90_000);

    it('E2: SIGKILL com o comando ja no equipamento (journal STARTED): o restart NAO reescreve e fica em quarentena', async () => {
      const r = run('child-pilot.ts', {});
      await r.until(() => r.count('WRITE_DONE_AWAITING') === 1);
      r.child.kill('SIGKILL');
      await r.exited;
      // processo NOVO (restart): journal/ownership vem do PostgreSQL; o equipamento simulado e novo e vazio
      const h = await createPilotHarness(new PrismaAutomationStore(db));
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      const writes = h.ssh.writes.length;
      for (const action of ['ACTIVATE', 'REMOVE'] as const) {
        const res = await h.commands.execute({
          requestId: 'after-sigkill-' + action,
          action,
          profileId: P.profileId,
        });
        expect(res.verified).toBe(false);
        expect(res.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
      }
      for (let i = 0; i < 4; i++) {
        h.sample(9_500_000_000n);
        await h.lifecycle.tickPilot();
      }
      expect(h.ssh.writes).toHaveLength(writes);
      await expect(h.lifecycle.manualMutation(P.deviceId, P.policy)).rejects.toThrow(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
    }, 90_000);
  },
);
