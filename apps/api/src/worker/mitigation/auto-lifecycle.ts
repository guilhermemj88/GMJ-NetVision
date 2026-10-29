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
import { enqueueNotification } from './durable-mitigation-outbox';
import type { MitigationTrafficSample } from './mitigation-traffic-source';

export interface LifecycleConfig {
  installation: string;
  enabled: boolean;
  executionEnabled: boolean;
  removeEnabled: boolean;
  profiles: readonly string[];
  devices: readonly string[];
  maxActive: number;
  minHoldMs: number;
  recoveryMs: number;
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
  recoveryProofKey?: string | undefined;
}
export function lifecycleConfig(env: Record<string, string | undefined>): LifecycleConfig {
  const list = (key: string) =>
    (env[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const flag = (key: string) => /^(1|true)$/i.test(env[key]?.trim() ?? '');
  const seconds = (key: string, def: number, min: number) => {
    const n = Number(env[key]);
    return Number.isInteger(n) && n >= min ? n * 1000 : def * 1000;
  };
  const max = Number(env.MITIGATION_AUTO_MAX_ACTIVE);
  return {
    installation: env.NETVISION_INSTALLATION_ID ?? '',
    enabled: flag('MITIGATION_AUTO_LIFECYCLE_ENABLED'),
    executionEnabled: flag('MITIGATION_AUTO_EXECUTION_ENABLED'),
    removeEnabled: flag('MITIGATION_AUTO_REMOVE_ENABLED'),
    profiles: list('MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS'),
    devices: list('MITIGATION_ALLOWED_DEVICE_IDS'),
    maxActive: Number.isInteger(max) && max >= 1 && max <= 10 ? max : 1,
    minHoldMs: seconds('MITIGATION_AUTO_MIN_HOLD_SECONDS', 900, 60),
    recoveryMs: seconds('MITIGATION_AUTO_RECOVERY_SECONDS', 60, 10),
    cooldownMs: seconds('MITIGATION_AUTO_COOLDOWN_SECONDS', 600, 60),
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
        t.recoveryPercent,
        t.triggerSamples,
        t.recoverySamples,
        [...t.peerAddresses].sort(),
        t.configurationKey ?? null,
        t.recoveryProofKey ?? null,
      ]),
    )
    .digest('hex');
}
export interface ScopeOwnership {
  key: string;
  profileId: string;
  owner: string;
  revision: string;
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
  below: number;
  firstLow: number | null;
  operationId: string;
  reason: string | null;
}
export interface JournalCommand {
  id: string;
  scope: string;
  action: 'ACTIVATE' | 'REMOVE';
  state: 'PLANNED' | 'STARTED' | 'VERIFIED' | 'UNCERTAIN';
  result: MitigationActionResult | null;
  at: number;
}
interface Episode {
  id: string;
  profileId: string;
  closed: boolean;
  lastSample: number | null;
  below: number;
  firstLow: number | null;
  at: number;
}
export interface LifecycleDeps {
  store: AutomationStore;
  config: () => LifecycleConfig;
  target: (id: string) => Promise<LifecycleTarget | null>;
  execute: (input: MitigationCommandInput) => Promise<MitigationActionResult>;
  recoveryProof: (target: LifecycleTarget) => Promise<MitigationTrafficSample | null>;
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

export class AutoMitigationLifecycle {
  private readonly now: () => number;
  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }
  private allowed(t: LifecycleTarget, remove = false): string | null {
    const c = this.deps.config();
    if (c.installation !== 'IMPLANTAR' || !c.enabled || !c.executionEnabled)
      return 'AUTO_EXECUTION_DISABLED';
    if (remove && !c.removeEnabled) return 'AUTO_REMOVE_DISABLED';
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
    if (
      !t.fast ||
      t.direction !== 'tx' ||
      !t.interfaceId ||
      !t.policyName ||
      !t.addressFamily ||
      !t.rt
    )
      return 'AUTO_TELEMETRY_CONTRACT_REQUIRED';
    if (t.scopeMembers !== 1 || t.sharedPolicy || t.otherFamilyAuto) return 'AUTO_SCOPE_UNSAFE';
    if (
      !Number.isInteger(t.bogonNode) ||
      !Number.isInteger(t.mitigationNode) ||
      t.bogonNode === t.mitigationNode ||
      t.bogonNode! <= 0 ||
      t.mitigationNode! <= 0
    )
      return 'AUTO_PAIR_INVALID';
    if (remove && !t.recoveryProofKey) return 'AUTO_INDEPENDENT_RECOVERY_PROOF_REQUIRED';
    if (
      !t.effectiveBandwidthBps ||
      t.effectiveBandwidthBps <= 0n ||
      !Number.isInteger(t.triggerPercent) ||
      !Number.isInteger(t.recoveryPercent) ||
      t.recoveryPercent <= 0 ||
      t.triggerPercent <= t.recoveryPercent ||
      t.triggerPercent > 100 ||
      !Number.isInteger(t.triggerSamples) ||
      t.triggerSamples < 2 ||
      !Number.isInteger(t.recoverySamples) ||
      t.recoverySamples < 2
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
    const evidence = input.autoEvidence;
    const sampleAt = Date.parse(evidence?.sampleAt ?? '');
    if (
      !evidence?.continuityKey ||
      !Number.isFinite(sampleAt) ||
      sampleAt > this.now() ||
      this.now() - sampleAt > this.deps.config().maxAgeMs
    )
      return rejected('AUTO_EVIDENCE_REQUIRED');
    const reservation = await this.deps.store.transaction(async (tx) => {
      const key = scopeKey(t),
        old = await tx.get<ScopeOwnership>(key);
      if (old && old.phase !== 'COOLDOWN') return null;
      if (old && old.cooldownUntil > this.now()) return null;
      const scopes = await tx.list<ScopeOwnership>('scope', [
        'ACTIVATING',
        'ACTIVE',
        'REMOVING',
        'UNCERTAIN',
      ]);
      if (scopes.length >= this.deps.config().maxActive) return null;
      const owner = randomUUID(),
        id = 'auto-activate-' + owner;
      const scope: ScopeOwnership = {
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
        cooldownUntil: 0,
        lastSample: sampleAt,
        below: 0,
        firstLow: null,
        operationId: id,
        reason: null,
      };
      await tx.put(key, 'scope', scope.phase, scope);
      await tx.put(id, 'command', 'PLANNED', {
        id,
        scope: key,
        action: 'ACTIVATE',
        state: 'PLANNED',
        result: null,
        at: this.now(),
      } satisfies JournalCommand);
      return scope;
    });
    if (!reservation) return rejected('AUTO_CAPACITY_OR_SCOPE_BUSY');
    return this.dispatch(reservation, t, 'ACTIVATE', evidence);
  }
  private async dispatch(
    scope: ScopeOwnership,
    t: LifecycleTarget,
    action: 'ACTIVATE' | 'REMOVE',
    evidence?: MitigationCommandInput['autoEvidence'],
  ): Promise<MitigationAutoCommandResult> {
    let result: MitigationActionResult;
    try {
      result = await this.deps.execute({
        requestId: scope.operationId,
        action,
        profileId: t.profileId,
        origin: 'AUTO',
        autoOperationId: scope.operationId,
        ...(evidence ? { autoEvidence: evidence } : {}),
      });
    } catch {
      return this.uncertain(scope, 'COMMAND_TRANSPORT_FAILED');
    }
    const expected = action === 'ACTIVATE' ? 'ACTIVATED_VERIFIED' : 'REMOVED_VERIFIED';
    const physicallyVerified =
      result.ok && result.verified === true && result.status === expected && !result.safeError;
    const verified = await this.deps.store.transaction(async (tx) => {
      const journal = await tx.get<JournalCommand>(scope.operationId);
      // An idempotent pre-existing physical policy is never adopted as AUTO.
      const verified =
        physicallyVerified &&
        journal?.state === 'STARTED' &&
        result.bogonNode === scope.target.bogon &&
        result.mitigationNode === scope.target.mitigation &&
        result.rt === scope.target.rt;
      const current = await tx.get<ScopeOwnership>(scope.key);
      if (
        !current ||
        current.owner !== scope.owner ||
        current.operationId !== scope.operationId ||
        !['ACTIVATING', 'REMOVING'].includes(current.phase)
      )
        throw Error('AUTO_OWNERSHIP_CHANGED');
      current.phase = verified ? (action === 'ACTIVATE' ? 'ACTIVE' : 'COOLDOWN') : 'UNCERTAIN';
      current.reason = verified ? null : result.status;
      if (verified && action === 'ACTIVATE') {
        current.activatedAt = this.now();
        current.below = 0;
        current.firstLow = null;
      }
      if (verified && action === 'REMOVE')
        current.cooldownUntil = this.now() + this.deps.config().cooldownMs;
      await tx.put(current.key, 'scope', current.phase, current);
      await tx.put(scope.operationId, 'command', verified ? 'VERIFIED' : 'UNCERTAIN', {
        id: scope.operationId,
        scope: scope.key,
        action,
        state: verified ? 'VERIFIED' : 'UNCERTAIN',
        result,
        at: this.now(),
      } satisfies JournalCommand);
      await enqueueNotification(
        tx,
        this.notification(
          t,
          result,
          verified
            ? action === 'ACTIVATE'
              ? 'MITIGATION_VERIFIED'
              : 'MITIGATION_REMOVED_VERIFIED'
            : 'MITIGATION_FAILED',
          scope.operationId,
        ),
        this.now(),
      );
      return verified;
    });
    return verified ? result : rejected('AUTO_RECONCILIATION_REQUIRED');
  }
  private async uncertain(
    scope: ScopeOwnership,
    reason: string,
  ): Promise<MitigationAutoCommandResult> {
    const target = await this.deps.target(scope.profileId).catch(() => null);
    await this.deps.store.transaction(async (tx) => {
      const current = await tx.get<ScopeOwnership>(scope.key);
      if (!current || current.owner !== scope.owner) return;
      current.phase = 'UNCERTAIN';
      current.reason = reason;
      await tx.put(current.key, 'scope', current.phase, current);
      const op = await tx.get<JournalCommand>(scope.operationId);
      if (op) {
        op.state = 'UNCERTAIN';
        await tx.put(op.id, 'command', op.state, op);
      }
      if (target)
        await enqueueNotification(
          tx,
          this.notification(
            target,
            { verified: false, customer: target.customer, device: null, interface: null },
            'MITIGATION_FAILED',
            scope.operationId + ':uncertain',
          ),
          this.now(),
        );
    });
    return rejected(reason);
  }
  /** Runs inside the canonical policy lock, after preflight, immediately before SSH. */
  async authorize(
    input: MitigationCommandInput,
    pair: { bogonNode: number; mitigationNode: number } | null,
  ): Promise<boolean> {
    if (!input.autoOperationId || !pair) return false;
    const t = await this.deps.target(input.profileId);
    if (!t || this.allowed(t, input.action === 'REMOVE')) return false;
    const proof =
      input.action === 'REMOVE' ? await this.deps.recoveryProof(t).catch(() => null) : null;
    const proofAt = proof?.occurredAt?.getTime();
    return this.deps.store.transaction(async (tx) => {
      const scope = await tx.get<ScopeOwnership>(scopeKey(t));
      const command = await tx.get<JournalCommand>(input.autoOperationId!);
      if (
        !scope ||
        !command ||
        command.state !== 'PLANNED' ||
        command.action !== input.action ||
        scope.operationId !== command.id ||
        scope.profileId !== t.profileId ||
        scope.revision !== targetRevision(t)
      )
        return false;
      if (
        scope.phase !== (input.action === 'ACTIVATE' ? 'ACTIVATING' : 'REMOVING') ||
        scope.target.bogon !== pair.bogonNode ||
        scope.target.mitigation !== pair.mitigationNode ||
        scope.target.rt !== t.rt ||
        scope.target.family !== t.addressFamily
      )
        return false;
      if (
        input.action === 'REMOVE' &&
        (!proof ||
          !proof.continuityKey ||
          proof.continuityKey !== t.recoveryProofKey ||
          proofAt == null ||
          proofAt < this.now() - this.deps.config().maxAgeMs ||
          proofAt > this.now() ||
          scope.lastSample === null ||
          proofAt < scope.lastSample ||
          proofAt - scope.lastSample > this.deps.config().maxGapMs ||
          proof.bps < 0n ||
          proof.bps >= (t.effectiveBandwidthBps! * BigInt(t.recoveryPercent)) / 100n ||
          scope.below < t.recoverySamples ||
          scope.firstLow === null ||
          proofAt - scope.firstLow < this.deps.config().recoveryMs ||
          this.now() - scope.activatedAt < this.deps.config().minHoldMs)
      )
        return false;
      command.state = 'STARTED';
      await tx.put(command.id, 'command', command.state, command);
      return true;
    });
  }
  /** Manual mutation revokes automation ownership before any physical write. */
  async manualMutation(deviceId: string, policyName: string): Promise<void> {
    const key = scopeKey({ deviceId, policyName });
    await this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(key);
      if (s) {
        s.phase = 'MANUAL';
        s.reason = 'MANUAL_OPERATION';
        await tx.put(key, 'scope', s.phase, s);
      }
    });
  }
  async observe(decision: MitigationAutoDecision): Promise<void> {
    const t = await this.deps.target(decision.profileId);
    if (!t) return;
    const at = Date.parse(decision.sampleAt ?? '');
    const c = this.deps.config();
    const fresh =
      decision.direction === 'tx' &&
      Number.isFinite(at) &&
      at <= this.now() &&
      this.now() - at <= c.maxAgeMs &&
      decision.trafficBps !== null &&
      BigInt(decision.trafficBps) >= 0n;
    const proof = t.recoveryProofKey ? await this.deps.recoveryProof(t).catch(() => null) : null;
    const proofAt = proof?.occurredAt?.getTime();
    const proofFresh =
      !!proof &&
      proof.continuityKey === t.recoveryProofKey &&
      proofAt != null &&
      proofAt <= this.now() &&
      this.now() - proofAt <= c.maxAgeMs &&
      proof.bps >= 0n;
    const prepared = await this.deps.store.transaction(async (tx) => {
      const scope = await tx.get<ScopeOwnership>(scopeKey(t));
      const diverted =
        [
          'MITIGATING',
          'MITIGATED',
          'RECOVERING',
          'RECOVERY_PENDING',
          'RECONCILIATION_REQUIRED',
        ].includes(t.runtimeState ?? '') ||
        (!!scope && ['ACTIVE', 'REMOVING', 'UNCERTAIN'].includes(scope.phase));
      // A diverted client counter cannot positively close an attack episode.
      const episodeFresh =
        fresh &&
        (!diverted ||
          (proofFresh &&
            proof!.bps < (t.effectiveBandwidthBps! * BigInt(t.recoveryPercent)) / 100n));
      await this.recoverEpisode(tx, t, decision, episodeFresh ? at : null);
      if (!scope || scope.phase !== 'ACTIVE' || scope.profileId !== t.profileId) return null;
      if (scope.revision !== targetRevision(t)) {
        scope.phase = 'UNCERTAIN';
        scope.reason = 'CONFIGURATION_CHANGED';
        await tx.put(scope.key, 'scope', scope.phase, scope);
        return null;
      }
      if (!fresh || !proofFresh) {
        scope.below = 0;
        scope.firstLow = null;
        await tx.put(scope.key, 'scope', scope.phase, scope);
        return null;
      }
      const recoveryAt = proofAt!;
      if (scope.lastSample !== null && recoveryAt <= scope.lastSample) return null;
      if (scope.lastSample !== null && recoveryAt - scope.lastSample > c.maxGapMs) {
        scope.below = 0;
        scope.firstLow = null;
      }
      scope.lastSample = recoveryAt;
      const low = proof!.bps < (t.effectiveBandwidthBps! * BigInt(t.recoveryPercent)) / 100n;
      scope.below = low ? scope.below + 1 : 0;
      scope.firstLow = low ? (scope.firstLow ?? recoveryAt) : null;
      await tx.put(scope.key, 'scope', scope.phase, scope);
      if (
        !low ||
        scope.below < t.recoverySamples ||
        scope.firstLow === null ||
        recoveryAt - scope.firstLow < c.recoveryMs ||
        this.now() - scope.activatedAt < c.minHoldMs ||
        this.allowed(t, true)
      )
        return null;
      return scope;
    });
    if (!prepared) return;
    let physical: Awaited<ReturnType<LifecycleDeps['physical']>>;
    try {
      physical = await this.deps.physical(t);
    } catch {
      return;
    }
    if (
      physical.state !== 'MITIGATED' ||
      physical.bogon !== prepared.target.bogon ||
      physical.mitigation !== prepared.target.mitigation ||
      physical.rt !== prepared.target.rt
    ) {
      await this.uncertain(prepared, 'PHYSICAL_OWNERSHIP_DIVERGED');
      return;
    }
    const claimed = await this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(prepared.key);
      if (
        !s ||
        s.phase !== 'ACTIVE' ||
        s.owner !== prepared.owner ||
        s.lastSample !== prepared.lastSample ||
        s.below !== prepared.below ||
        s.revision !== targetRevision(t) ||
        this.allowed(t, true)
      )
        return null;
      s.phase = 'REMOVING';
      s.operationId = 'auto-remove-' + s.owner;
      await tx.put(s.key, 'scope', s.phase, s);
      await tx.put(s.operationId, 'command', 'PLANNED', {
        id: s.operationId,
        scope: s.key,
        action: 'REMOVE',
        state: 'PLANNED',
        result: null,
        at: this.now(),
      } satisfies JournalCommand);
      return s;
    });
    if (claimed) await this.dispatch(claimed, t, 'REMOVE');
  }
  /** Restart never replays an ambiguous write or adopts a legacy/manual policy. */
  async reconcile(): Promise<void> {
    const scopes = await this.deps.store.transaction((tx) =>
      tx.list<ScopeOwnership>('scope', ['ACTIVATING', 'REMOVING', 'ACTIVE']),
    );
    for (const s of scopes) {
      if (s.phase !== 'ACTIVE') {
        await this.uncertain(s, 'RESTART_DURING_COMMAND');
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
  }
  async detection(
    decision: MitigationAutoDecision,
    build: (decision: MitigationAutoDecision) => Promise<MitigationNotification>,
  ): Promise<{ delivered: boolean }> {
    if (!decision.episodeId) throw Error('DURABLE_ENGINE_EPISODE_ID_REQUIRED');
    const episode = await this.deps.store.transaction(async (tx) => {
      const aliasKey =
        'episode-alias:' +
        createHash('sha256')
          .update(JSON.stringify([decision.profileId, decision.episodeId]))
          .digest('hex');
      const alias = await tx.get<{ id: string }>(aliasKey);
      if (alias) {
        const existing = await tx.get<Episode>('episode-history:' + alias.id);
        if (!existing) throw Error('DURABLE_EPISODE_HISTORY_MISSING');
        return existing;
      }
      const key = 'episode-current:' + decision.profileId;
      let ep = await tx.get<Episode>(key);
      if (!ep || ep.closed) {
        ep = {
          id: randomUUID(),
          profileId: decision.profileId,
          closed: false,
          lastSample: null,
          below: 0,
          firstLow: null,
          at: this.now(),
        };
        await tx.put(key, 'episode', 'OPEN', ep);
        await tx.put('episode-history:' + ep.id, 'episode-history', 'OPEN', ep);
      }
      await tx.put(aliasKey, 'episode-alias', 'MAPPED', { id: ep.id });
      return ep;
    });
    const n = await build({ ...decision, episodeId: episode.id });
    const delivered = await this.deps.store.transaction((tx) =>
      enqueueNotification(tx, n, this.now()),
    );
    return { delivered };
  }
  private async recoverEpisode(
    tx: AutomationTx,
    t: LifecycleTarget,
    d: MitigationAutoDecision,
    at: number | null,
  ) {
    const key = 'episode-current:' + t.profileId;
    const ep = await tx.get<Episode>(key);
    if (!ep || ep.closed) return;
    if (at === null) {
      ep.below = 0;
      ep.firstLow = null;
      await tx.put(key, 'episode', 'OPEN', ep);
      return;
    }
    if (ep.lastSample !== null && at <= ep.lastSample) return;
    if (ep.lastSample !== null && at - ep.lastSample > this.deps.config().maxGapMs) {
      ep.below = 0;
      ep.firstLow = null;
    }
    ep.lastSample = at;
    const low =
      t.effectiveBandwidthBps !== null &&
      d.trafficBps !== null &&
      BigInt(d.trafficBps) < (t.effectiveBandwidthBps * BigInt(t.recoveryPercent)) / 100n;
    ep.below = low ? ep.below + 1 : 0;
    ep.firstLow = low ? (ep.firstLow ?? at) : null;
    if (
      ep.below >= t.recoverySamples &&
      ep.firstLow !== null &&
      at - ep.firstLow >= this.deps.config().recoveryMs
    ) {
      ep.closed = true;
      await tx.put('episode-history:' + ep.id, 'episode-history', 'CLOSED', ep);
    }
    await tx.put(key, 'episode', ep.closed ? 'CLOSED' : 'OPEN', ep);
  }
  private notification(
    t: LifecycleTarget,
    r: Pick<MitigationActionResult, 'verified' | 'customer' | 'device' | 'interface'>,
    event: MitigationNotification['event'],
    id: string,
  ): MitigationNotification {
    return {
      event,
      eventId: id,
      profileId: t.profileId,
      addressFamily: t.addressFamily ?? null,
      simulation: false,
      verified: event !== 'MITIGATION_FAILED' && r.verified === true,
      customer: r.customer ?? t.customer,
      device: r.device ?? null,
      interfaceName: r.interface ?? null,
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
