import { afterEach, describe, expect, it } from 'vitest';
import type { MapSummary } from '@gmj/shared';
import { useMapStore } from './map-store';

const maps: MapSummary[] = ['backbone', 'access'].map((id, index) => ({
  id,
  name: id,
  description: '',
  mode: 'HYBRID',
  isDefault: index === 0,
  nodeCount: 0,
  linkCount: 0,
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
}));

describe('NOC rotation state', () => {
  afterEach(() => {
    useMapStore.getState().stopRotation();
    useMapStore.setState({ maps: [], activeMapId: null, map: null });
  });

  it('starts, navigates in a loop, pauses and exits', () => {
    useMapStore.setState({ maps });
    useMapStore.getState().startRotation({
      mapIds: maps.map((map) => map.id),
      intervalSeconds: 30,
      hideTopBar: true,
      hideControls: true,
      pauseOnInteraction: true,
    });

    expect(useMapStore.getState().activeMapId).toBe('backbone');
    expect(useMapStore.getState().rotation.active).toBe(true);
    useMapStore.getState().rotateBy(1);
    expect(useMapStore.getState().activeMapId).toBe('access');
    useMapStore.getState().rotateBy(1);
    expect(useMapStore.getState().activeMapId).toBe('backbone');
    useMapStore.getState().setRotationPaused(true);
    expect(useMapStore.getState().rotation.paused).toBe(true);
    useMapStore.getState().stopRotation();
    expect(useMapStore.getState().rotation.active).toBe(false);
  });
});
