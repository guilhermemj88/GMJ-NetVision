import { describe, expect, it } from 'vitest';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { InterfaceTrafficSource } from './mitigation-traffic-source';
import type {
  InterfaceTrafficReader,
  InterfaceTrafficRow,
} from '../../infrastructure/bgp/mitigation/prisma-interface-traffic-reader';

// AUTO-ALL-PREP-1: direcao POR PERFIL, contencao IPv4/IPv6 e guarda de policy
// compartilhada. O globalMode fica SIMULATION_ONLY: o foco e a DECISAO (o
// caminho de escrita continua coberto pelos suites existentes do motor).

const DEVICE = 'device-1';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;
const UNDER = (BW * 50n) / 100n;
const NOW = (): Date => new Date('2026-10-13T12:00:00.000Z');

/** Leitor de teste: uma amostra por interface, trocada pelo proprio teste. */
class FakeReader implements InterfaceTrafficReader {
  rows = new Map<string, InterfaceTrafficRow>();
  async latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null> {
    return this.rows.get(interfaceId) ?? null;
  }
}

function targetState(
  profileId: string,
  over: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    policyName: `PL-${profileId}-IN`,
    interfaceId: 'if-1',
    customer: `CLIENTE-${profileId}`,
    mode: 'ALERT_ONLY',
    addressFamily: 'IPV4',
    direction: 'tx',
    directionSource: 'PROFILE',
    sharedPolicyAutomationBlocked: false,
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
    peerAddresses: ['10.200.200.222'],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    ...over,
  };
}

interface HarnessOptions {
  directionByProfile?: Record<string, 'rx' | 'tx'>;
  /** false = nao injeta o resolver (testa o mapa do ENV isolado). */
  useResolver?: boolean;
  sharedPolicyGuard?: { enabled: boolean; allowedProfileIds: readonly string[] };
  approvedFamilyPairs?: readonly (readonly [string, string])[];
}

function harness(targets: MitigationAutoTargetState[], options: HarnessOptions = {}) {
  const reader = new FakeReader();
  const traffic = new InterfaceTrafficSource(reader, {
    ...(options.directionByProfile ? { directionByProfile: options.directionByProfile } : {}),
    // Reproduz a resolucao do processo: a direcao resolvida do target e a fonte.
    ...(options.useResolver === false
      ? {}
      : {
          resolveDirection: (target: { profileId: string }) =>
            targets.find((item) => item.profileId === target.profileId)?.direction ?? null,
        }),
    maxAgeMs: 600_000,
    now: NOW,
  });
  const engine = new MitigationAutoEngine({
    globalMode: 'SIMULATION_ONLY',
    execution: { executor: 'MOCK', liveWrite: false, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => targets },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => ({
        state: 'NORMAL',
        triggerCounter: 0,
        recoveryCounter: 0,
        lastSampleAt: null,
      }),
      save: async () => undefined,
    },
    commands: { execute: async () => ({ ok: true, status: 'OK', verified: true }) },
    now: NOW,
    ...(options.sharedPolicyGuard ? { sharedPolicyGuard: options.sharedPolicyGuard } : {}),
    ...(options.approvedFamilyPairs
      ? { approvedFamilyPairs: options.approvedFamilyPairs }
      : {}),
  });
  /** Amostra REAL do equipamento (na direcao tx por padrao) com identidade. */
  const feed = (value: bigint, at: string, interfaceId = 'if-1', field: 'tx' | 'rx' = 'tx') => {
    reader.rows.set(interfaceId, {
      interfaceId,
      rxBps: field === 'rx' ? Number(value) : 0,
      txBps: field === 'tx' ? Number(value) : 0,
      timestamp: new Date(at),
    });
  };
  const byProfile = (decisions: Awaited<ReturnType<MitigationAutoEngine['tick']>>, id: string) =>
    decisions.find((item) => item.profileId === id)!;
  return { engine, reader, feed, byProfile };
}

