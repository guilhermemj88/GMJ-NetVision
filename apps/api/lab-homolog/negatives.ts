import { readFileSync, writeFileSync } from 'node:fs';
import { ACTIVATE_INPUT, DEVICE_ID, POLICY, REMOVE_INPUT, RT, STATE_PATH, baselineStore, check, device, executor, prismaClient, report } from './shared';
import { seedDevice, SimulatedRouter, type SimDevice } from './router-sim';
import { captureMitigationBaseline } from '../src/infrastructure/bgp/mitigation/mitigation-baseline-record';

/** ETAPA 5 — cenarios negativos (nenhum deles pode escrever no "equipamento"). */

type Case = { name: string; pass: boolean; detail: string; evidence?: unknown };
const results: Case[] = [];

const activated = (): SimDevice => {
  const state = seedDevice(POLICY);
  state.nodes = [
    { node: 1, action: 'deny', ifMatch: ['BOGONS'], applies: [] },
    {
      node: 2,
      action: 'permit',
      ifMatch: ['PREFIX8to24'],
      applies: ['apply local-preference 1100', 'apply extcommunity rt 268568:140 rt 268568:660 additive'],
    },
    ...state.nodes,
  ];
  return state;
};

const writeState = (state: SimDevice): void => {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
};

const readState = (): SimDevice => JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SimDevice;

