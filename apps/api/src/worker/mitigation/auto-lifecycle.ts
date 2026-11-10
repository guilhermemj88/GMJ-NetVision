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
import {
  fastContinuityWindowMs,
  readFastNormalIntervalMs,
} from '../../infrastructure/snmp/fast-cadence';
import type { ClientBinding } from './auto-client-binding';
import { enqueueNotification } from './durable-mitigation-outbox';
import type { MitigationTrafficSource } from './mitigation-traffic-source';
import type { PolicyScopeLock } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { mitigationRefOf } from '../../infrastructure/bgp/mitigation/mitigation-ref';
import {
  baselineRecordId,
  baselineReleaseMarker,
  baselineDriftReasons,
  retainedBaseline,
} from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';
import { inspectPolicyMitigation } from '../../infrastructure/bgp/mitigation/mitigation-policy-physical';
import {
  PHYSICAL_UNVERIFIED_FAILURE_KIND,
  PHYSICAL_UNVERIFIED_MESSAGE,
  PHYSICAL_UNVERIFIED_STATUS,
} from '../../infrastructure/bgp/mitigation/mitigation-physical-verification';
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
  expansionEnabled?: boolean;
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
  const rawMax = env.MITIGATION_AUTO_MAX_ACTIVE;
  const max = Number(rawMax),
    cooldown = Number(env.MITIGATION_AUTO_COOLDOWN_SECONDS);
  return {
    installation: env.NETVISION_INSTALLATION_ID ?? '',
    enabled: flag('MITIGATION_AUTO_LIFECYCLE_ENABLED'),
    expansionEnabled: flag('MITIGATION_AUTO_EXPANSION_ENABLED'),
    executionEnabled: flag('MITIGATION_AUTO_EXECUTION_ENABLED'),
    removeEnabled: false,
    profiles: list('MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS'),
    devices: list('MITIGATION_ALLOWED_DEVICE_IDS'),
    // D12: valor AUSENTE usa o default 1; valor PRESENTE e invalido falha no boot
    // (nunca cai silenciosamente para 1, que mudaria o significado da configuracao).
    maxActive:
      rawMax === undefined
        ? 1
        : Number.isInteger(max) && max >= 1 && max <= 10
          ? max
          : (() => {
              throw Error('MITIGATION_AUTO_MAX_ACTIVE_INVALID');
            })(),
    cooldownMs: Number.isInteger(cooldown) && cooldown >= 60 ? cooldown * 1000 : 600_000,
    // D4: a janela de decisao e DERIVADA da cadencia real do coletor embutido
    // (mesma funcao do poller). 10 s -> 15 s (inalterado); 15 s -> 22,5 s;
    // 30 s -> 45 s. Antes era 15 s fixos e a cadencia nao valia na decisao.
    maxAgeMs: fastContinuityWindowMs(readFastNormalIntervalMs(env)),
    maxGapMs: fastContinuityWindowMs(readFastNormalIntervalMs(env)),
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
  /**
   * `eventId` of the MITIGATION_VERIFIED event of the mitigation this scope currently holds
   * (AUTO operation id or request id of the verified manual ACTIVATE); `null` when it holds
   * none. Independent of `phase`/`reason`, which later rejected commands overwrite.
   */
  activeEventId?: string | null;
}
export interface JournalCommand {
  id: string;
  scope: string;
  action: 'ACTIVATE' | 'REMOVE';
  origin: 'AUTO' | 'MANUAL';
  state: 'PLANNED' | 'STARTED' | 'VERIFIED' | 'UNCERTAIN' | 'REJECTED' | 'RECONCILED';
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
  /** Presentation only, before durable enqueue; failure cannot change lifecycle. */
  enrichNotification?: (notification: MitigationNotification, direction?: 'rx' | 'tx' | null, confirmedAtMs?: number | null) => MitigationNotification;
  /** Required only for explicit, non-physical release reconciliation. */
  scopeLock?: PolicyScopeLock;
  readPolicy?: (target: LifecycleTarget) => Promise<string>;
  /** The existing FAST reader; supplied only for the single-client production path. */
  pilotTraffic?: Pick<MitigationTrafficSource, 'sampleWithId'>;
  /**
   * Optional scope around the whole equipment-facing part of an AUTO activation attempt (reads
   * share one SSH snapshot; the first write closes it). Absent = every read hits the equipment.
   */
  readScope?: <R>(target: LifecycleTarget, run: () => Promise<R>) => Promise<R>;
  /** Closes the read scope of the current attempt (called when the write is authorized). */
  closeReadScope?: () => void;
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
/**
 * A PLANNED/STARTED command younger than this may still be running and its scope is never
 * released by reconciliation. The age counts from the last transition (PLANNED, then STARTED
 * right before the write): after STARTED a command is bounded by the SSH write/read timeouts
 * and the physical verification budget, well below this value. A command that still completes
 * after its scope was released re-quarantines the scope (see `completeManual`).
 */
export const QUARANTINE_RELEASE_MIN_AGE_MS = 300_000;
/**
 * `eventId` of the MITIGATION_VERIFIED event of the mitigation currently owned by the scope:
 * the AUTO operation id, or the request id of a verified manual ACTIVATE. `null` when the scope
 * holds no verified activation (nothing a bound REMOVE could refer to).
 */
export function activeMitigationEventId(s: ScopeOwnership | null): string | null {
  if (!s) return null;
  if (s.activeEventId !== undefined) return s.activeEventId;
  // Records written before the dedicated field existed.
  if (s.phase === 'ACTIVE') return s.operationId;
  if (
    s.phase === 'MANUAL' &&
    s.reason === 'MANUAL_ACTIVATE_VERIFIED' &&
    s.owner.startsWith('manual:')
  )
    return s.owner.slice('manual:'.length);
  return null;
}
const manualKey = (id: string) => 'manual-command:' + createHash('sha256').update(id).digest('hex');

/** Scope-wide, not request/profile-wide: quarantine cannot be bypassed by a new id. */
async function scopeQuarantined(
  tx: AutomationTx,
  scope: string,
  deviceId: string,
  policyName: string,
): Promise<boolean> {
  const s = await tx.get<ScopeOwnership>(scope);
  if (s && ['UNCERTAIN', 'ACTIVATING', 'REMOVING'].includes(s.phase)) return true;
  const baseline = await tx.get<{ version?: number }>(baselineRecordId({ deviceId, policyName }));
  if (baseline?.version === 2) return true;
  const pending = await tx.list<JournalCommand>('command', ['STARTED', 'UNCERTAIN']);
  return pending.length >= 1000 || pending.some((j) => j.scope === scope);
}

/** `MITIGATION_FAILED` com subtipo UNVERIFIED_PHYSICAL (escrita aplicada; efeito nao comprovado). */
function unverifiedPhysicalExtras(r: {
  status?: string;
}): Pick<MitigationNotification, 'failureKind' | 'failureMessage'> {
  return r.status === PHYSICAL_UNVERIFIED_STATUS
    ? {
        failureKind: PHYSICAL_UNVERIFIED_FAILURE_KIND,
        failureMessage: PHYSICAL_UNVERIFIED_MESSAGE,
      }
    : {};
}

/** AUTO ACTIVATE only. No timer, observation or restart can dispatch REMOVE. */
export class AutoMitigationLifecycle {
  private readonly now: () => number;
  private readonly sequences = new Map<string, PilotSequence>();
  private readonly acceptAfter = new Map<string, number>();
  private readonly views = new Map<string, { state: string; reason: string | null }>();
  private pilotReconciled = false;
  private pilotRunning = false;
  private pilotAcceptAfter = 0;
  /** D12: visao do PILOTO (perfil unico). Cada perfil tem a sua em views. */
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
    for (const id of ids) {
      this.sequences.delete(id);
      this.acceptAfter.set(id, this.now());
    }
  }
  expansionStatus() {
    return Object.fromEntries(this.views);
  }

