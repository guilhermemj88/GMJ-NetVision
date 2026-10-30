import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHuaweiAdvertisedRoutes } from '../huawei-bgp-advertised-routes-parser';
import { buildMitigationWebhookPayload } from './mitigation-webhook';
import type { MitigationNotification } from './notification-publisher';
import { MemoryAutomationStore } from '../../../worker/mitigation/automation-store';
import { DurableMitigationOutbox } from '../../../worker/mitigation/durable-mitigation-outbox';

const scope = JSON.parse(
  readFileSync(
    new URL('../../../../../../docs/evidence/aglink-prefix-scope-fixture.json', import.meta.url),
    'utf8',
  ),
) as {
  profileId: string;
  deviceId: string;
  policy: string;
  peer: string;
  receivedRoutes: string;
};
const prefixes = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];
type PrefixNotice = MitigationNotification & { prefixes?: string[] | null };
type ScopeEvidence = Pick<typeof scope, 'profileId' | 'policy' | 'peer' | 'receivedRoutes'>;

// Contract prototype ONLY, deliberately outside the runtime. An integration
// would obtain this scoped evidence in the canonical command path and persist
// it with the event. Prefixes identify affected scope, not verified RT changes.
function proposedNotification(
  n: MitigationNotification,
  evidence: ScopeEvidence | null,
): PrefixNotice {
  const parsed = evidence
    ? parseHuaweiAdvertisedRoutes(evidence.receivedRoutes, {
        addressFamily: 'IPV4',
        localAs: 268568n,
      })
    : null;
  const matches =
    n.event === 'MITIGATION_VERIFIED' &&
    n.verified === true &&
    !n.simulation &&
    n.addressFamily === 'IPV4' &&
    evidence?.profileId === n.profileId &&
    evidence?.policy === n.policy &&
    evidence?.peer === n.peer &&
    parsed !== null &&
    parsed.reportedTotal !== null &&
    parsed.reportedTotal > 0 &&
    parsed.routes.length === parsed.reportedTotal &&
    parsed.warnings.length === 0 &&
    parsed.routes.every((r) => r.nextHop === n.peer);
  const selected = matches ? [...new Set(parsed.routes.map((r) => r.prefix))].sort() : null;
  return {
    ...n,
    prefixes: selected,
    fieldsUnavailable: [
      ...new Set([...(n.fieldsUnavailable ?? []), ...(selected ? [] : ['prefixes'])]),
    ],
  };
}
function proposedPayload(n: PrefixNotice) {
  return { ...buildMitigationWebhookPayload(n), prefixes: n.prefixes ?? null };
}
function fixtureNotice(): MitigationNotification {
  return {
    event: 'MITIGATION_VERIFIED',
    eventId: 'ISOLATED-CONTRACT-NO-HUAWEI-NO-TELEGRAM',
    profileId: scope.profileId,
    addressFamily: 'IPV4',
    customer: 'OFFLINE CONTRACT FIXTURE',
    device: 'OFFLINE',
    policy: scope.policy,
    peer: scope.peer,
    affectedPeers: [scope.peer],
    simulation: false, // synthetic input exercises the real-event contract locally
    verified: true, // a fixture value, never evidence of physical Huawei readback
    interfaceName: 'Eth-Trunk1.3058',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 10_000_000_000n,
    trafficBps: null,
    thresholdBps: 9_000_000_000n,
    node: 2,
    bogonNode: 1,
    mitigationNode: 2,
    rt: '268568:660',
  };
}

describe('proposed additive prefix contract; no deployed code or n8n change', () => {
  it('documents the current serializer gap instead of claiming it already sends prefixes', () => {
    const notification = { ...fixtureNotice(), prefixes };
    expect(buildMitigationWebhookPayload(notification)).not.toHaveProperty('prefixes');
  });
  it('carries the three observed scope prefixes while retaining every legacy payload field', () => {
    const n = proposedNotification(fixtureNotice(), scope);
    expect(n.prefixes).toEqual(prefixes);
    const { prefixes: added, ...legacy } = proposedPayload(n);
    expect(added).toEqual(prefixes);
    expect(legacy).toEqual(buildMitigationWebhookPayload(n));
    expect(legacy).toMatchObject({ rt: '268568:660', verified: true, eventId: n.eventId });
  });
  it.each(['profileId', 'policy', 'peer'] as const)('rejects mismatched %s evidence', (key) => {
    const n = proposedNotification(fixtureNotice(), { ...scope, [key]: 'wrong-scope' });
    expect(n.prefixes).toBeNull();
    expect(n.fieldsUnavailable).toContain('prefixes');
  });
  it('does not replace missing evidence with a list hardcoded from profileId', () => {
    expect(proposedNotification(fixtureNotice(), null).prefixes).toBeNull();
  });
  it('rejects incomplete received-route output without emitting a partial list', () => {
    const incomplete = scope.receivedRoutes.replace(
      'Total Number of Routes: 3',
      'Total Number of Routes: 4',
    );
    expect(
      proposedNotification(fixtureNotice(), { ...scope, receivedRoutes: incomplete }).prefixes,
    ).toBeNull();
  });
  it('never promotes a failed/unverified result to verified', () => {
    const n = proposedNotification({ ...fixtureNotice(), verified: false }, scope);
    expect(n.verified).toBe(false);
    expect(n.prefixes).toBeNull();
  });
  it('does not attach IPv4 evidence to an IPv6 notification', () => {
    expect(
      proposedNotification({ ...fixtureNotice(), addressFamily: 'IPV6' }, scope).prefixes,
    ).toBeNull();
  });
  it('keeps prefix scope and eventId stable through the existing JSON outbox retry codec', async () => {
    const store = new MemoryAutomationStore();
    let now = 0;
    const sent: ReturnType<typeof proposedPayload>[] = [];
    let acknowledged = false;
    const transport = {
      publish: async (n: MitigationNotification) => {
        sent.push(proposedPayload(n));
        return { published: acknowledged, skipped: false };
      },
    };
    let outbox = new DurableMitigationOutbox(store, transport, () => now);
    await outbox.publish(proposedNotification(fixtureNotice(), scope));
    await outbox.drain();
    expect(sent).toHaveLength(1);
    now = 30_000;
    acknowledged = true;
    outbox = new DurableMitigationOutbox(store, transport, () => now);
    await outbox.drain();
    await outbox.drain();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[1]?.prefixes).toEqual(prefixes);
  });
});
