import type { LifecycleConfig, LifecycleTarget } from './auto-lifecycle';
import type { MitigationTrafficSample } from './mitigation-traffic-source';
import {
  fastContinuityWindowMs,
  readFastNormalIntervalMs,
} from '../../infrastructure/snmp/fast-cadence';
import {
  parseHuaweiBgpPolicyConfiguration,
  resolvePeerInboundPolicy,
  parseHuaweiRoutePolicyNodes,
} from '../../infrastructure/bgp/mitigation/huawei-bgp-policy-parser';

/**
 * Janela do contrato publicado quando o chamador nao informa a cadencia:
 * cadencia nominal de 10 s => 15 s de frescor/continuidade.
 */
export const FAST_DEFAULT_WINDOW = Object.freeze({
  maxAgeMs: fastContinuityWindowMs(readFastNormalIntervalMs({})),
  maxGapMs: fastContinuityWindowMs(readFastNormalIntervalMs({})),
});

/** Reviewed pilot identity. These are planned nodes, never evidence of occupancy. */
export const SINGLE_AUTO_PILOT = Object.freeze({
  profileId: 'cmuoavm4e00bysslhqd0h3q7u',
  deviceId: 'host-377c554a-8d1e-47c4-baa4-f258693b4d91',
  hostname: 'BHE-VTA-F1A-BGP-01',
  interfaceId: 'cmsxk21gs03pdssimims9ojlb',
  interfaceName: 'Eth-Trunk1.3058',
  ifIndex: 236,
  customer: 'AGLINK-IPV4',
  policy: 'PL-AGLINK_IPv4-IN',
  rt: '268568:660',
  bogon: 1,
  mitigation: 2,
  bandwidthBps: 10_000_000_000n,
  thresholdBps: 9_000_000_000n,
});

export function assertSinglePilotAuthorization(c: LifecycleConfig): void {
  if (!c.enabled) return;
  if (c.expansionEnabled === true) {
    if (c.installation !== 'IMPLANTAR' || !c.profiles.length || !c.devices.length ||
        new Set(c.profiles).size !== c.profiles.length || c.profiles.length > 128 ||
        // D12: device duplicado e configuracao ambigua (o mesmo device contado duas vezes).
        new Set(c.devices).size !== c.devices.length || c.devices.length > 64 ||
        !Number.isInteger(c.maxActive) || c.maxActive < 1 || c.maxActive > 10)
      throw Error('AUTO_EXPANSION_EXPLICIT_AUTHORIZATION_REQUIRED');
    return;
  }
  if (
    c.installation !== 'IMPLANTAR' ||
    c.profiles.length !== 1 ||
    c.profiles[0] !== SINGLE_AUTO_PILOT.profileId ||
    c.devices.length !== 1 ||
    c.devices[0] !== SINGLE_AUTO_PILOT.deviceId ||
    c.maxActive !== 1
  )
    throw Error('SINGLE_PILOT_EXPLICIT_AUTHORIZATION_REQUIRED');
}

export function singlePilotIdentityMatches(t: LifecycleTarget): boolean {
  const p = SINGLE_AUTO_PILOT,
    b = t.clientBinding;
  return (
    t.profileId === p.profileId &&
    t.deviceId === p.deviceId &&
    t.interfaceId === p.interfaceId &&
    t.customer === p.customer &&
    t.policyName === p.policy &&
    t.addressFamily === 'IPV4' &&
    t.direction === 'tx' &&
    t.rt === p.rt &&
    t.bogonNode === p.bogon &&
    t.mitigationNode === p.mitigation &&
    t.effectiveBandwidthBps === p.bandwidthBps &&
    t.triggerPercent === 90 &&
    t.triggerSamples === 3 &&
    !!b &&
    b.interfaceName === p.interfaceName &&
    b.ifIndex === p.ifIndex
  );
}

