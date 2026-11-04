// Adapted from preserved auditor reproduction; corrected expectations only.
/* global console, setTimeout */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  createPilotHarness,
  PilotFakeHuawei,
} from '../../../apps/api/src/testing/single-pilot-harness.ts';
import { HuaweiMitigationExecutor } from '../../../apps/api/src/infrastructure/bgp/mitigation/huawei-mitigation-executor.ts';
import { testDurableBaselineStore } from '../../../apps/api/src/infrastructure/bgp/mitigation/mitigation-test-support.ts';
import { SINGLE_AUTO_PILOT as P } from '../../../apps/api/src/worker/mitigation/single-pilot-trigger.ts';
import { MemoryMitigationBaselineStore } from '../../../apps/api/src/infrastructure/bgp/mitigation/mitigation-baseline-record.ts';

const rows = [];
for (const node of [0, 1, 2]) {
  const h = await createPilotHarness(),
    ssh = new PilotFakeHuawei();
  const store = testDurableBaselineStore();
  const live = new HuaweiMitigationExecutor({
    ssh,
    baseline: store,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [P.deviceId] },
  });
  const input = {
    policyName: P.policy,
    bogonNode: 1,
    mitigationNode: 2,
    rt: P.rt,
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'unused',
  };
  const pre = await live.preflight(h.host, {
    ...input,
    mode: 'ACTIVATE',
    expectedExistingNodes: [10, 1000],
  });
  assert.equal(pre.ok, true);
  const normal = ssh.config();
  ssh.config = () =>
    `route-policy ${P.policy} permit node ${node}\n if-match ip-prefix OPERATOR_ONLY\n${normal}`;
  let error = '';
  try {
    await live.activate(h.host, { ...input, preflightBaseline: pre.baselineRecord! });
  } catch (e) {
    error = String(e);
  }
  assert.match(error, /MITIGATION_NODE_OCCUPIED/);
  assert.equal(ssh.writes.length, 0);
  rows.push({
    test: 'node appears at second read',
    node,
    blocked: true,
    writes: ssh.writes.length,
  });
}
// Same request in flight: two other operations must fail immediately without inherited fields.
{
  const h = await createPilotHarness();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    latch = new Promise<void>((r) => (release = r));
  h.ssh.afterWrite = async () => {
    enter();
    await latch;
  };
  const first = h.commands.execute({
    requestId: 'parallel-request',
    profileId: P.profileId,
    action: 'ACTIVATE',
  });
  await entered;
  for (const [profileId, action] of [
    [P.profileId, 'REMOVE'],
    ['another-profile', 'ACTIVATE'],
  ] as const) {
    const result = await Promise.race([
      h.commands.execute({ requestId: 'parallel-request', profileId, action }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Error('conflict waited for foreign operation')), 500),
      ),
    ]);
    assert.equal(result.status, 'IDEMPOTENCY_CONFLICT');
    assert.equal(result.policy, null);
    assert.equal(result.interfaceId, null);
    assert.equal(result.verification, null);
    assert.deepEqual(result.commandPreview, []);
    rows.push({
      test: 'parallel identity collision',
      profileId,
      action,
      status: result.status,
      noForeignReceipt: true,
    });
  }
  const replay = h.commands.execute({
    requestId: 'parallel-request',
    profileId: P.profileId,
    action: 'ACTIVATE',
  });
  release();
  assert.equal((await first).verified, true);
  assert.equal((await replay).idempotent, true);
  assert.equal(h.ssh.writes.length, 1);
  rows.push({ test: 'same identity simultaneous replay', mutantWrites: h.ssh.writes.length });
}
{
  const h = await createPilotHarness();
  h.config.executionEnabled = false;
  for (let i = 0; i < 5; i++) {
    h.sample(9500000000n);
    await h.lifecycle.tickPilot();
  }
  assert.equal(h.ssh.writes.length, 0);
  rows.push({ test: 'global AUTO switch OFF', samples: 5, writes: 0 });
  const result = await h.commands.execute({
    requestId: 'auto-remove-independent',
    profileId: P.profileId,
    action: 'REMOVE',
    origin: 'AUTO',
  });
  assert.equal(result.verified, false);
  assert.equal(h.ssh.writes.length, 0);
  rows.push({ test: 'automatic REMOVE forbidden', status: result.status, writes: 0 });
}
{
  const h = await createPilotHarness(),
    ssh = new PilotFakeHuawei();
  const live = new HuaweiMitigationExecutor({
    ssh,
    baseline: new MemoryMitigationBaselineStore(),
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [P.deviceId] },
  });
  const pre = await live.preflight(h.host, {
    policyName: P.policy,
    bogonNode: 1,
    mitigationNode: 2,
    rt: P.rt,
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'unused',
    mode: 'ACTIVATE',
    expectedExistingNodes: [10, 1000],
  });
  assert.equal(pre.ok, false);
  assert(pre.blockedReasons.some((r) => r.includes('baseline_record_store')));
  assert.equal(ssh.writes.length, 0);
  rows.push({ test: 'non-durable baseline store', blocked: true, writes: 0 });
}
writeFileSync(
  'C:/projetos/GMJ-NetVision-auto-all-ipv4-fast-fixes/docs/audits/f1-f4-corrections/independent-guards.json',
  JSON.stringify(
    { candidate: '1c37f15a076de9bc9c2fcf83d6caa6024db02c98', syntheticOnly: true, rows },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ independentGuardCases: rows.length, passed: true }));
