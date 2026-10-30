import { createHash, randomUUID } from 'node:crypto';
import type {
  MitigationAutoDecision,
  MitigationAutoTargetState,
  MitigationAutoCommandResult,
} from './mitigation-auto-engine';
import type {
  MitigationCommandInput,
  MitigationActionResult,
} from '../../infrastructure/bgp/mitigation/mitigation-command-service';
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';
import type { AutomationStore, AutomationTx } from './automation-store';
import type { ClientBinding } from './auto-client-binding';
import { enqueueNotification } from './durable-mitigation-outbox';
import type { MitigationTrafficSource } from './mitigation-traffic-source';
import {
  SINGLE_AUTO_PILOT,
  assertSinglePilotAuthorization,
  singlePilotIdentityMatches,
  nextPilotSequence,
  type PilotSequence,
} from './single-pilot-trigger';

export interface LifecycleConfig {
  installation: string;
  enabled: boolean;
  executionEnabled: boolean;
  removeEnabled: false;
  profiles: readonly string[];
  devices: readonly string[];
  maxActive: number;
  cooldownMs: number;
  maxAgeMs: number;
  maxGapMs: number;
}
export interface LifecycleTarget extends MitigationAutoTargetState {
  enabled: boolean;
  rt: string;
  scopeMembers: number;
  fast: boolean;
  otherFamilyAuto: boolean;
  clientBinding: ClientBinding | null;
}
export function lifecycleConfig(env: Record<string, string | undefined>): LifecycleConfig {
  const removal = env.MITIGATION_AUTO_REMOVE_ENABLED?.trim();
  const production =
    env.NETVISION_INSTALLATION_ID === 'IMPLANTAR' &&
    (env.NODE_ENV === 'production' ||
      env.MITIGATION_AUTO_LIFECYCLE_ENABLED === '1' ||
      env.MITIGATION_AUTO_PERSISTENCE_ENABLED === '1');
  if ((removal !== undefined && removal !== '0') || (production && removal !== '0'))
    throw Error('MITIGATION_AUTO_REMOVE_ENABLED_MUST_BE_0');
  const flag = (k: string) => /^(1|true)$/i.test(env[k]?.trim() ?? '');
  const list = (k: string) =>
    (env[k] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const max = Number(env.MITIGATION_AUTO_MAX_ACTIVE),
    cooldown = Number(env.MITIGATION_AUTO_COOLDOWN_SECONDS);
  return {
    installation: env.NETVISION_INSTALLATION_ID ?? '',
    enabled: flag('MITIGATION_AUTO_LIFECYCLE_ENABLED'),
    executionEnabled: flag('MITIGATION_AUTO_EXECUTION_ENABLED'),
    removeEnabled: false,
    profiles: list('MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS'),
    devices: list('MITIGATION_ALLOWED_DEVICE_IDS'),
    maxActive: Number.isInteger(max) && max >= 1 && max <= 10 ? max : 1,
    cooldownMs: Number.isInteger(cooldown) && cooldown >= 60 ? cooldown * 1000 : 600_000,
    maxAgeMs: 15000,
    maxGapMs: 15000,
  };
}
export function scopeKey(t: Pick<LifecycleTarget, 'deviceId' | 'policyName'>) {
  return (
    'scope:' +
    createHash('sha256')
      .update(JSON.stringify([t.deviceId, t.policyName]))
      .digest('hex')
  );
}
export function targetRevision(t: LifecycleTarget) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        t.profileId,
        t.deviceId,
        t.policyName,
        t.interfaceId,
        t.addressFamily,
        t.direction,
        t.rt,
        t.bogonNode,
        t.mitigationNode,
        t.effectiveBandwidthBps?.toString(),
        t.triggerPercent,
        t.triggerSamples,
        [...t.peerAddresses].sort(),
        t.configurationKey ?? null,
        t.clientBinding?.key ?? null,
      ]),
    )
    .digest('hex');
}
export interface ScopeOwnership {
  key: string;
  profileId: string;
  owner: string;
  revision: string;
  // REMOVING is a legacy quarantine state only; this version cannot create it.
  phase: 'ACTIVATING' | 'ACTIVE' | 'REMOVING' | 'COOLDOWN' | 'UNCERTAIN' | 'MANUAL';
  target: {
    deviceId: string;
    policy: string;
    family: string;
    rt: string;
    bogon: number;
    mitigation: number;
  };
  activatedAt: number;
  cooldownUntil: number;
  lastSample: number | null;
  operationId: string;
  reason: string | null;
  removedAt?: number;
}
export interface JournalCommand {
  id: string;
  scope: string;
  action: 'ACTIVATE' | 'REMOVE';
  origin: 'AUTO' | 'MANUAL';
  state: 'PLANNED' | 'STARTED' | 'VERIFIED' | 'UNCERTAIN' | 'REJECTED';
  result: MitigationActionResult | null;
  at: number;
  requestId?: string;
  profileId?: string;
  deviceId?: string;
  policyName?: string;
}
interface Episode {
  id: string;
  profileId: string;
  closed: boolean;
  lastSample: number | null;
  below: number;
  at: number;
}
export interface LifecycleDeps {
  /** The existing FAST reader; supplied only for the single-client production path. */
  pilotTraffic?: Pick<MitigationTrafficSource, 'sampleWithId'>;
  store: AutomationStore;
  config: () => LifecycleConfig;
  target: (id: string) => Promise<LifecycleTarget | null>;
  execute: (input: MitigationCommandInput) => Promise<MitigationActionResult>;
  physical: (target: LifecycleTarget) => Promise<{
    state: 'NORMAL' | 'MITIGATED' | 'UNKNOWN';
    bogon: number | null;
    mitigation: number | null;
    rt: string | null;
  }>;
  now?: () => number;
}
const rejected = (reason: string): MitigationAutoCommandResult => ({
  ok: false,
  verified: false,
  status: reason,
  safeError: reason,
});
const manualKey = (id: string) => 'manual-command:' + createHash('sha256').update(id).digest('hex');

