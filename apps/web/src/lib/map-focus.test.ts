import { describe, expect, it } from 'vitest';
import type { Device, MapNode, NetworkLink } from '@gmj/shared';
import {
  HIGH_UTILIZATION_THRESHOLD,
  computeMapFocus,
  linkWorstUtilization,
  neighborhood,
  nodeKey,
} from './map-focus';

function device(id: string, status: Device['status'], site: string, deviceType: Device['deviceType']): Device {
  return { id, status, site, deviceType, name: id, hostname: id } as Device;
}

function mapNode(id: string, deviceId: string | null): MapNode {
  return { id, deviceId } as MapNode;
}

function link(
  id: string,
  source: string,
  target: string,
  utilization: [number, number] = [0, 0],
  status: NetworkLink['status'] = 'UP',
): NetworkLink {
  return {
    id,
    status,
    sourceDeviceId: source,
    targetDeviceId: target,
    sourceNodeId: null,
    targetNodeId: null,
    directions: {
      A_TO_B: { utilization: utilization[0] },
      B_TO_A: { utilization: utilization[1] },
    },
  } as NetworkLink;
}

// core (UP, DC, router) — aggr (WARNING, DC, switch) — olt (DOWN, VTA, olt) — cliente genérico
const devices = [
  device('core', 'UP', 'DC Savassi', 'router'),
  device('aggr', 'WARNING', 'DC Savassi', 'switch'),
  device('olt', 'DOWN', 'Venda Nova', 'olt'),
];
const nodes = [
  mapNode('n-core', 'core'),
  mapNode('n-aggr', 'aggr'),
  mapNode('n-olt', 'olt'),
  mapNode('n-generic', null),
];
const links = [
  link('l-core-aggr', 'core', 'aggr', [31, 42]),
  link('l-aggr-olt', 'aggr', 'olt', [88, 12], 'DOWN'),
  link('l-olt-generic', 'olt', 'n-generic', [5, 5]),
];

const base = {
  nodes,
  devices,
  links,
  site: null,
  deviceType: null,
  focusHops: 0 as const,
  focusNodeId: null,
  alarmCountByDevice: new Map<string, number>(),
};

describe('map-focus', () => {
  it('resume nodeKey e o pior sentido do enlace sem somar full-duplex', () => {
    expect(nodeKey(mapNode('n1', 'd1'))).toBe('d1');
    expect(nodeKey(mapNode('n1', null))).toBe('n1');
    expect(linkWorstUtilization(link('l', 'a', 'b', [31, 88]))).toBe(88);
  });

  it('calcula vizinhança por saltos a partir do node selecionado', () => {
    expect(neighborhood(links, 'core', 1)).toEqual(new Set(['core', 'aggr']));
    expect(neighborhood(links, 'core', 2)).toEqual(new Set(['core', 'aggr', 'olt']));
    expect(neighborhood(links, 'core', 3)).toEqual(
      new Set(['core', 'aggr', 'olt', 'n-generic']),
    );
    expect(neighborhood(links, null, 2)).toBeNull();
    expect(neighborhood(links, 'core', 0)).toBeNull();
  });

  it('sem camada, site nem tipo, nada é atenuado e o resumo conta o real', () => {
    const result = computeMapFocus({ ...base, layer: 'ALL' });

    expect(result.dimmedNodeIds.size).toBe(0);
    expect(result.dimmedLinkIds.size).toBe(0);
    expect(result.stats).toMatchObject({
      nodes: 4,
      links: 3,
      devicesUp: 1,
      devicesWarning: 1,
      devicesDown: 1,
      linksDown: 1,
      linksHighUtilization: 1,
      alarms: 0,
      worstUtilization: 88,
    });
  });

  it('camada DOWN mantém em foco o equipamento caído e a ponta do enlace caído', () => {
    const result = computeMapFocus({ ...base, layer: 'DOWN' });

    expect(result.dimmedNodeIds.has('core')).toBe(true);
    expect(result.dimmedNodeIds.has('olt')).toBe(false);
    expect(result.dimmedNodeIds.has('aggr')).toBe(false); // tem enlace DOWN
    expect(result.dimmedLinkIds.has('l-aggr-olt')).toBe(false);
    expect(result.dimmedLinkIds.has('l-core-aggr')).toBe(true);
  });

  it('camada ALARMS usa apenas alarmes reais por equipamento', () => {
    const result = computeMapFocus({
      ...base,
      layer: 'ALARMS',
      alarmCountByDevice: new Map([['core', 2]]),
    });

    expect(result.dimmedNodeIds.has('core')).toBe(false);
    expect(result.dimmedNodeIds.has('aggr')).toBe(true);
    expect(result.stats.alarms).toBe(2);
  });

  it('camada HIGH_UTIL respeita o limiar do pior sentido', () => {
    const result = computeMapFocus({ ...base, layer: 'HIGH_UTIL' });

    expect(HIGH_UTILIZATION_THRESHOLD).toBe(70);
    expect(result.dimmedNodeIds.has('aggr')).toBe(false);
    expect(result.dimmedNodeIds.has('core')).toBe(true);
    expect(result.dimmedNodeIds.has('olt')).toBe(false);
  });

  it('filtro de site e de tipo atenuam quem não corresponde', () => {
    const bySite = computeMapFocus({ ...base, layer: 'ALL', site: 'Venda Nova' });
    expect(bySite.dimmedNodeIds.has('olt')).toBe(false);
    expect(bySite.dimmedNodeIds.has('core')).toBe(true);
    expect(bySite.dimmedNodeIds.has('n-generic')).toBe(true);

    const byType = computeMapFocus({ ...base, layer: 'ALL', deviceType: 'router' });
    expect(byType.dimmedNodeIds.has('core')).toBe(false);
    expect(byType.dimmedNodeIds.has('aggr')).toBe(true);
  });

  it('vizinhança atenua tudo fora do raio sem remover do grafo', () => {
    const result = computeMapFocus({ ...base, layer: 'ALL', focusHops: 1, focusNodeId: 'core' });

    expect(result.dimmedNodeIds.has('core')).toBe(false);
    expect(result.dimmedNodeIds.has('aggr')).toBe(false);
    expect(result.dimmedNodeIds.has('olt')).toBe(true);
    expect(result.dimmedLinkIds.has('l-aggr-olt')).toBe(true);
  });

  it('combina camada e vizinhança (o foco mais restrito vence)', () => {
    const result = computeMapFocus({
      ...base,
      layer: 'PROBLEM',
      focusHops: 1,
      focusNodeId: 'olt',
    });

    expect(result.dimmedNodeIds.has('olt')).toBe(false);
    expect(result.dimmedNodeIds.has('aggr')).toBe(false);
    expect(result.dimmedNodeIds.has('core')).toBe(true);
  });
});
