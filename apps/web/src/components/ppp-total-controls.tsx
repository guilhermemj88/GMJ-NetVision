'use client';

import { defaultPppTotalSettings, type HostRecord, type MapWidget } from '@gmj/shared';
import { deleteWidget, updateWidget, upsertWidget } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

function hexColor(value: string | null): string {
  return value ?? '#000000';
}

/**
 * Map-level settings for the PPP TOTAL widget (part of "Visual do mapa").
 * The widget is created on first enable and follows the generic MapWidget
 * architecture; it is never rendered when absent.
 */
export function PppTotalControls() {
  const map = useMapStore((state) => state.map);
  const setWidget = useMapStore((state) => state.setWidget);
  const removeWidget = useMapStore((state) => state.removeWidget);
  const showToast = useMapStore((state) => state.showToast);
  if (!map) return null;

  const widget = map.widgets.find((item) => item.type === 'PPP_TOTAL');
  const capableHosts = map.devices.filter((device) => device.pppSupported);
  const settings = widget?.settings ?? defaultPppTotalSettings();

  const apply = async (next: MapWidget | null) => {
    if (next) setWidget(next);
    else if (widget) removeWidget(widget.id);
  };

  const toggleEnabled = async (enabled: boolean) => {
    try {
      if (enabled) {
        const created = await upsertWidget(map.id, {
          type: 'PPP_TOTAL',
          enabled: true,
          ...(widget
            ? {}
            : { positionX: 120, positionY: 120, settings: defaultPppTotalSettings() }),
        });
        await apply(created);
      } else if (widget) {
        const updated = await updateWidget(map.id, widget.id, { enabled: false });
        await apply(updated);
      }
    } catch {
      showToast('Falha ao atualizar PPP TOTAL');
    }
  };

  const updateSettings = async (patch: Partial<typeof settings>) => {
    if (!widget) return;
    try {
      const updated = await updateWidget(map.id, widget.id, { settings: patch });
      await apply(updated);
    } catch {
      showToast('Falha ao atualizar PPP TOTAL');
    }
  };

  const toggleHost = (hostId: string, selected: boolean) => {
    const selectedHostIds = new Set(settings.selectedHostIds);
    if (selected) selectedHostIds.add(hostId);
    else selectedHostIds.delete(hostId);
    void updateSettings({ selectedHostIds: [...selectedHostIds] });
  };

  const remove = async () => {
    if (!widget) return;
    try {
      await deleteWidget(map.id, widget.id);
      await apply(null);
    } catch {
      showToast('Falha ao remover PPP TOTAL');
    }
  };

  return (
    <div className="ppp-total-controls">
      <div className="ppp-total-controls__row">
        <span>PPP TOTAL</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(widget?.enabled)}
            onChange={(event) => void toggleEnabled(event.target.checked)}
          />
          <i />
          <em>{widget?.enabled ? 'Exibindo' : 'Oculto'}</em>
        </label>
      </div>

      {widget?.enabled && (
        <div className="ppp-total-controls__body">
          <div className="segmented-row">
            <span>Fonte</span>
            <div>
              {(
                [
                  ['AUTO', 'Automático'],
                  ['MANUAL', 'Selecionar hosts'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  type="button"
                  key={mode}
                  className={settings.mode === mode ? 'is-active' : ''}
                  onClick={() => void updateSettings({ mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {settings.mode === 'MANUAL' && (
            <div className="ppp-total-controls__hosts">
              {capableHosts.length === 0 ? (
                <small>Nenhum host com PPP suportado neste mapa.</small>
              ) : (
                capableHosts.map((host: HostRecord) => (
                  <label key={host.id}>
                    <input
                      type="checkbox"
                      checked={settings.selectedHostIds.includes(host.id)}
                      onChange={(event) => toggleHost(host.id, event.target.checked)}
                    />
                    <span>{host.displayName || host.hostname}</span>
                  </label>
                ))
              )}
            </div>
          )}

          <label className="ppp-total-controls__field">
            <span>Título</span>
            <input
              type="text"
              value={settings.title}
              onChange={(event) => void updateSettings({ title: event.target.value })}
            />
          </label>

          <label className="ppp-total-controls__field">
            <span>Cor da fonte</span>
            <input
              type="color"
              value={hexColor(settings.fontColor)}
              onChange={(event) => void updateSettings({ fontColor: event.target.value })}
            />
          </label>

          <label className="ppp-total-controls__field">
            <span>Tamanho da fonte</span>
            <input
              type="range"
              min="10"
              max="64"
              value={settings.fontSize}
              onChange={(event) => void updateSettings({ fontSize: Number(event.target.value) })}
            />
            <output>{settings.fontSize}px</output>
          </label>

          <label className="ppp-total-controls__field">
            <span>Cor de fundo</span>
            <input
              type="color"
              value={hexColor(settings.backgroundColor)}
              onChange={(event) => void updateSettings({ backgroundColor: event.target.value })}
            />
          </label>

          <label className="ppp-total-controls__field">
            <span>Transparência</span>
            <input
              type="range"
              min="0"
              max="100"
              value={settings.backgroundOpacity}
              onChange={(event) =>
                void updateSettings({ backgroundOpacity: Number(event.target.value) })
              }
            />
            <output>{settings.backgroundOpacity}%</output>
          </label>

          <label className="ppp-total-controls__toggle">
            <input
              type="checkbox"
              checked={settings.showHostCount}
              onChange={(event) => void updateSettings({ showHostCount: event.target.checked })}
            />
            <span>Mostrar quantidade de hosts</span>
          </label>

          <label className="ppp-total-controls__toggle">
            <input
              type="checkbox"
              checked={settings.showFreshness}
              onChange={(event) => void updateSettings({ showFreshness: event.target.checked })}
            />
            <span>Mostrar freshness</span>
          </label>

          <button type="button" className="ppp-total-controls__remove" onClick={() => void remove()}>
            Remover widget
          </button>
        </div>
      )}
    </div>
  );
}
