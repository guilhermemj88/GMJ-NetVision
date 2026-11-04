// Adapted from preserved auditor reproduction; corrected expectations only.
/* eslint-disable @typescript-eslint/no-explicit-any -- Independent audit fixtures only. */
/* global console */
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { inspectPolicyMitigation } from '../../../apps/api/src/infrastructure/bgp/mitigation/mitigation-policy-physical.ts';
import { createPilotHarness } from '../../../apps/api/src/testing/single-pilot-harness.ts';
import { MemoryAutomationStore } from '../../../apps/api/src/worker/mitigation/automation-store.ts';
import { AutoMitigationLifecycle } from '../../../apps/api/src/worker/mitigation/auto-lifecycle.ts';
import { SINGLE_AUTO_PILOT as P } from '../../../apps/api/src/worker/mitigation/single-pilot-trigger.ts';
import { baselineRecordId } from '../../../apps/api/src/infrastructure/bgp/mitigation/mitigation-baseline-record.ts';

const evidence: Record<string, unknown> = {
  base: '640a7014b4b077c54f2adc7fe0e1098d6bb985f9',
  candidate: '1c37f15a076de9bc9c2fcf83d6caa6024db02c98',
  implementerDifferentialRecheck: true,
  syntheticOnly: true,
  realHuawei: false,
};
const policy = 'PL-LIVINET_IPv4-IN';
const inspect = (body: string) =>
  inspectPolicyMitigation({ policyName: policy, readBack: body, rts: ['268568:660'] });
const denyBogons = [
  `route-policy ${policy} deny node 5`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${policy} permit node 10`,
  ' if-match as-path-filter CLIENT',
  `route-policy ${policy} deny node 1000`,
].join('\n');
const result = inspect(denyBogons);
assert.equal(result.state, 'NORMAL');
evidence.d9 = {
  expected: 'NORMAL for a legitimate isolated permanent deny BOGONS',
  actual: result,
  input: denyBogons,
  mutatedHardware: false,
};

const backing = new MemoryAutomationStore();
let failRelease = false;
const store = {
  transaction: async (work: any) =>
    backing.transaction(async (tx) =>
      work({
        ...tx,
        put: async (id: string, kind: string, status: string, payload: unknown) => {
          if (failRelease && kind === 'mitigation-baseline' && status === 'RELEASED')
            throw Error('injected release persistence failure');
          return tx.put(id, kind, status, payload);
        },
      }),
    ),
};
const h = await createPilotHarness(store);
for (const bps of [9200000000n, 9300000000n, 9400000000n]) {
  h.sample(bps);
  await h.lifecycle.tickPilot();
}
assert.equal((await h.scope())?.phase, 'ACTIVE');
failRelease = true;
const failedRemoval = await h.commands.execute({
  requestId: 'independent-release-fail',
  action: 'REMOVE',
  profileId: P.profileId,
});
assert.equal(failedRemoval.verified, false);
assert.equal(h.ssh.active, false);
const afterFailedRemoval = await h.scope();
const staleBaseline = await store.transaction((tx: any) =>
  tx.get(baselineRecordId({ deviceId: P.deviceId, policyName: P.policy })),
);
assert.equal(afterFailedRemoval?.phase, 'UNCERTAIN');
failRelease = false;
await h.restart();
const afterRestart = await h.scope();
assert.equal(afterRestart?.phase, 'UNCERTAIN');
// Outside actor installs identical text after NetVision physically removed its own pair.
const normalText = h.ssh.config();
const foreignText = h.ssh.writes[0]!.filter((c) => c !== 'system-view' && c !== 'commit').join(
  '\n',
);
h.ssh.config = () => [...(h.ssh.active ? [foreignText] : []), normalText].join('\n');
h.ssh.active = true;
const beforeWrites = h.ssh.writes.length;
const retry = await h.commands.execute({
  requestId: 'independent-new-remove-foreign-pair',
  action: 'REMOVE',
  profileId: P.profileId,
});
assert.equal((staleBaseline as any).version, 2);
assert.equal(retry.status, 'MANUAL_RECONCILIATION_REQUIRED');
assert.equal(h.ssh.writes.length, beforeWrites);
assert.equal((await h.scope())?.phase, 'UNCERTAIN');

evidence.d3 = {
  failedRemoval: {
    status: failedRemoval.status,
    verified: failedRemoval.verified,
    safeError: failedRemoval.safeError,
  },
  afterFailedRemoval,
  staleBaselineStillValid: !!staleBaseline && (staleBaseline as any).version === 1,
  afterRestart,
  foreignPairInstalledInFake: true,
  retry: {
    status: retry.status,
    verified: retry.verified,
    safeError: retry.safeError,
    blockedReasons: retry.preflight?.blockedReasons,
  },
  additionalMutantWrites: h.ssh.writes.length - beforeWrites,
  scopeAfterRetry: await h.scope(),
};

// Start reconciliation with AGLINK healthy and another target physically uncertain.
const h2 = await createPilotHarness();
const other = {
  ...h2.target,
  profileId: 'other-ipv4',
  interfaceId: 'other-if',
  policyName: 'PL-OTHER_IPv4-IN',
  customer: 'OTHER',
  clientBinding: {
    ...h2.target.clientBinding!,
    profileId: 'other-ipv4',
    interfaceId: 'other-if',
    customer: 'OTHER',
  },
};
const lc = new AutoMitigationLifecycle({
  store: new MemoryAutomationStore(),
  config: () => ({
    ...h2.config,
    expansionEnabled: true,
    profiles: [P.profileId, other.profileId],
  }),
  target: async (id) => (id === P.profileId ? h2.target : id === other.profileId ? other : null),
  pilotTraffic: { sampleWithId: async () => null },
  execute: async () => {
    throw Error('NO_WRITES_ALLOWED');
  },
  physical: async (t) =>
    t.profileId === P.profileId
      ? { state: 'NORMAL', bogon: null, mitigation: null, rt: null }
      : { state: 'UNKNOWN', bogon: null, mitigation: null, rt: null },
  now: h2.now,
});
await lc.reconcile();
assert.equal(lc.pilotStatus()?.state, 'IDLE');
assert.equal(lc.expansionStatus()[P.profileId]?.state, 'IDLE');
assert.equal(lc.expansionStatus()[other.profileId]?.state, 'UNCERTAIN');
evidence.d12 = {
  aglinkPhysicalState: 'NORMAL',
  otherPhysicalState: 'UNKNOWN',
  beforeFirstTick: { pilotStatus: lc.pilotStatus(), expansionStatus: lc.expansionStatus() },
};
await lc.tickPilot();
(evidence.d12 as any).afterFirstTick = {
  pilotStatus: lc.pilotStatus(),
  expansionStatus: lc.expansionStatus(),
};

writeFileSync(
  'C:/projetos/GMJ-NetVision-auto-all-ipv4-fast-fixes/docs/audits/f1-f4-corrections/reproductions.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    d9: result.state,
    d3: { retryStatus: retry.status, additionalWrites: h.ssh.writes.length - beforeWrites },
    d12: evidence.d12,
  }),
);
