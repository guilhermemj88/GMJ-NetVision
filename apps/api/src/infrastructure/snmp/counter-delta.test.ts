import { describe, expect, it } from 'vitest';
import { calculateCounterDelta } from './counter-delta';

describe('SNMP error/discard counter deltas', () => {
  it('returns only new events', () => {
    expect(calculateCounterDelta(7057n, 7054n)).toBe(3n);
  });

  it('returns zero when the counter did not change', () => {
    expect(calculateCounterDelta(7054n, 7054n)).toBe(0n);
  });

  it('uses the first post-reset value without producing a negative delta', () => {
    expect(calculateCounterDelta(4n, 7054n)).toBe(4n);
  });

  it('handles a plausible Counter32 wrap', () => {
    expect(calculateCounterDelta(3n, 0xffff_fffen)).toBe(5n);
  });

  it('uses the first sample only as a baseline', () => {
    expect(calculateCounterDelta(7054n, undefined)).toBe(0n);
  });
});