/** AUTO ACTIVATE only. No timer, observation or restart can dispatch REMOVE. */
export class AutoMitigationLifecycle {
  private readonly now: () => number;
  private pilotSequence: PilotSequence | null = null;
  private pilotReconciled = false;
  private pilotRunning = false;
  private pilotAcceptAfter = 0;
  private pilotView: {
    state: 'IDLE' | 'ACTIVATING' | 'ACTIVE' | 'UNCERTAIN';
    reason: string | null;
  } = { state: 'UNCERTAIN', reason: 'RECONCILIATION_REQUIRED' };
  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }
  pilotStatus() {
    return this.deps.pilotTraffic ? { ...this.pilotView } : null;
  }
  forgetProfiles(ids: readonly string[]): void {
    if (ids.includes(SINGLE_AUTO_PILOT.profileId)) this.pilotSequence = null;
  }

  /** One tick in the existing runtime, not another worker or Huawei executor. */
  async tickPilot(): Promise<MitigationAutoDecision[]> {
    if (!this.deps.pilotTraffic || this.pilotRunning) return [];
    this.pilotRunning = true;
    let t: LifecycleTarget | null = null;
    const decision = (
      reason: string | null,
      outcome: MitigationAutoDecision['outcome'] = 'BLOCKED',
      traffic: bigint | null = null,
      sampleAt?: number,
    ): MitigationAutoDecision[] => {
      const d: MitigationAutoDecision = {
        at: new Date(this.now()).toISOString(),
        profileId: SINGLE_AUTO_PILOT.profileId,
        deviceId: SINGLE_AUTO_PILOT.deviceId,
        customer: t?.customer ?? null,
        outcome,
        reason: outcome === 'BLOCKED' ? 'TARGET_BLOCKED' : null,
        detail: reason,
        trafficBps: traffic?.toString() ?? null,
        thresholdBps: SINGLE_AUTO_PILOT.thresholdBps.toString(),
        recoveryThresholdBps: null,
        samplesOver: this.pilotSequence?.over ?? 0,
        samplesBelow: 0,
        requiredSamples: 3,
        runtimeState: t?.runtimeState ?? null,
        sharedPolicy: t?.sharedPolicy ?? false,
        direction: 'tx',
        requestId: null,
        commandStatus: null,
        verified: false,
        notification: null,
        ...(sampleAt === undefined ? {} : { sampleAt: new Date(sampleAt).toISOString() }),
      };
      return [d];
    };
    try {
      if (!this.pilotReconciled) return decision('RECONCILIATION_REQUIRED');
      assertSinglePilotAuthorization(this.deps.config());
      t = await this.deps.target(SINGLE_AUTO_PILOT.profileId);
      if (!t) {
        this.pilotSequence = null;
        return decision('AUTO_TARGET_MISSING');
      }
      const owned = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t!)));
      if (owned && owned.phase !== 'COOLDOWN') {
        this.pilotSequence = null;
        this.pilotView = {
          state:
            owned.phase === 'ACTIVE' ||
            (owned.phase === 'MANUAL' && owned.reason === 'MANUAL_ACTIVATE_VERIFIED')
              ? 'ACTIVE'
              : owned.phase === 'ACTIVATING'
                ? 'ACTIVATING'
                : 'UNCERTAIN',
          reason: owned.reason,
        };
        return decision(owned.reason ?? 'OWNERSHIP_HELD', 'NO_ACTION');
      }
      const blocked = this.allowed(t);
      if (blocked || (owned && owned.cooldownUntil > this.now())) {
        this.pilotSequence = null;
        this.pilotAcceptAfter = this.now();
        this.pilotView = { state: 'IDLE', reason: blocked ?? 'AUTO_COOLDOWN_ACTIVE' };
        return decision(this.pilotView.reason);
      }
      if (t.runtimeState !== 'NORMAL' && t.runtimeState !== 'ALERT_ONLY') {
        this.pilotSequence = null;
        this.pilotView = { state: 'UNCERTAIN', reason: 'RUNTIME_REQUIRES_RECONCILIATION' };
        return decision(this.pilotView.reason);
      }
      const sample = await this.deps.pilotTraffic.sampleWithId({
        profileId: t.profileId,
        deviceId: t.deviceId,
        interfaceId: t.interfaceId,
        bandwidthBps: t.effectiveBandwidthBps,
        ...(t.configurationKey === undefined ? {} : { configurationKey: t.configurationKey }),
      });
      if (
        sample?.occurredAt &&
        sample.occurredAt.getTime() <=
          Math.max(this.pilotAcceptAfter, owned?.cooldownUntil ?? 0, owned?.removedAt ?? 0)
      ) {
        this.pilotSequence = this.pilotSequence ? { ...this.pilotSequence, over: 0 } : null;
        return decision('AUTO_NEW_EPISODE_REQUIRED');
      }
      const step = nextPilotSequence(
        this.pilotSequence,
        sample,
        targetRevision(t),
        this.now(),
        this.deps.config().maxAgeMs,
        this.deps.config().maxGapMs,
      );
      this.pilotSequence = step.sequence;
      this.pilotView = { state: 'IDLE', reason: step.reason };
      if (step.reason || !step.sequence || !sample)
        return decision(
          step.reason,
          step.reason === 'TELEMETRY_UNAVAILABLE' ? 'BLOCKED' : 'NO_ACTION',
          sample?.bps ?? null,
          sample?.occurredAt?.getTime(),
        );
      this.pilotView = { state: 'ACTIVATING', reason: null };
      const result = await this.activate({
        profileId: t.profileId,
        autoEvidence: {
          sampleAt: new Date(step.sequence.at).toISOString(),
          continuityKey: step.sequence.key,
          sequenceStartedAt: new Date(step.sequence.start).toISOString(),
          samplesOver: step.sequence.over,
        },
      });
      this.pilotSequence = null;
      if (['AUTO_PHYSICAL_READ_FAILED', 'AUTO_PHYSICAL_SCOPE_NOT_NORMAL'].includes(result.status))
        await this.holdPilotUncertain(t, result.status);
      const after = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t!)));
      const verified = result.ok && result.verified && after?.phase === 'ACTIVE';
      this.pilotView = {
        state: after?.phase === 'ACTIVE' ? 'ACTIVE' : 'UNCERTAIN',
        reason: result.ok && result.verified ? null : result.status,
      };
      const [d] = decision(
        this.pilotView.reason,
        verified ? 'ACTIVATED' : after?.phase === 'ACTIVE' ? 'NO_ACTION' : 'FAILED',
        sample.bps,
        step.sequence.at,
      );
      return [
        {
          ...d!,
          verified,
          requestId: verified ? after.operationId : null,
          commandStatus: result.status,
        },
      ];
    } catch {
      this.pilotSequence = null;
      this.pilotView = { state: 'UNCERTAIN', reason: 'PILOT_DEPENDENCY_UNAVAILABLE' };
      return decision(this.pilotView.reason);
    } finally {
      this.pilotRunning = false;
    }
  }
  private allowed(t: LifecycleTarget): string | null {
    const c = this.deps.config();
    if (this.deps.pilotTraffic && !singlePilotIdentityMatches(t))
      return 'AUTO_SINGLE_PILOT_IDENTITY_MISMATCH';
    if (c.installation !== 'IMPLANTAR' || !c.enabled || !c.executionEnabled)
      return 'AUTO_EXECUTION_DISABLED';
    if (!c.profiles.includes(t.profileId) || !c.devices.includes(t.deviceId))
      return 'AUTO_NOT_ALLOWLISTED';
    if (
      !t.enabled ||
      t.mode !== 'AUTO' ||
      t.mitigationExcluded ||
      !t.snapshotAvailable ||
      t.readiness !== 'READY' ||
      t.prefixStatus !== 'SAFE' ||
      t.blockedReason
    )
      return 'AUTO_TARGET_NOT_READY';
    const b = t.clientBinding;
    if (
      !b ||
      b.profileId !== t.profileId ||
      b.deviceId !== t.deviceId ||
      b.interfaceId !== t.interfaceId ||
      b.customer !== t.customer ||
      b.direction !== t.direction ||
      b.effectiveBandwidthBps !== t.effectiveBandwidthBps?.toString()
    )
      return 'AUTO_CLIENT_BINDING_INVALID';
    if (
      !t.fast ||
      t.direction !== 'tx' ||
      !t.policyName ||
      !t.interfaceId ||
      !t.addressFamily ||
      !t.rt
    )
      return 'AUTO_TELEMETRY_CONTRACT_REQUIRED';
    if (t.scopeMembers !== 1 || t.sharedPolicy || t.otherFamilyAuto) return 'AUTO_SCOPE_UNSAFE';
    if (
      !Number.isInteger(t.bogonNode) ||
      !Number.isInteger(t.mitigationNode) ||
      t.bogonNode! <= 0 ||
      t.mitigationNode! <= 0 ||
      t.bogonNode === t.mitigationNode
    )
      return 'AUTO_PAIR_INVALID';
    if (
      !t.effectiveBandwidthBps ||
      t.effectiveBandwidthBps <= 0n ||
      !Number.isInteger(t.triggerPercent) ||
      t.triggerPercent <= 0 ||
      t.triggerPercent > 100 ||
      !Number.isInteger(t.triggerSamples) ||
      t.triggerSamples < 1
    )
      return 'AUTO_THRESHOLDS_INVALID';
    return null;
  }
  async activate(input: {
    profileId: string;
    autoEvidence?: MitigationCommandInput['autoEvidence'];
  }): Promise<MitigationAutoCommandResult> {
    const t = await this.deps.target(input.profileId);
    if (!t) return rejected('AUTO_TARGET_MISSING');
    const reason = this.allowed(t);
    if (reason) return rejected(reason);
    const e = input.autoEvidence,
      at = Date.parse(e?.sampleAt ?? ''),
      start = Date.parse(e?.sequenceStartedAt ?? '');
    if (
      !e?.continuityKey ||
      !Number.isFinite(at) ||
      at > this.now() ||
      this.now() - at > this.deps.config().maxAgeMs ||
      !Number.isFinite(start) ||
      start > at ||
      !Number.isInteger(e.samplesOver) ||
      e.samplesOver! < t.triggerSamples
    )
      return rejected('AUTO_EVIDENCE_REQUIRED');
    // Check the durable gate before any hardware read. Runtime NORMAL is never
    // accepted as physical evidence and an existing policy is never adopted.
    const prior = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t)));
    const gate = this.activationGate(prior, start);
    if (gate) return rejected(gate);
    let p: Awaited<ReturnType<LifecycleDeps['physical']>>;
    try {
      p = await this.deps.physical(t);
    } catch {
      return rejected('AUTO_PHYSICAL_READ_FAILED');
    }
    if (p.state !== 'NORMAL' || p.bogon !== null || p.mitigation !== null || p.rt !== null)
      return rejected('AUTO_PHYSICAL_SCOPE_NOT_NORMAL');
    const reservation = await this.deps.store.transaction(async (tx) => {
      const key = scopeKey(t),
        old = await tx.get<ScopeOwnership>(key);
      if (this.activationGate(old, start)) return null;
      const scopes = await tx.list<ScopeOwnership>('scope', [
        'ACTIVATING',
        'ACTIVE',
        'REMOVING',
        'UNCERTAIN',
        'MANUAL',
      ]);
      if (scopes.length >= this.deps.config().maxActive) return null;
      const owner = randomUUID(),
        operationId = 'auto-activate-' + owner;
      const s: ScopeOwnership = {
        key,
        profileId: t.profileId,
        owner,
        revision: targetRevision(t),
        phase: 'ACTIVATING',
        target: {
          deviceId: t.deviceId,
          policy: t.policyName!,
          family: t.addressFamily!,
          rt: t.rt,
          bogon: t.bogonNode!,
          mitigation: t.mitigationNode!,
        },
        activatedAt: 0,
        cooldownUntil: old?.cooldownUntil ?? 0,
        lastSample: at,
        operationId,
        reason: null,
        ...(old?.removedAt !== undefined ? { removedAt: old.removedAt } : {}),
      };
      await tx.put(key, 'scope', s.phase, s);
      await tx.put(operationId, 'command', 'PLANNED', {
        id: operationId,
        scope: key,
        action: 'ACTIVATE',
        origin: 'AUTO',
        state: 'PLANNED',
        result: null,
        at: this.now(),
      } satisfies JournalCommand);
      return s;
    });
    if (!reservation) return rejected('AUTO_CAPACITY_OR_SCOPE_BUSY');
    let result: MitigationActionResult;
    try {
      result = await this.deps.execute({
        requestId: reservation.operationId,
        action: 'ACTIVATE',
        profileId: t.profileId,
        origin: 'AUTO',
        autoOperationId: reservation.operationId,
        autoEvidence: e,
      });
    } catch {
      return this.uncertain(reservation, 'COMMAND_TRANSPORT_FAILED');
    }
    const journal = await this.deps.store.transaction((tx) =>
      tx.get<JournalCommand>(reservation.operationId),
    );
    if (journal?.state === 'VERIFIED' && result.ok && !result.safeError) return result;
    if (journal?.state === 'STARTED' || journal?.state === 'PLANNED')
      return this.uncertain(reservation, 'AUTO_RESULT_NOT_COMMITTED');
    return rejected('AUTO_RECONCILIATION_REQUIRED');
  }
  /** Called before the canonical policy lock is released. */
  async completeActivation(
    input: MitigationCommandInput,
    result: MitigationActionResult,
    real: boolean,
  ): Promise<void> {
    if (input.action !== 'ACTIVATE' || !input.autoOperationId) return;
    const t = await this.deps.target(input.profileId);
    if (!t) throw Error('AUTO_RESULT_TARGET_MISSING');
    await this.deps.store.transaction(async (tx) => {
      const j = await tx.get<JournalCommand>(input.autoOperationId!);
      if (!j || j.origin !== 'AUTO' || j.action !== 'ACTIVATE') throw Error('AUTO_JOURNAL_MISSING');
      const s = await tx.get<ScopeOwnership>(j.scope);
      if (!s || s.operationId !== j.id || s.phase !== 'ACTIVATING')
        throw Error('AUTO_OWNERSHIP_CHANGED');
      const good =
        real &&
        result.ok &&
        result.verified &&
        result.status === 'ACTIVATED_VERIFIED' &&
        !result.safeError &&
        j.state === 'STARTED' &&
        s.revision === targetRevision(t) &&
        result.bogonNode === s.target.bogon &&
        result.mitigationNode === s.target.mitigation &&
        result.rt === s.target.rt;
      s.phase = good ? 'ACTIVE' : 'UNCERTAIN';
      s.reason = good ? null : result.status;
      if (good) s.activatedAt = this.now();
      await tx.put(s.key, 'scope', s.phase, s);
      await tx.put(j.id, 'command', good ? 'VERIFIED' : 'UNCERTAIN', {
        ...j,
        state: good ? 'VERIFIED' : 'UNCERTAIN',
        result,
        at: this.now(),
      } satisfies JournalCommand);
      await enqueueNotification(
        tx,
        this.notification(
          t,
          result,
          good ? 'MITIGATION_VERIFIED' : 'MITIGATION_FAILED',
          s.operationId,
          !real,
        ),
        this.now(),
      );
    });
  }
  private activationGate(s: ScopeOwnership | null, start: number): string | null {
    if (!s) return null;
    if (s.phase !== 'COOLDOWN') return 'AUTO_CAPACITY_OR_SCOPE_BUSY';
    if (s.cooldownUntil > this.now()) return 'AUTO_COOLDOWN_ACTIVE';
    if (start <= Math.max(s.cooldownUntil, s.removedAt ?? 0)) return 'AUTO_NEW_EPISODE_REQUIRED';
    return null;
  }
  /** Executed inside the canonical policy lock immediately before ACTIVATE. */
  async authorize(
    input: MitigationCommandInput,
    pair: { bogonNode: number; mitigationNode: number } | null,
  ): Promise<boolean> {
    if (input.action !== 'ACTIVATE' || !input.autoOperationId || !pair) return false;
    const t = await this.deps.target(input.profileId);
    if (!t || this.allowed(t)) return false;
    const evidence = input.autoEvidence;
    const start = Date.parse(evidence?.sequenceStartedAt ?? '');
    const sampledAt = Date.parse(evidence?.sampleAt ?? '');
    if (
      !evidence?.continuityKey ||
      !Number.isFinite(start) ||
      !Number.isFinite(sampledAt) ||
      start > sampledAt ||
      sampledAt > this.now() ||
      this.now() - sampledAt > this.deps.config().maxAgeMs ||
      !Number.isInteger(evidence.samplesOver) ||
      evidence.samplesOver! < t.triggerSamples
    )
      return false;
    return this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(scopeKey(t)),
        j = await tx.get<JournalCommand>(input.autoOperationId!);
      if (
        !s ||
        !j ||
        s.phase !== 'ACTIVATING' ||
        j.origin !== 'AUTO' ||
        j.action !== 'ACTIVATE' ||
        j.state !== 'PLANNED' ||
        s.operationId !== j.id ||
        s.profileId !== t.profileId ||
        s.revision !== targetRevision(t) ||
        s.target.bogon !== pair.bogonNode ||
        s.target.mitigation !== pair.mitigationNode ||
        s.target.rt !== t.rt ||
        s.target.family !== t.addressFamily
      )
        return false;
      if (s.removedAt !== undefined && start <= Math.max(s.removedAt, s.cooldownUntil))
        return false;
      j.state = 'STARTED';
      await tx.put(j.id, 'command', j.state, j);
      return true;
    });
  }
  /** No observation can write to Huawei. While owned, even zero traffic holds. */
  async observe(d: MitigationAutoDecision): Promise<void> {
    const t = await this.deps.target(d.profileId);
    if (!t) return;
    const at = Date.parse(d.sampleAt ?? ''),
      fresh =
        d.direction === t.direction &&
        Number.isFinite(at) &&
        at <= this.now() &&
        this.now() - at <= this.deps.config().maxAgeMs &&
        d.trafficBps !== null &&
        BigInt(d.trafficBps) >= 0n;
    await this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(scopeKey(t));
      if (s && s.phase !== 'COOLDOWN') return; // ACTIVE/MANUAL/UNCERTAIN wait indefinitely.
      if (
        [
          'MITIGATING',
          'MITIGATED',
          'RECOVERING',
          'RECOVERY_PENDING',
          'RECONCILIATION_REQUIRED',
        ].includes(t.runtimeState ?? '')
      )
        return;
      await this.observeUnmitigatedEpisode(tx, t, d, fresh ? at : null);
    });
  }
  /** APPLY LOCAL changes ownership only, never rearms or removes a policy. */
  async manualMutation(deviceId: string, policyName: string): Promise<void> {
    await this.deps.store.transaction(async (tx) => {
      const key = scopeKey({ deviceId, policyName }),
        s = await tx.get<ScopeOwnership>(key);
      if (s) {
        s.phase = 'MANUAL';
        s.reason = 'MANUAL_RECONCILIATION';
        await tx.put(key, 'scope', s.phase, s);
      }
    });
  }
  /** These callbacks run under the same policy lock as preflight/write/readback. */
  async beginManual(
    input: MitigationCommandInput,
    deviceId: string,
    policyName: string,
  ): Promise<MitigationActionResult | null> {
    return this.deps.store.transaction(async (tx) => {
      const id = manualKey(input.requestId),
        key = scopeKey({ deviceId, policyName }),
        old = await tx.get<JournalCommand>(id);
      if (
        old &&
        (old.origin !== 'MANUAL' ||
          old.action !== input.action ||
          old.profileId !== input.profileId ||
          old.scope !== key)
      )
        throw Error('MANUAL_IDEMPOTENCY_CONFLICT');
      if (old?.state === 'VERIFIED' && old.result) return { ...old.result, idempotent: true };
      if (old && ['STARTED', 'UNCERTAIN'].includes(old.state))
        throw Error('MANUAL_RECONCILIATION_REQUIRED');
      const s = await tx.get<ScopeOwnership>(key);
      if (s) {
        s.phase = 'MANUAL';
        s.reason = 'MANUAL_COMMAND_PENDING';
        await tx.put(key, 'scope', s.phase, s);
      }
      await tx.put(id, 'command', 'PLANNED', {
        id,
        scope: key,
        action: input.action as 'ACTIVATE' | 'REMOVE',
        origin: 'MANUAL',
        state: 'PLANNED',
        result: null,
        requestId: input.requestId,
        profileId: input.profileId,
        deviceId,
        policyName,
        at: this.now(),
      } satisfies JournalCommand);
      return null;
    });
  }
  async authorizeManual(input: MitigationCommandInput): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const j = await tx.get<JournalCommand>(manualKey(input.requestId));
      if (
        !j ||
        j.origin !== 'MANUAL' ||
        j.state !== 'PLANNED' ||
        j.action !== input.action ||
        j.profileId !== input.profileId
      )
        return false;
      j.state = 'STARTED';
      await tx.put(j.id, 'command', j.state, j);
      return true;
    });
  }
  async completeManual(
    input: MitigationCommandInput,
    result: MitigationActionResult,
    real: boolean,
  ): Promise<void> {
    await this.deps.store.transaction(async (tx) => {
      const j = await tx.get<JournalCommand>(manualKey(input.requestId));
      if (
        !j ||
        j.origin !== 'MANUAL' ||
        j.action !== input.action ||
        j.profileId !== input.profileId
      )
        throw Error('MANUAL_JOURNAL_MISSING');
      const verified =
        real &&
        j.state === 'STARTED' &&
        result.ok &&
        result.verified &&
        !result.safeError &&
        result.status === (input.action === 'REMOVE' ? 'REMOVED_VERIFIED' : 'ACTIVATED_VERIFIED');
      let s = await tx.get<ScopeOwnership>(j.scope);
      if (!s && verified) {
        if (
          !j.deviceId ||
          !j.policyName ||
          !result.addressFamily ||
          !result.rt ||
          result.bogonNode === null ||
          result.mitigationNode === null
        )
          throw Error('MANUAL_RESULT_SCOPE_MISSING');
        s = {
          key: j.scope,
          profileId: input.profileId,
          owner: 'manual:' + input.requestId,
          revision: 'MANUAL',
          phase: 'MANUAL',
          target: {
            deviceId: j.deviceId,
            policy: j.policyName,
            family: result.addressFamily,
            rt: result.rt,
            bogon: result.bogonNode,
            mitigation: result.mitigationNode,
          },
          activatedAt: this.now(),
          cooldownUntil: 0,
          lastSample: null,
          operationId: j.id,
          reason: 'MANUAL_ACTIVATE_VERIFIED',
        };
      }
      if (s) {
        if (verified && input.action === 'REMOVE') {
          s.phase = 'COOLDOWN';
          s.owner = 'released:' + input.requestId;
          s.reason = 'MANUAL_REMOVE_VERIFIED';
          s.removedAt = this.now();
          s.cooldownUntil = this.now() + this.deps.config().cooldownMs;
          s.lastSample = null;
          await this.closeEpisode(tx, s.profileId);
          if (s.profileId !== input.profileId) await this.closeEpisode(tx, input.profileId);
        } else {
          s.phase = verified ? 'MANUAL' : j.state === 'STARTED' ? 'UNCERTAIN' : 'MANUAL';
          s.reason = verified ? 'MANUAL_ACTIVATE_VERIFIED' : result.status;
        }
        s.operationId = j.id;
        if (verified && input.action === 'ACTIVATE') s.owner = 'manual:' + input.requestId;
        await tx.put(s.key, 'scope', s.phase, s);
      } else if (verified && input.action === 'REMOVE')
        await this.closeEpisode(tx, input.profileId);
      j.state = verified ? 'VERIFIED' : j.state === 'STARTED' ? 'UNCERTAIN' : 'REJECTED';
      // Scope confirmation tokens are short-lived authorization material, not journal data.
      j.result = { ...result };
      if (result.scopeConfirmation) {
        const { token: _token, ...summary } = result.scopeConfirmation;
        j.result.scopeConfirmation = summary;
      }
      j.at = this.now();
      await tx.put(j.id, 'command', j.state, j);
      if (j.state === 'REJECTED') return; // Preflight/confirmation rejection never pretends a physical result.
      const event = verified
        ? input.action === 'REMOVE'
          ? 'MITIGATION_REMOVED_VERIFIED'
          : 'MITIGATION_VERIFIED'
        : 'MITIGATION_FAILED';
      await enqueueNotification(
        tx,
        this.resultNotification(result, event, input.requestId, !real),
        this.now(),
      );
    });
  }
  /** Legacy interrupted REMOVE intents are quarantined, never replayed. */
  async reconcile(): Promise<void> {
    this.pilotReconciled = false;
    this.pilotSequence = null;
    const scopes = await this.deps.store.transaction((tx) =>
      tx.list<ScopeOwnership>('scope', ['ACTIVATING', 'REMOVING', 'ACTIVE']),
    );
    for (const s of scopes) {
      if (s.phase !== 'ACTIVE') {
        await this.uncertain(
          s,
          s.phase === 'REMOVING' ? 'LEGACY_AUTO_REMOVE_QUARANTINED' : 'RESTART_DURING_ACTIVATE',
        );
        continue;
      }
      const t = await this.deps.target(s.profileId);
      if (!t || targetRevision(t) !== s.revision) {
        await this.uncertain(s, 'RESTART_CONFIGURATION_CHANGED');
        continue;
      }
      try {
        const p = await this.deps.physical(t);
        if (
          p.state !== 'MITIGATED' ||
          p.bogon !== s.target.bogon ||
          p.mitigation !== s.target.mitigation ||
          p.rt !== s.target.rt
        )
          await this.uncertain(s, 'RESTART_READBACK_DIVERGED');
      } catch {
        await this.uncertain(s, 'RESTART_READBACK_FAILED');
      }
    }
    if (this.deps.pilotTraffic) {
      const t = await this.deps.target(SINGLE_AUTO_PILOT.profileId);
      if (!t || !singlePilotIdentityMatches(t))
        throw Error('PILOT_RECONCILIATION_IDENTITY_REQUIRED');
      const s = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t)));
      if (!s || s.phase === 'COOLDOWN') {
        let normal = false;
        try {
          const physical = await this.deps.physical(t);
          normal =
            physical.state === 'NORMAL' &&
            physical.bogon === null &&
            physical.mitigation === null &&
            physical.rt === null;
        } catch {
          /* unknown physical state must remain held */
        }
        if (!normal) {
          await this.holdPilotUncertain(t, 'RESTART_PHYSICAL_STATE_UNPROVEN');
        }
      }
      const current = await this.deps.store.transaction((tx) =>
        tx.get<ScopeOwnership>(scopeKey(t)),
      );
      this.pilotView = {
        state:
          !current || current.phase === 'COOLDOWN'
            ? 'IDLE'
            : current.phase === 'ACTIVE'
              ? 'ACTIVE'
              : 'UNCERTAIN',
        reason: current?.reason ?? null,
      };
    }
    this.pilotReconciled = true;
    this.pilotAcceptAfter = this.now();
  }

  private async holdPilotUncertain(t: LifecycleTarget, reason: string): Promise<void> {
    const s = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t)));
    const id = 'pilot-uncertain-' + randomUUID();
    const held: ScopeOwnership = {
      key: scopeKey(t),
      profileId: t.profileId,
      owner: id,
      operationId: id,
      revision: targetRevision(t),
      phase: 'UNCERTAIN',
      reason,
      target: {
        deviceId: t.deviceId,
        policy: t.policyName!,
        family: t.addressFamily!,
        rt: t.rt,
        bogon: t.bogonNode!,
        mitigation: t.mitigationNode!,
      },
      activatedAt: 0,
      cooldownUntil: s?.cooldownUntil ?? 0,
      lastSample: null,
    };
    await this.deps.store.transaction(async (tx) => {
      const current = await tx.get<ScopeOwnership>(held.key);
      if (!current || current.phase === 'COOLDOWN')
        await tx.put(held.key, 'scope', held.phase, held);
    });
    await this.uncertain(held, held.reason!);
  }
  private async uncertain(
    scope: ScopeOwnership,
    reason: string,
  ): Promise<MitigationAutoCommandResult> {
    const t = await this.deps.target(scope.profileId).catch(() => null);
    await this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(scope.key);
      if (!s || s.owner !== scope.owner) return;
      s.phase = 'UNCERTAIN';
      s.reason = reason;
      await tx.put(s.key, 'scope', s.phase, s);
      const j = await tx.get<JournalCommand>(scope.operationId);
      if (j) {
        j.state = 'UNCERTAIN';
        await tx.put(j.id, 'command', j.state, j);
      }
      if (t)
        await enqueueNotification(
          tx,
          this.notification(
            t,
            { verified: false, customer: t.customer, device: null, interface: null },
            'MITIGATION_FAILED',
            s.operationId + ':uncertain',
            false,
          ),
          this.now(),
        );
    });
    return rejected(reason);
  }
  async detection(
    d: MitigationAutoDecision,
    build: (d: MitigationAutoDecision) => Promise<MitigationNotification>,
  ): Promise<{ delivered: boolean }> {
    if (!d.episodeId) throw Error('DURABLE_ENGINE_EPISODE_ID_REQUIRED');
    const ep = await this.deps.store.transaction(async (tx) => {
      const aliasKey =
          'episode-alias:' +
          createHash('sha256')
            .update(JSON.stringify([d.profileId, d.episodeId]))
            .digest('hex'),
        alias = await tx.get<{ id: string }>(aliasKey);
      if (alias) {
        const old = await tx.get<Episode>('episode-history:' + alias.id);
        if (!old) throw Error('DURABLE_EPISODE_HISTORY_MISSING');
        return old;
      }
      const key = 'episode-current:' + d.profileId;
      let e = await tx.get<Episode>(key);
      if (!e || e.closed) {
        e = {
          id: randomUUID(),
          profileId: d.profileId,
          closed: false,
          lastSample: null,
          below: 0,
          at: this.now(),
        };
        await tx.put(key, 'episode', 'OPEN', e);
        await tx.put('episode-history:' + e.id, 'episode-history', 'OPEN', e);
      }
      await tx.put(aliasKey, 'episode-alias', 'MAPPED', { id: e.id });
      return e;
    });
    const n = await build({ ...d, episodeId: ep.id });
    return {
      delivered: await this.deps.store.transaction((tx) => enqueueNotification(tx, n, this.now())),
    };
  }
  private async closeEpisode(tx: AutomationTx, profileId: string) {
    const key = 'episode-current:' + profileId,
      e = await tx.get<Episode>(key);
    if (e && !e.closed) {
      e.closed = true;
      await tx.put(key, 'episode', 'CLOSED', e);
      await tx.put('episode-history:' + e.id, 'episode-history', 'CLOSED', e);
    }
  }
  private async observeUnmitigatedEpisode(
    tx: AutomationTx,
    t: LifecycleTarget,
    d: MitigationAutoDecision,
    at: number | null,
  ) {
    const key = 'episode-current:' + t.profileId,
      e = await tx.get<Episode>(key);
    if (!e || e.closed) return;
    if (at === null) {
      e.below = 0;
      await tx.put(key, 'episode', 'OPEN', e);
      return;
    }
    if (e.lastSample !== null && at <= e.lastSample) return;
    if (e.lastSample !== null && at - e.lastSample > this.deps.config().maxGapMs) e.below = 0;
    e.lastSample = at;
    const low =
      t.effectiveBandwidthBps !== null &&
      d.trafficBps !== null &&
      BigInt(d.trafficBps) < (t.effectiveBandwidthBps * BigInt(t.recoveryPercent)) / 100n;
    e.below = low ? e.below + 1 : 0;
    if (
      Number.isInteger(t.recoverySamples) &&
      t.recoverySamples > 0 &&
      e.below >= t.recoverySamples
    )
      e.closed = true;
    await tx.put(key, 'episode', e.closed ? 'CLOSED' : 'OPEN', e);
    if (e.closed) await tx.put('episode-history:' + e.id, 'episode-history', 'CLOSED', e);
  }
  private resultNotification(
    r: MitigationActionResult,
    event: MitigationNotification['event'],
    id: string,
    simulation: boolean,
  ): MitigationNotification {
    return {
      event,
      eventId: id,
      profileId: r.profileId,
      addressFamily: (r.addressFamily as 'IPV4' | 'IPV6' | null) ?? null,
      simulation,
      verified: event !== 'MITIGATION_FAILED' && r.verified,
      customer: r.customer,
      device: r.device,
      interfaceName: r.interface,
      peer: r.affectedPeers[0] ?? null,
      affectedPeers: r.affectedPeers,
      sharedPolicy: r.sharedPolicy,
      sharedPolicyTargets: r.sharedPolicyTargets,
      detectedBandwidthBps: null,
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: null,
      trafficBps: null,
      thresholdBps: null,
      policy: r.policy,
      node: r.mitigationNode,
      bogonNode: r.bogonNode,
      mitigationNode: r.mitigationNode,
      rt: r.rt,
      occurredAt: new Date(this.now()).toISOString(),
    };
  }
  private notification(
    t: LifecycleTarget,
    r: Pick<MitigationActionResult, 'verified' | 'customer' | 'device' | 'interface'>,
    event: MitigationNotification['event'],
    id: string,
    simulation: boolean,
  ): MitigationNotification {
    return {
      event,
      eventId: id,
      profileId: t.profileId,
      addressFamily: t.addressFamily ?? null,
      simulation,
      verified: event !== 'MITIGATION_FAILED' && r.verified,
      customer: r.customer ?? t.customer,
      device: r.device,
      interfaceName: r.interface,
      peer: t.peerAddresses[0] ?? null,
      affectedPeers: [...t.peerAddresses],
      detectedBandwidthBps: null,
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: t.effectiveBandwidthBps,
      trafficBps: null,
      thresholdBps: null,
      policy: t.policyName ?? null,
      node: t.mitigationNode,
      bogonNode: t.bogonNode,
      mitigationNode: t.mitigationNode,
      rt: t.rt,
      occurredAt: new Date(this.now()).toISOString(),
    };
  }
}