describe('AUTO: direcao de telemetria por perfil (fail-closed)', () => {
  it('1) direcao EFETIVA e origem aparecem na decisao (auditoria do modo sombra)', async () => {
    const h = harness([targetState('p-1')]);
    h.feed(UNDER, '2026-10-13T11:59:00.000Z');

    const decision = (await h.engine.tick())[0]!;
    expect(decision.direction).toBe('tx');
    expect(decision.directionSource).toBe('PROFILE');
    expect(decision.addressFamily).toBe('IPV4');
    expect(decision.trafficBps).toBe(UNDER.toString());
  });

  it('2) SEM direcao => TELEMETRY_UNAVAILABLE (nunca um default implicito)', async () => {
    const h = harness([targetState('p-1', { direction: null, directionSource: null })]);
    h.feed(OVER, '2026-10-13T11:59:00.000Z');

    const decision = (await h.engine.tick())[0]!;
    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.reason).toBe('TELEMETRY_UNAVAILABLE');
    expect(decision.direction).toBeNull();
  });

  it('3) ENV resolvido no alvo (routes) => decisao mostra rx/ENV', async () => {
    const h = harness([
      targetState('p-9', { direction: 'rx', directionSource: 'ENV' }),
    ]);
    h.feed(OVER, '2026-10-13T11:59:00.000Z', 'if-1', 'rx');

    const decision = (await h.engine.tick())[0]!;
    expect(decision.direction).toBe('rx');
    expect(decision.directionSource).toBe('ENV');
    expect(decision.trafficBps).toBe(OVER.toString());
  });

  it('3b) fallback do mapa do ENV na PROPRIA fonte de telemetria', async () => {
    const h = harness([targetState('p-9', { direction: null, directionSource: null })], {
      directionByProfile: { 'p-9': 'rx' },
      useResolver: false,
    });
    h.feed(OVER, '2026-10-13T11:59:00.000Z', 'if-1', 'rx');

    const decision = (await h.engine.tick())[0]!;
    expect(decision.trafficBps).toBe(OVER.toString());
    expect(decision.reason).not.toBe('TELEMETRY_UNAVAILABLE');
  });

  it('4) tres amostras = tres OBSERVACOES distintas (a mesma nunca conta duas vezes)', async () => {
    const h = harness([targetState('p-1')]);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    const first = h.byProfile(await h.engine.tick(), 'p-1');
    expect(first.samplesOver).toBe(1);
    expect(first.outcome).toBe('TRIGGER_PENDING');

    const repeated = h.byProfile(await h.engine.tick(), 'p-1');
    expect(repeated.samplesOver).toBe(1);

    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'p-1').samplesOver).toBe(2);

    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const third = h.byProfile(await h.engine.tick(), 'p-1');
    expect(third.samplesOver).toBe(3);
    expect(third.outcome).toBe('ALERT_TRIGGERED');
  });

  it('5) amostra ATRASADA (timestamp menor) nao conta', async () => {
    const h = harness([targetState('p-1')]);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'p-1').samplesOver).toBe(2);

    h.feed(OVER, '2026-10-13T11:55:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'p-1').samplesOver).toBe(2);
  });

  it('6) tráfego cai: contador zera e a ativacao exige novas amostras', async () => {
    const h = harness([targetState('p-1')]);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'p-1').outcome).toBe('ALERT_TRIGGERED');

    h.feed(UNDER, '2026-10-13T12:00:00.000Z');
    const dropped = h.byProfile(await h.engine.tick(), 'p-1');
    expect(dropped.samplesOver).toBe(0);
    expect(dropped.outcome).toBe('NO_ACTION');
  });
});