/** Read-only, under the existing writer lock: pin the observed dedicated BGP scope. */
export function singlePilotPhysicalScopeMatches(input: {
  bgpConfiguration: string | null;
  routePolicyConfiguration: string | null;
  prefixListConfiguration: string | null;
}): boolean {
  if (!input.bgpConfiguration || !input.routePolicyConfiguration || !input.prefixListConfiguration)
    return false;
  const bgp = parseHuaweiBgpPolicyConfiguration(input.bgpConfiguration);
  const peers = [...new Set([...bgp.directPeerPolicies.keys(), ...bgp.peerGroups.keys()])].filter(
    (key) => {
      const [family, peer] = key.split('\u0000');
      return (
        (family === 'IPV4' || family === 'IPV6') &&
        !!peer &&
        resolvePeerInboundPolicy(peer, family, bgp) === SINGLE_AUTO_PILOT.policy
      );
    },
  );
  if (peers.length !== 1 || peers[0] !== 'IPV4\u000010.200.201.2') return false;
  const nodes = parseHuaweiRoutePolicyNodes(input.routePolicyConfiguration).get(
    SINGLE_AUTO_PILOT.policy,
  );
  if (!nodes || nodes.length !== 2) return false;
  const permit = nodes.find((n) => n.node === 10),
    deny = nodes.find((n) => n.node === 1000);
  if (
    !permit ||
    !deny ||
    permit.action !== 'permit' ||
    deny.action !== 'deny' ||
    permit.ifMatchIpPrefix.join() !== 'AGLINK-BLOCO-TODO-23' ||
    permit.routeTargets.join() !== '268568:140' ||
    deny.ifMatchIpPrefix.length ||
    deny.routeTargets.length
  )
    return false;
  const lines = input.prefixListConfiguration
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '));
  const target = lines.filter((line) => line.startsWith('ip ip-prefix PREFIX8to24 '));
  return (
    target.length === 1 &&
    target[0] ===
      'ip ip-prefix PREFIX8to24 index 10 permit 0.0.0.0 8 greater-equal 8 less-equal 24' &&
    lines.some((line) => line.startsWith('ip ip-prefix BOGONS ')) &&
    lines.filter((line) => line.startsWith('ip ip-prefix AGLINK-BLOCO-TODO-23 ')).join() ===
      'ip ip-prefix AGLINK-BLOCO-TODO-23 index 10 permit 167.250.126.0 23 greater-equal 23 less-equal 24'
  );
}

export interface PilotSequence {
  key: string;
  revision: string;
  at: number;
  id: string;
  start: number;
  over: number;
}

/** Recheck the third sample or exactly its adjacent successor after preflight. */
export function pilotEvidenceValid(
  sample: MitigationTrafficSample | null,
  evidence: { sampleAt: string; continuityKey: string } | undefined,
  now: number,
  thresholdBps: bigint = SINGLE_AUTO_PILOT.thresholdBps,
  /**
   * D4: janela DERIVADA da cadencia do coletor (mesma do poller). Ausente =
   * janela do contrato publicado (cadencia 10 s -> 15 s), sem afrouxar nada.
   */
  window: { maxAgeMs: number; maxGapMs: number } = FAST_DEFAULT_WINDOW,
): boolean {
  if (!sample || !evidence || !sample.occurredAt || !sample.rateStartAt) return false;
  const at = +sample.occurredAt,
    previous = +sample.rateStartAt,
    trigger = Date.parse(evidence.sampleAt);
  return (
    Number.isFinite(trigger) &&
    trigger <= now &&
    now - trigger <= window.maxAgeMs &&
    at <= now &&
    now - at <= window.maxAgeMs &&
    previous < at &&
    at - previous <= window.maxGapMs &&
    sample.continuityKey === evidence.continuityKey &&
    sample.bps > thresholdBps &&
    (at === trigger || previous === trigger)
  );
}

/**
 * Backstop for the ORIGINAL trigger sample when the evidence is re-validated after the preflight.
 * It is NOT the freshness limit (that stays `window.maxAgeMs`, 15 s, and is applied to the CURRENT
 * sample): it is the same 60 s response deadline the engine already reports as
 * `responseDeadlineExceeded`, so a sequence that is older than the whole response budget can never
 * be revived by a newer sample.
 */
export const AUTO_TRIGGER_EVIDENCE_DEADLINE_MS = 60_000;

/**
 * Post-preflight re-validation of the AUTO evidence (FAST → detection → dispatch → PREFLIGHT →
 * THIS → reservation/authorization → executor).
 *
 * `pilotEvidenceValid` ties the write to the ORIGINAL trigger sample: it must be at most 15 s old and
 * the freshest sample must be that very sample or the one right after it. The preflight (physical
 * reads + 18 checks) legitimately takes ~7 s and the dispatch ~7 s before it, so with a 5 s FAST
 * cadence that rule is arithmetically unsatisfiable (the first real AUTO attempt was rejected with
 * AUTO_TELEMETRY_UNAVAILABLE at ~15.3 s although traffic stayed at ~7x the threshold).
 *
 * This keeps every safety property but moves the freshness proof to where it belongs — the sample
 * that is about to authorize the write:
 *  - the CURRENT sample is valid telemetry of the SAME continuity (`continuityKey`, which embeds the
 *    FAST generation, device, interface, ifIndex and direction) and is not older than `maxAgeMs`;
 *  - its own rate window is continuous (`previous < at`, gap ≤ `maxGapMs`): lost samples widen it
 *    and are rejected;
 *  - it is NOT older than the trigger and its window does not reach back before the trigger
 *    (`at === trigger || previous >= trigger`);
 *  - traffic is STILL above the threshold in that sample (`bps > threshold`, strict);
 *  - the original trigger is within the response deadline (`deadlineMs`), never revived beyond it.
 * Missing/invalid telemetry, a changed continuity or traffic at/below the threshold return `null`
 * (block). On success it returns the evidence REFRESHED to the current sample (`sampleAt`), which
 * is what the write authorization must see; the sequence identity/start/count are untouched.
 */
