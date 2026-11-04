import { describe, expect, it } from 'vitest';
import fixtures from './mitigation-f2-real-policy-fixtures.json';
import { inspectPolicyMitigation } from './mitigation-policy-physical';

describe('F2: real read-only policy captures, permanent nodes never imply ownership', () => {
  for (const [policyName, readBack] of Object.entries(fixtures)) {
    it(`${policyName}: legitimate permanent policy is NORMAL, without a managed pair`, () => {
      const result = inspectPolicyMitigation({ policyName, readBack, rts: ['268568:660'] });
      expect(result.state).toBe('NORMAL');
      expect(result.pair).toBeNull();
      expect(result.partialNodes).toEqual([]);
    });
  }
  const policyName = 'PL-LIVINET_IPv4-IN';
  for (const [name, extra] of [
    [
      'legacy complete pair',
      `route-policy ${policyName} permit node 6\n apply extcommunity rt 268568:660`,
    ],
    [
      'identifiable legacy half pair',
      `route-policy ${policyName} permit node 6\n if-match ip-prefix PREFIX8to24\n apply extcommunity rt 268568:660 additive`,
    ],
    ['precedence', `route-policy ${policyName} permit node 0`],
    ['foreign node 1', `route-policy ${policyName} permit node 1\n if-match ip-prefix OTHER`],
    ['foreign node 2', `route-policy ${policyName} permit node 2\n apply local-preference 1100`],
  ] as const)
    it(`${name} remains fail-closed`, () => {
      // Convert the extra node to display format so the parser sees one unambiguous format.
      const display = extra.replace(`route-policy ${policyName} permit node `, '  permit : ');
      const readBack = fixtures[policyName].replace('<BHE-VTA-F1A-BGP-01>', display);
      expect(inspectPolicyMitigation({ policyName, readBack, rts: ['268568:660'] }).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
    });
});
