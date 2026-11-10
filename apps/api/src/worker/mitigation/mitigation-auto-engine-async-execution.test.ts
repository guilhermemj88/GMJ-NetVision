import { describe, expect, it } from 'vitest';
import {
  MitigationAutoEngine,
  type MitigationAutoCommandResult,
  type MitigationAutoTargetState,
} from './mitigation-auto-engine';
import { SequenceTrafficSource } from './mitigation-traffic-source';

/**
 * M1-AUTO: o ACTIVATE AUTO (preflight, escrita, read-back e verificacao fisica de ate ~90 s)
 * nao pode prender o tick de 5 s nem o lock do motor. Com `asyncExecution` o tick devolve o
 * progresso (`TRIGGER_PENDING`/`IN_FLIGHT`), continua avaliando os demais perfis e entrega o
 * resultado FINAL no tick seguinte, sem nunca disparar um segundo ACTIVATE do mesmo perfil ou
 * do mesmo escopo fisico. O comando aqui e um falso controlavel (nada toca equipamento).
 */

const DEVICE = 'device-1';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-11-10T00:00:00.000Z');
const OVER = (BANDWIDTH * 95n) / 100n;
const UNDER = (BANDWIDTH * 50n) / 100n;

function target(
  profileId: string,
  policyName: string,
  over: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    interfaceId: 'if-' + profileId,
    customer: 'CLIENTE-' + profileId,
    mode: 'AUTO',
    snapshotAvailable: true,
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    mitigationExcluded: false,
    runtimeState: 'NORMAL',
    effectiveBandwidthBps: BANDWIDTH,
    bogonNode: 1,
    mitigationNode: 2,
    sharedPolicy: false,
    peerAddresses: ['10.0.0.' + profileId.length],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    policyName,
    ...over,
  } as MitigationAutoTargetState;
}

interface Deferred {
  profileId: string;
  resolve: (result: MitigationAutoCommandResult) => void;
  reject: (error: Error) => void;
}

function harness(options: {
  asyncExecution?: boolean;
  maxConcurrentExecutions?: number;
  targets: MitigationAutoTargetState[];
}) {
  const runtime = new Map<
    string,
    { state: 'NORMAL'; triggerCounter: number; recoveryCounter: number }
  >();
  const pending: Deferred[] = [];
  const executed: string[] = [];
  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    executionControl: { enabled: true },
    sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => options.targets },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async (id) =>
        runtime.get(id) ?? { state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 },
      save: async () => undefined,
    },
    commands: {
      execute: (input) => {
        executed.push(input.profileId);
        return new Promise<MitigationAutoCommandResult>((resolve, reject) => {
          pending.push({ profileId: input.profileId, resolve, reject });
        });
      },
    },
    now: () => NOW,
    ...(options.asyncExecution === undefined ? {} : { asyncExecution: options.asyncExecution }),
    ...(options.maxConcurrentExecutions === undefined
      ? {}
      : { maxConcurrentExecutions: options.maxConcurrentExecutions }),
  });
  /** Um tick com UMA amostra nova por perfil (valor por perfil). */
  const tick = async (values: Record<string, bigint>) => {
    for (const [id, value] of Object.entries(values)) traffic.push(id, value);
    return engine.tick();
  };
  const byProfile = (decisions: Awaited<ReturnType<typeof engine.tick>>, id: string) =>
    decisions.filter((d) => d.profileId === id);
  return { engine, tick, pending, executed, byProfile };
}

const VERIFIED: MitigationAutoCommandResult = {
  ok: true,
  verified: true,
  status: 'ACTIVATED_VERIFIED',
};