describe('AUTO: contencao IPv4/IPv6 no MESMO escopo de contadores', () => {
  it('7) as duas familias em AUTO: a secundaria fica BLOQUEADA (fail-closed)', async () => {
    const targets = [
      targetState('p-v4', { mode: 'AUTO', addressFamily: 'IPV4' }),
      targetState('p-v6', { mode: 'AUTO', addressFamily: 'IPV6' }),
    ];
    const h = harness(targets);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const decisions = await h.engine.tick();

    expect(h.byProfile(decisions, 'p-v4').reason).not.toBe('FAMILY_CONTENTION_UNRESOLVED');
    const secondary = h.byProfile(decisions, 'p-v6');
    expect(secondary.outcome).toBe('BLOCKED');
    expect(secondary.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(secondary.detail).toContain('p-v4');
  });

  it('8) par v4/v6 APROVADO explicitamente: as duas familias avaliam', async () => {
    const targets = [
      targetState('p-v4', { mode: 'AUTO', addressFamily: 'IPV4' }),
      targetState('p-v6', { mode: 'AUTO', addressFamily: 'IPV6' }),
    ];
    const h = harness(targets, { approvedFamilyPairs: [['p-v4', 'p-v6']] });
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const decisions = await h.engine.tick();

    for (const id of ['p-v4', 'p-v6']) {
      const decision = h.byProfile(decisions, id);
      expect(decision.reason, id).not.toBe('FAMILY_CONTENTION_UNRESOLVED');
      expect(decision.outcome, id).toBe('WOULD_ACTIVATE');
    }
  });

  it('9) apenas IPv6 em AUTO (sem irmao IPv4): BLOQUEADO por design (fail-closed)', async () => {
    const targets = [targetState('p-v6', { mode: 'AUTO', addressFamily: 'IPV6' })];
    const h = harness(targets);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const decision = h.byProfile(await h.engine.tick(), 'p-v6');
    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(decision.detail ?? '').toContain('SEM_VINCULO_IPV4');
  });

  it('9b) irmao IPv4 SEM direcao (gap antigo): IPv6 segue BLOQUEADO', async () => {
    const targets = [
      targetState('p-v4', { mode: 'AUTO', addressFamily: 'IPV4', direction: null, directionSource: null }),
      targetState('p-v6', {
        mode: 'AUTO',
        addressFamily: 'IPV6',
        direction: null,
        directionSource: null,
      }),
    ];
    const h = harness(targets);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const decisions = await h.engine.tick();

    const secondary = h.byProfile(decisions, 'p-v6');
    expect(secondary.outcome).toBe('BLOCKED');
    expect(secondary.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('10) SOMBRA (ALERT_ONLY) mede as duas familias sem contencao', async () => {
    const targets = [
      targetState('p-v4', { addressFamily: 'IPV4' }),
      targetState('p-v6', { addressFamily: 'IPV6' }),
    ];
    const h = harness(targets);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    const decisions = await h.engine.tick();

    expect(h.byProfile(decisions, 'p-v4').outcome).toBe('ALERT_TRIGGERED');
    expect(h.byProfile(decisions, 'p-v6').outcome).toBe('ALERT_TRIGGERED');
  });
});

describe('AUTO: guarda de automacao em policy COMPARTILHADA', () => {
  it('11) guarda DESLIGADA preserva o comportamento atual (compat BHNET)', async () => {
    const h = harness([targetState('bhnet', { mode: 'AUTO', sharedPolicyAutomationBlocked: true })]);
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'bhnet').outcome).toBe('WOULD_ACTIVATE');
  });

  it('12) guarda LIGADA bloqueia sem allowlist explicita', async () => {
    const h = harness([targetState('bhnet', { mode: 'AUTO', sharedPolicyAutomationBlocked: true })], {
      sharedPolicyGuard: { enabled: true, allowedProfileIds: [] },
    });
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    const decision = h.byProfile(await h.engine.tick(), 'bhnet');
    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.reason).toBe('SHARED_POLICY_UNRESOLVED');
  });

  it('13) guarda LIGADA libera perfil na allowlist', async () => {
    const h = harness([targetState('bhnet', { mode: 'AUTO', sharedPolicyAutomationBlocked: true })], {
      sharedPolicyGuard: { enabled: true, allowedProfileIds: ['bhnet'] },
    });
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'bhnet').outcome).toBe('WOULD_ACTIVATE');
  });

  it('14) ALERT_ONLY (sombra) nunca passa pela guarda de policy compartilhada', async () => {
    const h = harness([
      targetState('bhnet', { mode: 'ALERT_ONLY', sharedPolicyAutomationBlocked: true }),
    ], { sharedPolicyGuard: { enabled: true, allowedProfileIds: [] } });
    h.feed(OVER, '2026-10-13T11:50:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:54:00.000Z');
    await h.engine.tick();
    h.feed(OVER, '2026-10-13T11:58:00.000Z');
    expect(h.byProfile(await h.engine.tick(), 'bhnet').outcome).toBe('ALERT_TRIGGERED');
  });
});
