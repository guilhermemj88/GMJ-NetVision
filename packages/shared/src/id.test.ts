import { describe, expect, it } from 'vitest';
import { createLocalId } from './id';

describe('createLocalId', () => {
  it('uses randomUUID when it is available', () => {
    expect(createLocalId('node', () => 'uuid-value')).toBe('node-uuid-value');
  });

  it('falls back safely when randomUUID is unavailable', () => {
    const first = createLocalId('node', null);
    const second = createLocalId('node', null);
    expect(first).toMatch(/^node-[a-z0-9]+-[a-z0-9]+$/);
    expect(second).not.toBe(first);
  });

  it('falls back if an exposed randomUUID implementation throws', () => {
    expect(
      createLocalId('link', () => {
        throw new Error('unsupported');
      }),
    ).toMatch(/^link-[a-z0-9]+-[a-z0-9]+$/);
  });
});
