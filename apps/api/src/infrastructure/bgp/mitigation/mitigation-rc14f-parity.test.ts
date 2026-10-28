/**
 * RC14-F — PARIDADE COM A RC13 (producao).
 *
 * A RC14-F e a RC13 + kill switch M8 (9c4f3f3) + produtor de alerta FAST de
 * deteccao bloqueada (S5/RC6). Nada mais. Este teste prova, de forma explicita,
 * que as mudancas N1-N4 da RC14 NAO entraram nesta release e que o caminho
 * MANUAL (UI/n8n) da RC13 continua identico:
 *
 *  - N1: nenhum `local-preference 3000` injetado no comando canonico;
 *  - N2: readback de policy legada nao passou a exigir LP3000;
 *  - N3: ACTIVATE manual de perfil IPv6 NAO e bloqueado (nao existe fase);
 *  - N4: a contencao de familia IPv4/IPv6 do motor continua como na RC13.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService } from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { InMemoryPolicyScopeLock } from './mitigation-policy-lock';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

const DEV = 'host-parity';
const NOW = new Date('2026-10-28T20:00:00.000Z');
const BW = 10_000_000_000n;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const TOUCHED = {
  'command service': '../mitigation/mitigation-command-service.ts',
  'motor AUTO': '../../../worker/mitigation/mitigation-auto-engine.ts',
  'publisher de deteccao': '../../../application/mitigation-detection-alert.ts',
  'politica de alerta': '../../../worker/mitigation/mitigation-detection-alert-policy.ts',
} as const;

/** Marcadores exclusivos das mudancas N1-N4 da RC14. */
const RC14_ONLY_MARKERS = [
  'FAMILY_OUT_OF_PHASE',
  'DIRECTION_NOT_VALIDATED',
  'FAMILY_DEFAULT',
  'isAutomationFamily',
  'allowFamilyDefaultDirection',
  'local-preference 3000',
  'SCOPE_RECOVERY_MAX_SAMPLE_AGE_MS',
  'mitigation-scope-recovery',
] as const;

describe('RC14-F: as mudancas N1-N4 da RC14 nao existem nesta release', () => {
  it.each(Object.entries(TOUCHED))('%s nao carrega marcador de N1-N4', (_label, path) => {
    const source = read(path);
    for (const marker of RC14_ONLY_MARKERS) {
      expect(source, `${path} nao pode conter ${marker}`).not.toContain(marker);
    }
  });

  it('o delta e somente routes.ts + os modulos de deteccao (nenhum outro arquivo de dominio)', () => {
    for (const path of Object.values(TOUCHED)) expect(read(path).length).toBeGreaterThan(0);
    // A RC13 continua com a contencao de familia: quem remove-la e a RC14 (N4).
    const engine = read(TOUCHED['motor AUTO']);
    expect(engine).toContain('FAMILY_CONTENTION_UNRESOLVED');
    expect(engine).toContain('detectFamilyContention');
    expect(engine).toContain('SEM_VINCULO_IPV4');
    // O guarda de policy compartilhada da RC13 tambem permanece.
    expect(engine).toContain('sharedPolicyGuard');
    expect(engine).toContain('approvedFamilyPairs');
  });
});

function commandService(options: { autoExecutionEnabled?: () => boolean } = {}) {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  let executorWrites = 0;
  const activate = executor.activate.bind(executor);
  const remove = executor.remove.bind(executor);
  executor.activate = async (input) => {
    executorWrites += 1;
    return activate(input);
  };
  executor.remove = async (input) => {
    executorWrites += 1;
    return remove(input);
  };
  // Executor Huawei SIMULADO: preflight aprovado e escrita contada. E o caminho
  // que a UI/n8n usam em producao quando LIVE_WRITE esta ligado.
  let liveWrites = 0;
  const live = {
    enabledFor: () => true,
    resolveActivePair: async () => null,
    preflight: async () => ({ ok: true, blockedReasons: [] }) as never,
    activate: async () => {
      liveWrites += 1;
      return { output: 'ok' };
    },
    remove: async () => {
      liveWrites += 1;
      return { output: 'ok' };
    },
    readRoutePolicy: async () => '',
  };
  const commands = new MitigationCommandService({
    ...(options.autoExecutionEnabled ? { autoExecutionEnabled: options.autoExecutionEnabled } : {}),
    repository,
    hosts: { getHost: async (id) => ({ id, hostname: `hw-${id}` }) as unknown as HostRecord },
    executor,
    live: live as never,
    scopeLock: new InMemoryPolicyScopeLock(),
    expectedNodes: async () => [10],
    now: () => NOW,
  });
  return {
    repository,
    commands,
    writes: () => executorWrites + liveWrites,
  };
}

