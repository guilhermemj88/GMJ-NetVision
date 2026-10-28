import { describe, expect, it } from 'vitest';
import { InMemoryMitigationRepository } from '../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import {
  MitigationAutoEngine,
  type MitigationAutoDecision,
  type MitigationAutoTargetState,
} from '../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../worker/mitigation/mitigation-traffic-source';

const BASE = Date.parse('2026-10-28T20:00:00Z');
const BW = 10_000_000_000n;
function scenario(ack: () => Promise<{ delivered: boolean }> = async () => ({ delivered: true })) {
  const repository = new InMemoryMitigationRepository();
  const traffic = new SequenceTrafficSource();
  const sent: MitigationAutoDecision[] = [];
  let clock = BASE;
  let commands = 0;
  const target: MitigationAutoTargetState = {
    profileId: 'codex-episode',
    deviceId: 'fake-device',
    policyName: 'PL-FAKE_IPv4-IN',
    interfaceId: 'fake-if',
    customer: 'OFFLINE',
    mode: 'AUTO',
    addressFamily: 'IPV4',
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
    peerAddresses: ['192.0.2.1'],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
  };
  const makeEngine = () =>
    new MitigationAutoEngine({
      sampling: { maxAgeMs: 45000, maxGapMs: 45000 },
      globalMode: 'AUTO',
      evaluationScope: 'OPERATIONAL',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['fake-device'] },
      executionControl: { enabled: false },
      targets: { list: async () => [target] },
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
          commands++;
          throw Error('FORBIDDEN WRITE');
        },
      },
      onBlockedActivation: async (decision) => {
        sent.push(decision);
        return ack();
      },
      now: () => new Date(clock),
    });
  let engine = makeEngine();
  const tick = async (bps: bigint | null, seconds = 5, identity?: number) => {
    clock += seconds * 1000;
    if (bps !== null)
      traffic.push(
        target.profileId,
        bps,
        'sample-' + (identity ?? clock),
        new Date(identity ?? clock),
      );
    const decisions = await engine.tick();
    await engine.settleDetectionAlerts();
    return decisions[0]!;
  };
  return {
    tick,
    sent,
    repository,
    target,
    commands: () => commands,
    engine: () => engine,
    restart: () => {
      engine = makeEngine();
    },
    now: () => clock,
    burst: async (count = 4, bps = (BW * 95n) / 100n) => {
      for (let i = 0; i < count; i++) await tick(bps);
    },
    recover: async () => {
      for (let i = 0; i < 12; i++) await tick(BW / 10n);
    },
  };
}
describe('CODEX independent: episodes, retries and process restart limits', () => {
  it('uses bps and a strict greater-than threshold', async () => {
    const h = scenario();
    await h.burst(5, 9_000_000_000n);
    expect(h.sent).toHaveLength(0);
    await h.burst();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.thresholdBps).toBe('9000000000');
    expect(h.commands()).toBe(0);
  });
  it('duplicate and stale samples do not recover or create another episode', async () => {
    const h = scenario();
    await h.burst();
    const id = h.sent[0]!.episodeId;
    for (let i = 0; i < 4; i++) await h.tick(BW / 10n, 1, BASE + 20000);
    await h.tick(null, 60);
    expect(h.engine().activeDetectionEpisodes()[0]?.episodeId).toBe(id);
    expect(h.sent).toHaveLength(1);
  });
  it('one prolonged attack sends one alert until positive recovery', async () => {
    const h = scenario();
    await h.burst(100);
    expect(h.sent).toHaveLength(1);
    expect(h.commands()).toBe(0);
    await h.recover();
    expect(h.engine().activeDetectionEpisodes()).toHaveLength(0);
    await h.burst();
    expect(h.engine().activeDetectionEpisodes()[0]?.episodeId).not.toBe(h.sent[0]?.episodeId);
  });
  it('retries keep episodeId stable and never fabricate verified/mitigated', async () => {
    let attempts = 0;
    const h = scenario(async () => ({ delivered: ++attempts >= 2 }));
    await h.burst(12);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.episodeId).toBe(h.sent[0]?.episodeId);
    expect(h.sent.every((d) => d.verified === false && d.outcome === 'WOULD_ACTIVATE')).toBe(true);
    expect(h.commands()).toBe(0);
  });
  it('documents the in-memory restart limit: new process can re-emit the same attack', async () => {
    const h = scenario();
    await h.burst();
    const id = h.sent[0]?.episodeId;
    h.restart();
    await h.burst();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.episodeId).not.toBe(id);
  });
  it('does not discard an undelivered attack when recovery completes', async () => {
    let available = false;
    const h = scenario(async () => ({ delivered: available }));
    await h.burst();
    await h.recover();
    available = true;
    for (let i = 0; i < 12; i++) await h.tick(BW / 10n, 10);
    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.at(-1)?.episodeId).toBe(h.sent[0]?.episodeId);
    expect(h.engine().activeDetectionEpisodes()).toHaveLength(0);
  });
  it('retries during missing telemetry without inventing another detection', async () => {
    let attempts = 0;
    const h = scenario(async () => ({ delivered: ++attempts > 1 }));
    await h.burst();
    const id = h.sent[0]?.episodeId;
    await h.tick(null, 31);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.episodeId).toBe(id);
    expect(h.commands()).toBe(0);
  });
  it('stops retries at the configured default attempt cap', async () => {
    const h = scenario(async () => ({ delivered: false }));
    await h.burst();
    for (let i = 0; i < 16; i++) await h.tick(null, 601);
    expect(h.sent).toHaveLength(12);
    expect(h.commands()).toBe(0);
  });
  it('delivers a rate-limited subsequent episode even after it has recovered', async () => {
    const h = scenario();
    await h.burst();
    await h.recover();
    await h.burst();
    const secondId = h.engine().activeDetectionEpisodes()[0]?.episodeId;
    expect(h.sent).toHaveLength(1);
    await h.recover();
    await h.tick(null, 31 * 60);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.episodeId).toBe(secondId);
    expect(h.sent[1]?.episodeId).not.toBe(h.sent[0]?.episodeId);
  });
  it('expires an undelivered pending notification instead of replaying it indefinitely', async () => {
    const h = scenario(async () => ({ delivered: false }));
    await h.burst();
    await h.tick(null, 7 * 60 * 60);
    expect(h.sent).toHaveLength(1);
    expect(h.commands()).toBe(0);
    expect(h.engine().activeDetectionEpisodes()[0]).toMatchObject({ alertState: 'FAILED' });
  });
});
