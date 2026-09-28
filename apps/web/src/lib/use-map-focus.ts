'use client';

import { useMemo } from 'react';
import { useMapStore } from '@/store/map-store';
import { countAlarmsByDevice, useActiveAlarms } from '@/lib/use-alarms';
import { computeMapFocus, nodeKey, type MapFocusResult } from '@/lib/map-focus';

export interface MapFocusView extends MapFocusResult {
  /** Nome do equipamento/node em foco por vizinhança (quando houver). */
  focusLabel: string | null;
  /** Total de elementos atenuados, para o aviso da rail e da status bar. */
  dimmedTotal: number;
}

/**
 * Fonte única do recorte visual do mapa (camada + site + tipo + vizinhança).
 *
 * Usada pela rail (contadores e avisos) e pelo canvas (atenuação real), sempre
 * a partir dos mesmos dados — alarmes vêm da mesma query do restante do mapa.
 */
export function useMapFocus(): MapFocusView {
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const layerFilter = useMapStore((state) => state.layerFilter);
  const siteFilter = useMapStore((state) => state.siteFilter);
  const deviceTypeFilter = useMapStore((state) => state.deviceTypeFilter);
  const focusHops = useMapStore((state) => state.focusHops);
  const alarms = useActiveAlarms(Boolean(map));

  const alarmCountByDevice = useMemo(() => countAlarmsByDevice(alarms), [alarms]);

  const focusNodeId = useMemo(() => {
    if (!selection || (selection.kind !== 'device' && selection.kind !== 'node')) return null;
    return selection.id;
  }, [selection]);

  const focusLabel = useMemo(() => {
    if (!map || !focusNodeId) return null;
    const node = map.nodes.find((item) => nodeKey(item) === focusNodeId);
    if (!node) return null;
    if (node.deviceId) {
      const device = map.devices.find((item) => item.id === node.deviceId);
      return device?.name ?? device?.hostname ?? null;
    }
    return node.label ?? node.genericType ?? 'node';
  }, [focusNodeId, map]);

  return useMemo(() => {
    const empty: MapFocusResult = {
      dimmedNodeIds: new Set<string>(),
      dimmedLinkIds: new Set<string>(),
      layerCounts: { ALL: 0, PROBLEM: 0, DOWN: 0, ALARMS: 0, HIGH_UTIL: 0 },
      stats: {
        nodes: 0,
        nodesDimmed: 0,
        links: 0,
        linksDimmed: 0,
        devicesUp: 0,
        devicesWarning: 0,
        devicesDown: 0,
        linksDown: 0,
        linksHighUtilization: 0,
        alarms: 0,
        worstUtilization: 0,
      },
    };
    const result = map
      ? computeMapFocus({
          nodes: map.nodes,
          devices: map.devices,
          links: map.links,
          layer: layerFilter,
          site: siteFilter,
          deviceType: deviceTypeFilter,
          focusHops,
          focusNodeId,
          alarmCountByDevice,
        })
      : empty;

    return {
      ...result,
      focusLabel,
      dimmedTotal: result.dimmedNodeIds.size + result.dimmedLinkIds.size,
    };
  }, [
    alarmCountByDevice,
    deviceTypeFilter,
    focusHops,
    focusLabel,
    focusNodeId,
    layerFilter,
    map,
    siteFilter,
  ]);
}
