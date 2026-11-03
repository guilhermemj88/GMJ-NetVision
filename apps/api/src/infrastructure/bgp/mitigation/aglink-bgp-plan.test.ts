import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../../testing/single-pilot-harness';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import { inspectPolicyMitigation } from './mitigation-policy-physical';
import { buildMitigationActivateCommands } from './mitigation-write-guard';
import { SimulationCommandExecutor } from './simulation-command-executor';

const prefixes = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];
const pair = { bogonNode: 1, mitigationNode: 2 };
const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

const COMMANDS = [
  'system-view',
  `route-policy ${A.policy} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${A.policy} permit node 2`,
  ' apply extcommunity rt 268568:660',
  'commit',
];

async function activate() {
  const h = await createPilotHarness();
  for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
    h.sample(rate);
    await h.lifecycle.tickPilot();
  }
  expect(h.ssh.writes).toHaveLength(1);
  return h;
}

// Independent, deliberately limited reference model: first matching node,
// prefix match, local-pref and RT add/replace only. This is not physical VRP evidence.
function evaluate(config: string, prefix: string, incomingRts = ['268568:330']) {
  const result = { accepted: false, localPreference: 100, rts: [...incomingRts], node: 0 };
  for (const block of config.split(/(?=^route-policy )/m)) {
    const header = /^route-policy \S+ (permit|deny) node (\d+)/.exec(block);
    if (!header) continue;
    const list = /if-match ip-prefix (\S+)/.exec(block)?.[1];
    const length = Number(prefix.split('/')[1]);
    const match =
      !list ||
      (list === 'PREFIX8to24' && length >= 8 && length <= 24) ||
      (list === A.targetPrefixList && prefixes.includes(prefix)) ||
      (list === 'BOGONS' && prefix.startsWith('10.'));
    if (!match) continue;
    result.node = Number(header[2]);
    if (header[1] === 'deny') return result;
    result.accepted = true;
    const lp = /apply local-preference (\d+)/.exec(block)?.[1];
    if (lp) result.localPreference = Number(lp);
    for (const m of block.matchAll(/apply extcommunity rt ([^\n]+)/g)) {
      const additive = /\badditive\b/.test(m[1]!);
      const values = [...m[1]!.matchAll(/(\d+:\d+)/g)].map((x) => x[1]!);
      if (!additive) result.rts = [];
      for (const rt of values) if (!result.rts.includes(rt)) result.rts.push(rt);
    }
    return result; // additive is not continue/goto
  }
  return result;
}