  /** Existing runtime, one global writer, independent per-profile sequence state. */
  async tickPilot(): Promise<MitigationAutoDecision[]> {
    if (!this.deps.pilotTraffic || this.pilotRunning) return [];
    this.pilotRunning = true;
    try {
      const config = this.deps.config();
      const ids = config.expansionEnabled ? config.profiles : [SINGLE_AUTO_PILOT.profileId];
      const result: MitigationAutoDecision[] = [];
      for (const id of ids) result.push(...(await this.tickProfile(id)));
      return result;
    } finally {
      this.pilotRunning = false;
    }
  }

  private async tickProfile(profileId: string): Promise<MitigationAutoDecision[]> {
    // Visao LOCAL do perfil: nunca herda a razao do perfil processado antes.
    let view: { state: 'IDLE' | 'ACTIVATING' | 'ACTIVE' | 'UNCERTAIN'; reason: string | null } = {
      state: 'IDLE',
      reason: 'RECONCILIATION_REQUIRED',
    };
    let sequence: PilotSequence | null = this.sequences.get(profileId) ?? null;
    let acceptAfter = this.acceptAfter.get(profileId) ?? this.pilotAcceptAfter;
    let t: LifecycleTarget | null = null;
    const decision = (
      reason: string | null,
      outcome: MitigationAutoDecision['outcome'] = 'BLOCKED',
      traffic: bigint | null = null,
      sampleAt?: number,
    ): MitigationAutoDecision[] => {
      const d: MitigationAutoDecision = {
        at: new Date(this.now()).toISOString(),
        profileId: profileId,
        deviceId: t?.deviceId ?? '',
        customer: t?.customer ?? null,
        outcome,
        reason: outcome === 'BLOCKED' ? 'TARGET_BLOCKED' : null,
        detail: reason,
        trafficBps: traffic?.toString() ?? null,
        thresholdBps: t?.effectiveBandwidthBps
          ? ((t.effectiveBandwidthBps * BigInt(t.triggerPercent)) / 100n).toString()
          : null,
        recoveryThresholdBps: null,
        samplesOver: sequence?.over ?? 0,
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
      t = await this.deps.target(profileId);
      if (!t) {
        sequence = null;
        return decision('AUTO_TARGET_MISSING');
      }
      const owned = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t!)));
      if (owned && owned.phase !== 'COOLDOWN') {
        sequence = null;
        view = {
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
        sequence = null;
        acceptAfter = this.now();
        view = { state: 'IDLE', reason: blocked ?? 'AUTO_COOLDOWN_ACTIVE' };
        return decision(view.reason);
      }
      if (t.runtimeState !== 'NORMAL' && t.runtimeState !== 'ALERT_ONLY') {
        sequence = null;
        view = { state: 'UNCERTAIN', reason: 'RUNTIME_REQUIRES_RECONCILIATION' };
        return decision(view.reason);
      }
      const sample = await this.deps.pilotTraffic!.sampleWithId({
        profileId: t.profileId,
        deviceId: t.deviceId,
        interfaceId: t.interfaceId,
        bandwidthBps: t.effectiveBandwidthBps,
        ...(t.configurationKey === undefined ? {} : { configurationKey: t.configurationKey }),
      });
      if (
        sample?.occurredAt &&
        sample.occurredAt.getTime() <=
          Math.max(acceptAfter, owned?.cooldownUntil ?? 0, owned?.removedAt ?? 0)
      ) {
        sequence = sequence ? { ...sequence, over: 0 } : null;
        return decision('AUTO_NEW_EPISODE_REQUIRED');
      }
      const step = nextPilotSequence(
        sequence,
        sample,
        targetRevision(t),
        this.now(),
        this.deps.config().maxAgeMs,
        this.deps.config().maxGapMs,
        (t.effectiveBandwidthBps! * BigInt(t.triggerPercent)) / 100n,
        t.triggerSamples,
      );
      sequence = step.sequence;
      view = { state: 'IDLE', reason: step.reason };
      if (step.reason || !step.sequence || !sample)
        return decision(
          step.reason,
          step.reason === 'TELEMETRY_UNAVAILABLE' ? 'BLOCKED' : 'NO_ACTION',
          sample?.bps ?? null,
          sample?.occurredAt?.getTime(),
        );
      view = { state: 'ACTIVATING', reason: null };
      const result = await this.activate({
        profileId: t.profileId,
        autoEvidence: {
          sampleAt: new Date(step.sequence.at).toISOString(),
          continuityKey: step.sequence.key,
          sequenceStartedAt: new Date(step.sequence.start).toISOString(),
          samplesOver: step.sequence.over,
        },
      });
      sequence = null;
      if (['AUTO_PHYSICAL_READ_FAILED', 'AUTO_PHYSICAL_SCOPE_NOT_NORMAL'].includes(result.status))
        await this.holdPilotUncertain(t, result.status);
      const after = await this.deps.store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(t!)));
      const verified = result.ok && result.verified && after?.phase === 'ACTIVE';
      view = {
        state: after?.phase === 'ACTIVE' ? 'ACTIVE' : 'UNCERTAIN',
        reason: result.ok && result.verified ? null : result.status,
      };
      const [d] = decision(
        view.reason,
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
      sequence = null;
      view = { state: 'UNCERTAIN', reason: 'PILOT_DEPENDENCY_UNAVAILABLE' };
      return decision(view.reason);
    } finally {
      if (sequence) this.sequences.set(profileId, sequence);
      else this.sequences.delete(profileId);
      this.acceptAfter.set(profileId, acceptAfter);
      // D12: cada perfil guarda a SUA visao; a visao do piloto so e escrita pelo piloto.
      this.views.set(profileId, { ...view });
      if (profileId === SINGLE_AUTO_PILOT.profileId) this.pilotView = { ...view };
    }
  }
  private allowed(t: LifecycleTarget): string | null {
    const c = this.deps.config();
    if (this.deps.pilotTraffic && !c.expansionEnabled && !singlePilotIdentityMatches(t))
      return 'AUTO_SINGLE_PILOT_IDENTITY_MISMATCH';
    if (c.installation !== 'IMPLANTAR' || !c.enabled || !c.executionEnabled)
      return 'AUTO_EXECUTION_DISABLED';
    if (t.addressFamily !== 'IPV4') return 'AUTO_IPV6_CONTRACT_NOT_AUTHORIZED';
    // `*` e uma AUTORIZACAO EXPLICITA de escopo (AUTO-ALL), nunca um curinga
    // implicito: o perfil ainda precisa ter sido descoberto como AUTO elegivel
    // pelo coletor e passar por todos os gates abaixo.
    if (
      (!c.profiles.includes(t.profileId) && !c.profiles.includes('*')) ||
      !c.devices.includes(t.deviceId)
    )
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
      t.bogonNode !== 1 ||
      t.mitigationNode !== 2 ||
      t.rt !== '268568:660'
    )
      return 'AUTO_PAIR_INVALID';
    if (
      !t.effectiveBandwidthBps ||
      t.effectiveBandwidthBps <= 0n ||
      !Number.isInteger(t.triggerPercent) ||
      t.triggerPercent <= 0 ||
      t.triggerPercent > 100 ||
      !Number.isInteger(t.triggerSamples) ||
      t.triggerSamples < (c.expansionEnabled ? 3 : 1)
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
    // One shared READ-ONLY equipment snapshot for every pre-write read of this attempt (see
    // HuaweiBgpSshService.withActivationReadScope). Gates, freshness and the read-back are unchanged.
    const run = () => this.activatePhysical(t, e, at, start);
    return this.deps.readScope ? this.deps.readScope(t, run) : run();
  }
  private async activatePhysical(
    t: LifecycleTarget,
    e: NonNullable<MitigationCommandInput['autoEvidence']>,
    at: number,
    start: number,
  ): Promise<MitigationAutoCommandResult> {
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
      if (await scopeQuarantined(tx, key, t.deviceId, t.policyName!)) return null;
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
    const late = await this.deps.store.transaction(async (tx) => {
      const j = await tx.get<JournalCommand>(input.autoOperationId!);
      if (!j || j.origin !== 'AUTO' || j.action !== 'ACTIVATE') throw Error('AUTO_JOURNAL_MISSING');
      if (j.state === 'RECONCILED') {
        await this.requarantine(tx, j, result, j.id, !real);
        return true;
      }
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
      s.activeEventId = good ? s.operationId : null;
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
          s.lastSample,
        ),
        this.now(),
      );
      return false;
    });
    if (late) throw Error('AUTO_COMMAND_COMPLETED_AFTER_RELEASE');
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
    // From here on (the write path) nothing may be served from the pre-write snapshot: the last
    // physical read before the write (baseline capture) and the read-back hit the equipment.
    this.deps.closeReadScope?.();
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
      j.at = this.now();
      await tx.put(j.id, 'command', j.state, j);
      return true;
    });
  }
  /** No observation can write to Huawei. While owned, even zero traffic holds. */
  async observe(
    d: MitigationAutoDecision,
    resolveTarget: (profileId: string) => Promise<LifecycleTarget | null> = this.deps.target,
  ): Promise<void> {
    const t = await resolveTarget(d.profileId);
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
  /**
   * APPLY LOCAL changes ownership only, never rearms or removes a policy.
   *
   * Runs under the policy lock of the reconciler. A QUARANTINED scope (uncertain command,
   * interrupted operation, retained removal intent) is released ONLY with the fresh physical
   * proof of that same APPLY: policy read back NORMAL with no mitigation pair AND the BGP effect
   * proven undone (mitigation RT off the customer routes, announcement withdrawn). Without that
   * proof the quarantine holds, exactly as before. Nothing is written to the equipment.
   */
  async manualMutation(
    deviceId: string,
    policyName: string,
    proof?: {
      state: string;
      pairPresent: boolean;
      readBack: string;
      restoration?: () => Promise<{ outcome: string; summary: string }>;
    },
  ): Promise<void> {
    const key = scopeKey({ deviceId, policyName });
    const quarantined = await this.deps.store.transaction(async (tx) => {
      if (!(await scopeQuarantined(tx, key, deviceId, policyName))) return false;
      if (!proof || proof.state !== 'NORMAL' || proof.pairPresent || !proof.restoration)
        throw Error('MANUAL_RECONCILIATION_REQUIRED');
      await this.assertNothingInFlight(tx, key);
      return true;
    });
    if (quarantined) {
      // Equipment read OUTSIDE the store transaction (the caller holds the policy lock).
      const routing = await proof!.restoration!().catch(() => null);
      if (routing?.outcome !== 'PASS')
        throw Error(
          'RECONCILIATION_ROUTING_NOT_RESTORED: ' + (routing?.summary ?? 'leitura BGP indisponivel'),
        );
      const released = await this.deps.store.transaction(async (tx) => {
        // Released meanwhile by a concurrent reconciliation: nothing left to do.
        if (!(await scopeQuarantined(tx, key, deviceId, policyName))) return null;
        return this.releaseProvenAbsent(
          tx,
          key,
          deviceId,
          policyName,
          proof!.readBack,
          routing.summary,
        );
      });
      if (released) this.forgetProfiles([released]);
      return;
    }
    await this.deps.store.transaction(async (tx) => {
      const s = await tx.get<ScopeOwnership>(key);
      // Quarantined again between the two transactions: hold.
      if (await scopeQuarantined(tx, key, deviceId, policyName))
        throw Error('MANUAL_RECONCILIATION_REQUIRED');
      // An explicit absence reconciliation already released ownership. Applying
      // the reviewed NORMAL runtime must not put that scope back into MANUAL.
      if (s?.phase === 'COOLDOWN' && s.reason === 'EXPLICIT_MANUAL_RELEASE_RECONCILED') return;
      if (s) {
        s.phase = 'MANUAL';
        s.reason = 'MANUAL_RECONCILIATION';
        // Reconciled to anything but the same proven mitigation: no button refers to it any more.
        if (proof?.state !== 'MITIGATED' || !proof.pairPresent) s.activeEventId = null;
        await tx.put(key, 'scope', s.phase, s);
      }
    });
  }
  /** A PLANNED/STARTED command younger than the release age may still be running. */
  private async assertNothingInFlight(tx: AutomationTx, key: string): Promise<JournalCommand[]> {
    const now = this.now();
    const inFlight = (j: JournalCommand | null) =>
      !!j && ['PLANNED', 'STARTED'].includes(j.state) && now - j.at < QUARANTINE_RELEASE_MIN_AGE_MS;
    const s = await tx.get<ScopeOwnership>(key);
    // PLANNED included: a command still in preflight is also "possibly running"; once
    // RECONCILED it can no longer be authorized to write.
    const pending = await tx.list<JournalCommand>('command', ['PLANNED', 'STARTED', 'UNCERTAIN']);
    if (pending.length >= 1000) throw Error('RECONCILIATION_COMMAND_SET_INCOMPLETE');
    const mine = pending.filter((j) => j.scope === key);
    const current = s ? await tx.get<JournalCommand>(s.operationId) : null;
    if (mine.some(inFlight) || inFlight(current))
      throw Error('RECONCILIATION_COMMAND_IN_FLIGHT: aguarde 5 minutos desde o ultimo comando');
    return current && current.state === 'PLANNED' && !mine.some((j) => j.id === current.id)
      ? [...mine, current]
      : mine;
  }
  /**
   * Explicit operator release of a quarantined scope whose mitigation pair is PROVEN ABSENT.
   * Never forges a result: pending commands become RECONCILED (original result retained), the
   * baseline ownership is dropped (a pair created later is never adopted) and the scope goes to
   * COOLDOWN. An operation that may still be running is never released.
   */
  private async releaseProvenAbsent(
    tx: AutomationTx,
    key: string,
    deviceId: string,
    policyName: string,
    readBack: string,
    routingProof: string,
  ): Promise<string | null> {
    const now = this.now();
    const s = await tx.get<ScopeOwnership>(key);
    const mine = await this.assertNothingInFlight(tx, key);
    const id = 'manual-reconciliation-' + randomUUID();
    for (const command of mine) {
      command.state = 'RECONCILED'; // Retain the original result; never forge VERIFIED.
      await tx.put(command.id, 'command', command.state, command);
    }
    const baselineId = baselineRecordId({ deviceId, policyName });
    const raw = await tx.get<{ version?: number }>(baselineId);
    const owned = raw?.version === 1 || raw?.version === 2;
    const baseline = owned ? retainedBaseline(raw) : null;
    if (owned)
      await tx.put(
        baselineId,
        'mitigation-baseline',
        'RELEASED',
        baselineReleaseMarker({ deviceId, policyName }, baseline ?? undefined),
      );
    if (s) {
      const resolved: ScopeOwnership = {
        ...s,
        phase: 'COOLDOWN',
        owner: 'released:' + id,
        operationId: id,
        reason: 'EXPLICIT_MANUAL_RELEASE_RECONCILED',
        activeEventId: null,
        removedAt: now,
        cooldownUntil: now + this.deps.config().cooldownMs,
        lastSample: null,
      };
      await tx.put(resolved.key, 'scope', resolved.phase, resolved);
      await this.closeEpisode(tx, resolved.profileId);
    }
    await tx.put(id, 'reconciliation', 'RESOLVED_NO_WRITE', {
      id,
      scope: key,
      deviceId,
      policyName,
      previousOperationId: s?.operationId ?? null,
      previousPhase: s?.phase ?? null,
      reconciledCommands: mine.map((j) => j.id),
      at: now,
      physicalReadbackSha256: createHash('sha256').update(readBack).digest('hex'),
      routingProof,
      baselineSha256: baseline?.readBackSha256 ?? null,
      baselineDrift: baseline ? baselineDriftReasons(baseline, readBack) : [],
      action: 'RELEASE_WITHOUT_PHYSICAL_WRITE',
    });
    return s?.profileId ?? null;
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
      if (old && ['STARTED', 'UNCERTAIN', 'RECONCILED'].includes(old.state))
        throw Error('MANUAL_RECONCILIATION_REQUIRED');
      const s = await tx.get<ScopeOwnership>(key);
      // REMOVE bound to ONE mitigation (Telegram button): only the ACTIVE mitigation of the
      // scope may be removed with it. A button from an earlier mitigation never removes a new one.
      if (input.action === 'REMOVE' && input.mitigationRef) {
        const active = activeMitigationEventId(s);
        if (!active || mitigationRefOf(active) !== input.mitigationRef)
          throw Error('MITIGATION_REFERENCE_STALE');
      }
      if (await scopeQuarantined(tx, key, deviceId, policyName))
        throw Error('MANUAL_RECONCILIATION_REQUIRED');
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
      if (
        !j.deviceId ||
        !j.policyName ||
        (await scopeQuarantined(tx, j.scope, j.deviceId, j.policyName))
      )
        return false;
      j.state = 'STARTED';
      j.at = this.now();
      await tx.put(j.id, 'command', j.state, j);
      return true;
    });
  }
  /**
   * A command finished AFTER its scope was released by reconciliation: its write was authorized,
   * so the physical state is unknown again. Never recorded as success or as a mere rejection:
   * the scope goes back to quarantine and the operator is told.
   */
  private async requarantine(
    tx: AutomationTx,
    j: JournalCommand,
    result: MitigationActionResult,
    eventId: string,
    simulation: boolean,
  ): Promise<void> {
    j.state = 'UNCERTAIN';
    j.result = { ...result };
    j.at = this.now();
    await tx.put(j.id, 'command', j.state, j);
    const s = await tx.get<ScopeOwnership>(j.scope);
    if (s) {
      s.phase = 'UNCERTAIN';
      s.reason = 'COMMAND_COMPLETED_AFTER_RELEASE';
      s.activeEventId = null;
      s.operationId = j.id;
      await tx.put(s.key, 'scope', s.phase, s);
    }
    await enqueueNotification(
      tx,
      this.resultNotification(result, 'MITIGATION_FAILED', eventId + ':after-release', simulation),
      this.now(),
    );
  }
  async completeManual(
    input: MitigationCommandInput,
    result: MitigationActionResult,
    real: boolean,
  ): Promise<void> {
    const late = await this.deps.store.transaction(async (tx) => {
      const j = await tx.get<JournalCommand>(manualKey(input.requestId));
      if (
        !j ||
        j.origin !== 'MANUAL' ||
        j.action !== input.action ||
        j.profileId !== input.profileId
      )
        throw Error('MANUAL_JOURNAL_MISSING');
      if (j.state === 'RECONCILED') {
        await this.requarantine(tx, j, result, input.requestId, !real);
        return true;
      }
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
          activeEventId: input.requestId,
        };
      }
      if (s) {
        if (verified && input.action === 'REMOVE') {
          s.phase = 'COOLDOWN';
          s.owner = 'released:' + input.requestId;
          s.reason = 'MANUAL_REMOVE_VERIFIED';
          s.activeEventId = null;
          s.removedAt = this.now();
          s.cooldownUntil = this.now() + this.deps.config().cooldownMs;
          s.lastSample = null;
          await this.closeEpisode(tx, s.profileId);
          if (s.profileId !== input.profileId) await this.closeEpisode(tx, input.profileId);
        } else {
          s.phase = verified ? 'MANUAL' : j.state === 'STARTED' ? 'UNCERTAIN' : 'MANUAL';
          s.reason = verified ? 'MANUAL_ACTIVATE_VERIFIED' : result.status;
          // Verified ACTIVATE: this is now THE mitigation of the scope. A write with unknown
          // outcome drops the binding. A rejection before any write leaves it untouched, so the
          // button of the current mitigation keeps working after a refused/duplicate command.
          if (verified) s.activeEventId = input.requestId;
          else if (j.state === 'STARTED') s.activeEventId = null;
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
      return false;
    });
    // Thrown AFTER the commit: the caller reports the command as not synchronized (never ok).
    if (late) throw Error('MANUAL_COMMAND_COMPLETED_AFTER_RELEASE');
  }
  /**
   * Explicit operator reconciliation. No Huawei mutation and no node adoption.
   * Must run through the same physical-scope lock; absence + permanent baseline
   * are read again before the transactional release/audit receipt is committed.
   * This is deliberately not called by ticks, timers, startup or readback errors.
   */
  async reconcileManualRelease(input: {
    profileId: string;
    expectedOperationId: string;
    actor: string;
    reason: string;
  }): Promise<{ status: 'RECONCILED_RELEASED'; reconciliationId: string }> {
    if (!input.actor.trim() || !input.reason.trim() || !input.expectedOperationId)
      throw Error('EXPLICIT_RECONCILIATION_EVIDENCE_REQUIRED');
    const t = await this.deps.target(input.profileId);
    if (!t?.policyName || !this.deps.scopeLock || !this.deps.readPolicy)
      throw Error('RECONCILIATION_DEPENDENCIES_REQUIRED');
    return this.deps.scopeLock.run({ deviceId: t.deviceId, policyName: t.policyName }, async () => {
      const baselineId = baselineRecordId({ deviceId: t.deviceId, policyName: t.policyName! });
      const before = await this.deps.store.transaction(async (tx) => ({
        scope: await tx.get<ScopeOwnership>(scopeKey(t)),
        baseline: await tx.get(baselineId),
      }));
      if (
        !before.scope ||
        before.scope.phase !== 'UNCERTAIN' ||
        before.scope.profileId !== input.profileId ||
        before.scope.operationId !== input.expectedOperationId
      )
        throw Error('RECONCILIATION_SCOPE_CHANGED');
      const baseline = retainedBaseline(before.baseline);
      if (!baseline || baseline.deviceId !== t.deviceId || baseline.policyName !== t.policyName)
        throw Error('RECONCILIATION_BASELINE_EVIDENCE_REQUIRED');
      const readBack = await this.deps.readPolicy!(t);
      const physical = inspectPolicyMitigation({
        policyName: t.policyName!,
        readBack,
        rts: [t.rt],
      });
      if (
        physical.state !== 'NORMAL' ||
        physical.pair ||
        baselineDriftReasons(baseline, readBack).length
      )
        throw Error('RECONCILIATION_PHYSICAL_ABSENCE_NOT_PROVEN');
      const id = 'manual-reconciliation-' + randomUUID();
      await this.deps.store.transaction(async (tx) => {
        const current = await tx.get<ScopeOwnership>(scopeKey(t));
        const currentBaseline = await tx.get(baselineId);
        if (
          JSON.stringify(current) !== JSON.stringify(before.scope) ||
          JSON.stringify(currentBaseline) !== JSON.stringify(before.baseline)
        )
          throw Error('RECONCILIATION_SCOPE_CHANGED');
        const commands = await tx.list<JournalCommand>('command', ['STARTED', 'UNCERTAIN']);
        if (commands.length >= 1000) throw Error('RECONCILIATION_COMMAND_SET_INCOMPLETE');
        for (const command of commands.filter((j) => j.scope === scopeKey(t))) {
          command.state = 'RECONCILED'; // Retain the original failed result; never forge VERIFIED.
          await tx.put(command.id, 'command', command.state, command);
        }
        await tx.put(
          baselineId,
          'mitigation-baseline',
          'RELEASED',
          baselineReleaseMarker({ deviceId: t.deviceId, policyName: t.policyName! }, baseline),
        );
        const resolved: ScopeOwnership = {
          ...current!,
          phase: 'COOLDOWN',
          owner: 'released:' + id,
          operationId: id,
          reason: 'EXPLICIT_MANUAL_RELEASE_RECONCILED',
          activeEventId: null,
          removedAt: this.now(),
          cooldownUntil: this.now() + this.deps.config().cooldownMs,
          lastSample: null,
        };
        await tx.put(resolved.key, 'scope', resolved.phase, resolved);
        await this.closeEpisode(tx, resolved.profileId);
        await tx.put(id, 'reconciliation', 'RESOLVED_NO_WRITE', {
          id,
          actor: input.actor,
          reason: input.reason,
          scope: resolved.key,
          previousOperationId: input.expectedOperationId,
          at: this.now(),
          physicalReadbackSha256: createHash('sha256').update(readBack).digest('hex'),
          baselineSha256: baseline.readBackSha256,
          action: 'RELEASE_WITHOUT_PHYSICAL_WRITE',
        });
      });
      this.forgetProfiles([t.profileId]);
      return { status: 'RECONCILED_RELEASED', reconciliationId: id };
    });
  }

  /** Legacy interrupted REMOVE intents are quarantined, never replayed. */
  async reconcile(): Promise<void> {
    this.pilotReconciled = false;
    this.sequences.clear();
    this.acceptAfter.clear();
    this.views.clear();
    this.pilotView = { state: 'UNCERTAIN', reason: 'RECONCILIATION_REQUIRED' };
    await this.deps.store.transaction(async (tx) => {
      const pending = await tx.list<JournalCommand>('command', ['STARTED', 'UNCERTAIN']);
      if (pending.length >= 1000) throw Error('RECONCILIATION_COMMAND_SET_INCOMPLETE');
      for (const j of pending) {
        const s = await tx.get<ScopeOwnership>(j.scope);
        if (s && s.phase !== 'UNCERTAIN') {
          s.phase = 'UNCERTAIN';
          s.reason = 'RESTART_COMMAND_OUTCOME_UNCERTAIN';
          s.operationId = j.id;
          await tx.put(s.key, 'scope', s.phase, s);
        }
      }
    });
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
    if (this.deps.pilotTraffic)
      for (const id of this.deps.config().expansionEnabled
        ? this.deps.config().profiles
        : [SINGLE_AUTO_PILOT.profileId]) {
        const t = await this.deps.target(id);
        if (
          !t ||
          t.addressFamily !== 'IPV4' ||
          (!this.deps.config().expansionEnabled && !singlePilotIdentityMatches(t))
        )
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
        const view: typeof this.pilotView = {
          state:
            !current || current.phase === 'COOLDOWN'
              ? 'IDLE'
              : current.phase === 'ACTIVE' ||
                  (current.phase === 'MANUAL' && current.reason === 'MANUAL_ACTIVATE_VERIFIED')
                ? 'ACTIVE'
                : 'UNCERTAIN',
          reason: current?.reason ?? null,
        };
        this.views.set(id, view);
        if (id === SINGLE_AUTO_PILOT.profileId) this.pilotView = { ...view };
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
      s.activeEventId = null;
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
    const n = this.enrich(await build({ ...d, episodeId: ep.id }), d.direction, Date.parse(d.sampleAt ?? d.at));
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
    return this.enrich({
      ...unverifiedPhysicalExtras(r),
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
    });
  }
  private notification(
    t: LifecycleTarget,
    r: Pick<MitigationActionResult, 'verified' | 'customer' | 'device' | 'interface'> &
      Partial<Pick<MitigationActionResult, 'status'>>,
    event: MitigationNotification['event'],
    id: string,
    simulation: boolean,
    confirmedAtMs?: number | null,
  ): MitigationNotification {
    return this.enrich({
      ...unverifiedPhysicalExtras(r),
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
    }, event === 'MITIGATION_VERIFIED' ? t.activationDirection ?? t.direction : t.direction, confirmedAtMs);
  }

  private enrich(notification: MitigationNotification, direction?: 'rx' | 'tx' | null, confirmedAtMs?: number | null): MitigationNotification {
    try {
      return this.deps.enrichNotification?.(notification, direction, confirmedAtMs) ?? notification;
    } catch {
      return notification;
    }
  }
}