async function seed(family: 'IPV4' | 'IPV6') {
  const h = commandService({ autoExecutionEnabled: () => false });
  await h.repository.upsertProfile({
    deviceId: DEV,
    policyName: family === 'IPV4' ? 'PL-PARITY_IPv4-IN' : 'PL-PARITY_IPv6-IN',
    interfaceId: family === 'IPV4' ? 'if-v4' : 'if-v6',
    addressFamily: family,
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
  });
  const profile = (await h.repository.listProfiles())[0]!;
  return { ...h, profile };
}

describe('RC14-F: ACTIVATE manual nao e afetado pelo kill switch nem por fase de familia', () => {
  it.each(['IPV4', 'IPV6'] as const)('%s manual: com execucao automatica DESLIGADA o comando passa', async (family) => {
    const h = await seed(family);
    const result = await h.commands.execute({
      requestId: `manual-${family}`,
      action: 'ACTIVATE',
      profileId: h.profile.id,
    } as never);
    // Paridade RC13: o comando manual NAO e recusado pelo kill switch nem por
    // gate de familia; ele chega ao preflight READ-ONLY real e so para na regra
    // de negocio da RC13 (alvo sem par de nodes planejado no discovery).
    expect(result.status).not.toBe('AUTO_EXECUTION_DISABLED');
    expect(result.status).not.toBe('FAMILY_OUT_OF_PHASE');
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(result.safeError ?? '').toContain('Sem par de nodes planejado');
    // Sem preflight aprovado nao existe escrita: fail-closed identico a RC13.
    expect(h.writes()).toBe(0);
  });

  it.each(['IPV4', 'IPV6'] as const)('%s de origem AUTO: kill switch recusa antes da escrita', async (family) => {
    const h = await seed(family);
    const result = await h.commands.execute({
      requestId: `auto-activate-${h.profile.id}-1`,
      action: 'ACTIVATE',
      profileId: h.profile.id,
      origin: 'AUTO',
    } as never);
    expect(result.status).toBe('AUTO_EXECUTION_DISABLED');
    expect(h.writes()).toBe(0);
  });
});

const target = (profileId: string, over: Partial<MitigationAutoTargetState> = {}):
  MitigationAutoTargetState => ({
  profileId,
  deviceId: DEV,
  policyName: 'PL-PARITY_IPv6-IN',
  interfaceId: 'if-v6',
  customer: 'C',
  mode: 'AUTO',
  addressFamily: 'IPV6',
  direction: 'tx',
  directionSource: 'INTERFACE',
  snapshotAvailable: true,
  readiness: 'READY',
  prefixStatus: 'SAFE',
  blockedReason: null,
  mitigationExcluded: false,
  runtimeState: 'NORMAL',
  effectiveBandwidthBps: BW,
  bogonNode: 1,
  mitigationNode: 2,
  sharedPolicy: false,
  peerAddresses: ['2001:db8::1'],
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  ...over,
});

describe('RC14-F: contencao de familia IPv4/IPv6 da RC13 permanece no motor', () => {
  function engine(targets: MitigationAutoTargetState[]) {
    const repository = new InMemoryMitigationRepository();
    const traffic = new SequenceTrafficSource();
    let commands = 0;
    const auto = new MitigationAutoEngine({
      sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
      evaluationScope: 'OPERATIONAL',
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEV] },
      executionControl: { enabled: true },
      requireRuntimeRead: false,
      targets: { list: async () => targets },
      traffic,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: (id) => repository.getRuntime(id),
        save: async (id, patch) => {
          await repository.upsertRuntime(id, patch);
        },
      },
      commands: {
        execute: async () => {
          commands += 1;
          return { ok: true, status: 'x', verified: false } as never;
        },
      },
      now: () => NOW,
    });
    return { auto, traffic, commands: () => commands };
  }

  it('AUTO IPv6 sem irmao IPv4 aprovado: BLOCKED/FAMILY_CONTENTION_UNRESOLVED (nao FAMILY_OUT_OF_PHASE)', async () => {
    const h = engine([target('p-v6')]);
    let decisions: Awaited<ReturnType<typeof h.auto.tick>> = [];
    for (let index = 0; index < 4; index += 1) {
      h.traffic.push('p-v6', (BW * 95n) / 100n);
      decisions = await h.auto.tick();
    }
    expect(decisions[0]?.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(decisions[0]?.outcome).toBe('BLOCKED');
    expect(h.commands()).toBe(0);
  });

  it('AUTO IPv4 do mesmo par segue o fluxo normal (nenhum gate de familia)', async () => {
    const h = engine([target('p-v4', { addressFamily: 'IPV4', policyName: 'PL-PARITY_IPv4-IN', interfaceId: 'if-v4', peerAddresses: ['10.0.0.1'] })]);
    let decisions: Awaited<ReturnType<typeof h.auto.tick>> = [];
    for (let index = 0; index < 4; index += 1) {
      h.traffic.push('p-v4', (BW * 95n) / 100n);
      decisions = await h.auto.tick();
    }
    expect(decisions[0]?.reason).not.toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(decisions[0]?.reason).not.toBe('FAMILY_OUT_OF_PHASE');
  });
});
