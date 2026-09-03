// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  cloneDemoMaps,
  type InterfaceSearchResult,
  type MapSummary,
  type NetworkMap,
} from '@gmj/shared';
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
  afterEach(() => {
    window.localStorage.clear();
    useMapStore.setState({ map: null, dirty: false });
  });

  it('uses the backend map and removes stale legacy local geometry', () => {
    const map = cloneDemoMaps()[0]!;
    const firstNode = map.nodes[0]!;
    const backendPosition = { ...firstNode.position };
    window.localStorage.setItem(
      `gmj:positions:${map.id}`,
      JSON.stringify({ [firstNode.id]: { x: 9999, y: 8888 } }),
    );
    window.localStorage.setItem(
      `gmj:settings:${map.id}`,
      JSON.stringify({ ...map.settings, viewport: { x: 900, y: 800, zoom: 2 } }),
    );

    useMapStore.getState().setMap(map);

    expect(useMapStore.getState().map?.nodes[0]?.position).toEqual(backendPosition);
    expect(useMapStore.getState().map?.settings.viewport).toEqual(map.settings.viewport);
    expect(window.localStorage.getItem(`gmj:positions:${map.id}`)).toBeNull();
    expect(window.localStorage.getItem(`gmj:settings:${map.id}`)).toBeNull();
  });

  it('keeps unsaved node movement in memory instead of persistent local storage', () => {
    const map = cloneDemoMaps()[0]!;
    const firstNode = map.nodes[0]!;
    useMapStore.getState().setMap(map);

    useMapStore.getState().moveNode(firstNode.id, { x: 123, y: 456 });

    expect(useMapStore.getState().map?.nodes[0]).toMatchObject({
      position: { x: 123, y: 456 },
      positionSource: 'MANUAL',
    });
    expect(window.localStorage.getItem(`gmj:positions:${map.id}`)).toBeNull();
  });

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

describe('global interface search navigation', () => {
  afterEach(() => {
    useMapStore.setState({
      activeMapId: null,
      map: null,
      selection: null,
      focusRequest: null,
      pendingInterfaceNavigation: null,
      hostDetailRequest: null,
      view: 'MAP',
    });
  });

  function resultFor(map: NetworkMap): InterfaceSearchResult {
    const node = map.nodes.find((item) => item.deviceId)!;
    const device = map.devices.find((item) => item.id === node.deviceId)!;
    const networkInterface = device.interfaces[0]!;
    return {
      interfaceId: networkInterface.id,
      deviceId: device.id,
      hostname: device.hostname,
      deviceName: device.name,
      interfaceName: networkInterface.name,
      alias: networkInterface.alias,
      description: networkInterface.description,
      ifIndex: networkInterface.ifIndex,
      status: networkInterface.operStatus,
      ip: device.managementIp,
      vlan: null,
      maps: [{ id: map.id, name: map.name }],
    };
  }

  it('selects the interface and requests smooth focus on the current map', () => {
    const map = cloneDemoMaps()[0]!;
    const result = resultFor(map);
    useMapStore.getState().setMap(map);

    useMapStore.getState().openInterfaceOnMap(result, map.id);

    expect(useMapStore.getState().selection).toEqual({
      kind: 'interface',
      id: result.interfaceId,
      deviceId: result.deviceId,
    });
    expect(useMapStore.getState().focusRequest?.deviceId).toBe(result.deviceId);
  });

  it('waits for another map to load before opening its interface', () => {
    const [current, target] = cloneDemoMaps();
    const result = resultFor(target!);
    useMapStore.getState().setMap(current!);

    useMapStore.getState().openInterfaceOnMap(result, target!.id);
    expect(useMapStore.getState().activeMapId).toBe(target!.id);
    expect(useMapStore.getState().selection).toBeNull();

    useMapStore.getState().setMap(target!);
    expect(useMapStore.getState().selection).toMatchObject({
      kind: 'interface',
      id: result.interfaceId,
      deviceId: result.deviceId,
    });
  });

  it('routes inventory-only results to host details', () => {
    useMapStore.getState().openHostDetails('host-without-map');

    expect(useMapStore.getState()).toMatchObject({
      view: 'HOSTS',
      hostDetailRequest: 'host-without-map',
    });
  });
});

describe('traffic label mode persistence', () => {
  afterEach(() => {
    useMapStore.setState({ map: null, dirty: false, readOnly: false, publicMaps: [] });
    useMapStore.getState().stopRotation();
  });

  it('defaults to CARD in demo and freshly loaded maps', () => {
    const map = cloneDemoMaps()[0]!;

    expect(map.settings.trafficLabelMode).toBe('CARD');
    useMapStore.getState().setMap(map);
    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('CARD');
  });

  it('updates trafficLabelMode in the map settings', () => {
    const map = cloneDemoMaps()[0]!;
    useMapStore.getState().setMap(map);

    useMapStore.getState().setTrafficLabelMode('INLINE');

    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
    expect(useMapStore.getState().dirty).toBe(true);
  });

  it('preserves INLINE in a public map view', () => {
    const map = cloneDemoMaps()[0]!;
    map.settings.trafficLabelMode = 'INLINE';

    useMapStore.getState().setPublicMap(map);

    expect(useMapStore.getState().readOnly).toBe(true);
    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
  });

  it('preserves INLINE during public NOC rotation', () => {
    const publicMaps: NetworkMap[] = ['backbone', 'access'].map((id) => ({
      ...cloneDemoMaps()[0]!,
      id,
      name: id,
      settings: { ...cloneDemoMaps()[0]!.settings, trafficLabelMode: 'INLINE' as const },
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

    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
    useMapStore.getState().rotateBy(1);
    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
  });
});
