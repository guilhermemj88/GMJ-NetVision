/**
 * M8 — KILL SWITCH GLOBAL: matriz EXAUSTIVA dos caminhos de escrita Huawei.
 *
 * `MITIGATION_AUTO_EXECUTION_ENABLED=0` precisa impedir ACTIVATE **e** REMOVE
 * automáticos em TODOS os caminhos, inclusive:
 *  - perfil AUTO "manual" (mode=AUTO definido à mão, sem promoção por sweep);
 *  - perfil isento legado (LEGACY_PROFILE_IDS);
 *  - perfil presente na allowlist de execução;
 *  - comando que só "parece" manual (requestId com prefixo AUTO ou autoEvidence);
 *  - execução em outro processo (worker/observer), que não tem caminho de escrita.
 *
 * E precisa PRESERVAR o comando MANUAL (UI/n8n), que é o único jeito de retirar
 * uma mitigação existente.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  AUTO_COMMAND_REQUEST_PREFIX,
  MitigationCommandService,
} from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { InMemoryPolicyScopeLock } from './mitigation-policy-lock';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

const DEV = 'host-a';
const POLICY = 'PL-M8_IPv4-IN';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;
const NOW = new Date('2026-10-28T20:00:00.000Z');

const host = (id: string) =>
  ({ id, hostname: `hw-${id}`, displayName: `HW ${id}` }) as unknown as HostRecord;

const target = (profileId: string, over: Partial<MitigationAutoTargetState> = {}):
  MitigationAutoTargetState => ({
  profileId, deviceId: DEV, policyName: POLICY, interfaceId: 'if-1', customer: 'C',
  mode: 'AUTO', addressFamily: 'IPV4', direction: 'tx', directionSource: 'INTERFACE',
  snapshotAvailable: true, readiness: 'READY', prefixStatus: 'SAFE', blockedReason: null,
  mitigationExcluded: false, runtimeState: 'NORMAL', effectiveBandwidthBps: BW,
  bogonNode: 1, mitigationNode: 2, sharedPolicy: false, peerAddresses: ['10.0.0.1'],
  triggerPercent: 90, recoveryPercent: 70, triggerSamples: 3, recoverySamples: 12, ...over,
});

/** Conta chamadas de escrita do executor (mock) e do "live" Huawei. */
function harness(options: {
  executionEnabled?: boolean;
  allowlist?: string[];
  legacyExempt?: string[];
  targetOver?: Partial<MitigationAutoTargetState>;
} = {}) {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  let executorWrites = 0;
  const activate = executor.activate.bind(executor);
  const remove = executor.remove.bind(executor);
  executor.activate = async (input) => { executorWrites += 1; return activate(input); };
  executor.remove = async (input) => { executorWrites += 1; return remove(input); };

  let liveWrites = 0;
  const live = {
    enabledFor: () => true,
    resolveActivePair: async () => null,
    preflight: async () => ({ ok: true, blockedReasons: [] }) as never,
    activate: async () => { liveWrites += 1; return { output: 'ok' }; },
    remove: async () => { liveWrites += 1; return { output: 'ok' }; },
    readRoutePolicy: async () => '',
  };

  let engineCommands = 0;
  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
    evaluationScope: 'OPERATIONAL',
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEV] },
    executionControl: {
      enabled: options.executionEnabled === true,
      allowedProfileIds: options.allowlist ?? [],
      legacyExemptProfileIds: options.legacyExempt ?? [],
    },
    requireRuntimeRead: false,
    targets: { list: async () => [target('p1', options.targetOver)] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: (id) => repository.getRuntime(id),
      save: async (id, patch) => { await repository.upsertRuntime(id, patch); },
    },
    commands: { execute: async (_input) => { engineCommands += 1; return { ok: true, status: 'x', verified: false } as never; } },
    now: () => NOW,
  });

  const commands = new MitigationCommandService({
    autoExecutionEnabled: () => options.executionEnabled === true,
    repository,
    hosts: { getHost: async (id) => host(id) },
    executor,
    live: live as never,
    scopeLock: new InMemoryPolicyScopeLock(),
    expectedNodes: async () => [10],
    now: () => NOW,
  });

  const tick = async (ticks = 4) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let index = 0; index < ticks; index += 1) {
      traffic.push('p1', OVER);
      last = await engine.tick();
    }
    return last;
  };

  return {
    repository, executor, engine, commands, tick,
    counts: () => ({ executorWrites, liveWrites, engineCommands }),
  };
}

