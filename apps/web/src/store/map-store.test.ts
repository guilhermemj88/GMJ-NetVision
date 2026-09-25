// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  cloneDemoMaps,
  type InterfaceSearchResult,
  type MapSummary,
  type NetworkMap,
} from '@gmj/shared';
import { inferVisualPreset, presetScalePatch, useMapStore } from './map-store';

describe('local SINGLE_ENDED creation', () => {
  afterEach(() => useMapStore.setState({ map: null }));
  it.each(['SOURCE', 'TARGET'] as const)('uses the %s interface status and counters for the local fallback', (side) => {
    const map = cloneDemoMaps()[0]!;
    const real = map.devices[0]!.interfaces[0]!;
    real.operStatus = 'DOWN';
    real.telemetryAvailable = true;
    real.rxBps = 2000;
    real.txBps = 5000;
    useMapStore.setState({ map });
    useMapStore.getState().addLink({ ...map.links[0]!, sourceDeviceId: side === 'SOURCE' ? real.deviceId : null,
      targetDeviceId: side === 'TARGET' ? real.deviceId : null, sourceNodeId: side === 'TARGET' ? 'carrier' : null,
      targetNodeId: side === 'SOURCE' ? 'carrier' : null, sourceInterfaceId: side === 'SOURCE' ? real.id : null,
      targetInterfaceId: side === 'TARGET' ? real.id : null, trafficMode: 'SINGLE_ENDED' });
    const link = useMapStore.getState().map!.links.at(-1)!;
    expect(link).toMatchObject({ status: 'DOWN', rxBps: 2000, txBps: 5000 });
    expect(link.directions.A_TO_B.bps).toBe(side === 'SOURCE' ? 5000 : 2000);
    expect(link.directions.B_TO_A.bps).toBe(side === 'SOURCE' ? 2000 : 5000);
  });
});

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

