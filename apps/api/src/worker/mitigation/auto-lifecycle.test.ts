import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerN8nRoutes } from '../../n8n-routes';
import type { HostRecord } from '@gmj/shared';
import {
  AutoMitigationLifecycle,
  lifecycleConfig,
  scopeKey,
  type LifecycleTarget,
  type ScopeOwnership,
  type JournalCommand,
} from './auto-lifecycle';
import { resolveAutoClientBinding } from './auto-client-binding';
import { MemoryAutomationStore } from './automation-store';
import {
  testDurableBaselineStore,
  testPermanentClientNode,
} from '../../infrastructure/bgp/mitigation/mitigation-test-support';
import { GenericPhysicalDisplays } from '../../testing/physical-bgp-simulator';
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
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';

const BW = 10_000_000_000n;
const PREFIX_LISTS =
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8\nip ip-prefix PREFIX8to24 index 10 permit 192.0.2.0 24';
class FakeSsh implements MitigationSshPort {
  active = false;
  writes: string[][] = [];
  reads = 0;
  failWrite = false;
  failRead = false;
  diverge = false;
  ignoreRemove = false;
  baselineManual = false;
  beforePreflight: (() => void) | null = null;
  config() {
    return [
      ...(this.active
        ? [
            'route-policy PL-TEST_IPv4-IN deny node 1',
            ' if-match ip-prefix BOGONS',
            'route-policy PL-TEST_IPv4-IN permit node 2',
            ' if-match ip-prefix PREFIX8to24',
            ' apply local-preference 1100',
            ' apply extcommunity rt 268568:660',
          ]
        : []),
      // Node permanente do cliente elegivel ao contrato do node 2 (lista + LP + RT 140).
      ...testPermanentClientNode('PL-TEST_IPv4-IN', { node: 11 }),
      // Node do OPERADOR depois do node do cliente: nunca adotado nem removido pelo REMOVE.
      ...(this.baselineManual
        ? ['route-policy PL-TEST_IPv4-IN deny node 50', ' if-match ip-prefix OPERATOR-ONLY']
        : []),
    ].join('\n');
  }
  private displays: GenericPhysicalDisplays | null = null;
  async readMitigationDisplays(_h: HostRecord, commands: readonly string[]) {
    this.displays ??= new GenericPhysicalDisplays({
      policyName: 'PL-TEST_IPv4-IN',
      customerPeers: ['192.0.2.1'],
      routePolicy: () => this.config(),
      prefixLists: () => PREFIX_LISTS,
      mitigated: () => this.active,
    });
    return this.displays.read([...commands]);
  }
  async readMitigationConfiguration() {
    this.reads++;
    this.beforePreflight?.();
    if (this.failRead) throw Error('read timeout');
    return {
      routePolicyConfiguration: this.config(),
      prefixListConfiguration: PREFIX_LISTS,
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    this.reads++;
    if (this.failRead) throw Error('read timeout');
    return this.diverge ? 'route-policy PL-TEST_IPv4-IN permit node 11' : this.config();
  }
  async applyMitigationCommands(_h: HostRecord, commands: readonly string[]) {
    this.writes.push([...commands]);
    const remove = commands.some((c) => c.startsWith('undo route-policy'));
    if (!remove || !this.ignoreRemove) this.active = !remove;
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
  const iface = {
    id: 'client-if',
    name: 'Eth-Trunk1.100',
    ifIndex: 100,
    description: 'FAKE-IP_10GB',
    alias: null,
    adminStatus: 'UP',
    operStatus: 'UP',
  };
  const host = {
    id: profile.deviceId,
    hostname: 'FAKE',
    interfaces: [iface],
    sshEnabled: true,
    ssh: { host: '192.0.2.254', port: 22, username: 'fake' },
  } as unknown as HostRecord;
  const bindingInput = {
    profileId: profile.id,
    deviceId: profile.deviceId,
    interfaceId: profile.interfaceId,
    customer: 'FAKE-IP',
    direction: 'tx' as const,
    detectedBandwidthBps: BW,
    bandwidthOverrideBps: null,
  };
  const t: LifecycleTarget = {
    enabled: true,
    profileId: profile.id,
    deviceId: profile.deviceId,
    policyName: profile.policyName,
    interfaceId: profile.interfaceId,
    customer: 'FAKE-IP',
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
    clientBinding: resolveAutoClientBinding(bindingInput, {
      id: profile.deviceId,
      interfaces: [iface],
    }),
  };
  const config = {
    ...lifecycleConfig({}),
    installation: 'IMPLANTAR',
    enabled: true,
    executionEnabled: true,
    profiles: [profile.id],
    devices: [profile.deviceId],
    cooldownMs: 60000,
  };
  const ssh = new FakeSsh(),
    live = new HuaweiMitigationExecutor({
      ssh,
      config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [profile.deviceId] },
      // B6: escrita real exige armazenamento duravel do baseline.
      baseline: testDurableBaselineStore(),
    });
  let lifecycle: AutoMitigationLifecycle,
    commands: MitigationCommandService,
    engine: MitigationAutoEngine | undefined;
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
    expectedNodes: async () => (ssh.baselineManual ? [11, 50] : [11]),
    now: () => new Date(now),
    autoExecutionEnabled: () => config.executionEnabled,
    autoEvidence: async () => true,
    requireAutomaticAuthorization: true,
    autoWriteAuthorization: (i, p) => lifecycle.authorize(i, p),
    manualCommands: {
      begin: (i, s) => lifecycle.beginManual(i, s.deviceId, s.policyName),
      authorize: (i) => lifecycle.authorizeManual(i),
      complete: (i, r, real) => lifecycle.completeManual(i, r, real),
    },
    afterAutomaticCommand: (i, r, real) => lifecycle.completeActivation(i, r, real),
    onScopeRemoved: async (scope) => {
      engine?.forgetProfiles(scope.profileIds);
    },
  };
  const create = () => {
    commands = new MitigationCommandService(deps);
    lifecycle = new AutoMitigationLifecycle({
      store,
      config: () => config,
      target: async () => t,
      execute: (i) => commands.execute(i),
      physical,
      now: () => now,
    });
  };
  create();
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
    runtimeState: 'NORMAL',
    sharedPolicy: false,
    direction: 'tx',
    requestId: null,
    commandStatus: null,
    verified: false,
    notification: null,
    detail: null,
    episodeId: 'engine-episode-1',
  });
  const activate = (start = now - 10000) =>
    lifecycle.activate({
      profileId: t.profileId,
      autoEvidence: {
        sampleAt: new Date(now).toISOString(),
        continuityKey: 'fast-revision',
        sequenceStartedAt: new Date(start).toISOString(),
        samplesOver: 3,
      },
    });
  const scope = () => store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t)));
  const manual = (id = 'manual-remove') =>
    commands.execute({ requestId: id, action: 'REMOVE', profileId: t.profileId });
  return {
    t,
    store,
    repository,
    config,
    ssh,
    deps,
    physical,
    iface,
    bindingInput,
    host,
    decision,
    activate,
    scope,
    manual,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    get lifecycle() {
      return lifecycle;
    },
    get commands() {
      return commands;
    },
    restart: async () => {
      create();
      await lifecycle.reconcile();
    },
    attachEngine: () => {
      let bps = 9_500_000_000n;
      engine = new MitigationAutoEngine({
        sampling: { maxAgeMs: 15000, maxGapMs: 15000 },
        globalMode: 'AUTO',
        execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [t.deviceId] },
        executionControl: { enabled: true, allowedProfileIds: [t.profileId] },
        targets: {
          list: async () => [
            { ...t, runtimeState: (await repository.getRuntime(t.profileId))!.state },
          ],
        },
        traffic: {
          sample: async () => bps,
          sampleWithId: async () => ({
            bps,
            sampleKey: String(now),
            occurredAt: new Date(now),
            continuityKey: 'fast-revision',
          }),
        },
        exclusions: { listPeerExclusions: async () => [] },
        runtime: {
          get: (id) => repository.getRuntime(id),
          save: async (id, patch) => {
            await repository.upsertRuntime(id, patch);
          },
        },
        commands: {
          execute: async (i) => {
            const result = await lifecycle.activate(i);
            if (['AUTO_COOLDOWN_ACTIVE', 'AUTO_NEW_EPISODE_REQUIRED'].includes(result.status ?? ''))
              engine?.forgetProfiles([i.profileId]);
            return result;
          },
        },
        now: () => new Date(now),
      });
      return {
        set: (value: bigint) => {
          bps = value;
        },
        tick: async () => {
          now += 5000;
          for (const d of await engine!.tick()) await lifecycle.observe(d);
        },
      };
    },
  };
}

