/**
 * Benchmark ISOLADO do caminho de decisão da RC2 (sem SSH, sem banco, sem rede).
 *
 * Mede o custo de avaliação do motor por tick nos dois contratos de fonte, para
 * comparar com os números do rc1. Não é teste: não falha por orçamento.
 *
 * Uso: npx tsx src/scripts/bench-mitigation-rc2.ts [iteracoes]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASE_TIME, Runner, type Step } from '../testing/mitigation-engine-harness';

const iterations = Number(process.argv[2] ?? 300);
const over = 9_500_000_000n;
const at = (offsetMs: number) => BASE_TIME + offsetMs;

const fastSampling = () => ({ maxAgeMs: 30_000, maxGapMs: 45_000 as number | null });

const fastSteps: Step[] = [
  { at: at(0), sample: { bps: over, atMs: at(0), rateStartAtMs: at(-10_000) } },
  { at: at(10_000), sample: { bps: over, atMs: at(10_000), rateStartAtMs: at(0) } },
  { at: at(20_000), sample: { bps: over, atMs: at(20_000), rateStartAtMs: at(10_000) } },
];

const legacySteps: Step[] = [
  { at: at(0), sample: { bps: over, atMs: at(0) } },
  { at: at(100_000) },
  { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
  { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
  { at: at(378_000), sample: { bps: over, atMs: at(378_000) } },
];

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
};

async function measure(label: string, make: () => Runner, steps: Step[]) {
  const tickMs: number[] = [];
  const pipelineMs: number[] = [];
  let activated = 0;
  for (let run = 0; run < iterations; run++) {
    const runner = make();
    const started = performance.now();
    let previous = started;
    for (const step of steps) {
      await runner.run([step]);
      const now = performance.now();
      tickMs.push(now - previous);
      previous = now;
    }
    pipelineMs.push(performance.now() - started);
    if (runner.calls.length > 0) activated++;
  }
  const result = {
    scenario: label,
    iterations,
    activatedRatio: Number((activated / iterations).toFixed(3)),
    tickMs: {
      p50: Number(percentile(tickMs, 0.5).toFixed(3)),
      p95: Number(percentile(tickMs, 0.95).toFixed(3)),
      max: Number(Math.max(...tickMs).toFixed(3)),
    },
    pipelineMs: {
      p50: Number(percentile(pipelineMs, 0.5).toFixed(3)),
      p95: Number(percentile(pipelineMs, 0.95).toFixed(3)),
      max: Number(Math.max(...pipelineMs).toFixed(3)),
    },
  };
  console.log(
    `${label.padEnd(22)} ticks p50 ${String(result.tickMs.p50).padStart(7)} ms | p95 ${String(
      result.tickMs.p95,
    ).padStart(7)} ms | max ${String(result.tickMs.max).padStart(7)} ms | pipeline p50 ${String(
      result.pipelineMs.p50,
    ).padStart(7)} ms`,
  );
  return result;
}

async function main() {
  const results = [
    await measure(
      'FAST 10s (3 amostras)',
      () => new Runner({ sampling: fastSampling }, false),
      fastSteps,
    ),
    await measure(
      'FAST SHADOW (3 amostras)',
      () => new Runner({ sampling: fastSampling, evaluationScope: 'SHADOW' }, false),
      fastSteps,
    ),
    await measure('LEGACY 126s', () => new Runner({}, false), legacySteps),
    await measure('LEGACY publicado', () => new Runner({}, true), legacySteps),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: 'v2026.10.18-ddos-fast-bridge-rc2',
    baseline: 'fc790ade3455f2c16eeff372a8a9168deffb0d7d',
    note: 'Virtual clock, synthetic source and synthetic executor. Measures decision cost only; no SSH/SQL/network.',
    results,
  };
  const out = resolve(process.cwd(), '../../.artifacts/rc2/benchmark-rc2.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nJSON: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
