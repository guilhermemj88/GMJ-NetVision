import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService, type MitigationCommandDeps } from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import { InMemoryPolicyScopeLock } from './mitigation-policy-lock';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

const RC13 = process.env.CODEX_AUDIT_RC13_BASELINE === 'true';
const NOW = new Date('2026-10-28T20:00:00Z');
const DEVICE = 'codex-fake-device';
const BW = 10_000_000_000n;

/** In-memory physical policy. This port has no network client or real credentials. */
class AuditSsh implements MitigationSshPort {
  active = false;
  reads = 0;
  readonly writes: string[][] = [];
  beforeRead: (() => void) | null = null;
  constructor(readonly policy: string) {}
  configuration() {
    return [
      ...(this.active
        ? [
            `route-policy ${this.policy} deny node 1`,
            ' if-match ip-prefix BOGONS',
            `route-policy ${this.policy} permit node 2`,
            ' if-match ip-prefix PREFIX8to24',
            ' apply extcommunity rt 268568:660 additive',
          ]
        : []),
      `route-policy ${this.policy} permit node 11`,
    ].join('\n');
  }
  async readMitigationConfiguration() {
    this.reads++;
    this.beforeRead?.();
    return {
      routePolicyConfiguration: this.configuration(),
      prefixListConfiguration:
        'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8\nip ip-prefix PREFIX8to24 index 10 permit 192.0.2.0 24',
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    this.reads++;
    return this.configuration();
  }
  async applyMitigationCommands(_host: HostRecord, commands: readonly string[]) {
    this.writes.push([...commands]);
    this.active = !commands.some((c) => c.startsWith('undo route-policy'));
    return { ok: true, output: 'commit accepted by in-memory fake' };
  }
}

async function commandHarness(
  family: 'IPV4' | 'IPV6',
  flag: (() => boolean) | null = () => false,
  liveWrite = true,
) {
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: `PL-CODEX_${family}-IN`,
    interfaceId: 'fake-interface',
    addressFamily: family,
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerAddress: family === 'IPV4' ? '192.0.2.1' : '2001:db8::1', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });
  const ssh = new AuditSsh(profile.policyName);
  const live = new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: liveWrite, allowedDeviceIds: [DEVICE] },
  });
  const mock = new MockMitigationExecutor();
  const host = {
    id: DEVICE,
    hostname: 'FAKE-CODEX',
    displayName: 'FAKE-CODEX',
    sshEnabled: true,
    ssh: { host: '192.0.2.254', port: 22, username: 'in-memory-only' },
  } as unknown as HostRecord;
  const deps: MitigationCommandDeps = {
    repository,
    hosts: { getHost: async () => host },
    executor: mock,
    live,
    scopeLock: new InMemoryPolicyScopeLock(),
    expectedNodes: async () => [11],
    now: () => NOW,
    autoEvidence: async () => true,
    ...(flag ? { autoExecutionEnabled: flag } : {}),
  };
  return { repository, profile, ssh, live, mock, commands: new MitigationCommandService(deps) };
}

