'use client';

/**
 * MAP-VISUAL-V2 — painel lateral demonstrativo do enlace (Fase B).
 *
 * Mostra as MESMAS informações que o ContextDrawer real apresentaria (pontas,
 * A→B, B→A, capacidade, qualidade das métricas, estado e histórico), mas com
 * dados mock e sem nenhuma dependência da API. O ContextDrawer de produção não
 * foi alterado.
 */

import { useMemo } from 'react';
import { formatCompactBps, LINK_V2_STATE_LABELS } from '@/lib/map-visual-v2';
import { mockLinkHistory, type LinkV2GroupModel, type LinkV2EdgeModel } from './v2-model';

const HISTORY_WIDTH = 250;
const HISTORY_HEIGHT = 62;
const HISTORY_POINTS = 48;

function HistoryChart({ seed, currentPercent }: { seed: string; currentPercent: number }) {
  const { linePath, areaPath } = useMemo(() => {
    const series = mockLinkHistory(seed, currentPercent, HISTORY_POINTS);
    const stepX = HISTORY_WIDTH / Math.max(1, series.length - 1);
    const toY = (value: number) => HISTORY_HEIGHT - (Math.min(120, value) / 120) * HISTORY_HEIGHT;
    const points = series.map((value, index) => `${(index * stepX).toFixed(1)},${toY(value).toFixed(1)}`);
    return {
      linePath: `M${points.join(' L')}`,
      areaPath: `M0,${HISTORY_HEIGHT} L${points.join(' L')} L${HISTORY_WIDTH},${HISTORY_HEIGHT} Z`,
    };
  }, [seed, currentPercent]);

  const lineY = (percent: number) => HISTORY_HEIGHT - (percent / 120) * HISTORY_HEIGHT;

  return (
    <svg
      className="mv2-panel__chart"
      viewBox={`0 0 ${HISTORY_WIDTH} ${HISTORY_HEIGHT}`}
      role="img"
      aria-label="Histórico demonstrativo de utilização"
    >
      <path className="mv2-panel__chart-area" d={areaPath} />
      <line x1="0" y1={lineY(50)} x2={HISTORY_WIDTH} y2={lineY(50)} className="mv2-panel__chart-threshold mv2-panel__chart-threshold--attention" />
      <line x1="0" y1={lineY(80)} x2={HISTORY_WIDTH} y2={lineY(80)} className="mv2-panel__chart-threshold mv2-panel__chart-threshold--critical" />
      <path className="mv2-panel__chart-line" pathLength={1} d={linePath} />
    </svg>
  );
}

export function LinkV2Panel({
  edge,
  group,
  expanded,
  onToggleLag,
  onClose,
}: {
  edge: LinkV2EdgeModel;
  group: LinkV2GroupModel | null;
  expanded: boolean;
  onToggleLag: (groupId: string) => void;
  onClose: () => void;
}) {
  const { visual, tooltip } = edge;
  return (
    <aside className="mv2-panel" data-testid="mv2-link-panel">
      <header className="mv2-panel__head">
        <div>
          <p className="mv2-panel__eyebrow">Enlace selecionado · DEMONSTRAÇÃO</p>
          <h3 className="mv2-panel__title">{edge.label}</h3>
        </div>
        <button type="button" className="mv2-panel__close" onClick={onClose} aria-label="Fechar painel">
          ✕
        </button>
      </header>

      <dl className="mv2-panel__facts">
        <div>
          <dt>Ponta A</dt>
          <dd>{tooltip.aName}</dd>
        </div>
        <div>
          <dt>Ponta B</dt>
          <dd>{tooltip.bName}</dd>
        </div>
        <div>
          <dt>Capacidade</dt>
          <dd>{tooltip.capacityText}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd data-state={visual.state}>{LINK_V2_STATE_LABELS[visual.state]}</dd>
        </div>
        <div>
          <dt>Tráfego A→B</dt>
          <dd>{tooltip.aToBText}</dd>
        </div>
        <div>
          <dt>Tráfego B→A</dt>
          <dd>{tooltip.bToAText}</dd>
        </div>
        <div>
          <dt>Qualidade das métricas</dt>
          <dd>{tooltip.consistencyText}</dd>
        </div>
        <div>
          <dt>Fonte</dt>
          <dd>{tooltip.metricsSource}</dd>
        </div>
      </dl>

      <p className="mv2-panel__desc">
        {tooltip.description}
        {edge.simTag ? ` · ${edge.simTag}` : ''}
      </p>

      {group && (
        <div className="mv2-panel__group">
          <p className="mv2-panel__eyebrow">Grupo LAG demonstrativo</p>
          <p className="mv2-panel__group-line">
            {group.label} · {group.memberCount} membros
            {group.downMembers > 0 ? ` · ${group.downMembers} DOWN` : ''}
            {group.noDataMembers > 0 ? ` · ${group.noDataMembers} sem telemetria` : ''}
          </p>
          <p className="mv2-panel__group-line">
            Capacidade agregada:{' '}
            {group.declaredCapacityBps
              ? `${formatCompactBps(group.declaredCapacityBps)} (comprovada no mock)`
              : 'não comprovada — não somada'}
          </p>
          <button
            type="button"
            id="mv2-lag-toggle"
            className="mv2-panel__button"
            onClick={() => onToggleLag(group.groupId)}
          >
            {expanded ? 'Recolher grupo (linha única)' : 'Expandir grupo (membros individuais)'}
          </button>
        </div>
      )}

      <div className="mv2-panel__history">
        <p className="mv2-panel__eyebrow">Histórico demonstrativo (48 pontos)</p>
        <HistoryChart seed={edge.linkId} currentPercent={visual.utilizationPercent ?? 0} />
        <p className="mv2-panel__chart-caption">
          Linhas de referência em 50% (atenção) e 80% (crítico). O gráfico histórico real
          (MAP-LINK-GRAPHS) não foi recriado nem alterado.
        </p>
      </div>
    </aside>
  );
}