describe('AUTO ACTIVATE + MANUAL REMOVE: canonical executor with fake SSH only', () => {
  it('real engine -> three samples -> ACTIVATE -> indefinite hold -> manual REMOVE -> cooldown -> new episode', async () => {
    const h = await harness(),
      e = h.attachEngine();
    for (let i = 0; i < 3; i++) await e.tick();
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    e.set(0n);
    for (let i = 0; i < 20; i++) await e.tick();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
    expect(await h.manual()).toMatchObject({
      ok: true,
      verified: true,
      status: 'REMOVED_VERIFIED',
    });
    expect((await h.scope())?.phase).toBe('COOLDOWN');
    e.set(9_500_000_000n);
    for (let i = 0; i < 10; i++) await e.tick();
    expect(h.ssh.writes).toHaveLength(2);
    for (let i = 0; i < 10; i++) await e.tick();
    expect(h.ssh.writes).toHaveLength(3);
    const notices = await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(notices.map((n) => n.event)).toEqual([
      'MITIGATION_VERIFIED',
      'MITIGATION_REMOVED_VERIFIED',
      'MITIGATION_VERIFIED',
    ]);
    expect(notices.every((n) => n.payload.verified)).toBe(true);
  });
  it('zero, stale, missing and repeated telemetry never removes even after 100 hours', async () => {
    const h = await harness();
    await h.activate();
    for (let i = 0; i < 100; i++) {
      h.advance(3600000);
      await h.lifecycle.observe({
        ...h.decision(0n),
        sampleAt: i % 2 ? null : new Date(h.now()).toISOString(),
        trafficBps: i % 3 ? null : '0',
      });
    }
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
  });
  it.each([
    { origin: 'AUTO' as const },
    { requestId: 'auto-remove-forbidden' },
    { autoEvidence: { sampleAt: '2026-10-29T15:00:00Z', continuityKey: 'x' } },
    { autoOperationId: 'old-remove-intent' },
  ])('rejects every AUTO REMOVE marker before SSH even with M8 enabled: %j', async (marker) => {
    const h = await harness();
    const r = await h.commands.execute({
      requestId: 'remove-marker',
      action: 'REMOVE',
      profileId: h.t.profileId,
      ...marker,
    });
    expect(r.status).toBe('AUTO_REMOVE_FORBIDDEN');
    expect(h.ssh.writes).toHaveLength(0);
    expect(h.ssh.reads).toBe(0);
  });
  it('cannot authorize legacy automatic REMOVE journal', async () => {
    const h = await harness();
    expect(
      await h.lifecycle.authorize(
        {
          requestId: 'auto-remove-old',
          action: 'REMOVE',
          profileId: h.t.profileId,
          origin: 'AUTO',
          autoOperationId: 'old',
        },
        { bogonNode: 1, mitigationNode: 2 },
      ),
    ).toBe(false);
  });
  it.each(['VNT', 'FIBINET', ''])('installation %s cannot activate', async (installation) => {
    const h = await harness();
    h.config.installation = installation;
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it.each([
    { scopeMembers: 2 },
    { sharedPolicy: true },
    { otherFamilyAuto: true },
    { direction: 'rx' as const },
    { fast: false },
    { bogonNode: 2 },
    { mitigationExcluded: true },
    { readiness: 'BLOCKED' as const },
    { clientBinding: null },
    { effectiveBandwidthBps: 0n },
    { triggerSamples: 0 },
  ])('rejects unsafe target %#', async (patch) => {
    const h = await harness();
    Object.assign(h.t, patch);
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it.each(['profiles', 'devices'] as const)('requires explicit %s allowlist', async (key) => {
    const h = await harness();
    h.config[key] = [];
    expect((await h.activate()).status).toBe('AUTO_NOT_ALLOWLISTED');
    expect(h.ssh.writes).toHaveLength(0);
  });
  it("'*' autoriza o escopo AUTO-ALL sem perder os demais gates", async () => {
    const wildcard = await harness();
    wildcard.config.profiles = ['*'];
    expect((await wildcard.activate()).ok).toBe(true);

    // O curinga NAO autoriza outro device: a allowlist de equipamento continua.
    const otherDevice = await harness();
    otherDevice.config.profiles = ['*'];
    otherDevice.config.devices = ['device-nao-autorizado'];
    expect((await otherDevice.activate()).status).toBe('AUTO_NOT_ALLOWLISTED');
    expect(otherDevice.ssh.writes).toHaveLength(0);
  });
  it('does not repeat activation while active, including after restart', async () => {
    const h = await harness();
    await h.activate();
    await h.activate();
    await h.restart();
    await h.activate();
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
  });
  it('runtime NORMAL cannot adopt physically existing manual mitigation', async () => {
    const h = await harness();
    h.ssh.active = true;
    expect((await h.activate()).status).toBe('AUTO_PHYSICAL_SCOPE_NOT_NORMAL');
    expect(h.ssh.writes).toHaveLength(0);
    expect(await h.scope()).toBeNull();
  });
  it('physical read failure blocks activation', async () => {
    const h = await harness();
    h.ssh.failRead = true;
    expect((await h.activate()).status).toBe('AUTO_PHYSICAL_READ_FAILED');
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('a physical read failure reports its SAFE classified cause and reserves/persists nothing (retry stays possible)', async () => {
    const h = await harness();
    h.physical.mockRejectedValueOnce(new Error('ACTIVATION_SNAPSHOT_SSH_FAILED:SSH_UNREACHABLE'));
    const failed = await h.activate();
    expect(failed.status).toBe('AUTO_PHYSICAL_READ_FAILED'); // status unchanged: same fail-closed contract
    expect(failed.ok).toBe(false);
    expect(failed.safeError).toBe(
      'AUTO_PHYSICAL_READ_FAILED:ACTIVATION_SNAPSHOT_SSH_FAILED:SSH_UNREACHABLE',
    );
    expect(h.ssh.writes).toHaveLength(0);
    expect(await h.scope()).toBeNull(); // nothing reserved: no scope, no command, no quarantine...
    // ...so a LEGITIMATE next attempt (equipment reachable again) is not blocked by the earlier failure
    const next = await h.activate();
    expect(next.status).toBe('ACTIVATED_VERIFIED');
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('an unclassified or sensitive physical-read error text never reaches the result', async () => {
    const h = await harness();
    for (const raw of [
      'connect ECONNREFUSED 10.200.1.1:22 password=hunter2 user=netvision',
      'ssh: handshake failed',
      '',
    ]) {
      h.physical.mockRejectedValueOnce(new Error(raw));
      const failed = await h.activate();
      expect(failed.status).toBe('AUTO_PHYSICAL_READ_FAILED');
      expect(failed.safeError).toBe('AUTO_PHYSICAL_READ_FAILED:UNCLASSIFIED');
      expect(JSON.stringify(failed)).not.toMatch(/hunter2|netvision|10\.200\.1\.1|ECONNREFUSED/);
    }
    h.physical.mockRejectedValueOnce('not even an Error');
    expect((await h.activate()).safeError).toBe('AUTO_PHYSICAL_READ_FAILED:UNCLASSIFIED');
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('manual REMOVE preserves operator nodes and local-preference without adopting them', async () => {
    const h = await harness();
    h.ssh.baselineManual = true;
    await h.activate();
    expect(await h.manual()).toMatchObject({ ok: true, verified: true });
    expect(h.ssh.config()).toContain('node 50');
    expect(h.ssh.config()).toContain('OPERATOR-ONLY');
    expect(h.ssh.writes.flat().filter((c) => c.startsWith('undo route-policy'))).toEqual(
      expect.arrayContaining([
        'undo route-policy PL-TEST_IPv4-IN node 1',
        'undo route-policy PL-TEST_IPv4-IN node 2',
      ]),
    );
    expect(h.ssh.writes.flat().join('\n')).not.toContain(
      'undo route-policy PL-TEST_IPv4-IN node 50',
    );
  });
  it('verified manual removal releases ownership but requires entirely new post-cooldown evidence', async () => {
    const h = await harness();
    await h.activate();
    await h.manual();
    const old = h.now();
    expect((await h.activate()).status).toBe('AUTO_COOLDOWN_ACTIVE');
    h.advance(61000);
    expect((await h.activate(old)).status).toBe('AUTO_NEW_EPISODE_REQUIRED');
    expect((await h.activate(h.now())).ok).toBe(true);
  });
  it('manual command receipt survives restart without repeating SSH or extending cooldown', async () => {
    const h = await harness();
    await h.activate();
    await h.manual();
    const before = await h.scope();
    await h.restart();
    h.advance(30000);
    expect(await h.manual()).toMatchObject({ ok: true, idempotent: true });
    expect(h.ssh.writes).toHaveLength(2);
    expect((await h.scope())?.cooldownUntil).toBe(before?.cooldownUntil);
  });
  it('readback divergence after manual REMOVE does not release ownership', async () => {
    const h = await harness();
    await h.activate();
    h.ssh.ignoreRemove = true;
    expect((await h.manual()).verified).toBe(false);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    h.advance(3600000);
    expect((await h.activate()).ok).toBe(false);
  });
  it('manual SSH timeout never replays uncertain command after restart', async () => {
    const h = await harness();
    await h.activate();
    h.ssh.failWrite = true;
    await h.manual();
    await h.restart();
    expect((await h.manual()).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(h.ssh.writes).toHaveLength(2);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
  });
  it('manual ACTIVATE is held indefinitely and legitimate REMOVE still works with M8 off', async () => {
    const h = await harness();
    h.config.executionEnabled = false;
    expect((await h.activate()).ok).toBe(false);
    expect(
      (
        await h.commands.execute({
          requestId: 'manual-activate',
          action: 'ACTIVATE',
          profileId: h.t.profileId,
        })
      ).verified,
    ).toBe(true);
    h.advance(9999999);
    await h.lifecycle.observe(h.decision(0n));
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.manual()).verified).toBe(true);
    expect((await h.scope())?.phase).toBe('COOLDOWN');
  });
  it('observe resolves the target through the per-tick resolver (O(N) bookkeeping), not a fresh listing', async () => {
    const h = await harness();
    const calls: string[] = [];
    const resolver = async (profileId: string) => {
      calls.push(profileId);
      return null;
    };
    await h.lifecycle.observe(h.decision(0n), resolver);
    await h.lifecycle.observe(h.decision(0n), resolver);
    expect(calls).toEqual([h.t.profileId, h.t.profileId]);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('observe with the per-tick resolver is state-equivalent to the fresh resolver (episode bookkeeping)', async () => {
    const fresh = await harness();
    const memo = await harness();
    const open = (id: string) => ({ id: 'episode-1', profileId: id, closed: false, below: 0, lastSample: null });
    for (const h of [fresh, memo])
      await h.store.transaction((tx) => tx.put('episode-current:' + h.t.profileId, 'episode', 'OPEN', open(h.t.profileId)));
    const resolver = async () => ({ ...memo.t, runtimeState: 'NORMAL' as const });
    // low traffic, stale, missing and reordered samples: identical bookkeeping on both paths
    for (let i = 0; i < 20; i++) {
      for (const h of [fresh, memo]) h.advance(5000);
      const mk = (h: typeof fresh) => ({
        ...h.decision(i % 7 === 3 ? 9_500_000_000n : 100_000_000n),
        sampleAt: i % 5 === 4 ? null : new Date(h.now() - (i % 6 === 5 ? 60000 : 0)).toISOString(),
      });
      await fresh.lifecycle.observe(mk(fresh));
      await memo.lifecycle.observe(mk(memo), resolver);
    }
    const read = (h: typeof fresh) =>
      h.store.transaction((tx) => tx.get('episode-current:' + h.t.profileId));
    const a = await read(fresh);
    const b = await read(memo);
    expect(a).toBeTruthy();
    expect({ ...(b as object), profileId: 'x' }).toEqual({ ...(a as object), profileId: 'x' });
    expect(memo.ssh.writes).toHaveLength(fresh.ssh.writes.length);
  });
  it('global capacity serializes concurrent activations', async () => {
    const h = await harness();
    const results = await Promise.all([h.activate(), h.activate()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it.each(['ACTIVE', 'MANUAL', 'UNCERTAIN'])(
    'another %s scope exhausts AUTO budget',
    async (phase) => {
      const h = await harness();
      await h.store.transaction((tx) => tx.put('other', 'scope', phase, { phase }));
      expect((await h.activate()).status).toBe('AUTO_CAPACITY_OR_SCOPE_BUSY');
      expect(h.ssh.writes).toHaveLength(0);
    },
  );
  it.each(['ACTIVATING', 'REMOVING'] as const)(
    'restart quarantines legacy/interrupted %s without write',
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
      expect(h.ssh.writes).toHaveLength(1);
    },
  );
  it('ACTIVATE timeout remains uncertain without fabricated verified notification', async () => {
    const h = await harness();
    h.ssh.failWrite = true;
    await h.activate();
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(
      (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'))).every(
        (n) => n.payload.verified === false,
      ),
    ).toBe(true);
  });
  it('M8 flipping off immediately before write blocks transport', async () => {
    const h = await harness();
    h.ssh.beforePreflight = () => {
      h.config.executionEnabled = false;
    };
    await h.activate();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('slow preflight cannot consume expired activation evidence', async () => {
    const h = await harness();
    h.ssh.beforePreflight = () => {
      h.advance(16000);
    };
    await h.activate();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('a corrupted runtime REMOVE flag cannot create an automatic withdrawal path', async () => {
    const h = await harness();
    await h.activate();
    Object.assign(h.config, { removeEnabled: true });
    for (let i = 0; i < 20; i++) {
      h.advance(15000);
      await h.lifecycle.observe(h.decision(0n));
    }
    await h.restart();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
  });
  it('manual journal authorization failure blocks write', async () => {
    const h = await harness();
    h.deps.manualCommands!.authorize = async () => false;
    await h.manual();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('result transaction failure blocks rearm and leaves uncertain durable intent', async () => {
    const h = await harness();
    await h.activate();
    h.deps.manualCommands!.complete = async () => {
      throw Error('database unavailable');
    };
    expect((await h.manual()).ok).toBe(false);
    await h.restart();
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(2);
  });
  it('missing or failing telemetry revalidation is fail-closed even with journal authorization', async () => {
    for (const check of [
      undefined,
      async () => {
        throw Error('no telemetry');
      },
    ]) {
      const h = await harness();
      if (check) h.deps.autoEvidence = check;
      else delete h.deps.autoEvidence;
      await h.activate();
      expect(h.ssh.writes).toHaveLength(0);
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
    }
  });
  it('restart between manual write intent and result never replays or rearms', async () => {
    const h = await harness();
    await h.activate();
    const input = {
      requestId: 'interrupted-manual',
      action: 'REMOVE' as const,
      profileId: h.t.profileId,
    };
    await h.lifecycle.beginManual(input, h.t.deviceId, h.t.policyName!);
    expect(await h.lifecycle.authorizeManual(input)).toBe(true);
    await h.restart();
    expect((await h.commands.execute(input)).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    h.advance(3600000);
    expect((await h.activate()).ok).toBe(false);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('existing manual journal cannot be reused for another action', async () => {
    const h = await harness();
    await h.activate();
    await h.manual('same-id');
    await h.restart();
    expect(
      (
        await h.commands.execute({
          requestId: 'same-id',
          action: 'ACTIVATE',
          profileId: h.t.profileId,
        })
      ).status,
    ).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(h.ssh.writes).toHaveLength(2);
  });
  it('shared scope needs a fresh Telegram token and Bearer; a boolean cannot authorize withdrawal', async () => {
    const h = await harness();
    await h.activate();
    const other = await h.repository.upsertProfile({
      deviceId: h.t.deviceId,
      policyName: h.t.policyName!,
      interfaceId: 'other-if',
      addressFamily: 'IPV4',
      detectedBandwidthBps: BW,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.upsertRuntime(other.id, {
      state: 'MITIGATED',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });
    const app = Fastify();
    registerN8nRoutes(app, { commands: h.commands, commandToken: 'fake-inbound-only' });
    await app.ready();
    try {
      const body = { requestId: 'telegram-remove', action: 'REMOVE', profileId: h.t.profileId };
      const post = (payload: object, authorized = true) =>
        app.inject({
          method: 'POST',
          url: '/api/integrations/n8n/mitigation-command',
          payload,
          headers: authorized
            ? { authorization: 'Bearer fake-inbound-only' }
            : { 'X-NetVision-Token': 'fake-inbound-only' },
        });
      expect((await post(body, false)).statusCode).toBe(401);
      expect((await post({ ...body, acknowledgeScopeRemoval: true })).statusCode).toBe(400);
      const blocked = (await post(body)).json();
      expect(blocked.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
      expect(h.ssh.writes).toHaveLength(1);
      expect((await h.scope())?.phase).toBe('MANUAL');
      const result = (
        await post({
          ...body,
          requestId: 'telegram-confirm',
          scopeConfirmationToken: blocked.scopeConfirmation.token,
        })
      ).json();
      expect(result).toMatchObject({ ok: true, verified: true, status: 'REMOVED_VERIFIED' });
      expect((await h.scope())?.phase).toBe('COOLDOWN');
      expect(h.ssh.writes).toHaveLength(2);
      const journal = await h.store.transaction((tx) => tx.list<JournalCommand>('command'));
      expect(JSON.stringify(journal)).not.toContain(blocked.scopeConfirmation.token);
      expect(JSON.stringify(journal)).not.toContain('fake-inbound-only');
    } finally {
      await app.close();
    }
  });
});

describe('Eth-Trunk identity and removal policy', () => {
  it.each([undefined, '1', 'true', 'false', 'yes'])(
    'production requires literal REMOVE=0, rejects %s',
    (value) => {
      expect(() =>
        lifecycleConfig({
          NETVISION_INSTALLATION_ID: 'IMPLANTAR',
          NODE_ENV: 'production',
          MITIGATION_AUTO_REMOVE_ENABLED: value,
        }),
      ).toThrow('MUST_BE_0');
    },
  );
  it('REMOVE=0 is accepted and defaults AUTO off', () => {
    expect(
      lifecycleConfig({
        NETVISION_INSTALLATION_ID: 'IMPLANTAR',
        NODE_ENV: 'production',
        MITIGATION_AUTO_REMOVE_ENABLED: '0',
      }),
    ).toMatchObject({ removeEnabled: false, enabled: false, executionEnabled: false });
  });
  it('binds client description and contracted bandwidth, ignoring physical trunk capacity', async () => {
    const h = await harness();
    expect(h.t.clientBinding).toMatchObject({
      interfaceName: 'Eth-Trunk1.100',
      ifIndex: 100,
      customer: 'FAKE-IP',
      direction: 'tx',
      detectedBandwidthBps: BW.toString(),
    });
  });
  it.each(['MITIG-IP_10GB', 'SCRUB-IP_10GB', 'UPLINK-IP_10GB', 'NO-BANDWIDTH'])(
    'rejects inappropriate source %s',
    async (description) => {
      const h = await harness();
      expect(
        resolveAutoClientBinding(h.bindingInput, {
          id: h.t.deviceId,
          interfaces: [{ ...h.iface, description }],
        }),
      ).toBeNull();
    },
  );
  it.each([{ name: '100GE1/0/1' }, { operStatus: 'DOWN' }, { ifIndex: 0 }])(
    'rejects unsafe source identity %j',
    async (patch) => {
      const h = await harness();
      expect(
        resolveAutoClientBinding(h.bindingInput, {
          id: h.t.deviceId,
          interfaces: [{ ...h.iface, ...patch }],
        }),
      ).toBeNull();
    },
  );
  it('ambiguous duplicate interface name, wrong device or mismatched bandwidth cannot bind', async () => {
    const h = await harness();
    expect(
      resolveAutoClientBinding(h.bindingInput, {
        id: h.t.deviceId,
        interfaces: [h.iface, { ...h.iface, id: 'duplicate' }],
      }),
    ).toBeNull();
    expect(
      resolveAutoClientBinding(h.bindingInput, { id: 'wrong', interfaces: [h.iface] }),
    ).toBeNull();
    expect(
      resolveAutoClientBinding(
        { ...h.bindingInput, detectedBandwidthBps: BW * 2n },
        { id: h.t.deviceId, interfaces: [h.iface] },
      ),
    ).toBeNull();
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
