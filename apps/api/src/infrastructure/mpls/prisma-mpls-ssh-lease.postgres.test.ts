import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaMplsRepository } from './prisma-mpls-repository';

// Opt-in explicito: nunca aceitar URL de banco operacional.
const url = process.env.MPLS_SSH_LEASE_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55077')
    throw Error('DISPOSABLE_BASELINE_DATABASE_REQUIRED');
}

const LIMITS = { maxConcurrentSessions: 1, sessionBudgetPerHour: 2, staleAfterMs: 60_000 };

describe.skipIf(!url)('P6 — orcamento SSH do MPLS em PostgreSQL real', () => {
  const db = new PrismaClient({
    datasources: { db: { url: url ?? 'postgresql://invalid/unused' } },
  });
  // Pool INDEPENDENTE: simula outra instancia da API durante a troca de release.
  const dbB = new PrismaClient({
    datasources: { db: { url: url ?? 'postgresql://invalid/unused' } },
  });
  // Cada `new PrismaMplsRepository` representa um PROCESSO diferente:
  // um restart perde o estado em memoria, nao o orcamento.
  const processA = () => new PrismaMplsRepository(db);
  const processB = () => new PrismaMplsRepository(dbB);

  beforeEach(async () => {
    await db.mplsSshSessionLog.deleteMany();
  });

  afterAll(async () => {
    await db.mplsSshSessionLog.deleteMany();
    await db.$disconnect();
  });

  it('concorrencia vale entre processos distintos', async () => {
    const first = await processA().acquireSshLease('h1', LIMITS);
    expect(first.ok).toBe(true);

    const second = await processB().acquireSshLease('h1', LIMITS);
    expect(second).toEqual({ ok: false, denial: 'CONCURRENCY' });

    if (!first.ok) throw new Error('lease ausente');
    await processA().releaseSshLease(first.leaseId);

    const third = await processB().acquireSshLease('h1', LIMITS);
    expect(third.ok).toBe(true);
  });

  it('orcamento por hora sobrevive a restart do processo', async () => {
    for (let i = 0; i < 2; i += 1) {
      const lease = await processA().acquireSshLease('h1', LIMITS);
      if (!lease.ok) throw new Error('lease inesperadamente negado');
      await processA().releaseSshLease(lease.leaseId);
    }

    // Instancia nova (restart) ainda enxerga as duas sessoes da ultima hora.
    const denied = await processB().acquireSshLease('h1', LIMITS);
    expect(denied).toEqual({ ok: false, denial: 'BUDGET' });
    expect(await db.mplsSshSessionLog.count()).toBe(2);
  });

  it('lease abandonado (processo morto) expira pela janela de staleness', async () => {
    await db.mplsSshSessionLog.create({
      data: { hostId: 'h1', startedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const acquired = await processA().acquireSshLease('h1', {
      ...LIMITS,
      sessionBudgetPerHour: 10,
    });
    expect(acquired.ok).toBe(true);
  });

  it('lease ativo e antigo o suficiente ainda bloqueia quando a janela e maior', async () => {
    await db.mplsSshSessionLog.create({
      data: { hostId: 'h1', startedAt: new Date(Date.now() - 1_000) },
    });

    const denied = await processA().acquireSshLease('h1', {
      ...LIMITS,
      sessionBudgetPerHour: 10,
    });
    expect(denied).toEqual({ ok: false, denial: 'CONCURRENCY' });
  });

  it('housekeeping remove o historico com mais de um dia', async () => {
    await db.mplsSshSessionLog.create({
      data: { hostId: 'h1', startedAt: new Date(Date.now() - 2 * 86_400_000) },
    });

    const acquired = await processA().acquireSshLease('h1', LIMITS);
    expect(acquired.ok).toBe(true);
    expect(await db.mplsSshSessionLog.count()).toBe(1);
  });

  it('A1-e: trilha de auditoria do opt-in grava e sobrevive ao dispositivo', async () => {
    await db.mplsSshFallbackAudit.deleteMany({ where: { hostId: 'h-audit' } });
    const repo = processA();
    await repo.recordSshFallbackAudit!({
      hostId: 'h-audit',
      actorId: 'u9',
      actorUsername: 'admin',
      previousValue: false,
      newValue: true,
      result: 'ALLOWED',
      reason: 'autorizado em teste',
    });
    const rows = await db.mplsSshFallbackAudit.findMany({ where: { hostId: 'h-audit' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: 'u9',
      actorUsername: 'admin',
      previousValue: false,
      newValue: true,
      result: 'ALLOWED',
    });
    // Nao existe FK para Device: a trilha aceita host inexistente de proposito.
    expect(await db.device.findUnique({ where: { id: 'h-audit' } })).toBeNull();
    await db.mplsSshFallbackAudit.deleteMany({ where: { hostId: 'h-audit' } });
  });

  it('opt-in do fallback CLI e persistente e nasce desligado', async () => {    // MplsDeviceState tem FK para Device: o host precisa existir de fato.
    await db.device.upsert({
      where: { id: 'h-lease' },
      create: {
        id: 'h-lease',
        name: 'PE-LEASE',
        displayName: 'PE-LEASE',
        hostname: 'pe-lease',
        ip: '192.0.2.10',
        managementIp: '192.0.2.10',
        deviceType: 'ROUTER',
        source: 'MANUAL',
      },
      update: {},
    });

    expect(await processA().isSshFallbackEnabled('h-lease')).toBe(false);
    await processA().setSshFallbackEnabled('h-lease', true);
    expect(await processB().isSshFallbackEnabled('h-lease')).toBe(true);
    await processB().setSshFallbackEnabled('h-lease', false);
    expect(await processA().isSshFallbackEnabled('h-lease')).toBe(false);
    await db.mplsDeviceState.deleteMany({ where: { hostId: 'h-lease' } });
    await db.device.deleteMany({ where: { id: 'h-lease' } });
  });
});