async function main(): Promise<void> {
  const client = prismaClient();
  const store = baselineStore(client);

  // ---------- 1) baseline AUSENTE ----------
  {
    writeState(activated());
    await client.mitigationAutomationRecord.deleteMany({});
    const router = new SimulatedRouter(STATE_PATH);
    const live = executor(router, store);
    const result = await live.preflight(device(), { ...REMOVE_INPUT, expectedExistingNodes: null });
    const record = check('policy_baseline_record', result);
    results.push({
      name: 'baseline ausente bloqueia REMOVE',
      pass: !result.ok && (record?.detail.includes('MITIGATION_BASELINE_RECORD_MISSING') ?? false),
      detail: record?.detail ?? 'sem check',
      evidence: { escritas: router.appliedCommands.length },
    });
  }

  // ---------- 2) baseline CORROMPIDO ----------
  {
    writeState(activated());
    const record = captureMitigationBaseline({
      deviceId: DEVICE_ID,
      policyName: POLICY,
      readBack: new SimulatedRouter(STATE_PATH).renderConfig(activated()),
      bogonNode: 1,
      mitigationNode: 2,
    })!;
    await store.save(record);
    await client.$executeRawUnsafe(
      `update "MitigationAutomationRecord" set payload = '{"version":1}'::jsonb where id like 'mitigation-baseline:%'`,
    );
    const router = new SimulatedRouter(STATE_PATH);
    const result = await executor(router, store).preflight(device(), {
      ...REMOVE_INPUT,
      expectedExistingNodes: null,
    });
    const check1 = check('policy_baseline_record', result);
    results.push({
      name: 'baseline corrompido bloqueia REMOVE',
      pass: !result.ok && (check1?.detail.includes('RECORD_MISSING') ?? false),
      detail: check1?.detail ?? 'sem check',
      evidence: { escritas: router.appliedCommands.length },
    });
  }

  // ---------- 3) node permanente MODIFICADO ----------
  {
    const original = activated();
    writeState(original);
    const record = captureMitigationBaseline({
      deviceId: DEVICE_ID,
      policyName: POLICY,
      readBack: new SimulatedRouter(STATE_PATH).renderConfig(original),
      bogonNode: 1,
      mitigationNode: 2,
    })!;
    await store.save(record);
    const drifted = activated();
    drifted.nodes = drifted.nodes.map((node) =>
      node.node === 10
        ? { ...node, applies: ['apply local-preference 500', 'apply extcommunity rt 268568:140 additive'] }
        : node,
    );
    writeState(drifted);
    const router = new SimulatedRouter(STATE_PATH);
    const result = await executor(router, store).preflight(device(), {
      ...REMOVE_INPUT,
      expectedExistingNodes: null,
    });
    const check1 = check('policy_baseline_record', result);
    results.push({
      name: 'node permanente modificado bloqueia REMOVE',
      pass: !result.ok && (check1?.detail.includes('MITIGATION_BASELINE_DRIFT') ?? false),
      detail: check1?.detail ?? 'sem check',
      evidence: { escritas: router.appliedCommands.length },
    });
  }

  // ---------- 4) PostgreSQL INDISPONIVEL ----------
  {
    writeState(activated());
    const deadUrl =
      'postgresql://nv_baseline_lab:nv_lab_only_2026@127.0.0.1:55999/mitigation_baseline_test?schema=public&connect_timeout=2';
    const deadClient = prismaClient(deadUrl);
    const deadStore = baselineStore(deadClient);
    const router = new SimulatedRouter(STATE_PATH);
    const live = executor(router, deadStore);
    const result = await live.preflight(device(), { ...REMOVE_INPUT, expectedExistingNodes: null });
    const check1 = check('policy_baseline_record', result);
    let activateBlocked = false;
    let activateError = '';
    try {
      await live.activate(device(), {
        policyName: POLICY,
        bogonNode: 1,
        mitigationNode: 2,
        rt: RT,
        bogonPrefixList: 'BOGONS',
        targetPrefixList: 'PREFIX8to24',
        preservedClauses: {
          baselineNode: 10,
          baselineMatch: 'PREFIX_LIST',
          localPreference: 'apply local-preference 1100',
          routeTargets: ['268568:140'],
          otherApplies: [],
          expectedClauses: [],
          safe: true,
          unsafeReasons: [],
        },
      });
    } catch (error) {
      activateBlocked = true;
      activateError = error instanceof Error ? error.message : String(error);
    }
    await deadClient.$disconnect().catch(() => undefined);
    results.push({
      name: 'PostgreSQL indisponivel bloqueia operacoes que dependem do registro',
      pass: !result.ok && activateBlocked && router.appliedCommands.length === 0,
      detail: `${check1?.detail ?? 'sem check'} | activate=${activateError}`,
      evidence: { escritas: router.appliedCommands.length },
    });
  }

  // ---------- 5) ERRO SSH IMPEDE COMMIT ----------
  {
    writeState(activated());
    await client.mitigationAutomationRecord.deleteMany({});
    writeState(seedDevice(POLICY));
    const router = new SimulatedRouter(STATE_PATH, 'reject-node2');
    const live = executor(router, store);
    const preflight = await live.preflight(device(), ACTIVATE_INPUT);
    let error = '';
    try {
      await live.activate(device(), {
        policyName: POLICY,
        bogonNode: 1,
        mitigationNode: 2,
        rt: RT,
        bogonPrefixList: 'BOGONS',
        targetPrefixList: 'PREFIX8to24',
        preservedClauses: preflight.preservedClauses!,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const after = readState();
    results.push({
      name: 'erro SSH impede commit',
      pass:
        preflight.ok &&
        error.includes('MITIGATION_WRITE_FAILED') &&
        after.commits === 0 &&
        JSON.stringify(after.nodes.map((node) => node.node).sort((a, b) => a - b)) === '[10,1000]',
      detail: error || 'sem erro',
      evidence: { commits: after.commits, nodes: after.nodes.map((node) => node.node) },
    });
  }

  // ---------- 6) AMBIGUIDADE DE NODES ----------
  {
    writeState(activated());
    // Registro VALIDO para nodes permanentes 10/1000: o bloqueio abaixo NAO pode
    // vir da ausencia de registro, e sim da estrutura ambigua no equipamento.
    const record = captureMitigationBaseline({
      deviceId: DEVICE_ID,
      policyName: POLICY,
      readBack: new SimulatedRouter(STATE_PATH).renderConfig(activated()),
      bogonNode: 1,
      mitigationNode: 2,
    })!;
    await store.save(record);
    const ambiguous = activated();
    ambiguous.nodes = [
      ...ambiguous.nodes,
      { node: 5, action: 'deny', ifMatch: ['BOGONS'], applies: [] },
    ];
    writeState(ambiguous);
    const router = new SimulatedRouter(STATE_PATH);
    const result = await executor(router, store).preflight(device(), {
      ...REMOVE_INPUT,
      expectedExistingNodes: null,
    });
    const scope = check('policy_mitigation_scope', result);
    const baselineCheck = check('policy_baseline_record', result);
    results.push({
      name: 'ambiguidade de nodes permanece bloqueada',
      // O node extra tambem aparece como divergencia do registro (defesa em
      // profundidade); o que se prova aqui e que a AMBIGUIDADE e detectada:
      // 2 nodes BOGONS + 1 de mitigacao => reconciliacao obrigatoria.
      pass: !result.ok && scope?.ok === false && (scope?.detail.includes('multipla') ?? false),
      detail: `${scope?.detail ?? 'sem check'} | drift=${baselineCheck?.ok === false}`,
      evidence: { escritas: router.appliedCommands.length },
    });
  }

  report('ETAPA5 cenarios negativos', results);
  await client.$disconnect();
  const failures = results.filter((entry) => !entry.pass);
  if (failures.length > 0) throw new Error(`FALHAS: ${failures.map((f) => f.name).join(' | ')}`);
  process.stdout.write('\nETAPA5 PASS\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\nETAPA5 FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
