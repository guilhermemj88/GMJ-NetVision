import { describe, expect, it } from 'vitest';
import {
  createAutoAllHarness,
  LEGACY_EXEMPT,
  OTHER,
} from '../../testing/auto-all-physical-harness';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';
import {
  engineLegacyExemptProfileIds,
  physicalEvidenceSource,
  usesExternalPilotRuntime,
} from './auto-all-wiring';

const HIGH = 9_400_000_000n; // > 90% of 10 Gbps
const LOW = 300_000_000n;
const decisionOf = (
  all: Awaited<ReturnType<Awaited<ReturnType<typeof createAutoAllHarness>>['cycle']>>,
  id: string,
) => all.find((d) => d.profileId === id)!;

async function warm(h: Awaited<ReturnType<typeof createAutoAllHarness>>) {
  await h.cycle({}); // BASELINE observation
  await h.cycle({}); // first VALID rate
}

describe('AUTO-ALL wiring rules (single collection path, single decision path)', () => {
  it('never uses the external pilot runtime or bridge telemetry with the embedded FAST', () => {
    expect(usesExternalPilotRuntime({ autoAllEnforce: true, lifecycleEnabled: true })).toBe(false);
    expect(usesExternalPilotRuntime({ autoAllEnforce: true, lifecycleEnabled: false })).toBe(false);
    expect(physicalEvidenceSource({ autoAllEnforce: true, lifecycleEnabled: true })).toBe(
      'EMBEDDED_FAST',
    );
    // reviewed single-pilot topology keeps its own path
    expect(usesExternalPilotRuntime({ autoAllEnforce: false, lifecycleEnabled: true })).toBe(true);
    expect(physicalEvidenceSource({ autoAllEnforce: false, lifecycleEnabled: true })).toBe(
      'EXTERNAL_BRIDGE',
    );
    expect(physicalEvidenceSource({ autoAllEnforce: false, lifecycleEnabled: false })).toBe(
      'EFFECTIVE_ROUTING',
    );
  });
  it('legacy exemption is nullified only under AUTO-ALL', () => {
    expect(
      engineLegacyExemptProfileIds({ autoAllEnforce: true, lifecycleEnabled: true }, ['x']),
    ).toEqual([]);
    expect(
      engineLegacyExemptProfileIds({ autoAllEnforce: false, lifecycleEnabled: true }, ['x']),
    ).toEqual(['x']);
  });
});

describe('AUTO-ALL HOLD on the embedded FAST (execution disabled): zero physical commands', () => {
  it('1/3 -> 2/3 -> 3/3 yields WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED and no SSH write', async () => {
    const h = await createAutoAllHarness({ executionEnabled: false });
    await warm(h);
    const seen: Array<[string, number]> = [];
    for (let i = 0; i < 3; i++) {
      const d = decisionOf(await h.cycle({ [P.profileId]: HIGH }), P.profileId);
      seen.push([`${d.outcome}/${d.reason}`, d.samplesOver]);
    }
    expect(seen).toEqual([
      ['TRIGGER_PENDING/SAMPLES_INSUFFICIENT', 1],
      ['TRIGGER_PENDING/SAMPLES_INSUFFICIENT', 2],
      ['WOULD_ACTIVATE/AUTO_EXECUTION_DISABLED', 3],
    ]);
    expect(h.ssh.writes).toHaveLength(0);
    expect(h.ssh.calls).toBe(0);
    expect(h.used).toEqual({ bridge: 0, legacy: 0 });
  });
});