describe('M1-AUTO: ACTIVATE fora do tick (asyncExecution)', () => {
  it('o tick que confirma o gatilho volta IMEDIATAMENTE com o progresso, sem esperar o comando', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A')],
    });
    await h.tick({ A: OVER });
    await h.tick({ A: OVER });
    const third = await h.tick({ A: OVER }); // resolve com o comando AINDA pendente
    expect(h.executed).toEqual(['A']);
    expect(h.pending).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({
      profileId: 'A',
      outcome: 'TRIGGER_PENDING',
      commandStatus: 'IN_FLIGHT',
    });
    expect(h.engine.inFlightProfiles()).toEqual(['A']);
    h.pending[0]!.resolve(VERIFIED);
    await h.engine.settleExecutions();
  });

  it('com o comando em andamento: os demais perfis continuam avaliados e o perfil NAO e reexecutado', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A'), target('B', 'PL-B')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER, B: UNDER });
    expect(h.executed).toEqual(['A']);
    // Varios ticks durante a verificacao fisica (~90 s): B segue com decisao propria a cada tick.
    for (let i = 0; i < 5; i += 1) {
      const decisions = await h.tick({ A: OVER, B: UNDER });
      expect(h.byProfile(decisions, 'A')[0]).toMatchObject({
        outcome: 'SKIPPED',
        reason: 'CONCURRENT_TICK',
      });
      expect(h.byProfile(decisions, 'B')[0]).toMatchObject({
        outcome: 'NO_ACTION',
        reason: 'THRESHOLD_NOT_EXCEEDED',
      });
    }
    expect(h.executed).toEqual(['A']); // nunca duplicado
    h.pending[0]!.resolve(VERIFIED);
    await h.engine.settleExecutions();
  });

  it('o resultado FINAL (ACTIVATED verificado) chega no tick seguinte, uma unica vez', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER });
    h.pending[0]!.resolve(VERIFIED);
    await h.engine.settleExecutions();
    expect(h.engine.inFlightProfiles()).toEqual([]);
    const next = await h.tick({ A: OVER });
    const finals = next.filter((d) => d.profileId === 'A' && d.outcome === 'ACTIVATED');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ verified: true, commandStatus: 'ACTIVATED_VERIFIED' });
    expect(next[0]).toBe(finals[0]); // concluidos vem antes das decisoes do tick
    const again = await h.tick({ A: OVER });
    expect(again.filter((d) => d.outcome === 'ACTIVATED')).toHaveLength(0);
    expect(h.engine.getLastVerifiedActivate()?.profileId).toBe('A');
  });

  it('nao registra mitigacao confirmada sem o veredito do comando (UNVERIFIED => FAILED)', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER });
    h.pending[0]!.resolve({
      ok: false,
      verified: false,
      status: 'ACTIVATED_UNVERIFIED_PHYSICAL',
      safeError: 'verificacao fisica INCONCLUSIVE',
    });
    await h.engine.settleExecutions();
    const next = await h.tick({ A: OVER });
    const final = next.find(
      (d) => d.profileId === 'A' && d.commandStatus === 'ACTIVATED_UNVERIFIED_PHYSICAL',
    );
    expect(final).toMatchObject({ outcome: 'FAILED', verified: false });
    expect(next.some((d) => d.outcome === 'ACTIVATED')).toBe(false);
    expect(h.engine.getLastVerifiedActivate()).toBeNull();
  });

  it('falha de transporte no comando vira decisao FAILED no tick seguinte e libera o perfil', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER });
    h.pending[0]!.reject(new Error('ssh timeout'));
    await h.engine.settleExecutions();
    expect(h.engine.inFlightProfiles()).toEqual([]);
    const next = await h.tick({ A: OVER });
    expect(next.find((d) => d.profileId === 'A' && d.reason === 'ACTIVATE_FAILED')).toMatchObject({
      outcome: 'FAILED',
      verified: false,
    });
  });

  it('MAX_ACTIVE: outro perfil que confirma o gatilho com um ACTIVATE em andamento NAO dispara', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 1,
      targets: [target('A', 'PL-A'), target('B', 'PL-B')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER, B: UNDER });
    let last: Awaited<ReturnType<typeof h.tick>> = [];
    for (let i = 0; i < 3; i += 1) last = await h.tick({ A: OVER, B: OVER });
    expect(h.byProfile(last, 'B')[0]).toMatchObject({
      outcome: 'SKIPPED',
      reason: 'SCOPE_OPERATION_IN_FLIGHT',
    });
    expect(h.executed).toEqual(['A']);
    h.pending[0]!.resolve(VERIFIED);
    await h.engine.settleExecutions();
  });

  it('mesmo escopo fisico (device+policy): o segundo perfil nunca dispara, mesmo com teto maior', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 4,
      targets: [target('A', 'PL-COMPARTILHADA'), target('B', 'PL-COMPARTILHADA')],
    });
    for (let i = 0; i < 3; i += 1) await h.tick({ A: OVER, B: UNDER });
    let last: Awaited<ReturnType<typeof h.tick>> = [];
    for (let i = 0; i < 3; i += 1) last = await h.tick({ A: OVER, B: OVER });
    expect(h.byProfile(last, 'B')[0]).toMatchObject({
      outcome: 'SKIPPED',
      reason: 'SCOPE_OPERATION_IN_FLIGHT',
    });
    expect(h.executed).toEqual(['A']);
    h.pending[0]!.resolve(VERIFIED);
    await h.engine.settleExecutions();
  });

  it('teto maior que 1 permite escopos DIFERENTES em paralelo (cada um uma unica vez)', async () => {
    const h = harness({
      asyncExecution: true,
      maxConcurrentExecutions: 2,
      targets: [target('A', 'PL-A'), target('B', 'PL-B')],
    });
    for (let i = 0; i < 4; i += 1) await h.tick({ A: OVER, B: OVER });
    expect([...h.executed].sort()).toEqual(['A', 'B']);
    h.pending.forEach((p) => p.resolve(VERIFIED));
    await h.engine.settleExecutions();
    const next = await h.tick({ A: OVER, B: OVER });
    expect(
      next
        .filter((d) => d.outcome === 'ACTIVATED')
        .map((d) => d.profileId)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('sem asyncExecution o comportamento anterior e preservado (o tick aguarda o comando)', async () => {
    const h = harness({ targets: [target('A', 'PL-A')] });
    await h.tick({ A: OVER });
    await h.tick({ A: OVER });
    const third = h.tick({ A: OVER });
    let settled = false;
    void third.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // preso ao comando
    h.pending[0]!.resolve(VERIFIED);
    const decisions = await third;
    expect(decisions[0]).toMatchObject({ outcome: 'ACTIVATED', verified: true });
  });
});
