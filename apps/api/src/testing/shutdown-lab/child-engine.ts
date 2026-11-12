/**
 * LABORATORIO (nunca em producao, nunca toca equipamento): processo-filho com Fastify REAL, os mesmos hooks onClose de
 * routes.ts (hook de desconexao registrado ANTES, hook de settle registrado POR ULTIMO), `installGracefulShutdown` e
 * `settleBeforeClose` REAIS, MitigationAutoEngine REAL com `asyncExecution`, e lock advisory REAL em PostgreSQL
 * (PrismaPolicyScopeLock). O "ACTIVATE" e um comando simulado que segura o lock da policy por ACTIVATE_MS e NAO escreve
 * em nenhum equipamento. Cada linha de stdout e um marcador que o ensaio confere.
 *
 * env: SHUTDOWN_LAB_DATABASE_URL, LAB_PROFILES (1..2), LAB_ACTIVATE_MS, MITIGATION_SHUTDOWN_SETTLE_MS
 */
import Fastify from 'fastify';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaPolicyScopeLock } from '../../infrastructure/bgp/mitigation/prisma-policy-scope-lock';
import { POLICY_SCOPE_LOCK_TIMEOUT_MS } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import {
  MitigationAutoEngine,
  type MitigationAutoCommandResult,
  type MitigationAutoTargetState,
} from '../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../worker/mitigation/mitigation-traffic-source';
import { settleBeforeClose } from '../../worker/mitigation/shutdown-settle';
import { installGracefulShutdown } from '../../graceful-shutdown';

const mark = (m: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ m, t: Date.now(), ...extra }) + '\n');

const url = process.env.SHUTDOWN_LAB_DATABASE_URL!;
const profiles = Number(process.env.LAB_PROFILES ?? 1);
const activateMs = Number(process.env.LAB_ACTIVATE_MS ?? 1500);
const DEVICE = 'lab-device';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;

const db = new PrismaClient({ datasourceUrl: url });
const lock = new PrismaPolicyScopeLock(db, POLICY_SCOPE_LOCK_TIMEOUT_MS);

const targets = Array.from({ length: profiles }, (_, i) => ({
  profileId: 'P' + i,
  deviceId: DEVICE,
  interfaceId: 'if-' + i,
  customer: 'CLIENTE-' + i,
  mode: 'AUTO',
  snapshotAvailable: true,
  readiness: 'READY',
  prefixStatus: 'SAFE',
  blockedReason: null,
  mitigationExcluded: false,
  runtimeState: 'NORMAL',
  effectiveBandwidthBps: BW,
  bogonNode: 1,
  mitigationNode: 2,
  sharedPolicy: false,
  peerAddresses: ['10.0.0.' + (i + 1)],
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  policyName: 'LAB-POLICY-' + i,
})) as unknown as MitigationAutoTargetState[];

const traffic = new SequenceTrafficSource();
const engine = new MitigationAutoEngine({
  executionControl: { enabled: true },
  sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
  globalMode: 'AUTO',
  execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
  targets: { list: async () => targets },
  traffic,
  exclusions: { listPeerExclusions: async () => [] },
  runtime: {
    get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 }),
    save: async () => undefined,
  },
  commands: {
    execute: async (input) => {
      const t = targets.find((x) => x.profileId === input.profileId)!;
      return lock.run({ deviceId: DEVICE, policyName: t.policyName! }, async (lease) => {
        mark('ACTIVATE_START', { profile: input.profileId });
        await new Promise((r) => setTimeout(r, activateMs));
        await lease.assertHeld(); // o banco/lock precisam estar de pe ate o fim da operacao
        mark('ACTIVATE_END', { profile: input.profileId });
        return { ok: true, verified: true, status: 'ACTIVATED_VERIFIED' } as MitigationAutoCommandResult;
      });
    },
  },
  now: () => new Date(),
  asyncExecution: true,
  maxConcurrentExecutions: 2,
});

async function main() {
  const app = Fastify();
  // Mesma ordem de routes.ts: o hook que desconecta o banco e registrado ANTES...
  app.addHook('onClose', async () => {
    mark('PRISMA_DISCONNECT');
    await db.$disconnect();
  });
  // ...e o de settle POR ULTIMO (roda PRIMEIRO no encerramento).
  app.addHook('onClose', async () => {
    mark('SETTLE_BEGIN', { inFlight: engine.inFlightProfiles() });
    const r = await settleBeforeClose(engine, {
      warn: (o, m) => mark('LOG_WARN', { msg: m, ...o }),
      error: (o, m) => mark('LOG_ERROR', { msg: m, ...o }),
    });
    mark('SETTLE_END', { timedOut: r.timedOut });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  installGracefulShutdown(app, {
    onSignal: (s) => mark('SIGNAL', { s }),
    exit: (code) => {
      mark('EXIT', { code });
      process.exit(code);
    },
  });
  // dispara o(s) ACTIVATE(s): 3 amostras acima do limiar por perfil
  for (let i = 0; i < 3; i++) {
    for (const t of targets) traffic.push(t.profileId, OVER);
    await engine.tick();
  }
  mark('READY', { inFlight: engine.inFlightProfiles() });
}
void main().catch((e) => {
  mark('FATAL', { e: String(e) });
  process.exit(2);
});