describe('CODEX independent: complete manual IPv4/IPv6 operations with M8 off', () => {
  it.each(['IPV4', 'IPV6'] as const)(
    '%s ACTIVATE then REMOVE reaches the real executor through mock SSH',
    async (family) => {
      const flag = vi.fn(() => false);
      const h = await commandHarness(family, flag);
      const activated = await h.commands.execute({
        requestId: 'manual-activate',
        action: 'ACTIVATE',
        profileId: h.profile.id,
      });
      expect(activated).toMatchObject({ ok: true, status: 'ACTIVATED_VERIFIED', verified: true });
      expect(h.ssh.writes).toHaveLength(1);
      expect(h.ssh.active).toBe(true);
      expect(h.ssh.writes[0]).toContain('commit');
      expect(h.ssh.writes[0]!.join('\n')).not.toContain('local-preference');
      expect((await h.repository.getRuntime(h.profile.id))?.state).toBe('MITIGATED');
      const removed = await h.commands.execute({
        requestId: 'manual-remove',
        action: 'REMOVE',
        profileId: h.profile.id,
      });
      expect(removed).toMatchObject({ ok: true, status: 'REMOVED_VERIFIED', verified: true });
      expect(h.ssh.writes).toHaveLength(2);
      expect(h.ssh.active).toBe(false);
      expect((await h.repository.getRuntime(h.profile.id))?.state).toBe('NORMAL');
      expect(h.mock.calls).toHaveLength(0);
      expect(flag).not.toHaveBeenCalled();
    },
  );
  it('shared policy requires scope confirmation and synchronizes sibling runtime', async () => {
    const h = await commandHarness('IPV4');
    const sibling = await h.repository.upsertProfile({
      deviceId: DEVICE,
      policyName: h.profile.policyName,
      interfaceId: 'fake-sibling',
      addressFamily: 'IPV4',
      detectedBandwidthBps: BW,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.upsertRuntime(sibling.id, { state: 'NORMAL' });
    await h.commands.execute({
      requestId: 'manual-shared-activate',
      action: 'ACTIVATE',
      profileId: h.profile.id,
    });
    expect((await h.repository.getRuntime(sibling.id))?.state).toBe('MITIGATED');
    const count = h.ssh.writes.length;
    const denied = await h.commands.execute({
      requestId: 'manual-unconfirmed',
      action: 'REMOVE',
      profileId: h.profile.id,
    });
    expect(denied.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(h.ssh.writes).toHaveLength(count);
    const removed = await h.commands.execute({
      requestId: 'manual-confirmed',
      action: 'REMOVE',
      profileId: h.profile.id,
      acknowledgeScopeRemoval: true,
    });
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.ssh.active).toBe(false);
    expect((await h.repository.getRuntime(sibling.id))?.state).toBe('NORMAL');
  });
});

describe.skipIf(RC13)(
  'CODEX independent M8: all automatic markers/actions/families and dependency failures',
  () => {
    for (const family of ['IPV4', 'IPV6'] as const)
      for (const action of ['ACTIVATE', 'REMOVE'] as const)
        for (const marker of ['origin', 'prefix', 'evidence'] as const)
          for (const gate of ['off', 'missing', 'throw'] as const) {
            it(`${family} ${action}, marker=${marker}, gate=${gate}: zero mutating SSH`, async () => {
              const flag =
                gate === 'missing'
                  ? null
                  : gate === 'throw'
                    ? () => {
                        throw new Error('unavailable gate');
                      }
                    : () => false;
              const h = await commandHarness(family, flag);
              h.ssh.active = action === 'REMOVE';
              const result = await h.commands.execute({
                requestId: marker === 'prefix' ? 'auto-activate-codex-1' : 'audit-' + marker,
                action,
                profileId: h.profile.id,
                ...(marker === 'origin' ? { origin: 'AUTO' as const } : {}),
                ...(marker === 'evidence'
                  ? { autoEvidence: { sampleAt: NOW.toISOString(), continuityKey: 'fake' } }
                  : {}),
              });
              expect(result).toMatchObject({
                ok: false,
                status: 'AUTO_EXECUTION_DISABLED',
                verified: false,
              });
              expect(h.ssh.writes).toHaveLength(0);
              expect(h.mock.calls).toHaveLength(0);
            });
          }
    it.each(['ACTIVATE', 'REMOVE'] as const)(
      '%s: ACTIVATE rechecks M8 after preflight; REMOVE is forbidden before preflight',
      async (action) => {
        let enabled = true;
        const h = await commandHarness('IPV4', () => enabled);
        h.ssh.active = action === 'REMOVE';
        h.ssh.beforeRead = () => {
          enabled = false;
        };
        const result = await h.commands.execute({
          requestId: 'codex-race',
          action,
          profileId: h.profile.id,
          origin: 'AUTO',
        });
        expect(result.status).toBe(
          action === 'REMOVE' ? 'AUTO_REMOVE_FORBIDDEN' : 'AUTO_EXECUTION_DISABLED',
        );
        if (action === 'REMOVE') expect(enabled).toBe(true);
        expect(h.ssh.writes).toHaveLength(0);
      },
    );
  },
);

const target = (over: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState => ({
  profileId: 'codex-auto',
  deviceId: DEVICE,
  policyName: 'PL-CODEX_IPv4-IN',
  interfaceId: 'fake-interface',
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
  ...over,
});
async function engineWrites(
  options: {
    promoted?: boolean;
    legacy?: boolean;
    allowed?: boolean;
    mode?: 'AUTO' | 'SIMULATION_ONLY';
    liveWrite?: boolean;
  } = {},
) {
  const repository = new InMemoryMitigationRepository();
  const traffic = new SequenceTrafficSource();
  let writes = 0;
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 45000, maxGapMs: 45000 },
    globalMode: options.mode ?? 'AUTO',
    evaluationScope: 'OPERATIONAL',
    execution: {
      executor: 'HUAWEI',
      liveWrite: options.liveWrite ?? true,
      allowedDeviceIds: [DEVICE],
    },
    executionControl: {
      enabled: false,
      allowedProfileIds: options.allowed ? ['codex-auto'] : [],
      legacyExemptProfileIds: options.legacy ? ['codex-auto'] : [],
    },
    targets: { list: async () => [target({ autoPromotedBySweep: options.promoted ?? false })] },
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
        writes++;
        return { ok: false, status: 'FAKE', verified: false };
      },
    },
    now: () => NOW,
  });
  let last: Awaited<ReturnType<typeof engine.tick>> = [];
  for (let i = 0; i < 4; i++) {
    traffic.push('codex-auto', (BW * 95n) / 100n);
    last = await engine.tick();
  }
  return { writes, last };
}
describe('CODEX independent engine and rollback guards', () => {
  for (const promoted of [false, true])
    for (const legacy of [false, true])
      for (const allowed of [false, true])
        it(`M8 off, promoted=${promoted}, legacy=${legacy}, allowlisted=${allowed}`, async () => {
          const r = await engineWrites({ promoted, legacy, allowed });
          if (RC13 && !promoted) expect(r.writes).toBeGreaterThan(0);
          else {
            expect(r.writes).toBe(0);
            expect(r.last[0]?.reason).toBe('AUTO_EXECUTION_DISABLED');
          }
        });
  it.each([{ mode: 'SIMULATION_ONLY' as const }, { liveWrite: false }])(
    'independent rollback barrier %j prevents manual-origin AUTO dispatch',
    async (barrier) => {
      const r = await engineWrites(barrier);
      expect(r.writes).toBe(0);
    },
  );
  it.each(['ACTIVATE', 'REMOVE'] as const)(
    'LIVE_WRITE=false blocks %s in the actual Huawei executor, preserving physical policy',
    async (action) => {
      const h = await commandHarness('IPV4', () => false, false);
      h.ssh.active = action === 'REMOVE';
      const active = h.ssh.active;
      const r = await h.commands.execute({
        requestId: 'manual-frozen',
        action,
        profileId: h.profile.id,
      });
      expect(r.verified).toBe(false);
      expect(r.safeError).toContain('MITIGATION_WRITE_DISABLED');
      expect(h.ssh.writes).toHaveLength(0);
      expect(h.ssh.active).toBe(active);
      expect(h.mock.calls).toHaveLength(0);
    },
  );
});
