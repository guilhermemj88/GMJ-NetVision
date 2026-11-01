import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../../testing/single-pilot-harness';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import { inspectPolicyMitigation } from './mitigation-policy-physical';
import { buildMitigationActivateCommands } from './mitigation-write-guard';
import { derivePreservedClauses } from './mitigation-policy-clauses';
import { SimulationCommandExecutor } from './simulation-command-executor';

const prefixes = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];
const pair = { bogonNode: 1, mitigationNode: 2 };
const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

/** Baseline fisico de referencia; os atributos sao derivados por este mesmo texto. */
const BASELINE_CONFIG = [
  `route-policy ${A.policy} permit node 10`,
  ` if-match ip-prefix ${A.targetPrefixList}`,
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${A.policy} deny node 1000`,
].join('\n');
const PRESERVED = derivePreservedClauses(BASELINE_CONFIG, A.policy, A.targetPrefixList, A.rt);
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
describe('AGLINK BGP semantics: transit export marking, not a different local forwarding path', () => {
  it.each(prefixes)(
    '%s matches PREFIX8to24; legacy node 2 skips node 10 and can lose best-route selection',
    async (prefix) => {
      const h = await createPilotHarness();
      const old = [
        `route-policy ${A.policy} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${A.policy} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        h.ssh.config(),
      ].join('\n');
      const r = evaluate(old, prefix);
      expect(r).toMatchObject({ accepted: true, node: 2, localPreference: 100 });
      expect(r.rts).toEqual(['268568:330', '268568:660']);
      expect(r.rts).not.toContain(A.normalRt);
      expect(r.localPreference).toBeLessThan(800); // observed competing /24 path
    },
  );
  it.each(prefixes)(
    '%s stays selected and carries mitigation RT on top of the normal attributes; manual REMOVE restores baseline',
    async (prefix) => {
      const h = await createPilotHarness();
      const before = evaluate(h.ssh.config(), prefix);
      for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
        h.sample(rate);
        await h.lifecycle.tickPilot();
      }
      const during = evaluate(h.ssh.config(), prefix);
      expect(before).toMatchObject({ accepted: true, node: 10, localPreference: 1100 });
      expect(before.rts).toEqual(['268568:330', '268568:140']);
      // Contrato definitivo: LP1100 e RT140 preservados, RT660 acrescentada com
      // additive e a RT330 recebida do peer intacta.
      expect(during).toMatchObject({ accepted: true, node: 2, localPreference: 1100 });
      expect(during.rts).toEqual(['268568:330', '268568:140', '268568:660']);
      expect(during.localPreference).toBeGreaterThan(800);
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
    },
  );
  it('matches preview to canonical SSH commands and keeps mitigation independent from node 10', () => {
    const commands = buildMitigationActivateCommands(plan, PRESERVED);
    expect(
      new SimulationCommandExecutor().buildMitigation(A.policy, pair, A.rt, labels, PRESERVED)
        .commands,
    ).toEqual(commands);
    expect(commands).toContain(` if-match ip-prefix ${A.targetPrefixList}`);
    expect(commands).toContain(' apply local-preference 1100');
    // Forma fisica validada no equipamento: uma unica instrucao multi-RT.
    expect(commands).toContain(' apply extcommunity rt 268568:140 rt 268568:660 additive');
    expect(commands.join('\n')).not.toMatch(/goto next-node/);
    expect(commands.filter((line) => line.includes('apply extcommunity'))).toHaveLength(1);
    expect(commands.join('\n')).not.toMatch(/node (10|1000)\b/);
  });
  it('does not permit an unrelated public prefix previously caught by the broad wildcard', async () => {
    const h = await activate();
    expect(evaluate(h.ssh.config(), '198.51.100.0/24')).toMatchObject({
      accepted: false,
      node: 1000,
    });
    expect(evaluate(h.ssh.config(), '167.250.126.0/25').accepted).toBe(false);
  });
  it.each(['localpref', 'normalRt', 'scope', 'baseline'] as const)(
    'rejects %s divergence in readback',
    async (fault) => {
      const h = await activate();
      let text = h.ssh.config();
      if (fault === 'localpref')
        text = text.replace('apply local-preference 1100', 'apply local-preference 100');
      if (fault === 'normalRt')
        // Sem `additive` o node passa a SUBSTITUIR as RTs: divergencia.
        text = text.replace('rt 268568:660 additive', 'rt 268568:660');
      if (fault === 'scope')
        text = text.replace(
          `if-match ip-prefix ${A.targetPrefixList}`,
          'if-match ip-prefix PREFIX8to24',
        );
      if (fault === 'baseline')
        text = text.replace('rt 268568:140 additive', 'rt 268568:999 additive');
      expect(verifyActivation(A.policy, text, pair, A.rt, labels, PRESERVED).verified).toBe(false);
      expect(
        inspectPolicyMitigation({ policyName: A.policy, readBack: text, rts: [A.rt] }).state,
      ).toBe('RECONCILIATION_REQUIRED');
    },
  );
  it('does not declare REMOVE verified when original attributes were changed', async () => {
    const h = await createPilotHarness();
    expect(verifyRemoval(A.policy, h.ssh.config().replace('1100', '100'), pair).verified).toBe(
      false,
    );
  });
  it('adds the mitigation RT with additive, so the normal RT received from the peer is preserved', async () => {
    const h = await activate();
    const during = evaluate(h.ssh.config(), prefixes[0]!, ['268568:140', '268568:330']);
    expect(during.rts).toEqual(['268568:140', '268568:330', '268568:660']);
    expect(during.localPreference).toBe(1100);
    // Remover o `additive` faria o node substituir as RTs: readback rejeita.
    expect(
      verifyActivation(
        A.policy,
        h.ssh.config().replace('rt 268568:660 additive', 'rt 268568:660'),
        pair,
        A.rt,
        labels,
        PRESERVED,
      ).verified,
    ).toBe(false);
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
