// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { AlertCenterItem, AlarmType, NetworkMap } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import { alertDrawerSection, openAlertInterface, openAlertOnMap } from './alert-navigation';

function item(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return {
    id: 'alarm-1',
    category: 'ALARM',
    state: 'ACTIVE_UNACKNOWLEDGED',
    severity: 'CRITICAL',
    type: 'INTERFACE_DOWN',
    typeLabel: 'LINK DOWN',
    deviceId: 'dev-1',
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: null,
    site: null,
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: null,
    interfaceLabel: null,
    ifIndex: 1,
    startedAt: new Date('2026-10-12T09:00:00.000Z').toISOString(),
    lastSeenAt: new Date('2026-10-12T11:00:00.000Z').toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: 'DOWN',
    mapIds: ['map-1'],
    ...patch,
  };
}

function mapFixture(): NetworkMap {
  return {
    id: 'map-1',
    name: 'Backbone',
    devices: [
      { id: 'dev-1', name: 'RNS-FLOR-6730-MPLS-01', interfaces: [{ id: 'iface-1', name: '100GE0/0/2' }] },
    ],
    nodes: [],
    links: [],
    widgets: [],
  } as unknown as NetworkMap;
}

describe('navegacao do alerta (F9.4)', () => {
  beforeEach(() => {
    useMapStore.setState({
      view: 'MAP',
      map: mapFixture(),
      activeMapId: 'map-1',
      maps: [],
      selection: null,
      panel: null,
      focusRequest: null,
      interfaceSectionRequest: null,
      pendingDeviceNavigation: null,
      toast: null,
    });
  });

  it('mapeia a secao util do drawer por tipo de alerta', () => {
    expect(alertDrawerSection(item({ type: 'OPTICAL_RX_DEGRADATION' as AlarmType }))).toBe('OPTICAL');
    expect(alertDrawerSection(item({ type: 'INTERFACE_ERRORS' as AlarmType }))).toBe('METRICS');
    expect(alertDrawerSection(item({ type: 'INTERFACE_CRC' as AlarmType }))).toBe('METRICS');
    expect(alertDrawerSection(item({ type: 'INTERFACE_DISCARDS' as AlarmType }))).toBe('METRICS');
    expect(alertDrawerSection(item())).toBeNull();
    expect(
      alertDrawerSection(item({ category: 'OCCURRENCE', type: 'CRC_FCS', severity: null })),
    ).toBe('METRICS');
    expect(
      alertDrawerSection(item({ category: 'OCCURRENCE', type: 'DISCARDS', severity: null })),
    ).toBe('METRICS');
    expect(
      alertDrawerSection(item({ category: 'OCCURRENCE', type: 'OTHER', severity: null })),
    ).toBeNull();
  });

  it('abre a interface no mapa ativo e destaca a secao pedida', () => {
    const message = openAlertInterface(item({ type: 'INTERFACE_CRC' as AlarmType }));
    const state = useMapStore.getState();
    expect(message).toBeNull();
    expect(state.selection).toEqual({ kind: 'interface', id: 'iface-1', deviceId: 'dev-1' });
    expect(state.interfaceSectionRequest?.section).toBe('METRICS');
  });

  it('sem a interface no mapa ativo cai para o equipamento e avisa', () => {
    const message = openAlertInterface(item({ interfaceId: 'iface-9' }));
    expect(message).toContain('abrimos o equipamento');
    expect(useMapStore.getState().selection).toEqual({ kind: 'device', id: 'dev-1' });
  });

  it('troca de mapa quando o equipamento pertence a outro mapa', () => {
    const message = openAlertInterface(item({ interfaceId: 'iface-9', mapIds: ['map-9'] }));
    expect(message).toContain('abrimos o equipamento');
    expect(useMapStore.getState().pendingDeviceNavigation).toEqual({
      mapId: 'map-9',
      deviceId: 'dev-1',
    });
  });

  it('sem nenhum mapa devolve aviso seguro e nao muda a visao', () => {
    useMapStore.setState({ map: null, activeMapId: null });
    expect(openAlertOnMap(item({ mapIds: [] }))).toContain('não está em nenhum mapa');
    expect(useMapStore.getState().view).toBe('MAP');
    expect(openAlertInterface(item({ interfaceId: null, mapIds: [] }))).toContain(
      'não tem interface associada',
    );
  });
});
