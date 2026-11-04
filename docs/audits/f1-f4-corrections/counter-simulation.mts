// Adapted from preserved auditor reproduction; corrected expectations only.
/* eslint-disable @typescript-eslint/no-explicit-any -- Independent audit fixtures only. */
/* global console */
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { deriveFastTraffic } from '../../../apps/api/src/infrastructure/snmp/fast-traffic-rate.ts';
import { fastContinuityWindowMs } from '../../../apps/api/src/infrastructure/snmp/fast-cadence.ts';
import { nextPilotSequence } from '../../../apps/api/src/worker/mitigation/single-pilot-trigger.ts';
const BW = 10_000_000_000;
const target = {
  deviceId: 'sim',
  interfaceId: 'if-sim',
  ifIndex: 1,
  interfaceName: 'Eth-Trunk1.sim',
  speedBps: BigInt(BW),
  profiles: [],
};
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const stats = (v: number[]) => ({
  n: v.length,
  p50: percentile(v, 0.5),
  p95: percentile(v, 0.95),
  p99: percentile(v, 0.99),
  max: Math.max(...v),
});
function trial(cadence: number, timeout: number, seed: number, attack = true) {
  const random = rng(seed),
    attackAt = Math.round(random() * cadence),
    window = fastContinuityWindowMs(cadence);
  let previous: any = undefined,
    sequence: any = null,
    first: number | null = null,
    confirmed: number | null = null,
    timeouts = 0;
  const samples = [];
  for (let index = 0; index <= 12; index++) {
    const scheduled = index * cadence;
    if (random() < timeout) {
      previous = undefined;
      sequence = null;
      timeouts++;
      continue;
    }
    const at = Math.round(scheduled + 20 + random() * 280);
    // Counters integrate the traffic actually offered over elapsed time, including lost GETs.
    const before = attack ? Math.min(at, attackAt) : at,
      after = attack ? Math.max(0, at - attackAt) : 0;
    const current = {
      ...target,
      requestStartedAt: new Date(scheduled),
      collectedAt: new Date(at),
      inOctets: BigInt(Math.round((0.2 * BW * at) / 8000)),
      outOctets: BigInt(Math.round((0.3 * BW * before + BW * after) / 8000)),
      uptimeTicks: BigInt(500000 + Math.floor(at / 10)),
      discontinuityTicks: 0n,
      lastChangeTicks: 0n,
      adminStatus: 1,
      operStatus: 1,
    };
    const o = deriveFastTraffic(target, current, previous, 'simulation', window, 2000);
    previous = current;
    if (o.quality !== 'VALID') {
      sequence = null;
      continue;
    }
    const sample = {
      bps: BigInt(Math.round(o.txBps!)),
      occurredAt: o.collectedAt,
      rateStartAt: o.previousCollectedAt,
      sampleKey: o.id,
      continuityKey: o.generation,
    };
    const step = nextPilotSequence(sequence, sample, 'revision', at, window, window);
    sequence = step.sequence;
    if (sample.bps > 9_000_000_000n && first === null) first = at - attackAt;
    if (sequence?.over === 3 && confirmed === null) confirmed = at - attackAt;
    samples.push({ at, over: sequence?.over ?? 0 });
  }
  return { first, confirmed, timeouts, falsePositive: !attack && confirmed !== null };
}
const rows = [];
for (const [cadenceMs, timeoutRate] of [
  [10000, 0],
  [15000, 0],
  [30000, 0],
  [10000, 0.03],
]) {
  const trials = Array.from({ length: 40 }, (_, i) =>
    trial(cadenceMs!, timeoutRate!, 1234 + i * 7919),
  );
  const first = trials.flatMap((x) => (x.first === null ? [] : [x.first])),
    confirmation = trials.flatMap((x) => (x.confirmed === null ? [] : [x.confirmed]));
  rows.push({
    cadenceMs,
    timeoutRate,
    trials: 40,
    confirmed: confirmation.length,
    firstAbnormalMs: stats(first),
    confirmationMs: stats(confirmation),
    timeouts: trials.reduce((s, x) => s + x.timeouts, 0),
  });
}
const benign = Array.from({ length: 1000 }, (_, i) => trial(10000, 0.03, i + 1, false));
assert.equal(benign.filter((t) => t.falsePositive).length, 0);
const result = {
  syntheticClock: true,
  physicalHomologation: false,
  counterModel:
    'time integral of offered bps, counters continue during timeouts; actual nextPilotSequence; failures invalidate baseline',
  rows,
  benignTrials: benign.length,
  falsePositives: benign.filter((t) => t.falsePositive).length,
  commandSshMs: null,
  physicalReadbackMs: null,
  bgpEffectiveMitigationMs: null,
};
writeFileSync(
  'C:/projetos/GMJ-NetVision-auto-all-ipv4-fast-fixes/docs/audits/f1-f4-corrections/counter-simulation.json',
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result));
