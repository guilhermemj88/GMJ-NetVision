import type { AlertCenterItem } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';

/**
 * Navegacao do alerta para o mapa, compartilhada pela Central (F9.3) e pelo
 * painel compacto (F9.4): o MESMO item abre a interface no mapa ativo ou leva
 * o operador ao mapa que contem o equipamento. Cada funcao devolve a mensagem
 * de feedback quando o destino nao existe (nunca lanca).
 */

/** Secao do drawer da interface que o alerta pede para destacar (F9.1). */
export function alertDrawerSection(item: AlertCenterItem): 'OPTICAL' | 'METRICS' | null {
  if (item.category !== 'ALARM') {
    return item.type === 'CRC_FCS' || item.type === 'DISCARDS' ? 'METRICS' : null;
  }
  if (item.type === 'OPTICAL_RX_DEGRADATION') return 'OPTICAL';
  if (
    item.type === 'INTERFACE_ERRORS'
    || item.type === 'INTERFACE_CRC'
    || item.type === 'INTERFACE_DISCARDS'
  ) {
    return 'METRICS';
  }
  return null;
}

/**
 * Abrir interface: foca equipamento/interface no mapa ativo (o painel compacto
 * ja vive nele) e, quando possivel, destaca a secao util do drawer. Sem a
 * interface no mapa, cai para o equipamento; sem mapa, devolve o aviso.
 */
export function openAlertInterface(item: AlertCenterItem): string | null {
  if (!item.interfaceId) return 'Este alerta não tem interface associada.';
  const store = useMapStore.getState();
  if (store.openInterfaceInActiveMap(item.deviceId, item.interfaceId)) {
    const section = alertDrawerSection(item);
    if (section) store.focusInterfaceSection(item.interfaceId, section);
    return null;
  }
  const mapId = item.mapIds[0];
  if (mapId) {
    store.openHostOnMap(item.deviceId, mapId);
    return 'A interface não está no mapa ativo — abrimos o equipamento.';
  }
  return 'O equipamento deste alerta não está em nenhum mapa.';
}

/** Abrir no mapa: usa o mapa ativo quando ele contem o equipamento. */
export function openAlertOnMap(item: AlertCenterItem): string | null {
  const store = useMapStore.getState();
  const activeMapId = store.map?.id ?? null;
  if (activeMapId && store.map?.devices.some((device) => device.id === item.deviceId)) {
    if (item.interfaceId) store.openInterfaceInActiveMap(item.deviceId, item.interfaceId);
    else store.openHostOnMap(item.deviceId, activeMapId);
    return null;
  }
  const mapId = item.mapIds[0];
  if (!mapId) return 'O equipamento deste alerta não está em nenhum mapa.';
  store.openHostOnMap(item.deviceId, mapId);
  return null;
}