describe('contrato IPv4 definitivo: deny BOGONS node 1 + permit node 2 com RT660 exclusiva', () => {
  it.each(prefixes)(
    '%s: durante a mitigacao casa no node 2 com RT set exatamente {268568:660}',
    async (prefix) => {
      const h = await activate();
      const during = evaluate(h.ssh.config(), prefix);
      expect(during).toMatchObject({ accepted: true, node: 2, localPreference: 100 });
      // Sem additive o node 2 substitui o conjunto: RT140/RT330 recebidas nao permanecem.
      expect(during.rts).toEqual(['268568:660']);
    },
  );

  it.each(prefixes)('%s: REMOVE manual devolve exatamente o baseline', async (prefix) => {
    const h = await createPilotHarness();
    const before = evaluate(h.ssh.config(), prefix);
    expect(before).toMatchObject({ accepted: true, node: 10, localPreference: 1100 });
    expect(before.rts).toEqual(['268568:330', '268568:140']);
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    const removed = await h.commands.execute({
      requestId: `human-${prefix}`,
      action: 'REMOVE',
      profileId: h.target.profileId,
      origin: 'MANUAL',
    });
    expect(removed.verified).toBe(true);
    expect(evaluate(h.ssh.config(), prefix)).toEqual(before);
    expect(h.ssh.writes[1]).toEqual([
      'system-view',
      `undo route-policy ${A.policy} node 1`,
      `undo route-policy ${A.policy} node 2`,
      'commit',
    ]);
  });

  it('preview identico aos comandos canonicos, sem clausula nao autorizada', () => {
    const commands = buildMitigationActivateCommands(plan);
    expect(new SimulationCommandExecutor().buildMitigation(A.policy, pair, A.rt, labels).commands)
      .toEqual(commands);
    expect(commands).toEqual(COMMANDS);
    const text = commands.join('\n');
    expect(text).not.toContain('apply local-preference');
    expect(text).not.toContain('additive');
    expect(commands.filter((line) => line.includes('if-match'))).toEqual([
      ' if-match ip-prefix BOGONS',
    ]);
    expect(commands.filter((line) => line.includes('apply extcommunity'))).toHaveLength(1);
    expect(text).not.toMatch(/goto next-node/);
    expect(text).not.toMatch(/node (10|1000)\b/);
  });

  it('amplitude autorizada: prefixos fora da lista do cliente passam no node 2', async () => {
    const h = await activate();
    // Efeito aceito explicitamente pelo operador: o permit apos BOGONS cobre
    // qualquer NLRI, nao apenas os prefixos que o node 10 autorizava.
    for (const prefix of ['167.250.126.0/25', '167.250.128.0/24', '8.8.8.0/24', '0.0.0.0/0'])
      expect(evaluate(h.ssh.config(), prefix)).toMatchObject({ accepted: true, node: 2 });
    // BOGONS continua barrando no node 1 (o modelo cobre a faixa 10.0.0.0/8).
    expect(evaluate(h.ssh.config(), '10.1.0.0/24')).toMatchObject({ accepted: false, node: 1 });
  });

  it.each(['ifMatch', 'localPreference', 'additive', 'extraRt', 'bogonCondition'] as const)(
    'readback divergente (%s) exige reconciliacao',
    async (fault) => {
      const h = await activate();
      let text = h.ssh.config();
      if (fault === 'ifMatch')
        text = text.replace(
          ' apply extcommunity rt 268568:660',
          ' if-match ip-prefix PREFIX8to24\n apply extcommunity rt 268568:660',
        );
      if (fault === 'localPreference')
        text = text.replace(
          ' apply extcommunity rt 268568:660',
          ' apply local-preference 1100\n apply extcommunity rt 268568:660',
        );
      if (fault === 'additive')
        text = text.replace(
          'apply extcommunity rt 268568:660',
          'apply extcommunity rt 268568:660 additive',
        );
      if (fault === 'extraRt')
        text = text.replace(
          'apply extcommunity rt 268568:660',
          'apply extcommunity rt 268568:660 rt 268568:140',
        );
      if (fault === 'bogonCondition')
        text = text.replace(
          ' deny node 1\n if-match ip-prefix BOGONS',
          ' deny node 1\n if-match ip-prefix PREFIX8to24',
        );
      expect(verifyActivation(A.policy, text, pair, A.rt, labels).verified).toBe(false);
      expect(
        inspectPolicyMitigation({ policyName: A.policy, readBack: text, rts: [A.rt] }).state,
      ).toBe('RECONCILIATION_REQUIRED');
    },
  );

  it('node permanente alterado bloqueia verificacao e retirada', async () => {
    const h = await createPilotHarness();
    const changed = h.ssh
      .config()
      .replace('apply local-preference 1100', 'apply local-preference 100');
    expect(verifyActivation(A.policy, changed, pair, A.rt, labels).verified).toBe(false);
    expect(verifyRemoval(A.policy, changed, pair).verified).toBe(false);
  });

  it('RT660 ou BOGONS preexistentes em node permanente nao provam ownership', async () => {
    const h = await createPilotHarness();
    // Baseline normal (node 10/1000) sem par 1/2: estado NORMAL, nunca MITIGATED.
    expect(
      inspectPolicyMitigation({ policyName: A.policy, readBack: h.ssh.config(), rts: [A.rt] })
        .state,
    ).toBe('NORMAL');
  });

  it('blocks preflight on changed baseline before any SSH write', async () => {
    const h = await createPilotHarness();
    const config = h.ssh.config.bind(h.ssh);
    h.ssh.config = () =>
      config().replace('apply local-preference 1100', 'apply local-preference 100');
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect(h.ssh.writes).toHaveLength(0);
  });
});
