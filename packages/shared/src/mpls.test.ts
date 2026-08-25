import { describe, expect, it } from 'vitest';
import { summarizeMpls } from './mpls';
import type { MplsVsi } from './mpls';

describe('summarizeMpls', () => {
  it('accounts for every VSI state, including UNKNOWN', () => {
    const statuses = ['UP', 'DOWN', 'DEGRADED', 'ADMIN_DOWN', 'UNKNOWN'] as const;
    const vsis = statuses.map((status) => ({ status, pws: [] })) as unknown as MplsVsi[];

    const summary = summarizeMpls(vsis);
    expect(
      summary.vsiUp +
        summary.vsiDown +
        summary.vsiDegraded +
        summary.vsiAdminDown +
        summary.vsiUnknown,
    ).toBe(summary.vsiTotal);
    expect(summary).toMatchObject({ vsiTotal: 5, vsiUnknown: 1 });
  });
});
