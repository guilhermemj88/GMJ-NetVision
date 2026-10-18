import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyActivation } from './mitigation-executor';

it('recognizes an already active real NE8000 display shape and rejects missing or divergent RT', () => {
  const text = readFileSync(
    new URL(
      '../../../testing/fixtures/ne8000-route-policy-observed-anonymized.txt',
      import.meta.url,
    ),
    'utf8',
  );
  const verify = (content: string) =>
    verifyActivation(
      'PL-FIXTURE_IPv4-IN',
      content,
      { bogonNode: 1, mitigationNode: 2 },
      '64512:660',
      { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
    );
  expect(verify(text).verified).toBe(true);
  expect(verify(text.replace('64512:660', '64512:999')).verified).toBe(false);
  expect(verify(text.replace('if-match ip-prefix PREFIX8to24', '')).verified).toBe(false);
  expect(verify(text.replace('if-match ip-prefix BOGONS', '')).partial).toBe(true);
});