export function refreshPilotEvidence<E extends { sampleAt: string; continuityKey: string }>(
  sample: MitigationTrafficSample | null,
  evidence: E | undefined,
  now: number,
  thresholdBps: bigint,
  window: { maxAgeMs: number; maxGapMs: number },
  deadlineMs: number = AUTO_TRIGGER_EVIDENCE_DEADLINE_MS,
): E | null {
  if (!sample || !evidence || !sample.occurredAt || !sample.rateStartAt) return null;
  const at = +sample.occurredAt,
    previous = +sample.rateStartAt,
    trigger = Date.parse(evidence.sampleAt);
  if (!Number.isFinite(at) || !Number.isFinite(previous) || !Number.isFinite(trigger)) return null;
  const valid =
    trigger <= now &&
    now - trigger <= deadlineMs &&
    at <= now &&
    now - at <= window.maxAgeMs &&
    previous < at &&
    at - previous <= window.maxGapMs &&
    sample.continuityKey === evidence.continuityKey &&
    sample.bps > thresholdBps &&
    at >= trigger &&
    (at === trigger || previous >= trigger);
  return valid ? { ...evidence, sampleAt: new Date(at).toISOString() } : null;
}

/** Pure counter only. It cannot write hardware, store ownership, or send HTTP. */
export function nextPilotSequence(
  old: PilotSequence | null,
  sample: MitigationTrafficSample | null,
  revision: string,
  now: number,
  maxAge: number,
  maxGap: number,
  thresholdBps: bigint = SINGLE_AUTO_PILOT.thresholdBps,
  triggerSamples = 3,
): {
  sequence: PilotSequence | null;
  reason:
    | 'TELEMETRY_UNAVAILABLE'
    | 'DUPLICATE_SAMPLE'
    | 'THRESHOLD_NOT_EXCEEDED'
    | 'SAMPLES_INSUFFICIENT'
    | null;
} {
  const at = sample?.occurredAt?.getTime() ?? NaN;
  const start = sample?.rateStartAt?.getTime() ?? NaN;
  if (
    !sample ||
    !sample.sampleKey ||
    !sample.continuityKey ||
    sample.bps < 0n ||
    !Number.isFinite(at) ||
    !Number.isFinite(start) ||
    at > now ||
    now - at > maxAge ||
    start >= at ||
    at - start > maxGap
  )
    return { sequence: old ? { ...old, over: 0 } : null, reason: 'TELEMETRY_UNAVAILABLE' };
  if (old && (at < old.at || (at === old.at && sample.sampleKey !== old.id)))
    return { sequence: { ...old, over: 0 }, reason: 'TELEMETRY_UNAVAILABLE' };
  if (
    old?.id === sample.sampleKey &&
    (at !== old.at || old.key !== sample.continuityKey || old.revision !== revision)
  )
    return { sequence: { ...old, over: 0 }, reason: 'TELEMETRY_UNAVAILABLE' };
  if (old?.id === sample.sampleKey) return { sequence: old, reason: 'DUPLICATE_SAMPLE' };
  const continuous =
    old &&
    old.revision === revision &&
    old.key === sample.continuityKey &&
    start === old.at &&
    at - old.at <= maxGap;
  const over = sample.bps > thresholdBps ? (continuous ? old.over : 0) + 1 : 0;
  const sequence = {
    key: sample.continuityKey,
    revision,
    id: sample.sampleKey,
    at,
    start: continuous && old.over > 0 ? old.start : at,
    over,
  };
  return {
    sequence,
    reason: over === 0 ? 'THRESHOLD_NOT_EXCEEDED' : over < triggerSamples ? 'SAMPLES_INSUFFICIENT' : null,
  };
}
