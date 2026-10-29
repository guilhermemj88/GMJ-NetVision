import { describe, it, expect, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import {
  AutoMitigationLifecycle,
  lifecycleConfig,
  scopeKey,
  type LifecycleTarget,
  type ScopeOwnership,
  type JournalCommand,
} from './auto-lifecycle';
import { MemoryAutomationStore } from './automation-store';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';
import { InMemoryMitigationRepository } from '../../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationCommandDeps,
} from '../../infrastructure/bgp/mitigation/mitigation-command-service';
import {
  HuaweiMitigationExecutor,
  type MitigationSshPort,
} from '../../infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { MockMitigationExecutor } from '../../infrastructure/bgp/mitigation/mitigation-executor';
import { InMemoryPolicyScopeLock } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { MitigationAutoEngine, type MitigationAutoDecision } from './mitigation-auto-engine';
import type { MitigationTrafficSample } from './mitigation-traffic-source';
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';
import { recoveryMappings, independentRecoveryProof } from './auto-recovery-proof';

const BW = 10_000_000_000n;
class FakeSsh implements MitigationSshPort {
  active = false;
  writes: string[][] = [];
  failWrite = false;
  diverge = false;
  failRead = false;
  beforePreflight: (() => void) | null = null;
  config() {
    return [
      ...(this.active
        ? [
            `route-policy PL-TEST_IPv4-IN deny node 1`,
            ' if-match ip-prefix BOGONS',
            `route-policy PL-TEST_IPv4-IN permit node 2`,
            ' if-match ip-prefix PREFIX8to24',
            ' apply extcommunity rt 268568:660 additive',
          ]
        : []),
      'route-policy PL-TEST_IPv4-IN permit node 11',
    ].join('\n');
  }
  async readMitigationConfiguration() {
    this.beforePreflight?.();
    if (this.failRead) throw Error('read timeout');
    return {
      routePolicyConfiguration: this.config(),
      prefixListConfiguration:
        'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8\nip ip-prefix PREFIX8to24 index 10 permit 192.0.2.0 24',
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    if (this.failRead) throw Error('read timeout');
    return this.diverge ? 'route-policy PL-TEST_IPv4-IN permit node 11' : this.config();
  }
  async applyMitigationCommands(_h: HostRecord, commands: readonly string[]) {
    this.writes.push([...commands]);
    this.active = !commands.some((c) => c.startsWith('undo route-policy'));
    if (this.failWrite) throw Error('SSH timeout after commit');
    return { ok: true, output: 'fake only' };
  }
}
async function harness() {
  let now = Date.parse('2026-10-29T15:00:00Z');
  const store = new MemoryAutomationStore(),
    repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: 'fake-device',
    policyName: 'PL-TEST_IPv4-IN',
    interfaceId: 'client-if',
    addressFamily: 'IPV4',
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
    mode: 'AUTO',
  });
  await repository.replaceProfilePeers(profile.id, [{ peerAddress: '192.0.2.1', primary: true }]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });
  const t: LifecycleTarget = {
    enabled: true,
    profileId: profile.id,
    deviceId: profile.deviceId,
    policyName: profile.policyName,
    interfaceId: profile.interfaceId,
    customer: 'OFFLINE',
    mode: 'AUTO',
    addressFamily: 'IPV4',
    direction: 'tx',
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
    recoverySamples: 3,
    rt: '268568:660',
    scopeMembers: 1,
    fast: true,
    otherFamilyAuto: false,
    recoveryProofKey: 'dedicated-offered-traffic',
  };
  const config = {
    ...lifecycleConfig({}),
    installation: 'IMPLANTAR',
    enabled: true,
    executionEnabled: true,
    removeEnabled: true,
    profiles: [profile.id],
    devices: [profile.deviceId],
    minHoldMs: 60_000,
    recoveryMs: 10_000,
    cooldownMs: 60_000,
  };
  const ssh = new FakeSsh();
  const host = {
    id: profile.deviceId,
    hostname: 'FAKE',
    sshEnabled: true,
    ssh: { host: '192.0.2.254', port: 22, username: 'fake' },
  } as unknown as HostRecord;
  const live = new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [profile.deviceId] },
  });
  let proof: MitigationTrafficSample | null = null;
  let lifecycle: AutoMitigationLifecycle;
  const physical = vi.fn(async () => {
    if (ssh.failRead) throw Error('fake read timeout');
    return {
      state: ssh.active ? ('MITIGATED' as const) : ('NORMAL' as const),
      bogon: ssh.active ? 1 : null,
      mitigation: ssh.active ? 2 : null,
      rt: ssh.active ? t.rt : null,
    };
  });
  const deps: MitigationCommandDeps = {
    repository,
    hosts: { getHost: async () => host },
    live,
    executor: new MockMitigationExecutor(),
    scopeLock: new InMemoryPolicyScopeLock(),
    expectedNodes: async () => [11],
    now: () => new Date(now),
    autoExecutionEnabled: () => config.executionEnabled,
    autoEvidence: async () => true,
    requireAutomaticAuthorization: true,
    autoWriteAuthorization: (i, p) => lifecycle.authorize(i, p),
    beforeManualWrite: (d, p) => lifecycle.manualMutation(d, p),
  };
  const commands = new MitigationCommandService(deps);
  const create = () =>
    new AutoMitigationLifecycle({
      store,
      config: () => config,
      target: async () => t,
      execute: (i) => commands.execute(i),
      physical,
      recoveryProof: async () => proof,
      now: () => now,
    });
  lifecycle = create();
  const decision = (traffic = 100_000_000n): MitigationAutoDecision => ({
    at: new Date(now).toISOString(),
    sampleAt: new Date(now).toISOString(),
    profileId: t.profileId,
    deviceId: t.deviceId,
    customer: t.customer,
    outcome: 'NO_ACTION',
    reason: null,
    trafficBps: traffic.toString(),
    thresholdBps: '9000000000',
    recoveryThresholdBps: '7000000000',
    samplesOver: 0,
    samplesBelow: 0,
    requiredSamples: 3,
    runtimeState: 'MITIGATED',
    sharedPolicy: false,
    direction: 'tx',
    requestId: null,
    commandStatus: null,
    verified: false,
    notification: null,
    detail: null,
    episodeId: 'engine-episode-1',
  });
  const advance = (ms: number) => {
    now += ms;
  };
  const sample = (bps = 100_000_000n) => {
    proof = {
      bps,
      sampleKey: String(now),
      occurredAt: new Date(now),
      continuityKey: t.recoveryProofKey!,
    };
  };
  const activate = () =>
    lifecycle.activate({
      profileId: t.profileId,
      autoEvidence: { sampleAt: new Date(now).toISOString(), continuityKey: 'fast-revision' },
    });
  const recover = async () => {
    advance(60_000);
    for (let i = 0; i < 3; i++) {
      sample();
      await lifecycle.observe(decision());
      advance(5000);
    }
  };
  const scope = () => store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t)));
  return {
    t,
    store,
    repository,
    config,
    ssh,
    commands,
    deps,
    physical,
    advance,
    sample,
    decision,
    activate,
    recover,
    scope,
    get lifecycle() {
      return lifecycle;
    },
    restart: async () => {
      lifecycle = create();
      await lifecycle.reconcile();
    },
    loseProof: () => {
      proof = null;
    },
    now: () => now,
  };
}

