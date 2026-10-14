import { describe, expect, it } from 'vitest';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import type {
  MitigationDirectionsSample,
  MitigationTrafficSource,
} from './mitigation-traffic-source';

// AUTO-ALL (correcao pre-deploy): CONTENCAO DE FAMILIA na camada de EXECUCAO.
//
// O alvo IPv6 em AUTO NUNCA inicia acao BGP sem aprovacao explicita do par,
// independentemente de: RX/TX/DUAL, direcao herdada do ENV, direcao persistida,
// ausencia de direcao, proveniencia (sweep x manual) e policy compartilhada.

const DEVICE = 'device-1';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;

function target(
  profileId: string,
  over: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    policyName: `PL-${profileId}-IN`,
    interfaceId: 'if-shared',
    customer: profileId,
    mode: 'AUTO',
    addressFamily: 'IPV6',
    direction: null,
    directionSource: null,
    autoPromotedBySweep: true,
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
  };
}

function trafficSource(): MitigationTrafficSource {
  let tick = 0;
  const nextSample = () => {
    tick += 1;
    const at = new Date(Date.UTC(2026, 9, 14, 12, 0, tick * 10));
    return { bps: OVER, sampleKey: at.toISOString(), occurredAt: at };
  };
  return {
    async sample() {
      return OVER;
    },
    async sampleWithId() {
      return nextSample();
    },
    async sampleDirectionsWithId(): Promise<MitigationDirectionsSample> {
      const tx = nextSample();
      return {
        sampleKey: tx.sampleKey,
        occurredAt: tx.occurredAt,
        rx: { bps: (BW * 10n) / 100n, sampleKey: tx.sampleKey, occurredAt: tx.occurredAt },
        tx,
      };
    },
  };
}

function engine(
  targets: MitigationAutoTargetState[],
  options: {
    dual?: boolean;
    approvedFamilyPairs?: [string, string][];
  } = {},
) {
  const executed: string[] = [];
  const instance = new MitigationAutoEngine({
    globalMode: 'SIMULATION_ONLY',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => targets },
    traffic: trafficSource(),
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => ({
        state: 'NORMAL' as never,
        triggerCounter: 0,
        recoveryCounter: 0,
        lastSampleAt: null,
      }),
      save: async () => undefined,
    },
    commands: {
      execute: async (input) => {
        executed.push(input.profileId);
        return { ok: true, status: 'ACTIVATED_VERIFIED', verified: true };
      },
    },
    ...(options.dual ? { dualDirections: { enabled: true } } : {}),
    ...(options.approvedFamilyPairs
      ? { approvedFamilyPairs: options.approvedFamilyPairs }
      : {}),
  });
  const run3 = async () => {
    await instance.tick();
    await instance.tick();
    return (await instance.tick())[0]!;
  };
  return { instance, run3, executed };
}

describe('AUTO: contencao de familia IPv4/IPv6 (execucao, independente de direcao)', () => {
  it('1) IPv6 AUTO com direcao AUSENTE + DUAL ligado => BLOQUEADO (falha corrigida)', async () => {
    const h = engine([target('v6', { direction: null }), target('v4', { addressFamily: 'IPV4' })], {
      dual: true,
    });
    const decision = await h.run3();
    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(h.executed).toHaveLength(0);
  });

  it('2) IPv6 AUTO com direcao AUSENTE e DUAL desligado => BLOQUEADO', async () => {
    const h = engine([target('v6')]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('3) direcao persistida (PROFILE tx) => BLOQUEADO sem aprovacao', async () => {
    const h = engine([
      target('v6', { direction: 'tx', directionSource: 'PROFILE' }),
      target('v4', { addressFamily: 'IPV4', direction: 'tx', directionSource: 'PROFILE' }),
    ]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('4) direcao herdada do ENV (tx) => BLOQUEADO sem aprovacao', async () => {
    const h = engine([
      target('v6', { direction: 'tx', directionSource: 'ENV' }),
      target('v4', { addressFamily: 'IPV4', direction: 'tx', directionSource: 'ENV' }),
    ]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('5) direcao RX persistida => BLOQUEADO sem aprovacao', async () => {
    const h = engine([
      target('v6', { direction: 'rx', directionSource: 'PROFILE' }),
      target('v4', { addressFamily: 'IPV4', direction: 'rx', directionSource: 'PROFILE' }),
    ]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('6) PAR APROVADO (este alvo + irmao IPv4) => passa pela guarda de familia', async () => {
    const h = engine(
      [
        target('v6', { direction: 'tx', directionSource: 'PROFILE' }),
        target('v4', { addressFamily: 'IPV4', direction: 'tx', directionSource: 'PROFILE' }),
      ],
      { approvedFamilyPairs: [['v6', 'v4']] },
    );
    const decision = await h.run3();
    expect(decision.reason).not.toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(decision.outcome).toBe('WOULD_ACTIVATE');
  });

  it('7) NENHUM irmao IPv4 no escopo => BLOQUEADO (fail-closed)', async () => {
    const h = engine([target('v6')]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
    expect(decision.detail ?? '').toContain('SEM_VINCULO_IPV4');
  });

  it('8) POLICY COMPARTILHADA: irmao IPv4 em OUTRA interface nao aprova => BLOQUEADO', async () => {
    const h = engine([
      target('v6', { sharedPolicy: true, policyName: 'PL-SHARED-IN' }),
      target('v4', {
        addressFamily: 'IPV4',
        interfaceId: 'if-outra',
        sharedPolicy: true,
        policyName: 'PL-SHARED-IN',
        direction: 'tx',
        directionSource: 'PROFILE',
      }),
    ]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('9) proveniencia do sweep NAO contorna a guarda de familia', async () => {
    const h = engine([
      target('v6', { autoPromotedBySweep: true }),
      target('v4', { addressFamily: 'IPV4', autoPromotedBySweep: true }),
    ]);
    const decision = await h.run3();
    expect(decision.reason).toBe('FAMILY_CONTENTION_UNRESOLVED');
  });

  it('10) ALERT_ONLY IPv6 nao e bloqueado (sombra mede as duas familias)', async () => {
    const h = engine([
      target('v6', { mode: 'ALERT_ONLY', direction: 'tx', directionSource: 'PROFILE' }),
      target('v4', { addressFamily: 'IPV4', direction: 'tx', directionSource: 'PROFILE' }),
    ]);
    const decision = await h.run3();
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
  });
});
