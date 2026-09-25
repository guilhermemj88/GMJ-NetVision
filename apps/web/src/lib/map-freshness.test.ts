import { describe, expect, it } from 'vitest';
import { newestCollectionStamp } from './map-freshness';

describe('newestCollectionStamp', () => {
  it('usa o carimbo de coleta mais recente entre os equipamentos', () => {
    const stamp = newestCollectionStamp([
      { lastPollingAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z' },
      { lastPollingAt: '2026-09-25T10:07:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z' },
      { lastPollingAt: null, updatedAt: '2026-09-25T08:00:00.000Z' },
    ]);

    expect(stamp).toBe('2026-09-25T10:07:00.000Z');
  });

  it('cai para updatedAt quando não houve polling', () => {
    expect(newestCollectionStamp([{ lastPollingAt: null, updatedAt: '2026-09-25T11:00:00.000Z' }])).toBe(
      '2026-09-25T11:00:00.000Z',
    );
  });

  it('não inventa carimbo quando não existe nenhum', () => {
    expect(newestCollectionStamp([])).toBeNull();
    expect(newestCollectionStamp([{ lastPollingAt: null, updatedAt: null }])).toBeNull();
    expect(newestCollectionStamp([{ lastPollingAt: 'data-invalida', updatedAt: null }])).toBeNull();
  });
});