describe('durable AUTO lifecycle: real command service + Huawei executor, fake SSH only', () => {
  it('existing active reservation on another scope exhausts the global AUTO budget', async () => {
    const h = await harness();
    await h.store.transaction((tx) => tx.put('other', 'scope', 'ACTIVE', { phase: 'ACTIVE' }));
    expect((await h.activate()).status).toBe('AUTO_CAPACITY_OR_SCOPE_BUSY');
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('idempotent manual ACTIVATE relinquishes ownership without removing the policy', async () => {
    const h = await harness();
    await h.activate();
    await h.commands.execute({
      requestId: 'operator-takes-ownership',
      action: 'ACTIVATE',
      profileId: h.t.profileId,
    });
    expect((await h.scope())?.phase).toBe('MANUAL');
    await h.recover();
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('real engine detects three fresh FAST samples, activates through canonical transport and recovers', async () => {
    const h = await harness();
    let bps = 9_500_000_000n;
    const source = {
      sample: async () => bps,
      sampleWithId: async () => ({
        bps,
        sampleKey: String(h.now()),
        occurredAt: new Date(h.now()),
        continuityKey: 'fast-revision',
      }),
    };
    const engine = new MitigationAutoEngine({
      sampling: { maxAgeMs: 15000, maxGapMs: 15000 },
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [h.t.deviceId] },
      executionControl: { enabled: true, allowedProfileIds: [h.t.profileId] },
      targets: {
        list: async () => [
          { ...h.t, runtimeState: (await h.repository.getRuntime(h.t.profileId))!.state },
        ],
      },
      traffic: source,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: (id) => h.repository.getRuntime(id),
        save: async (id, patch) => {
          await h.repository.upsertRuntime(id, patch);
        },
      },
      commands: { execute: (i) => h.lifecycle.activate(i) },
      now: () => new Date(h.now()),
    });
    for (let i = 0; i < 3; i++) {
      h.advance(5000);
      await engine.tick();
    }
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    h.advance(60000);
    bps = 100_000_000n;
    for (let i = 0; i < 3; i++) {
      h.sample();
      for (const d of await engine.tick()) await h.lifecycle.observe(d);
      h.advance(5000);
    }
    expect(h.ssh.writes).toHaveLength(2);
    expect((await h.scope())?.phase).toBe('COOLDOWN');
  });
  it('AUTO cannot adopt a pre-existing physical manual mitigation even with stale NORMAL runtime', async () => {
    const h = await harness();
    h.ssh.active = true;
    await h.activate();
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    await h.recover();
    expect(h.ssh.writes).toHaveLength(0);
    expect(h.ssh.active).toBe(true);
  });
  it('ACTIVATE, fresh independent recovery, REMOVE, readbacks and two durable notifications', async () => {
    const h = await harness();
    expect(await h.activate()).toMatchObject({
      ok: true,
      verified: true,
      status: 'ACTIVATED_VERIFIED',
    });
    expect((await h.scope())?.phase).toBe('ACTIVE');
    await h.recover();
    expect(h.ssh.writes).toHaveLength(2);
    expect(h.ssh.active).toBe(false);
    expect((await h.scope())?.phase).toBe('COOLDOWN');
    const alerts = await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(alerts.map((a) => a.event)).toEqual([
      'MITIGATION_VERIFIED',
      'MITIGATION_REMOVED_VERIFIED',
    ]);
    expect(alerts.every((a) => a.payload.verified === true)).toBe(true);
    expect(await h.activate()).toMatchObject({ ok: false, status: 'AUTO_CAPACITY_OR_SCOPE_BUSY' });
  });
  it.each(['VNT', 'FIBINET', ''])('installation %s cannot write', async (installation) => {
    const h = await harness();
    h.config.installation = installation;
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it.each(['enabled', 'executionEnabled'] as const)(
    '%s off prevents ACTIVATE and REMOVE without touching physical mitigation',
    async (flag) => {
      const h = await harness();
      h.config[flag] = false;
      await h.activate();
      expect(h.ssh.writes).toHaveLength(0);
      h.config[flag] = true;
      await h.activate();
      h.config[flag] = false;
      await h.recover();
      expect(h.ssh.writes).toHaveLength(1);
      expect(h.ssh.active).toBe(true);
    },
  );
  it('REMOVE flag off leaves active policy intact', async () => {
    const h = await harness();
    await h.activate();
    h.config.removeEnabled = false;
    await h.recover();
    expect(h.ssh.writes).toHaveLength(1);
  });
  it.each([
    { scopeMembers: 2 },
    { sharedPolicy: true },
    { otherFamilyAuto: true },
    { direction: 'rx' as const },
    { fast: false },
    { bogonNode: 0 },
    { mitigationExcluded: true },
    { readiness: 'NOT_READY' as const },
    { effectiveBandwidthBps: 0n },
    { recoveryPercent: 90 },
    { recoverySamples: 1 },
  ])('rejects unsafe target %#', async (patch) => {
    const h = await harness();
    Object.assign(h.t, patch);
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it.each(['profiles', 'devices'] as const)('explicit %s allowlist is mandatory', async (key) => {
    const h = await harness();
    h.config[key] = [];
    await h.activate();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('rejects missing/stale/future activation evidence', async () => {
    const h = await harness();
    for (const at of [null, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'])
      expect(
        (
          await h.lifecycle.activate({
            profileId: h.t.profileId,
            ...(at ? { autoEvidence: { sampleAt: at, continuityKey: 'x' } } : {}),
          })
        ).ok,
      ).toBe(false);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('global capacity and same-scope concurrent attempts reserve only once', async () => {
    const h = await harness();
    const results = await Promise.all([h.activate(), h.activate(), h.activate()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('manual mitigation is never adopted and removed', async () => {
    const h = await harness();
    await h.commands.execute({
      requestId: 'operator',
      action: 'ACTIVATE',
      profileId: h.t.profileId,
    });
    await h.recover();
    expect(h.ssh.writes).toHaveLength(1);
    expect(await h.scope()).toBeNull();
  });
  it('manual command revokes AUTO ownership under canonical policy lock', async () => {
    const h = await harness();
    await h.activate();
    await h.commands.execute({
      requestId: 'operator-remove',
      action: 'REMOVE',
      profileId: h.t.profileId,
    });
    expect((await h.scope())?.phase).toBe('MANUAL');
    await h.recover();
    expect(h.ssh.writes).toHaveLength(2);
  });
  it('cannot remove solely because diverted client TX is low', async () => {
    const h = await harness();
    await h.activate();
    h.advance(60_000);
    for (let i = 0; i < 20; i++) {
      await h.lifecycle.observe(h.decision());
      h.advance(5000);
    }
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('duplicates do not accumulate recovery samples', async () => {
    const h = await harness();
    await h.activate();
    h.advance(60_000);
    h.sample();
    for (let i = 0; i < 20; i++) await h.lifecycle.observe(h.decision());
    expect((await h.scope())?.below).toBe(1);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('stale/missing proof resets recovery without false normalization', async () => {
    const h = await harness();
    await h.activate();
    h.advance(60_000);
    h.sample();
    await h.lifecycle.observe(h.decision());
    h.advance(16000);
    await h.lifecycle.observe(h.decision());
    expect((await h.scope())?.below).toBe(0);
    h.loseProof();
    await h.lifecycle.observe(h.decision());
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('missing/stale client telemetry also blocks recovery', async () => {
    const h = await harness();
    await h.activate();
    h.advance(60000);
    for (let i = 0; i < 4; i++) {
      h.sample();
      const d = h.decision();
      d.trafficBps = null;
      await h.lifecycle.observe(d);
      h.advance(5000);
    }
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('flapping or a telemetry gap restarts the recovery sequence', async () => {
    const h = await harness();
    await h.activate();
    h.advance(60000);
    h.sample();
    await h.lifecycle.observe(h.decision());
    h.advance(5000);
    h.sample(8_000_000_000n);
    await h.lifecycle.observe(h.decision());
    expect((await h.scope())?.below).toBe(0);
    h.advance(5000);
    h.sample();
    await h.lifecycle.observe(h.decision());
    h.advance(20000);
    h.sample();
    await h.lifecycle.observe(h.decision());
    expect((await h.scope())?.below).toBe(1);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('minimum hold prevents premature removal despite normal samples', async () => {
    const h = await harness();
    await h.activate();
    for (let i = 0; i < 6; i++) {
      h.advance(5000);
      h.sample();
      await h.lifecycle.observe(h.decision());
    }
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('high telemetry appearing DURING REMOVE preflight prevents SSH write', async () => {
    const h = await harness();
    await h.activate();
    h.ssh.beforePreflight = () => h.sample(9_900_000_000n);
    await h.recover();
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
  });
  it('failed readback before removal preserves policy', async () => {
    const h = await harness();
    await h.activate();
    h.ssh.failRead = true;
    await h.recover();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
  });
  it('configuration changes or divergent physical ownership require reconciliation', async () => {
    const h = await harness();
    await h.activate();
    h.t.rt = '268568:661';
    await h.recover();
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('verified ACTIVE survives restart after actual readback without replay', async () => {
    const h = await harness();
    await h.activate();
    await h.restart();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(h.physical).toHaveBeenCalledOnce();
    await h.recover();
    expect(h.ssh.writes).toHaveLength(2);
  });
  it.each(['ACTIVATING', 'REMOVING'] as const)(
    'restart during %s never replays ambiguous command',
    async (phase) => {
      const h = await harness();
      await h.activate();
      await h.store.transaction(async (tx) => {
        const s = (await tx.get<ScopeOwnership>(scopeKey(h.t)))!;
        s.phase = phase;
        await tx.put(s.key, 'scope', phase, s);
      });
      await h.restart();
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      await h.recover();
      expect(h.ssh.writes).toHaveLength(1);
    },
  );
  it('SSH timeout after partial write keeps uncertainty and never retries blindly', async () => {
    const h = await harness();
    h.ssh.failWrite = true;
    expect((await h.activate()).ok).toBe(false);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    await h.restart();
    await h.activate();
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('readback divergence never fabricates verified success', async () => {
    const h = await harness();
    h.ssh.diverge = true;
    await h.activate();
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    const events = await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(events[0]?.payload.verified).toBe(false);
  });
  it('missing or failed durable authorization blocks before every mutating SSH', async () => {
    const h = await harness();
    h.deps.autoWriteAuthorization = async () => {
      throw Error('DB failure');
    };
    await h.activate();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('kill switch is checked again after async durable authorization', async () => {
    const h = await harness();
    const original = h.deps.autoWriteAuthorization!;
    h.deps.autoWriteAuthorization = async (i, p) => {
      const result = await original(i, p);
      h.config.executionEnabled = false;
      return result;
    };
    await h.activate();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('command authorization is single use across restart', async () => {
    const h = await harness();
    await h.activate();
    const s = (await h.scope())!;
    expect(
      await h.lifecycle.authorize(
        {
          requestId: s.operationId,
          autoOperationId: s.operationId,
          action: 'ACTIVATE',
          profileId: h.t.profileId,
          origin: 'AUTO',
        },
        { bogonNode: 1, mitigationNode: 2 },
      ),
    ).toBe(false);
    expect((await h.store.transaction((tx) => tx.get<JournalCommand>(s.operationId)))?.state).toBe(
      'VERIFIED',
    );
  });
});

const notice = (
  id: string,
  event: MitigationNotification['event'] = 'MITIGATION_DETECTION_BLOCKED',
): MitigationNotification => ({
  event,
  eventId: id,
  profileId: 'p',
  simulation: false,
  verified: false,
  customer: 'OFFLINE',
  device: 'FAKE',
  interfaceName: 'test',
  peer: null,
  affectedPeers: [],
  detectedBandwidthBps: null,
  bandwidthOverrideBps: null,
  effectiveBandwidthBps: BW,
  trafficBps: BW,
  thresholdBps: 9_000_000_000n,
  policy: 'PL-TEST',
  node: 2,
  rt: '268568:660',
});
describe('persistent outbox and episodes', () => {
  it('future backlog cannot starve verified removal notifications', async () => {
    const store = new MemoryAutomationStore();
    const sent: string[] = [];
    const q = new DurableMitigationOutbox(
      store,
      {
        publish: async (n) => {
          sent.push(n.eventId!);
          return { published: true, skipped: false };
        },
      },
      () => 1000,
    );
    await store.transaction(async (tx) => {
      for (let i = 0; i < 1001; i++) {
        const n = notice('future-' + i),
          id = 'outbox:' + n.event + ':' + n.eventId;
        await tx.put(id, 'outbox', 'PENDING', {
          id,
          profileId: 'p',
          event: n.event,
          payload: {},
          state: 'PENDING',
          attempts: 0,
          nextAt: 999999,
          lease: null,
          leaseUntil: 0,
          deliveredAt: null,
          error: null,
        } satisfies OutboxEntry);
      }
    });
    await q.publish(notice('remove-first', 'MITIGATION_REMOVED_VERIFIED'));
    await q.drain();
    expect(sent).toEqual(['remove-first']);
  });
  it('abandoned SENDING lease survives restart and is reclaimed only on expiry', async () => {
    const store = new MemoryAutomationStore();
    let now = 1000,
      calls = 0;
    const q = new DurableMitigationOutbox(
      store,
      {
        publish: async () => {
          calls++;
          return { published: true, skipped: false };
        },
      },
      () => now,
    );
    await q.publish(notice('leased'));
    await store.transaction(async (tx) => {
      const id = 'outbox:MITIGATION_DETECTION_BLOCKED:leased',
        r = (await tx.get<OutboxEntry>(id))!;
      r.state = 'SENDING';
      r.lease = 'crashed-worker';
      r.leaseUntil = 61000;
      await tx.put(id, 'outbox', 'SENDING', r);
    });
    await q.drain();
    expect(calls).toBe(0);
    now = 61001;
    await q.drain();
    expect(calls).toBe(1);
  });
  it('stable event identity, retry after restart and ACK receipt, without BigInt loss', async () => {
    const store = new MemoryAutomationStore();
    let now = 1000;
    const seen: MitigationNotification[] = [];
    let delivered = false;
    const sender = {
      publish: async (n: MitigationNotification) => {
        seen.push(n);
        return { published: delivered, skipped: false };
      },
    };
    let q = new DurableMitigationOutbox(store, sender, () => now);
    const n = notice('one');
    expect((await q.publish(n)).published).toBe(false);
    await q.drain();
    q = new DurableMitigationOutbox(store, sender, () => now);
    now += 30000;
    delivered = true;
    await q.drain();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.eventId).toBe(seen[1]?.eventId);
    expect(seen[1]?.trafficBps).toBe(BW);
    expect((await q.publish(n)).published).toBe(true);
    await q.drain();
    expect(seen).toHaveLength(2);
  });
  it('concurrent drainers lease a notification only once', async () => {
    const store = new MemoryAutomationStore();
    const send = vi.fn(async () => ({ published: true, skipped: false }));
    const a = new DurableMitigationOutbox(store, { publish: send });
    const b = new DurableMitigationOutbox(store, { publish: send });
    await a.publish(notice('concurrent'));
    await Promise.all([a.drain(), b.drain()]);
    expect(send).toHaveBeenCalledOnce();
  });
  it('delivery rate limit persists across restart and preserves pending newer episode', async () => {
    const store = new MemoryAutomationStore();
    let now = 0;
    const send = vi.fn(async () => ({ published: true, skipped: false }));
    let q = new DurableMitigationOutbox(store, { publish: send }, () => now);
    await q.publish(notice('first'));
    await q.drain();
    await q.publish(notice('second'));
    q = new DurableMitigationOutbox(store, { publish: send }, () => now);
    await q.drain();
    expect(send).toHaveBeenCalledOnce();
    now += 30 * 60000;
    await q.drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('bounded retries retain failed evidence for operator review', async () => {
    const store = new MemoryAutomationStore();
    let now = 0;
    const q = new DurableMitigationOutbox(
      store,
      {
        publish: async () => {
          throw Error('timeout');
        },
      },
      () => now,
    );
    await q.publish(notice('fail'));
    for (let i = 0; i < 12; i++) {
      await q.drain();
      now += 600000;
    }
    const row = await store.transaction((tx) =>
      tx.get<OutboxEntry>('outbox:MITIGATION_DETECTION_BLOCKED:fail'),
    );
    expect(row).toMatchObject({ state: 'FAILED', attempts: 12 });
  });
  it('database transaction failures cannot retain partial ownership', async () => {
    const store = new MemoryAutomationStore();
    await expect(
      store.transaction(async (tx) => {
        await tx.put('x', 'scope', 'ACTIVE', { id: 1 });
        throw Error('transaction rollback');
      }),
    ).rejects.toThrow();
    expect(await store.transaction((tx) => tx.get('x'))).toBeNull();
  });
  it('episode identity survives restart and closes only with positive new recovery', async () => {
    const h = await harness();
    const ids: string[] = [];
    const build = async (d: MitigationAutoDecision) => {
      ids.push(d.episodeId!);
      return { ...notice(d.episodeId!), profileId: h.t.profileId };
    };
    await h.lifecycle.detection({ ...h.decision(), episodeId: 'engine-after-restart' }, build);
    await h.restart();
    await h.lifecycle.detection(h.decision(), build);
    expect(ids[0]).toBe(ids[1]);
    h.advance(60000);
    for (let i = 0; i < 3; i++) {
      await h.lifecycle.observe(h.decision());
      h.advance(5000);
    }
    await h.lifecycle.detection(h.decision(), build);
    expect(ids[2]).toBe(ids[0]); // old delivery retry after positive recovery
    await h.lifecycle.detection({ ...h.decision(), episodeId: 'new-attack' }, build);
    expect(ids[3]).not.toBe(ids[0]);
  });
});

describe('independent recovery counter adapter', () => {
  it('rejects malformed or ambiguous configuration', () => {
    expect(() => recoveryMappings('{}')).toThrow();
    expect(() =>
      recoveryMappings(
        '[{"profileId":"p","interfaceId":"i","direction":"rx"},{"profileId":"p","interfaceId":"j","direction":"tx"}]',
      ),
    ).toThrow();
  });
  it('requires separate UP/usable interface and preserves bps units', async () => {
    const h = await harness();
    const mappings = recoveryMappings(
      JSON.stringify([{ profileId: h.t.profileId, interfaceId: 'offered-if', direction: 'rx' }]),
    );
    h.t.recoveryProofKey = mappings.get(h.t.profileId)!.key;
    const now = Date.now();
    const row = {
      interfaceId: 'offered-if',
      deviceId: h.t.deviceId,
      rxBps: 1234567,
      txBps: 9,
      timestamp: new Date(now),
      rateStartAt: new Date(now - 5000),
      usable: true,
      adminStatus: 'UP',
      operStatus: 'UP',
      currentOperStatus: 'UP',
    };
    const reader = { latestTraffic: async () => row };
    expect((await independentRecoveryProof(h.t, mappings, reader, now))?.bps).toBe(1234567n);
    row.usable = false;
    expect(await independentRecoveryProof(h.t, mappings, reader, now)).toBeNull();
    row.usable = true;
    row.deviceId = 'other';
    expect(await independentRecoveryProof(h.t, mappings, reader, now)).toBeNull();
  });
});
