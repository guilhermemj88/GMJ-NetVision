import { describe, expect, it } from 'vitest';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { InterfaceTrafficSource } from './mitigation-traffic-source';
import type {
  InterfaceTrafficReader,
  InterfaceTrafficRow,
} from '../../infrastructure/bgp/mitigation/prisma-interface-traffic-reader';

// AUTO-ALL: modo DUAL RX+TX.
//
// Regras validadas aqui:
//  - RX e TX vem da MESMA amostra do equipamento, com contadores INDEPENDENTES;
//  - TX e a direcao da mitigacao BGP existente (diversao de prefixo);
//  - RX e detectado e ALERTADO (`RX_MONITOR_ONLY`) e NUNCA escreve comando;
//  - amostra duplicada (mesma identidade) conta UMA vez, por direcao;
//  - amostra atrasada nao conta;
//  - reset e por direcao;
//  - com a flag desligada o caminho LEGADO de direcao unica continua identico;
//  - perfil com direcao PINADA em rx segue no caminho legado (nao existe acao
//    BGP compativel com RX).

const DEVICE = 'device-1';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;
const UNDER = (BW * 50n) / 100n;
const NOW = (): Date => new Date('2026-10-13T12:00:00.000Z');

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
    direction: null,
    directionSource: null,
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
  dual?: boolean;
  /** AUTO + executor HUAWEI + live write: prova se o comando e executado. */
  armed?: boolean;
}

function harness(targets: MitigationAutoTargetState[], options: HarnessOptions = {}) {
  const reader = new FakeReader();
  const traffic = new InterfaceTrafficSource(reader, {
    // Espelha o wiring de producao: a direcao RESOLVIDA do alvo (persistida ou
    // ENV) e a fonte da leitura no caminho legado; sem direcao, fail-closed.
    resolveDirection: (target: { profileId: string }) =>
      targets.find((item) => item.profileId === target.profileId)?.direction ?? null,
    maxAgeMs: 600_000,
    now: NOW,
  });
  const executed: { requestId: string; action: string; profileId: string }[] = [];
  const runtime = new Map<string, { state: string; triggerCounter: number; recoveryCounter: number }>();
  const engine = new MitigationAutoEngine({
    globalMode: options.armed ? 'AUTO' : 'SIMULATION_ONLY',
    execution: options.armed
      ? { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] }
      : { executor: 'MOCK', liveWrite: false, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => targets },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async (profileId) => {
        const stored = runtime.get(profileId);
        return stored
          ? {
              state: stored.state as never,
              triggerCounter: stored.triggerCounter,
              recoveryCounter: stored.recoveryCounter,
              lastSampleAt: null,
            }
          : { state: 'NORMAL' as never, triggerCounter: 0, recoveryCounter: 0, lastSampleAt: null };
      },
      save: async (profileId, patch) => {
        const current = runtime.get(profileId) ?? {
          state: 'NORMAL',
          triggerCounter: 0,
          recoveryCounter: 0,
        };
        runtime.set(profileId, {
          state: (patch.state as string | undefined) ?? current.state,
          triggerCounter: patch.triggerCounter ?? current.triggerCounter,
          recoveryCounter: patch.recoveryCounter ?? current.recoveryCounter,
        });
      },
    },
    commands: {
      execute: async (input) => {
        executed.push({ ...input });
        return { ok: true, status: 'ACTIVATED_VERIFIED', verified: true };
      },
    },
    now: NOW,
    dualDirections: { enabled: options.dual === true },
  });

  /** UMA linha do equipamento alimenta as DUAS direcoes na mesma identidade. */
  const feed = (rx: bigint, tx: bigint, at: string, interfaceId = 'if-1') => {
    reader.rows.set(interfaceId, {
      interfaceId,
      rxBps: Number(rx),
      txBps: Number(tx),
      timestamp: new Date(at),
    });
  };
  const tick = async () => (await engine.tick())[0]!;
  return { engine, reader, feed, tick, executed };
}