describe('M8 - motor: nenhuma escrita automatica com a flag desligada', () => {
  const cases: [string, Parameters<typeof harness>[0]][] = [
    ['AUTO manual (sem sweep)', {}],
    ['promovido pelo sweep', { targetOver: { autoPromotedBySweep: true } }],
    ['isento legado', { legacyExempt: ['p1'] }],
    ['presente na allowlist', { allowlist: ['p1'] }],
    ['allowlist + sweep + isento', { allowlist: ['p1'], legacyExempt: ['p1'], targetOver: { autoPromotedBySweep: true } }],
  ];

  it.each(cases)('%s: WOULD_ACTIVATE/AUTO_EXECUTION_DISABLED, zero comando', async (_label, opts) => {
    const h = harness({ ...opts, executionEnabled: false });
    const decisions = await h.tick();
    expect(decisions[0]?.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(decisions[0]?.outcome).toBe('WOULD_ACTIVATE');
    expect(h.counts().engineCommands).toBe(0);
    expect(h.counts().executorWrites).toBe(0);
    expect(h.counts().liveWrites).toBe(0);
  });

  it('flag ligada: o mesmo cenario escreve (prova de que o bloqueio e a flag)', async () => {
    const h = harness({ executionEnabled: true, allowlist: ['p1'] });
    const decisions = await h.tick();
    expect(decisions[0]?.reason).not.toBe('AUTO_EXECUTION_DISABLED');
    expect(h.counts().engineCommands).toBeGreaterThan(0);
  });

  it('o motor NUNCA emite REMOVE (nem com a flag ligada)', async () => {
    const h = harness({ executionEnabled: true, allowlist: ['p1'], targetOver: { runtimeState: 'MITIGATED' } });
    let last: Awaited<ReturnType<typeof h.tick>> = [];
    for (let index = 0; index < 20; index += 1) {
      last = await h.tick(1);
    }
    expect(h.counts().executorWrites).toBe(0);
    expect(h.counts().liveWrites).toBe(0);
    expect(last.every((decision) => decision.outcome !== 'ACTIVATED')).toBe(true);
  });
});

describe('M8 - command service: barreira dupla (entrada + antes da escrita)', () => {
  const removeSeed = async () => {
    const h = harness({ executionEnabled: false });
    // Semeia um par instalado e runtime MITIGATED para o REMOVE ter o que fazer.
    await h.repository.upsertProfile({
      deviceId: DEV, policyName: POLICY, interfaceId: 'if-1', addressFamily: 'IPV4',
      detectedBandwidthBps: BW, bandwidthSource: 'DESCRIPTION',
    });
    return h;
  };

  it('ACTIVATE de origem AUTO e bloqueado antes de qualquer preflight/SSH', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const result = await h.commands.execute({
      requestId: 'a1', action: 'ACTIVATE', profileId: profile.id, origin: 'AUTO',
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
    expect(result.commandPreview ?? []).toHaveLength(0);
    expect(h.counts()).toMatchObject({ executorWrites: 0, liveWrites: 0 });
  });

  it('REMOVE de origem AUTO e bloqueado (mesmo caminho)', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const result = await h.commands.execute({
      requestId: 'r1', action: 'REMOVE', profileId: profile.id, origin: 'AUTO',
      acknowledgeScopeRemoval: true,
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
    expect(h.counts()).toMatchObject({ executorWrites: 0, liveWrites: 0 });
  });

  it('requestId com prefixo AUTO conta como automatico (nao da para disfarcar de manual)', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const result = await h.commands.execute({
      requestId: `${AUTO_COMMAND_REQUEST_PREFIX}x-1`, action: 'ACTIVATE', profileId: profile.id,
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
  });

  it('autoEvidence presente conta como automatico', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const result = await h.commands.execute({
      requestId: 'ev-1', action: 'ACTIVATE', profileId: profile.id,
      autoEvidence: { sampleAt: NOW.toISOString(), continuityKey: 'k' },
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
  });

  it('dependencia ausente = fail-closed (bloqueia)', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const withoutFlag = new MitigationCommandService({
      repository: h.repository,
      hosts: { getHost: async (id) => host(id) },
      executor: h.executor,
      now: () => NOW,
    });
    const result = await withoutFlag.execute({
      requestId: 'a2', action: 'ACTIVATE', profileId: profile.id, origin: 'AUTO',
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
    expect(h.counts().executorWrites).toBe(0);
  });

  it('dependencia que LANCA = fail-closed (bloqueia)', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const throwing = new MitigationCommandService({
      repository: h.repository,
      hosts: { getHost: async (id) => host(id) },
      executor: h.executor,
      autoExecutionEnabled: () => { throw new Error('env ilegivel'); },
      now: () => NOW,
    });
    const result = await throwing.execute({
      requestId: 'a3', action: 'ACTIVATE', profileId: profile.id, origin: 'AUTO',
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
    expect(h.counts().executorWrites).toBe(0);
  });

  it('comando MANUAL continua funcionando (retirada manual preservada)', async () => {
    const h = await removeSeed();
    const profile = (await h.repository.listProfiles())[0]!;
    const result = await h.commands.execute({
      requestId: 'manual-1', action: 'ACTIVATE', profileId: profile.id,
    } as never);
    // Nao interessa o desfecho de negocio (preflight/snapshot): interessa que o
    // kill switch NAO bloqueie o comando manual.
    expect(result.status).not.toBe('AUTO_EXECUTION_DISABLED');
  });
});

describe('M8 - outros processos nao tem caminho de escrita', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('o worker de mitigacao e READ-ONLY (sem activate/remove/commit)', () => {
    const worker = read('../../../worker/mitigation/mitigation-worker.ts');
    expect(worker).not.toContain('executeWrite');
    expect(worker).not.toContain('system-view');
    expect(worker).not.toMatch(/\.activate\(/);
    expect(worker).not.toMatch(/\.remove\(/);
    expect(worker).toContain('executeReadOnly');
  });

  it('so a API (routes.ts) constroi o MitigationCommandService em producao', () => {
    const routes = read('../../../routes.ts');
    expect(routes).toContain('new MitigationCommandService(');
    for (const modulePath of [
      '../../../mitigation-worker-main.ts',
      '../../../server.ts',
      '../../../mitigation-fast-observer-main.ts',
    ]) {
      const source = read(modulePath);
      expect(source).not.toContain('new MitigationCommandService(');
    }
  });
});