describe('presets visuais: escala preservada e WeatherMap', () => {
  afterEach(() =>
    useMapStore.setState({ map: null, visualPreset: 'OPERACIONAL', layerFilter: 'PROBLEM' }),
  );

  it('aplica a escala sugerida somente quando o operador nao ajustou a escala', () => {
    const map = cloneDemoMaps()[0]!;

    // Escala intacta (100/100/100 = OPERACIONAL): o preset novo traz a dele.
    expect(presetScalePatch(map.settings, 'OPERACIONAL', 'WEATHERMAP')).toEqual({
      nodeScale: 75,
      linkScale: 140,
      labelScale: 85,
    });

    // Escala mexida na mao: trocar de preset nao devolve nada para sobrescrever.
    const customized = { ...map.settings, nodeScale: 110 };
    expect(presetScalePatch(customized, 'OPERACIONAL', 'WEATHERMAP')).toEqual({});
  });

  it('o preset WeatherMap recombina a apresentacao sem tocar no grafo', () => {
    const map = cloneDemoMaps()[0]!;
    const linksBefore = map.links.length;
    const positionsBefore = map.nodes.map((node) => ({ ...node.position }));
    useMapStore.getState().setMap(map);

    useMapStore.getState().setVisualPreset('WEATHERMAP');

    const state = useMapStore.getState();
    expect(state.map?.settings).toMatchObject({
      nodeDisplayMode: 'ICON_2D',
      linkDisplayStyle: 'WEATHERMAP',
      linkMetricDisplay: 'BOTH',
      trafficLabelMode: 'CARD',
      nodeScale: 75,
      linkScale: 140,
      labelScale: 85,
    });
    expect(state.preferences).toMatchObject({
      showTraffic: true,
      showUtilization: true,
      showLabels: false,
      showInterfaces: false,
    });
    expect(state.layerFilter).toBe('ALL');
    expect(state.map?.links).toHaveLength(linksBefore);
    expect(state.map?.nodes.map((node) => ({ ...node.position }))).toEqual(positionsBefore);
  });

  it('trocar de preset nao sobrescreve a escala ajustada a mao', () => {
    const map = cloneDemoMaps()[0]!;
    useMapStore.getState().setMap(map);
    useMapStore.getState().setMapScales({ nodeScale: 130, linkScale: 130, labelScale: 130 });

    useMapStore.getState().setVisualPreset('WEATHERMAP');

    expect(useMapStore.getState().map?.settings).toMatchObject({
      nodeScale: 130,
      linkScale: 130,
      labelScale: 130,
      linkDisplayStyle: 'WEATHERMAP',
    });
  });

  it('infere o preset persistido e o reaplica ao abrir outro mapa', () => {
    const [first, second] = cloneDemoMaps();
    second!.settings.nodeDisplayMode = 'ICON_2D';
    second!.settings.linkDisplayStyle = 'WEATHERMAP';
    second!.settings.linkMetricDisplay = 'BOTH';
    second!.settings.trafficLabelMode = 'CARD';

    expect(inferVisualPreset(second!.settings)).toBe('WEATHERMAP');

    useMapStore.setState({ map: first!, visualPreset: 'ENGENHARIA', layerFilter: 'ALL' });
    useMapStore.getState().setMap(second!);

    expect(useMapStore.getState().visualPreset).toBe('WEATHERMAP');
  });

  it('a rotacao NOC nao perde o preset/escala persistidos do mapa', () => {
    const [first, second] = cloneDemoMaps();
    useMapStore.getState().setMap(first!);
    useMapStore.getState().setVisualPreset('WEATHERMAP');
    const weatherMap = useMapStore.getState().map!;

    useMapStore.getState().startRotation({
      mapIds: [first!.id, second!.id],
      intervalSeconds: 30,
      hideTopBar: true,
      hideControls: true,
      pauseOnInteraction: true,
    });
    useMapStore.getState().rotateBy(1);
    expect(useMapStore.getState().map).toBeNull();

    // O canvas recarrega o mapa do servidor: as configuracoes voltam como estavam.
    useMapStore.getState().setMap(weatherMap);
    expect(useMapStore.getState().map?.settings).toMatchObject({
      linkDisplayStyle: 'WEATHERMAP',
      nodeScale: 75,
      linkScale: 140,
      labelScale: 85,
    });
    expect(useMapStore.getState().visualPreset).toBe('WEATHERMAP');

    useMapStore.getState().stopRotation();
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

describe('navegação entre módulos', () => {
  afterEach(() =>
    useMapStore.setState({
      map: null,
      view: 'MAP',
      physicalFocusRequest: null,
      bgpDeviceFilter: null,
    }),
  );

  it('abre o BGP filtrado pelo equipamento escolhido no inventário', () => {
    useMapStore.getState().openBgpForDevice('ne8000-1');

    expect(useMapStore.getState().view).toBe('BGP');
    expect(useMapStore.getState().bgpDeviceFilter).toBe('ne8000-1');
  });

  it('pede foco no Físico com site/rack/porta exatos, sem inferir', () => {
    useMapStore.getState().openPhysicalPort('site-1', 'rack-1', 'port-9');
    const first = useMapStore.getState().physicalFocusRequest;

    expect(useMapStore.getState().view).toBe('PHYSICAL');
    expect(first).toMatchObject({ siteId: 'site-1', rackId: 'rack-1', portId: 'port-9' });

    useMapStore.getState().openPhysicalPort('site-2', 'rack-2', 'port-3');
    const second = useMapStore.getState().physicalFocusRequest;
    expect(second!.requestId).toBeGreaterThan(first!.requestId);

    // Limpar um pedido antigo não apaga o atual.
    useMapStore.getState().clearPhysicalFocusRequest(first!.requestId);
    expect(useMapStore.getState().physicalFocusRequest).toEqual(second);

    useMapStore.getState().clearPhysicalFocusRequest(second!.requestId);
    expect(useMapStore.getState().physicalFocusRequest).toBeNull();
  });

  it('não abre a interface no mapa quando o equipamento não está no mapa ativo', () => {
    const map = cloneDemoMaps()[0]!;
    useMapStore.setState({ map, activeMapId: map.id, view: 'MAP' });

    expect(useMapStore.getState().openInterfaceInActiveMap('equipamento-fora-do-mapa', 'i1')).toBe(
      false,
    );
    expect(useMapStore.getState().view).toBe('MAP');

    const device = map.devices[0]!;
    const networkInterface = device.interfaces[0]!;
    expect(
      useMapStore.getState().openInterfaceInActiveMap(device.id, networkInterface.id),
    ).toBe(true);
    expect(useMapStore.getState().selection).toEqual({
      kind: 'interface',
      id: networkInterface.id,
      deviceId: device.id,
    });
  });
});
