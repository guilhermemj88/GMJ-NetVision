import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyActivation } from './mitigation-executor';
import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';

const observed = readFileSync(
  new URL('../../../testing/fixtures/ne8000-route-policy-observed-anonymized.txt', import.meta.url),
  'utf8',
);

/**
 * Mesma policy real observada, reescrita no contrato final: node 2 estreito = lista + LP do node
 * permanente 10 + RT 660 sem additive (a RT 140 do cliente e a que a 660 substitui).
 */
const compliant = observed
  .replace(
    '      if-match ip-prefix PREFIX8to24\n    Apply clauses:\n      apply extcommunity rt 64512:660 additive',
    '      if-match ip-prefix PREFIX-FIXTURE-IPV4\n    Apply clauses:\n      apply local-preference 1000\n      apply extcommunity rt 268568:660',
  )
  .replace('apply extcommunity rt 64512:140 additive', 'apply extcommunity rt 268568:140 additive');

const verify = (content: string) =>
  verifyActivation(
    'PL-FIXTURE_IPv4-IN',
    content,
    { bogonNode: 1, mitigationNode: 2 },
    '268568:660',
    { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
  );

it('parses the real NE8000 display shape and requires the exact final contract', () => {
  // O parser continua entendendo o formato `display route-policy` real.
  const parsed = parseHuaweiRoutePolicyNodesLenient(observed).get('PL-FIXTURE_IPv4-IN') ?? [];
  expect(parsed.map((node) => node.node)).toEqual([1, 2, 10, 100]);

  // A forma antiga (if-match de lista + RT additive) NAO e o contrato final.
  expect(verify(observed).verified).toBe(false);

  // A mesma policy no contrato final: node 1 deny+BOGONS, node 2 = lista + LP do cliente + RT660.
  expect(verify(compliant).verified).toBe(true);
});

it('rejects missing or divergent RT and missing BOGONS condition', () => {
  expect(verify(compliant.replace('268568:660', '268568:999')).verified).toBe(false);
  expect(verify(compliant.replace('apply extcommunity rt 268568:660', '')).verified).toBe(false);
  expect(verify(compliant.replace('if-match ip-prefix BOGONS', '')).partial).toBe(true);
});

it('rejects additive, local-preference or if-match added to the mitigation node', () => {
  expect(
    verify(
      compliant.replace('apply extcommunity rt 268568:660', 'apply extcommunity rt 268568:660 additive'),
    ).verified,
  ).toBe(false);
  expect(
    verify(
      compliant.replace(
        'apply extcommunity rt 268568:660',
        'apply local-preference 1100\n      apply extcommunity rt 268568:660',
      ),
    ).verified,
  ).toBe(false);
  expect(
    verify(
      compliant.replace(
        'apply extcommunity rt 268568:660',
        'if-match ip-prefix PREFIX8to24\n      apply extcommunity rt 268568:660',
      ),
    ).verified,
  ).toBe(false);
});
