import { describe, expect, it, vi } from 'vitest';
import { InMemoryMitigationRepository } from '../../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { BgpMitigationService } from '../../infrastructure/bgp/mitigation/mitigation-service';
import type { MitigationDiscoveryResult } from '../../infrastructure/bgp/mitigation/mitigation-discovery-service';
import { MitigationAutoRuntime } from './mitigation-auto-runtime';
import { InterfaceTrafficSource } from './mitigation-traffic-source';
import type { MitigationAutoDecision } from './mitigation-auto-engine';

// Runtime (timer/loop) + telemetria real + health do motor AUTO.

const NOW = new Date('2026-10-01T12:00:00.000Z');


function decision(over: Partial<MitigationAutoDecision> = {}): MitigationAutoDecision {
  return {
    at: NOW.toISOString(),
    profileId: 'profile-1',
    deviceId: 'device-1',
    customer: 'BHNET-CEASA',
    outcome: 'BLOCKED',
    reason: 'LIVE_WRITE_DISABLED',
    trafficBps: '9500000000',
    thresholdBps: '9000000000',
    recoveryThresholdBps: '7000000000',
    samplesOver: 3,
    samplesBelow: 0,
    requiredSamples: 3,
    runtimeState: 'NORMAL',
    sharedPolicy: false,
    requestId: null,
    commandStatus: null,
    verified: false,
    notification: null,
    detail: 'LIVE_WRITE_DISABLED',
    ...over,
  };
}

describe('runtime do motor AUTO', () => {
  it('nao inicia dois timers e nao sobrepoe ticks', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const engine = {
      tick: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [decision()];
      }),
    };
    const runtime = new MitigationAutoRuntime({ engine, intervalMs: 1000, now: () => NOW });
    runtime.start();
    runtime.start();
    expect(runtime.getStatus().state).toBe('RUNNING');
    const results = await Promise.all([runtime.tickOnce(), runtime.tickOnce(), runtime.tickOnce()]);
    expect(maxInFlight).toBe(1);
    expect(results.filter((item) => item.length > 0)).toHaveLength(1);
    expect(runtime.getStatus().skippedTicks).toBeGreaterThanOrEqual(2);
    runtime.stop();
  });

  it('shutdown limpa o timer', () => {
    const clearIntervalSpy = vi.fn();
    const setIntervalSpy = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const runtime = new MitigationAutoRuntime({
      engine: { tick: async () => [] },
      intervalMs: 1000,
      setInterval: setIntervalSpy as unknown as typeof setInterval,
      clearInterval: clearIntervalSpy as unknown as typeof clearInterval,
    });
    runtime.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    runtime.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().state).toBe('STOPPED');
    expect(runtime.isRunning()).toBe(false);
  });

  it('erro em um ciclo nao derruba o loop e fica registrado', async () => {
    let calls = 0;
    const engine = {
      tick: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('falha simulada de ciclo');
        return [decision({ outcome: 'WOULD_ACTIVATE' })];
      }),
    };
    const runtime = new MitigationAutoRuntime({ engine, intervalMs: 1000, now: () => NOW });
    expect(await runtime.tickOnce()).toEqual([]);
    expect(runtime.getStatus().lastError).toBe('falha simulada de ciclo');
    expect(runtime.getStatus().lastTickAt).toBe(NOW.toISOString());
    const second = await runtime.tickOnce();
    expect(second[0]!.outcome).toBe('WOULD_ACTIVATE');
    expect(runtime.getStatus().lastError).toBeNull();
    expect(runtime.getStatus().lastSuccessfulTickAt).toBe(NOW.toISOString());
  });

  it('registra ultimo ACTIVATE verificado', async () => {
    const engine = {
      tick: async () => [decision({ outcome: 'ACTIVATED', verified: true, reason: null })],
    };
    const runtime = new MitigationAutoRuntime({ engine, intervalMs: 1000, now: () => NOW });
    await runtime.tickOnce();
    const status = runtime.getStatus();
    expect(status.lastAutoActivateAt).toBe(NOW.toISOString());
    expect(status.lastAutoActivateProfileId).toBe('profile-1');
  });
});

