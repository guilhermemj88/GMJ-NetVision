import { describe, expect, it } from 'vitest';
import { cloneDemoMap } from '@gmj/shared';
import { createAutoLayout } from './layout';

describe('auto layout', () => {
  it('preserves locked and manually positioned nodes in hybrid mode', () => {
    const map = cloneDemoMap();
    const locked = map.nodes.find((node) => node.locked);
    expect(locked).toBeDefined();
    const result = createAutoLayout(map);
    expect(result.get(locked?.id ?? '')).toEqual(locked?.position);
  });
});