describe('AUTO-ALL physical execution through the embedded FAST (simulated executor)', () => {
  it('detect -> confirm 1/3..3/3 -> decide -> execute -> verify, one ACTIVATE, canonical commands', async () => {
    const h = await createAutoAllHarness();
    await warm(h);
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = decisionOf(await h.cycle({ [P.profileId]: HIGH }), P.profileId);
      steps.push(`${d.samplesOver}:${d.outcome}`);
    }
    expect(steps).toEqual(['1:TRIGGER_PENDING', '2:TRIGGER_PENDING', '3:ACTIVATED']);
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes[0]).toEqual([
      'system-view',
      `route-policy ${P.policy} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${P.policy} permit node 2`,
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect((await h.physical({ policyName: P.policy, rt: P.rt })).state).toBe('MITIGATED');
    // telemetry came ONLY from the embedded FAST store
    expect(h.used).toEqual({ bridge: 0, legacy: 0 });
    // sustained traffic does not write again (capacity/ownership)
    await h.cycle({ [P.profileId]: HIGH });
    await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
  });

  it('the activation read scope wraps only authorized attempts (never other profiles)', async () => {
    const h = await createAutoAllHarness();
    await warm(h);
    for (let i = 0; i < 4; i++)
      await h.cycle({
        [P.profileId]: HIGH,
        [OTHER.profileId]: HIGH,
        [LEGACY_EXEMPT.profileId]: HIGH,
      });
    expect(h.scopeCalls).toEqual([P.profileId]);
  });

  it('other AUTO profiles and the legacy-exempt profile never get physical authorization', async () => {
    const h = await createAutoAllHarness();
    await warm(h);
    for (let i = 0; i < 6; i++) {
      const all = await h.cycle({
        [OTHER.profileId]: HIGH,
        [LEGACY_EXEMPT.profileId]: HIGH,
      });
      for (const id of [OTHER.profileId, LEGACY_EXEMPT.profileId]) {
        const d = decisionOf(all, id);
        expect(d.outcome).not.toBe('ACTIVATED');
        if (d.samplesOver >= 3)
          expect(['AUTO_EXECUTION_NOT_AUTHORIZED', 'AUTO_NOT_ALLOWLISTED']).toContain(d.reason);
      }
    }
    expect(h.ssh.writes).toHaveLength(0);
    expect(h.ssh.calls).toBe(0);
    expect(await h.scope(OTHER.profileId)).toBeFalsy();
    expect(await h.scope(LEGACY_EXEMPT.profileId)).toBeFalsy();
  });

  it('with the kill switch off the pilot is only detected, never written', async () => {
    const h = await createAutoAllHarness({ executionEnabled: false });
    await warm(h);
    for (let i = 0; i < 5; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(0);
  });

  it('empty/other allowlist: the pilot is not authorized', async () => {
    const h = await createAutoAllHarness({ allowlist: [OTHER.profileId] });
    await warm(h);
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(0);
  });

  it('recovery: restart reconciles ACTIVE without rewriting; manual REMOVE verifies and cooldown blocks re-arm', async () => {
    const h = await createAutoAllHarness();
    await warm(h);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    // process restart: counters are lost, ownership is durable, nothing is replayed
    await h.restart();
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    // traffic recovery never removes automatically (AUTO_REMOVE=0)
    for (let i = 0; i < 15; i++) await h.cycle({ [P.profileId]: LOW });
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
    // operator releases it
    const removed = await h.commands.execute({
      requestId: 'manual-clear',
      profileId: P.profileId,
      action: 'REMOVE',
    });
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.ssh.writes).toHaveLength(2);
    expect(h.ssh.active).toBe(false);
    // inside the cooldown a new attack is detected but cannot write
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(2);
    // after the cooldown a NEW episode can re-arm
    h.advance(61_000);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: LOW });
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(3);
    expect(h.used).toEqual({ bridge: 0, legacy: 0 });
  });

  it('the last physical read before the write and the read-back never come from the snapshot', async () => {
    const h = await createAutoAllHarness({ sshLatencyMs: 200 });
    await warm(h);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    const paid = h.paidOps();
    // 1 snapshot (first pre-write read), then the baseline capture right before the write, the write and the read-back
    expect(paid[0]).toMatch(/^read:/);
    expect(paid.slice(1)).toEqual([
      'read:readMitigationConfiguration',
      'write:apply',
      'read:readMitigationRoutePolicy',
    ]);
  });

  it('SSH latency budget: stale evidence is rejected fail-closed (no relaxed freshness); the read scope widens the budget', async () => {
    const outcome = async (latencyMs: number, useReadScope: boolean, decisionDelayMs: number) => {
      const h = await createAutoAllHarness({
        sshLatencyMs: latencyMs,
        useReadScope,
        decisionDelayMs,
      });
      await warm(h);
      for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
      return h.ssh.writes.length;
    };
    const sweep = async (useReadScope: boolean, decisionDelayMs: number) => {
      const out: Record<number, number> = {};
      for (const ms of [0, 1000, 2000, 3000, 4000, 5000, 6000, 8000])
        out[ms] = await outcome(ms, useReadScope, decisionDelayMs);
      return out;
    };
    for (const delay of [0, 2500, 4900]) {
      console.log(
        `SSH_BUDGET decision ${delay} ms after the sample | per-operation latency without scope:`,
        JSON.stringify(await sweep(false, delay)),
        '| per-snapshot latency with scope:',
        JSON.stringify(await sweep(true, delay)),
      );
    }
    expect(await outcome(0, false, 0)).toBe(1);
    expect(await outcome(2500, false, 0)).toBe(0);
    expect(await outcome(3500, true, 4900)).toBe(1);
    expect(await outcome(8000, true, 4900)).toBe(0);
  });
});