describe('telemetria real de interface (InterfaceMetricSample)', () => {
  const base = { interfaceId: 'if-1', rxBps: 1_000_000_000, txBps: 9_500_000_000, timestamp: NOW };

  it('aceita amostra fresca (direcao tx por padrao)', async () => {
    const source = new InterfaceTrafficSource(
      { latestTraffic: async () => base },
      { direction: 'tx', maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBe(9_500_000_000n);
  });

  it('respeita a direcao rx quando configurada', async () => {
    const source = new InterfaceTrafficSource(
      { latestTraffic: async () => base },
      { direction: 'rx', maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBe(1_000_000_000n);
  });

  it('rejeita amostra velha', async () => {
    const old = { ...base, timestamp: new Date(NOW.getTime() - 10 * 60 * 1000) };
    const source = new InterfaceTrafficSource(
      { latestTraffic: async () => old },
      { direction: 'tx', maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBeNull();
  });

  it('rejeita amostra ausente e interface ausente', async () => {
    const source = new InterfaceTrafficSource(
      { latestTraffic: async () => null },
      { direction: 'tx', maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBeNull();
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: null, bandwidthBps: null })).toBeNull();
  });

  it('sem direcao explicita para o profile => telemetria indisponivel (fail-closed)', async () => {
    const source = new InterfaceTrafficSource(
      { latestTraffic: async () => base },
      { directionByProfile: {}, maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await source.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBeNull();
    const configured = new InterfaceTrafficSource(
      { latestTraffic: async () => base },
      { directionByProfile: { p: 'rx' }, maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await configured.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBe(1_000_000_000n);
  });

  it('rejeita NaN e negativo', async () => {
    const nan = new InterfaceTrafficSource(
      { latestTraffic: async () => ({ ...base, txBps: Number.NaN }) },
      { direction: 'tx', maxAgeMs: 120_000, now: () => NOW },
    );
    const neg = new InterfaceTrafficSource(
      { latestTraffic: async () => ({ ...base, txBps: -1 }) },
      { direction: 'tx', maxAgeMs: 120_000, now: () => NOW },
    );
    expect(await nan.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBeNull();
    expect(await neg.sample({ profileId: 'p', deviceId: 'd', interfaceId: 'if-1', bandwidthBps: null })).toBeNull();
  });
});

describe('health expoe o estado do motor AUTO', () => {
  function service(repository: InMemoryMitigationRepository) {
    return new BgpMitigationService({
      repository,
      discovery: { discoverMitigationProfiles: async () => ({}) as MitigationDiscoveryResult } as never,
      hosts: { getHost: async () => null },
      schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
      repositoryKind: 'DATABASE',
      execution: { executor: 'HUAWEI', liveWriteEnabled: false, allowedDeviceIds: ['device-1'] },
      autoStatus: () => ({
        state: 'RUNNING',
        evaluationIntervalMs: 5000,
        startedAt: NOW.toISOString(),
        lastTickAt: NOW.toISOString(),
        lastSuccessfulTickAt: NOW.toISOString(),
        lastError: null,
        lastDecision: {
          at: NOW.toISOString(),
          profileId: 'profile-1',
          deviceId: 'device-1',
          customer: 'BHNET-CEASA',
          outcome: 'WOULD_ACTIVATE',
          reason: 'LIVE_WRITE_DISABLED',
          trafficBps: '9500000000',
          thresholdBps: '9000000000',
          runtimeState: 'TRIGGER_PENDING',
          commandStatus: null,
          verified: false,
          detail: 'LIVE_WRITE_DISABLED',
        },
        lastAutoActivateAt: null,
        lastAutoActivateProfileId: null,
      }),
    });
  }

  it('default SIMULATION_ONLY quando nada esta configurado', async () => {
    const repository = new InMemoryMitigationRepository();
    const plain = new BgpMitigationService({
      repository,
      discovery: { discoverMitigationProfiles: async () => ({}) as MitigationDiscoveryResult } as never,
      hosts: { getHost: async () => null },
      schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
      repositoryKind: 'MEMORY',
    });
    const health = await plain.health();
    expect(health.mode).toBe('SIMULATION_ONLY');
    expect(health.executor).toBe('MOCK');
    expect(health.liveWriteEnabled).toBe(false);
    expect(health.profiles).toEqual({ total: 0, auto: 0, alertOnly: 0, disabled: 0 });
  });

  it('expoe modo, executor, live write, contagem e ultima decisao', async () => {
    const repository = new InMemoryMitigationRepository();
    await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: 'PL-BHNET_IPv4-IN',
      interfaceId: 'if-1',
      addressFamily: 'IPV4',
      mode: 'AUTO',
    });
    await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: 'PL-OUTRA_IPv4-IN',
      interfaceId: 'if-2',
      addressFamily: 'IPV4',
      mode: 'ALERT_ONLY',
    });
    const health = await service(repository).health();
    expect(health.mode).toBe('SIMULATION_ONLY');
    expect(health.executor).toBe('HUAWEI');
    expect(health.liveWriteEnabled).toBe(false);
    expect(health.allowedDeviceCount).toBe(1);
    expect(health.profiles).toEqual({ total: 2, auto: 1, alertOnly: 1, disabled: 0 });
    expect(health.autoEngine?.state).toBe('RUNNING');
    expect(health.autoEngine?.lastDecision?.outcome).toBe('WOULD_ACTIVATE');
    expect(health.autoEngine?.lastDecision?.reason).toBe('LIVE_WRITE_DISABLED');
  });
});