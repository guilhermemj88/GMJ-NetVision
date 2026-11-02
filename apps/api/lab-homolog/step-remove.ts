import { readFileSync, writeFileSync } from 'node:fs';
import { verifyRemoval } from '../src/infrastructure/bgp/mitigation/mitigation-executor';
import { parseHuaweiRoutePolicyNodes } from '../src/infrastructure/bgp/mitigation/huawei-bgp-policy-parser';
import {
  DEVICE_ID,
  POLICY,
  REMOVE_INPUT,
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
 * ETAPAS 3 e 4 — processo NOVO: recupera o baseline EXCLUSIVAMENTE do
 * PostgreSQL, prova o par ativo no equipamento simulado (que sobreviveu, como
 * um roteador real) e executa o REMOVE.
 */
function diffLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (const line of a) if (!b.includes(line)) out.push(`- ${line}`);
  for (const line of b) if (!a.includes(line)) out.push(`+ ${line}`);
  return out;
}

async function main(): Promise<void> {
  const client = prismaClient();
  const store = baselineStore(client);
  const router = new SimulatedRouter(STATE_PATH);
  const live = executor(router, store);

  // ETAPA 3: prova de que o registro existe SOMENTE no PostgreSQL.
  const fromDb = await store.load({ deviceId: DEVICE_ID, policyName: POLICY });
  report('ETAPA3 baseline lido do PostgreSQL pela instancia B', {
    encontrado: fromDb !== null,
    deviceId: fromDb?.deviceId,
    policyName: fromDb?.policyName,
    par: fromDb ? { bogon: fromDb.bogonNode, mitigation: fromDb.mitigationNode } : null,
    nodesPermanentes: fromDb?.nodes.map((node) => node.node),
    readBackSha256: fromDb?.readBackSha256,
    capturedAt: fromDb?.capturedAt,
  });
  if (!fromDb) throw new Error('baseline NAO recuperado do PostgreSQL apos restart');

  const stateBefore = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
    policyName: string;
    nodes: { node: number }[];
    commits: number;
  };
  report('ETAPA3 equipamento simulado apos o restart da API', {
    policy: stateBefore.policyName,
    nodes: stateBefore.nodes.map((node) => node.node).sort((a, b) => a - b),
    commits: stateBefore.commits,
  });

  // ETAPA 4: preflight de REMOVE — sem snapshot de discovery de proposito.
  const preflight = await live.preflight(device(), { ...REMOVE_INPUT, expectedExistingNodes: null });
  report('ETAPA4 preflight REMOVE', {
    ok: preflight.ok,
    blockedReasons: preflight.blockedReasons,
    baselineRecord: check('policy_baseline_record', preflight),
    scope: check('policy_mitigation_scope', preflight),
    readBackNodes: preflight.readBackNodes,
  });
  if (!preflight.ok) throw new Error(`PREFLIGHT REMOVE RECUSADO: ${preflight.blockedReasons.join('; ')}`);
  const write = await live.remove(device(), { policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
  report('ETAPA4 escrita', { output: write.output, comandos: router.appliedCommands.flat() });

  const readBack = await live.readRoutePolicy(device(), POLICY);
  const verification = verifyRemoval(POLICY, readBack, { bogonNode: 1, mitigationNode: 2 });
  report('ETAPA4 readback pos-remove', {
    verified: verification.verified,
    summary: verification.summary,
    nodes: (parseHuaweiRoutePolicyNodes(readBack).get(POLICY) ?? []).map((node) => node.node),
  });

  const after = readFileSync(STATE_PATH, 'utf8');
  writeFileSync(`${STATE_PATH}.after-remove.json`, after, 'utf8');
  const original = readFileSync(`${STATE_PATH}.before.json`, 'utf8');
  // A comparacao e da CONFIGURACAO (route-policy), nunca do contador de commits
  // do simulador — ele existe apenas como prova interna de transporte.
  const configOf = (raw: string): string => {
    const parsed = JSON.parse(raw) as { nodes: unknown[] };
    return JSON.stringify(parsed.nodes);
  };
  report('ETAPA4 diff antes/depois final', {
    configIgualAoOriginal: configOf(original) === configOf(after),
    diffConfig: diffLines(configOf(original), configOf(after)),
    commitsSimulados: (JSON.parse(after) as { commits: number }).commits,
  });

  const policyNames = [...parseHuaweiRoutePolicyNodes(new SimulatedRouter(STATE_PATH).renderConfig(JSON.parse(after) as never)).keys()];
  report('ETAPA4 policies tocadas', { policies: policyNames });

  if (!verification.verified) throw new Error('READBACK DE REMOCAO NAO VERIFICADO');
  const finalState = JSON.parse(after) as { nodes: { node: number }[] };
  const finalNodes = finalState.nodes.map((node) => node.node).sort((a, b) => a - b);
  if (JSON.stringify(finalNodes) !== JSON.stringify([10, 1000])) {
    throw new Error(`nodes finais inesperados: ${finalNodes.join(',')}`);
  }
  if (configOf(original) !== configOf(after)) {
    throw new Error('configuracao final diferente da original');
  }

  await client.$disconnect();
  process.stdout.write('\nETAPA4 PASS\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\nETAPA4 FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
