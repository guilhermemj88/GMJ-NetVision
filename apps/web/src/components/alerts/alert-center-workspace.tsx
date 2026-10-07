'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALERT_CENTER_PERIODS,
  ALERT_CENTER_STATE_FILTERS,
  ALERT_CENTER_TYPE_OPTIONS,
  alertCenterAttentionCount,
  alertCenterPeriodLabel,
  alertCenterStateFilterLabel,
  alertCenterStateTitle,
  type AlertCenterCategory,
  type AlertCenterItem,
  type AlertCenterListQuery,
  type AlertCenterPeriod,
  type AlertCenterStateFilter,
  type AlarmSeverity,
} from '@gmj/shared';
import { RefreshCw, Search } from 'lucide-react';
import { suppressAlarm, type SuppressAlarmPayload } from '@/lib/api';
import {
  ALERT_CENTER_PAGE_SIZE,
  useAcknowledgeAlertItem,
  useAcknowledgeAlertItems,
  useAlertCenterList,
  useAlertCenterSummary,
} from '@/lib/use-alert-center';
import { useMapStore } from '@/store/map-store';
import { AlertDetailDrawer } from './alert-detail-drawer';
import { SuppressAlarmDialog } from './suppress-alarm-dialog';
import {
  alertAgeText,
  alertAckText,
  alertCanAcknowledge,
  alertCategoryBadge,
  alertSeverityLabel,
  alertSeverityTone,
  alertStateText,
  alertStateTone,
  alertTimelineText,
} from './alerts-format';

const SEVERITIES: readonly AlarmSeverity[] = ['CRITICAL', 'MAJOR', 'WARNING', 'INFO'];

/** Lista vazia ESTÁVEL: evita identidade nova a cada render (deps de efeito). */
const EMPTY_ITEMS: AlertCenterItem[] = [];

/** Filtros da tela (a URL carrega os mesmos campos, sem router). */
interface AlertCenterFilters {
  state: AlertCenterStateFilter;
  category?: AlertCenterCategory | undefined;
  types?: string[] | undefined;
  severities?: AlarmSeverity[] | undefined;
  period?: AlertCenterPeriod | undefined;
  search?: string | undefined;
}

function readFiltersFromUrl(): AlertCenterFilters {
  if (typeof window === 'undefined') return { state: 'ACTIVE' };
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state');
  const category = params.get('category');
  return {
    state: (ALERT_CENTER_STATE_FILTERS as readonly string[]).includes(state ?? '')
      ? (state as AlertCenterStateFilter)
      : 'ACTIVE',
    ...(category === 'ALARM' || category === 'OCCURRENCE'
      ? { category: category as AlertCenterCategory }
      : {}),
    ...(params.getAll('type').length ? { types: params.getAll('type') } : {}),
    ...(params.getAll('severity').length
      ? { severities: params.getAll('severity') as AlarmSeverity[] }
      : {}),
    ...((ALERT_CENTER_PERIODS as readonly string[]).includes(params.get('period') ?? '')
      ? { period: params.get('period') as AlertCenterPeriod }
      : {}),
    ...(params.get('search') ? { search: params.get('search') as string } : {}),
  };
}

