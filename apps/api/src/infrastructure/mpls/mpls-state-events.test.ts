import { describe, expect, it } from 'vitest';
import { isRealMplsStateChange } from './mpls-state-events';

describe('MPLS state-event safety', () => {
  it('records a real transition from a previously discovered entity', () => {
    expect(isRealMplsStateChange('UP', 'DOWN', { observed: true, complete: true })).toBe(true);
  });

  it('does not emit on first discovery, unknown status, timeout-like absence, or partial collection', () => {
    expect(isRealMplsStateChange(null, 'UP', { observed: true, complete: true })).toBe(false);
    expect(isRealMplsStateChange('UP', 'UNKNOWN', { observed: true, complete: true })).toBe(false);
    expect(isRealMplsStateChange('UP', 'DOWN', { observed: false, complete: true })).toBe(false);
    expect(isRealMplsStateChange('UP', 'DOWN', { observed: true, complete: false })).toBe(false);
    expect(isRealMplsStateChange('UP', 'UP', { observed: true, complete: true })).toBe(false);
  });
});
