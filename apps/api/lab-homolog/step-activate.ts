import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyActivation } from '../src/infrastructure/bgp/mitigation/mitigation-executor';
import {
  ACTIVATE_INPUT,
  DEVICE_ID,
  POLICY,
  RT,
  STATE_PATH,
  baselineStore,
  check,
  device,
  executor,
  prismaClient,
  report,
} from './shared';
import { SimulatedRouter } from './router-sim';

/**
 * ETAPA 2 — ACTIVATE em equipamento simulado, com executor e persistencia REAIS.
 *
 * Processo A: cria o equipamento simulado do zero, executa o ACTIVATE e morre.
 * Nada de estado em memoria e reaproveitado pelo processo seguinte.
 */
async function main(): Promise<void> {
  SimulatedRouter.reset(STATE_PATH, POLICY);
  const before = readFileSync(STATE_PATH, 'utf8');
  const router = new SimulatedRouter(STATE_PATH);
  const client = prismaClient();
  const store = baselineStore(client);
  const live = executor(router, store);

  await client.mitigationAutomationRecord.deleteMany({});

  const preflight = await live.preflight(device(), ACTIVATE_INPUT);
  report('ETAPA2 preflight', {
    ok: preflight.ok,
    blockedReasons: preflight.blockedReasons,
    preserved: preflight.preservedClauses,
    baselineStoreCheck: check('baseline_record_store', preflight),
    preservedCheck: check('preserved_attributes', preflight),
    occupancy: check('node_occupancy', preflight),
  });
  if (!preflight.ok) throw new Error(`PREFLIGHT RECUSADO: ${preflight.blockedReasons.join('; ')}`);

  const write = await live.activate(device(), {
    policyName: POLICY,
    bogonNode: ACTIVATE_INPUT.bogonNode,
    mitigationNode: ACTIVATE_INPUT.mitigationNode,
    rt: RT,
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'PREFIX8to24',
    preservedClauses: preflight.preservedClauses!,
  });
  report('ETAPA2 escrita', { output: write.output, comandos: router.appliedCommands.flat() });

  const readBack = await live.readRoutePolicy(device(), POLICY);
  const verification = verifyActivation(
    POLICY,
    readBack,
    { bogonNode: 1, mitigationNode: 2 },
    RT,
    { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
    preflight.preservedClauses!,
  );
  report('ETAPA2 readback', { verified: verification.verified, summary: verification.summary });

  const stored = await client.mitigationAutomationRecord.findMany();
  report('ETAPA2 registro no PostgreSQL', stored);

  const after = readFileSync(STATE_PATH, 'utf8');
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(`${STATE_PATH}.before.json`, before, 'utf8');
  writeFileSync(`${STATE_PATH}.after-activate.json`, after, 'utf8');

  if (!verification.verified) throw new Error('READBACK NAO VERIFICADO');
  if (stored.length !== 1) throw new Error(`registro inesperado: ${stored.length}`);
  if ((stored[0]?.payload as { deviceId?: string }).deviceId !== DEVICE_ID) {
    throw new Error('registro com device errado');
  }

  await client.$disconnect();
  process.stdout.write('\nETAPA2 PASS\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\nETAPA2 FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