/** Mantem a URL reutilizavel (?view=alerts&state=...) sem recarregar a tela. */
function writeFiltersToUrl(filters: AlertCenterFilters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  params.set('view', 'alerts');
  params.set('state', filters.state);
  if (filters.category) params.set('category', filters.category);
  else params.delete('category');
  params.delete('type');
  for (const type of filters.types ?? []) params.append('type', type);
  params.delete('severity');
  for (const severity of filters.severities ?? []) params.append('severity', severity);
  if (filters.period) params.set('period', filters.period);
  else params.delete('period');
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  else params.delete('search');
  const search = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}?${search}`);
}

/**
 * Workspace ALERTAS: central NOC com alarmes e ocorrencias na MESMA visao.
 * A leitura ja vem fundida e paginada do backend (`/api/alert-center`); aqui
 * so filtramos, ordenamos visualmente e agimos (ACK, supressao, mapa).
 */
export function AlertCenterWorkspace() {
  const [filters, setFilters] = useState<AlertCenterFilters>(readFiltersFromUrl);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [detail, setDetail] = useState<AlertCenterItem | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<AlertCenterItem | null>(null);
  const [suppressError, setSuppressError] = useState<string | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const query: AlertCenterListQuery = useMemo(
    () => ({
      state: filters.state,
      category: filters.category,
      types: filters.types,
      severities: filters.severities,
      period: filters.period,
      search: filters.search,
      limit: ALERT_CENTER_PAGE_SIZE,
      offset: page * ALERT_CENTER_PAGE_SIZE,
    }),
    [filters, page],
  );

  const list = useAlertCenterList(query);
  const summary = useAlertCenterSummary();
  const acknowledgeItem = useAcknowledgeAlertItem();
  const acknowledgeBatch = useAcknowledgeAlertItems();

  const items = useMemo(() => list.data?.items ?? EMPTY_ITEMS, [list.data]);
  const total = list.data?.total ?? 0;
  const summaryCards = list.data?.summary ?? summary;
  // Relogio da tela acompanha a leitura (idade/duracao sempre coerentes).
  const nowMs = list.data ? new Date(list.data.generatedAt).getTime() : Date.now();

  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  useEffect(() => {
    setPage(0);
    setSelected([]);
  }, [filters]);

  // Seleção some quando o item deixa de estar na lista (ACK/refetch). Devolve o
  // MESMO array quando nada mudou, para não realimentar o efeito.
  useEffect(() => {
    setSelected((current) => {
      const next = current.filter((id) => items.some((item) => item.id === id));
      return next.length === current.length ? current : next;
    });
  }, [items]);

  const update = useCallback((patch: Partial<AlertCenterFilters>) => {
    setFeedback(null);
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const selectableItems = items.filter((item) => alertCanAcknowledge(item));
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const allSelected = selectableItems.length > 0 && selected.length === selectableItems.length;

  const runBatchAcknowledge = async () => {
    if (!selectedItems.length) return;
    setFeedback(null);
    const result = await acknowledgeBatch.mutateAsync(selectedItems);
    const total = result.acknowledgedAlarms + result.acknowledgedOccurrences;
    setSelected([]);
    if (result.failures.length) {
      setFeedback(
        `${total} reconhecido(s); ${result.failures.length} falhou(aram): ${result.failures[0]}`,
      );
    } else {
      setFeedback(
        `${total} reconhecido(s) — ${result.acknowledgedAlarms} alarme(s), ${result.acknowledgedOccurrences} ocorrência(s).`,
      );
    }
  };

  const acknowledgeOne = async (item: AlertCenterItem) => {
    setFeedback(null);
    setDetailError(null);
    try {
      await acknowledgeItem.mutateAsync(item);
      setFeedback(`Reconhecido: ${item.typeLabel} — ${item.deviceName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'falha ao reconhecer';
      setFeedback(message);
      setDetailError(message);
    }
  };

  const submitSuppression = async (item: AlertCenterItem, payload: SuppressAlarmPayload) => {
    setSuppressError(null);
    try {
      await suppressAlarm(item.id, payload);
      setSuppressTarget(null);
      setDetail(null);
      setFeedback(`Alarme retirado: ${item.typeLabel} — ${item.deviceName}`);
      await list.refetch();
    } catch (error) {
      setSuppressError(error instanceof Error ? error.message : 'falha ao retirar o alarme');
    }
  };

  const openInterface = (item: AlertCenterItem) => {
    setNavError(null);
    if (!item.interfaceId) {
      setNavError('Este alerta não tem interface associada.');
      return;
    }
    const store = useMapStore.getState();
    if (store.openInterfaceInActiveMap(item.deviceId, item.interfaceId)) return;
    const mapId = item.mapIds[0];
    if (mapId) {
      // Sem a interface no mapa ativo: abre o equipamento e avisa o operador.
      store.openHostOnMap(item.deviceId, mapId);
      setNavError('A interface não está no mapa ativo — abrimos o equipamento.');
      return;
    }
    setNavError('O equipamento deste alerta não está em nenhum mapa.');
  };

  const openMap = (item: AlertCenterItem) => {
    setNavError(null);
    const store = useMapStore.getState();
    const activeMapId = store.map?.id ?? null;
    if (activeMapId && store.map?.devices.some((device) => device.id === item.deviceId)) {
      if (item.interfaceId) store.openInterfaceInActiveMap(item.deviceId, item.interfaceId);
      else store.openHostOnMap(item.deviceId, activeMapId);
      return;
    }
    const mapId = item.mapIds[0];
    if (!mapId) {
      setNavError('O equipamento deste alerta não está em nenhum mapa.');
      return;
    }
    store.openHostOnMap(item.deviceId, mapId);
  };

  return (
    <section className="alerts-workspace" aria-label="Central de Alertas">
      <header className="alerts-workspace__header">
        <div>
          <h2>ALERTAS</h2>
          <p>
            Alarmes e ocorrências operacionais na mesma visão. Resumo:{' '}
            {alertCenterAttentionCount(summaryCards)} item(ns) exigindo atenção.
          </p>
        </div>
        <div className="alerts-workspace__meta">
          {list.data?.generatedAt ? (
            <span>Atualizado {new Date(list.data.generatedAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void list.refetch()}
            aria-label="Atualizar alertas"
            disabled={list.isFetching}
          >
            <RefreshCw size={13} /> Atualizar
          </button>
        </div>
      </header>

      <div className="alerts-cards" role="group" aria-label="Resumo operacional">
        <button
          type="button"
          className={filters.state === 'ACTIVE' && !filters.category ? 'is-active' : ''}
          onClick={() => update({ state: 'ACTIVE', category: undefined, severities: undefined })}
        >
          <strong>{summaryCards.alarmsActive}</strong>
          <span>Ativos</span>
        </button>
        <button
          type="button"
          className={
            filters.severities?.length === 1 && filters.severities[0] === 'CRITICAL' ? 'is-active' : ''
          }
          onClick={() => update({ state: 'ACTIVE', severities: ['CRITICAL'], category: undefined })}
        >
          <strong>{summaryCards.alarmsActiveCritical}</strong>
          <span>Críticos</span>
        </button>
        <button
          type="button"
          className={filters.severities?.length === 2 ? 'is-active' : ''}
          onClick={() =>
            update({ state: 'ACTIVE', severities: ['MAJOR', 'WARNING'], category: undefined })
          }
        >
          <strong>{summaryCards.alarmsActiveMajor + summaryCards.alarmsActiveWarning}</strong>
          <span>Avisos</span>
        </button>
        <button
          type="button"
          className={filters.category === 'OCCURRENCE' ? 'is-active' : ''}
          onClick={() => update({ state: 'UNACKNOWLEDGED', category: 'OCCURRENCE', severities: undefined })}
        >
          <strong>{summaryCards.occurrencesUnacknowledged}</strong>
          <span>Ocorrências</span>
        </button>
        <button
          type="button"
          className={filters.state === 'ACKNOWLEDGED' ? 'is-active' : ''}
          onClick={() => update({ state: 'ACKNOWLEDGED', category: undefined, severities: undefined })}
        >
          <strong>
            {summaryCards.alarmsActiveAcknowledged + summaryCards.occurrencesAcknowledged}
          </strong>
          <span>Reconhecidos</span>
        </button>
      </div>

      <div className="alerts-filters">
        <label className="alerts-filters__search">
          <Search size={13} />
          <input
            type="search"
            value={filters.search ?? ''}
            placeholder="Buscar equipamento, interface, alias ou tipo…"
            aria-label="Buscar alertas"
            onChange={(event) => update({ search: event.target.value || undefined })}
          />
        </label>
        <label>
          ESTADO
          <select
            value={filters.state}
            onChange={(event) => update({ state: event.target.value as AlertCenterStateFilter })}
          >
            {ALERT_CENTER_STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {alertCenterStateFilterLabel(state)}
              </option>
            ))}
          </select>
        </label>
        <label>
          CATEGORIA
          <select
            value={filters.category ?? ''}
            onChange={(event) =>
              update({ category: (event.target.value || undefined) as AlertCenterCategory | undefined })
            }
          >
            <option value="">Todas</option>
            <option value="ALARM">Alarmes</option>
            <option value="OCCURRENCE">Ocorrências</option>
          </select>
        </label>
        <label>
          TIPO
          <select
            value={filters.types?.[0] ?? ''}
            onChange={(event) => update({ types: event.target.value ? [event.target.value] : undefined })}
          >
            <option value="">Todos</option>
            {(['ALARM', 'OCCURRENCE'] as const).map((category) => (
              <optgroup key={category} label={category === 'ALARM' ? 'Alarmes' : 'Ocorrências'}>
                {ALERT_CENTER_TYPE_OPTIONS.filter((option) => option.category === category).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          SEVERIDADE
          <select
            value={
              filters.severities?.length === 2
                ? 'MAJOR_WARNING'
                : (filters.severities?.[0] ?? '')
            }
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return update({ severities: undefined });
              if (value === 'MAJOR_WARNING') return update({ severities: ['MAJOR', 'WARNING'] });
              return update({ severities: [value as AlarmSeverity] });
            }}
          >
            <option value="">Todas</option>
            {filters.severities?.length === 2 ? (
              <option value="MAJOR_WARNING">MAJOR + WARNING</option>
            ) : null}
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {alertSeverityLabel(severity)}
              </option>
            ))}
          </select>
        </label>
        <label>
          PERÍODO
          <select
            value={filters.period ?? ''}
            onChange={(event) =>
              update({ period: (event.target.value || undefined) as AlertCenterPeriod | undefined })
            }
          >
            <option value="">Tudo</option>
            {ALERT_CENTER_PERIODS.map((period) => (
              <option key={period} value={period}>
                {alertCenterPeriodLabel(period)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="alerts-filters__clear"
          onClick={() => update({ state: 'ACTIVE', category: undefined, types: undefined, severities: undefined, period: undefined, search: undefined })}
        >
          Limpar filtros
        </button>
      </div>

      <div className="alerts-toolbar">
        <label className="alerts-toolbar__select-all">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={!selectableItems.length}
            aria-label="Selecionar todos os alertas reconhecíveis"
            onChange={(event) =>
              setSelected(event.target.checked ? selectableItems.map((item) => item.id) : [])
            }
          />
          {selected.length ? `${selected.length} selecionado(s)` : 'Selecionar'}
        </label>
        <button
          type="button"
          disabled={!selected.length || acknowledgeBatch.isPending}
          onClick={() => void runBatchAcknowledge()}
        >
          {acknowledgeBatch.isPending ? 'RECONHECENDO…' : 'RECONHECER SELECIONADOS'}
        </button>
        {feedback ? (
          <span className="alerts-toolbar__feedback" role="status">
            {feedback}
          </span>
        ) : null}
        {navError ? (
          <span className="alerts-toolbar__error" role="alert">
            {navError}
          </span>
        ) : null}
      </div>

      <div className="alerts-table-wrapper">
        {list.isLoading ? (
          <div className="alerts-skeleton" aria-live="polite">
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : list.isError ? (
          <div className="alerts-empty" role="alert">
            <strong>Falha ao carregar os alertas.</strong>
            <p>O restante do NetVision continua funcionando.</p>
            <button type="button" onClick={() => void list.refetch()}>
              Tentar novamente
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="alerts-empty">
            <strong>Nenhum alerta para os filtros selecionados.</strong>
            <p>Alarmes ativos e ocorrências vigentes aparecem aqui automaticamente.</p>
          </div>
        ) : (
          <table className="alerts-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Seleção</span>
                </th>
                <th scope="col">Estado</th>
                <th scope="col">Sev/Cat</th>
                <th scope="col">Alerta</th>
                <th scope="col">Equipamento</th>
                <th scope="col">Interface</th>
                <th scope="col">Valor</th>
                <th scope="col">Eventos</th>
                <th scope="col">Idade</th>
                <th scope="col">ACK</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const ackable = alertCanAcknowledge(item);
                return (
                  <tr
                    key={item.id}
                    className={selected.includes(item.id) ? 'is-selected' : ''}
                    onClick={() => {
                      setDetail(item);
                      setNavError(null);
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        disabled={!ackable}
                        aria-label={`Selecionar ${item.typeLabel} de ${item.deviceName}`}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <span
                        className={`alerts-chip alerts-chip--${alertStateTone(item.state)}`}
                        title={alertCenterStateTitle(item.state)}
                      >
                        {alertStateText(item.state)}
                      </span>
                    </td>
                    <td>
                      {item.severity ? (
                        <span className={`alerts-chip alerts-chip--${alertSeverityTone(item.severity)}`}>
                          {alertSeverityLabel(item.severity)}
                        </span>
                      ) : (
                        <span className={`alerts-chip alerts-chip--${alertStateTone(item.state)}`}>
                          {alertCategoryBadge(item)}
                        </span>
                      )}
                    </td>
                    <td className="alerts-table__alert">
                      <strong>{item.typeLabel}</strong>
                      <small>
                        {item.alarm?.message ??
                          (item.occurrence
                            ? `${item.occurrence.occurrenceCount} ocorrência(s) · pico ${item.occurrence.peakRatePerMin}/min`
                            : '')}
                      </small>
                    </td>
                    <td>
                      <strong>{item.deviceName}</strong>
                      <small>{item.deviceHostname ?? item.site ?? '—'}</small>
                    </td>
                    <td>
                      <strong>{item.interfaceName ?? '—'}</strong>
                      <small>
                        {item.interfaceAlias ??
                          (item.ifIndex === null ? '—' : `ifIndex ${item.ifIndex}`)}
                        {item.alarm?.optical?.lane != null ? ` · lane ${item.alarm.optical.lane}` : ''}
                        {item.alarm?.direction ? ` · ${item.alarm.direction}` : ''}
                      </small>
                    </td>
                    <td className="alerts-table__value">{item.valueSummary}</td>
                    <td>{alertTimelineText(item, nowMs)}</td>
                    <td>{alertAgeText(item.lastSeenAt, nowMs)}</td>
                    <td>{alertAckText(item)}</td>
                    <td className="alerts-table__actions">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDetail(item);
                        }}
                      >
                        Detalhes
                      </button>
                      {ackable ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void acknowledgeOne(item);
                          }}
                        >
                          Reconhecer
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="alerts-pagination">
        <span>
          {total === 0
            ? 'Nenhum item'
            : `${page * ALERT_CENTER_PAGE_SIZE + 1}–${page * ALERT_CENTER_PAGE_SIZE + items.length} de ${total}`}
        </span>
        <div>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(current - 1, 0))}
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={!list.data?.hasMore}
            onClick={() => setPage((current) => current + 1)}
          >
            Próxima
          </button>
        </div>
      </footer>

      {detail ? (
        <AlertDetailDrawer
          item={detail}
          nowMs={nowMs}
          pending={acknowledgeItem.isPending}
          error={detailError}
          onClose={() => setDetail(null)}
          onAcknowledge={(item) => void acknowledgeOne(item)}
          onSuppress={(item) => {
            setSuppressError(null);
            setSuppressTarget(item);
          }}
          onOpenInterface={openInterface}
          onOpenMap={openMap}
        />
      ) : null}

      {suppressTarget ? (
        <SuppressAlarmDialog
          item={suppressTarget}
          error={suppressError}
          onCancel={() => setSuppressTarget(null)}
          onSubmit={(payload) => void submitSuppression(suppressTarget, payload)}
        />
      ) : null}
    </section>
  );
}