describe('AUTO DUAL: RX monitorado + TX acionavel (contadores independentes)', () => {
  it('1) RX acima e TX abaixo: ALERT_TRIGGERED / RX_MONITOR_ONLY, ZERO comando', async () => {
    const h = harness([targetState('p-1')], { dual: true, armed: true });
    h.feed(OVER, UNDER, '2026-10-13T11:59:00.000Z');
    let decision = await h.tick();
    expect(decision.outcome).toBe('TRIGGER_PENDING');

    h.feed(OVER, UNDER, '2026-10-13T11:59:10.000Z');
    await h.tick();
    h.feed(OVER, UNDER, '2026-10-13T11:59:20.000Z');
    decision = await h.tick();

    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(decision.reason).toBe('RX_MONITOR_ONLY');
    expect(decision.triggeredDirections).toEqual(['rx']);
    expect(decision.trafficByDirection).toEqual({
      rx: OVER.toString(),
      tx: UNDER.toString(),
    });
    expect(h.executed).toHaveLength(0);
  });

  it('2) TX acima e RX abaixo: aciona a mitigacao BGP existente UMA vez', async () => {
    const h = harness([targetState('p-1', { mode: 'AUTO' })], { dual: true, armed: true });
    h.feed(UNDER, OVER, '2026-10-13T11:59:00.000Z');
    await h.tick();
    h.feed(UNDER, OVER, '2026-10-13T11:59:10.000Z');
    await h.tick();
    h.feed(UNDER, OVER, '2026-10-13T11:59:20.000Z');
    const decision = await h.tick();

    expect(decision.outcome).toBe('ACTIVATED');
    expect(decision.triggeredDirections).toEqual(['tx']);
    expect(decision.trafficByDirection).toEqual({
      rx: UNDER.toString(),
      tx: OVER.toString(),
    });
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]!.action).toBe('ACTIVATE');
  });

  it('3) as DUAS direcoes acima: TX executa UMA vez e o RX aparece na decisao', async () => {
    const h = harness([targetState('p-1', { mode: 'AUTO' })], { dual: true, armed: true });
    h.feed(OVER, OVER, '2026-10-13T11:59:00.000Z');
    await h.tick();
    h.feed(OVER, OVER, '2026-10-13T11:59:10.000Z');
    await h.tick();
    h.feed(OVER, OVER, '2026-10-13T11:59:20.000Z');
    const decision = await h.tick();

    expect(decision.outcome).toBe('ACTIVATED');
    expect(decision.triggeredDirections).toEqual(['rx', 'tx']);
    expect(h.executed).toHaveLength(1);
  });

  it('4) amostra DUPLICADA (mesma identidade) nao conta duas vezes por direcao', async () => {
    const h = harness([targetState('p-1')], { dual: true });
    for (let tick = 0; tick < 5; tick += 1) {
      h.feed(OVER, OVER, '2026-10-13T11:59:00.000Z');
      const decision = await h.tick();
      expect(decision.outcome).toBe('TRIGGER_PENDING');
    }
  });

  it('5) amostra ATRASADA (occurredAt menor) nao conta', async () => {
    const h = harness([targetState('p-1')], { dual: true });
    h.feed(OVER, OVER, '2026-10-13T11:59:20.000Z');
    await h.tick();
    h.feed(OVER, OVER, '2026-10-13T11:59:30.000Z');
    let decision = await h.tick();
    expect(decision.samplesOver).toBe(2);

    // Telemetria reordenada/atrasada: identidade MENOR nunca abre gatilho.
    h.feed(OVER, OVER, '2026-10-13T11:59:10.000Z');
    decision = await h.tick();
    expect(decision.samplesOver).toBe(2);
    expect(decision.outcome).toBe('TRIGGER_PENDING');
  });

  it('6) reset e POR DIRECAO: TX volta ao normal e o APENAS RX segue contando', async () => {
    const h = harness([targetState('p-1')], { dual: true });
    h.feed(OVER, OVER, '2026-10-13T11:59:00.000Z');
    await h.tick();
    h.feed(OVER, OVER, '2026-10-13T11:59:10.000Z');
    await h.tick();

    // TX cai abaixo do piso de recuperacao: ZERA os contadores de TX sem tocar
    // nos de RX (que fecham o gatilho nesta amostra).
    h.feed(OVER, UNDER, '2026-10-13T11:59:20.000Z');
    const decision = await h.tick();
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(decision.reason).toBe('RX_MONITOR_ONLY');
    expect(decision.triggeredDirections).toEqual(['rx']);
    // A decisao do RX reporta os contadores DO RX: 3 amostras acima.
    expect(decision.samplesOver).toBe(3);

    // TX volta a subir: se o contador de TX NAO tivesse sido zerado, esta
    // amostra fecharia o gatilho de TX (2 anteriores + esta). Zero escrita
    // prova que o reset foi POR DIRECAO.
    h.feed(OVER, OVER, '2026-10-13T11:59:30.000Z');
    const after = await h.tick();
    expect(after.outcome).toBe('ALERT_TRIGGERED');
    expect(after.samplesOver).toBe(4);
    expect(h.executed).toHaveLength(0);
  });

  it('7) flag DESLIGADA: caminho legado, sem leitura por direcao', async () => {
    const h = harness([targetState('p-1', { direction: 'tx', directionSource: 'PROFILE' })], {
      dual: false,
    });
    h.feed(UNDER, OVER, '2026-10-13T11:59:00.000Z');
    const decision = await h.tick();

    expect(decision.trafficBps).toBe(OVER.toString());
    expect(decision.trafficByDirection).toBeUndefined();
    expect(decision.triggeredDirections).toBeUndefined();
  });

  it('8) flag DESLIGADA sem direcao: TELEMETRY_UNAVAILABLE (fail-closed)', async () => {
    const h = harness([targetState('p-1')], { dual: false });
    h.feed(OVER, OVER, '2026-10-13T11:59:00.000Z');
    const decision = await h.tick();

    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.reason).toBe('TELEMETRY_UNAVAILABLE');
  });

  it('9) direcao PINADA em rx: segue o caminho legado (RX nao executa BGP)', async () => {
    const h = harness([targetState('p-1', { direction: 'rx', directionSource: 'PROFILE' })], {
      dual: true,
      armed: true,
    });
    h.feed(OVER, UNDER, '2026-10-13T11:59:00.000Z');
    await h.tick();
    h.feed(OVER, UNDER, '2026-10-13T11:59:10.000Z');
    await h.tick();
    h.feed(OVER, UNDER, '2026-10-13T11:59:20.000Z');
    const decision = await h.tick();

    expect(decision.trafficByDirection).toBeUndefined();
    expect(decision.trafficBps).toBe(OVER.toString());
    expect(h.executed).toHaveLength(0);
  });

  it('10) TX sem leitura valida e RX confirmado: alerta, nunca bloqueio silencioso', async () => {
    const h = harness([targetState('p-1')], { dual: true, armed: true });
    const reader = h.reader;
    reader.rows.set('if-1', {
      interfaceId: 'if-1',
      rxBps: Number(OVER),
      txBps: Number.NaN,
      timestamp: new Date('2026-10-13T11:59:00.000Z'),
    });
    await h.tick();
    reader.rows.set('if-1', {
      interfaceId: 'if-1',
      rxBps: Number(OVER),
      txBps: Number.NaN,
      timestamp: new Date('2026-10-13T11:59:10.000Z'),
    });
    await h.tick();
    reader.rows.set('if-1', {
      interfaceId: 'if-1',
      rxBps: Number(OVER),
      txBps: Number.NaN,
      timestamp: new Date('2026-10-13T11:59:20.000Z'),
    });
    const decision = await h.tick();

    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(decision.reason).toBe('RX_MONITOR_ONLY');
    expect(decision.trafficByDirection).toEqual({ rx: OVER.toString(), tx: null });
    expect(h.executed).toHaveLength(0);
  });
});
