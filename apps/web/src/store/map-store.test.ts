import { afterEach, describe, expect, it } from 'vitest';
import { cloneDemoMaps, type MapSummary, type NetworkMap } from '@gmj/shared';
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

describe('public NOC rotation', () => {
  afterEach(() => {
    useMapStore.getState().stopRotation();
    useMapStore.setState({ maps: [], activeMapId: null, map: null, readOnly: false, publicMaps: [] });
  });

  it('rotates through cached public maps without refetching', () => {
    const publicMaps: NetworkMap[] = ['backbone', 'access'].map((id) => ({
      ...cloneDemoMaps()[0]!,
      id,
      name: id,
    }));
    useMapStore.getState().loadPublicMaps(publicMaps);
    useMapStore.getState().setReadOnly(true);
    useMapStore.getState().startRotation({
      mapIds: publicMaps.map((map) => map.id),
      intervalSeconds: 30,
      hideTopBar: true,
      hideControls: true,
      pauseOnInteraction: false,
    });

    expect(useMapStore.getState().map?.id).toBe('backbone');
    useMapStore.getState().rotateBy(1);
    expect(useMapStore.getState().map?.id).toBe('access');
    expect(useMapStore.getState().activeMapId).toBe('access');
  });
});

describe('map visual scales', () => {
  afterEach(() => useMapStore.setState({ map: null, dirty: false }));

  it('clamps independent scales without changing persisted node coordinates', () => {
    const map = cloneDemoMaps()[0]!;
    const positions = map.nodes.map((node) => ({ ...node.position }));
    useMapStore.getState().setMap(map);
    useMapStore.getState().setMapScales({ nodeScale: 70, linkScale: 150, labelScale: 250 });

    expect(useMapStore.getState().map?.settings).toMatchObject({
      nodeScale: 70,
      linkScale: 150,
      labelScale: 200,
    });
    expect(useMapStore.getState().map?.nodes.map((node) => node.position)).toEqual(positions);
  });

  it('loads the scale preferences that belong to each map during NOC rotation', () => {
    const [first, second] = cloneDemoMaps();
    first!.settings.nodeScale = 80;
    second!.settings.nodeScale = 130;
    useMapStore.getState().setMap(first!);
    expect(useMapStore.getState().map?.settings.nodeScale).toBe(80);
    useMapStore.getState().setMap(second!);
    expect(useMapStore.getState().map?.settings.nodeScale).toBe(130);
  });
});
