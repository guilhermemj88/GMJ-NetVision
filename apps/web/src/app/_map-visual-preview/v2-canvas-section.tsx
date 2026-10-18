'use client';

/**
 * MAP-VISUAL-V2 — canvas da Fase B (React Flow real).
 *
 * Cenários A/B, visual de enlaces V1/V2, ícones V1/V2, rótulos inteligentes,
 * simulações, LAG demonstrativo, zoom presets e painel lateral mock. Tudo com
 * dados de demonstração — sem API, sem banco, sem tocar no mapa operacional.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { NetworkDeviceIcon } from '@/components/network-device-icon';
import {
  NetworkDeviceGlyphV2,
  resolveDeviceGlyphV2,
  type DeviceGlyphV2Type,
} from '@/components/network-device-glyphs-v2';
import { TrafficEdge, type TrafficEdgeData } from '@/components/traffic-edge';
import { defaultVisualPath, type MapVisualMode } from '@gmj/shared';
import type { NetworkDeviceIconType } from '@/lib/device-appearance';
import { resolveMapVisualMode } from '@/lib/map-visual-mode';
import type { LinkV2StrokeMode } from '@/lib/map-visual-v2';
import {
  LAB_OFFSETS_MAP_ID,
  laneForDirection,
  manualLabelOffset,
} from '@/lib/map-visual-v2-offsets';
import { selectionFromEdge } from '@/lib/map-visual-v2-selection';
import {
  getTrafficLabelOffsets,
  resetTrafficLabelOffsets,
  setTrafficLabelOffset,
  subscribeTrafficLabelOffsets,
} from '@/lib/traffic-label-offsets';
import {
  buildLinkV2Model,
  type LinkV2EdgeModel,
  type LinkV2Simulation,
  type LinkV2SimulationMode,
} from './v2-model';
import { LinkV2Edge, type LinkV2EdgeData } from './v2-link-edge';
import { LinkV2Panel } from './v2-link-panel';
import { scenarioById } from './v2-scenario-catalog';
import type { MockNodeStatus, MockScenario } from './v2-scenarios';

type Engine = 'v1' | 'v2';
type EdgeVisual = 'v1' | 'v2';
type LabelMode = 'smart' | 'all';
type BngMode = 'normal' | 'compact' | 'sugerida';
type CoreSwitchCandidate = 'SWITCH' | 'CORE_SWITCH';

const ICON_SIZE_STEPS = [16, 24, 32, 48] as const;
const ZOOM_PRESETS = [25, 50, 75, 100, 150, 220] as const;
const HANDLE_SIDES = ['left', 'right', 'top', 'bottom'] as const;
const POSITION_BY_SIDE = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
} as const;

interface LabFlowNodeData extends Record<string, unknown> {
  name: string;
  ip: string;
  status: MockNodeStatus;
  legacyType: NetworkDeviceIconType;
  glyph: DeviceGlyphV2Type | null;
  iconSize: number;
  bngCompact: boolean;
  alarms: number | undefined;
  tag: string | undefined;
}

type LabFlowNode = Node<LabFlowNodeData, 'labDevice'>;

function deviceColorClass(iconType: string): string {
  return `device-node--type-${iconType.toLowerCase().replaceAll('_', '-')}`;
}

function LabDeviceNode({ data, selected }: NodeProps<LabFlowNode>) {
  return (
    <div
      className={`device-node device-node--icon_2d ${deviceColorClass(data.legacyType)} status-${data.status} ${
        selected ? 'is-selected' : ''
      } ${data.glyph ? 'mv2-node--flat' : ''}`}
      title={`${data.name} · ${data.ip} · ${data.status}`}
    >
      {HANDLE_SIDES.map((side) => (
        <Handle key={`s-${side}`} id={`s-${side}`} type="source" position={POSITION_BY_SIDE[side]} isConnectable={false} />
      ))}
      {HANDLE_SIDES.map((side) => (
        <Handle key={`t-${side}`} id={`t-${side}`} type="target" position={POSITION_BY_SIDE[side]} isConnectable={false} />
      ))}
      <div className="device-node__icon">
        {data.glyph ? (
          <NetworkDeviceGlyphV2 type={data.glyph} size={data.iconSize} compact={data.bngCompact} />
        ) : (
          <NetworkDeviceIcon type={data.legacyType} variant="2d" size={data.iconSize} />
        )}
        <span className="status-pulse" />
      </div>
      <div className="device-node__copy">
        <strong>{data.name}</strong>
        <span>{data.ip}</span>
        {data.tag ? <em className="mv2-node__tag">{data.tag}</em> : null}
      </div>
      {data.alarms ? (
        <span
          className="device-node__alarm-badge"
          title={`${data.alarms} alarme(s) ativo(s)`}
          aria-label={`${data.alarms} alarmes ativos`}
        >
          ⚠ {data.alarms}
        </span>
      ) : null}
    </div>
  );
}

const LAB_NODE_TYPES = { labDevice: LabDeviceNode };
const LAB_EDGE_TYPES = { trafficV2: LinkV2Edge, traffic: TrafficEdge };

function ZoomPresets() {
  const { zoomTo } = useReactFlow();
  return (
    <div className="mv2-zoom-presets" role="group" aria-label="Zoom do canvas">
      {ZOOM_PRESETS.map((zoom) => (
        <button
          key={zoom}
          id={`mv2-zoom-${zoom}`}
          type="button"
          className="mv2-zoom-presets__button"
          onClick={() => {
            void zoomTo(zoom / 100, { duration: 250 });
          }}
        >
          {zoom}%
        </button>
      ))}
    </div>
  );
}

/** Mantém o modelo ciente do zoom para a anticolisão dos rótulos. */
function ZoomTracker({ onZoom }: { onZoom: (zoom: number) => void }) {
  const { getZoom } = useReactFlow();
  useEffect(() => {
    const timer = window.setTimeout(() => onZoom(getZoom()), 80);
    return () => window.clearTimeout(timer);
  }, [getZoom, onZoom]);
  return null;
}

function ControlGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mv2-control">
      <p className="mv2-control__title">{title}</p>
      <div className="mv2-control__options">{children}</div>
    </div>
  );
}

function Option<T extends string>({
  name,
  value,
  current,
  onSelect,
  id,
  children,
}: {
  name: string;
  value: T;
  current: T;
  onSelect: (value: T) => void;
  id?: string;
  children: ReactNode;
}) {
  return (
    <label className="mv2-option" id={id}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onSelect(value)} />
      <span>{children}</span>
    </label>
  );
}

export function MapVisualCanvasSection() {
  const [scenarioId, setScenarioId] = useState<MockScenario['id']>('simple');
  /**
   * Feature flag por mapa (Fase C): o laboratório usa um objeto de preferências
   * de demonstração; o campo ausente resolve SEMPRE para V1 (padrão do produto).
   */
  const [labPreferences, setLabPreferences] = useState<{ visualMode?: MapVisualMode }>({});
  const visualMode = resolveMapVisualMode(labPreferences);
  const edgeVisual: EdgeVisual = visualMode === 'V2' ? 'v2' : 'v1';
  const [iconEngine, setIconEngine] = useState<Engine>('v2');
  const [iconSize, setIconSize] = useState<number>(32);
  const [coreSwitchCandidate, setCoreSwitchCandidate] = useState<CoreSwitchCandidate>('CORE_SWITCH');
  const [bngMode, setBngMode] = useState<BngMode>('sugerida');
  const [labelMode, setLabelMode] = useState<LabelMode>('smart');
  const [strokeMode, setStrokeMode] = useState<LinkV2StrokeMode>('zoom');
  const [v1LabelMode, setV1LabelMode] = useState<'CARD' | 'INLINE'>('CARD');
  const [forceTooltip, setForceTooltip] = useState(false);
  const [simulation, setSimulation] = useState<LinkV2Simulation | null>(null);
  const [expandedLagIds, setExpandedLagIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [positionOverrides, setPositionOverrides] = useState<Record<string, { x: number; y: number }>>({});
  /**
   * Começa em 0 e recebe o relógio real só depois de montar: o primeiro render
   * do servidor e do cliente é idêntico (sem divergência de hydration). As
   * idades mock são relativas, então o resultado visual não muda.
   */
  const [nowMs, setNowMs] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [zoom, setZoom] = useState(1);
  /** Offsets manuais da V1 — lidos pela API real; a chave do mapa é de laboratório. */
  const labelOffsets = useSyncExternalStore(
    subscribeTrafficLabelOffsets,
    () => getTrafficLabelOffsets(LAB_OFFSETS_MAP_ID),
    () => getTrafficLabelOffsets(null),
  );

  const scenario = scenarioById(scenarioId);

  useEffect(() => {
    setMounted(true);
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const glyphFor = useCallback(
    (legacyType: NetworkDeviceIconType, v2Glyph: DeviceGlyphV2Type | undefined): DeviceGlyphV2Type | null => {
      if (iconEngine === 'v1') return null;
      if (v2Glyph) return v2Glyph;
      if (legacyType === 'CORE_SWITCH') {
        return coreSwitchCandidate === 'CORE_SWITCH' ? 'CORE_SWITCH' : 'SWITCH';
      }
      return resolveDeviceGlyphV2(legacyType);
    },
    [iconEngine, coreSwitchCandidate],
  );

  const bngCompactFor = useCallback(
    (legacyType: NetworkDeviceIconType): boolean => {
      if (legacyType !== 'BNG') return false;
      if (bngMode === 'compact') return true;
      if (bngMode === 'normal') return false;
      return iconSize <= 24;
    },
    [bngMode, iconSize],
  );

  const nodes = useMemo<LabFlowNode[]>(
    () =>
      scenario.nodes.map((node) => ({
        id: node.id,
        type: 'labDevice' as const,
        position: positionOverrides[node.id] ?? { x: node.x, y: node.y },
        selected: node.id === selectedNodeId,
        data: {
          name: node.name,
          ip: node.ip,
          status: node.status,
          legacyType: node.legacyType,
          glyph: glyphFor(node.legacyType, node.v2Glyph),
          iconSize,
          bngCompact: bngCompactFor(node.legacyType),
          alarms: node.alarms,
          tag: node.tag,
        },
      })),
    [scenario, positionOverrides, selectedNodeId, glyphFor, iconSize, bngCompactFor],
  );

  const model = useMemo(
    () =>
      buildLinkV2Model(scenario, {
        nowMs,
        showAllLabels: labelMode === 'all',
        selectedEdgeId,
        selectedNodeId,
        simulation,
        expandedLagIds,
        positions: positionOverrides,
        zoom,
        strokeMode,
        labelOffsets,
      }),
    [
      scenario,
      nowMs,
      labelMode,
      selectedEdgeId,
      selectedNodeId,
      simulation,
      expandedLagIds,
      positionOverrides,
      zoom,
      strokeMode,
      labelOffsets,
    ],
  );

  const edges = useMemo<Edge[]>(
    () =>
      model.edges.map((edge) => {
        const common = {
          id: edge.id,
          source: edge.a,
          target: edge.b,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          // Igual ao mapa operacional: enlaces são clicáveis para selecionar.
          selectable: true,
          selected: edge.id === selectedEdgeId,
        };
        if (edgeVisual === 'v2') {
          const data: LinkV2EdgeData = {
            model: edge,
            placement: model.placements.get(edge.id) ?? null,
            showLabel: model.placements.has(edge.id),
            forceTooltip: forceTooltip && edge.id === (selectedEdgeId ?? scenario.demoLinkId),
          };
          return { ...common, type: 'trafficV2', data };
        }
        const data: TrafficEdgeData = {
          link: edge.networkLink,
          showTraffic: true,
          showUtilization: true,
          showLabels: true,
          showTrafficAnimation: false,
          displayStyle: 'FLOW',
          metricDisplay: 'BOTH',
          trafficLabelMode: v1LabelMode,
          related: true,
          emphasized: false,
          linkScale: 100,
          labelScale: 100,
          editMode: false,
          readOnly: true,
          isPrimaryPath: edge.pathIndex === 0,
          pathIndex: edge.pathIndex,
          visualPath:
            edge.networkLink.visualPaths[edge.pathIndex] ??
            edge.networkLink.visualPaths[0] ??
            defaultVisualPath(0),
          autoOffset: edge.autoOffset,
          labelOffsets,
          labelMapId: LAB_OFFSETS_MAP_ID,
          labelAdjust: v1LabelMode === 'INLINE',
        };
        return { ...common, type: 'traffic', data };
      }),
    [model, edgeVisual, selectedEdgeId, forceTooltip, scenario.demoLinkId, v1LabelMode, labelOffsets],
  );

  const selectedEdge: LinkV2EdgeModel | null =
    model.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedGroup =
    selectedEdge?.lagGroupId !== null && selectedEdge?.lagGroupId !== undefined
      ? model.groups.find((group) => group.groupId === selectedEdge.lagGroupId) ?? null
      : null;
  /** Seleção no formato exato do map-store (contrato do ContextDrawer). */
  const selection = selectedEdge ? selectionFromEdge(selectedEdge.selectionId) : null;

  const onNodesChange = useCallback((changes: NodeChange<LabFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const position = change.position;
        setPositionOverrides((current) => ({ ...current, [change.id]: position }));
      }
    }
  }, []);

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelectedEdgeId(params.edges.find((edge) => edge.selected)?.id ?? params.edges[0]?.id ?? null);
    setSelectedNodeId(params.nodes.find((node) => node.selected)?.id ?? params.nodes[0]?.id ?? null);
  }, []);

  /**
   * Mesmo contrato de clique do mapa operacional (network-canvas.tsx): o mapa é
   * controlado, então a seleção vem dos handlers de clique — os "select changes"
   * internos do React Flow não são aplicados quando `edges` é controlado.
   */
  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: LabFlowNode) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null);
    setSelectedNodeId(null);
  }, []);

  const applySimulation = useCallback(
    (mode: LinkV2SimulationMode | null) => {
      if (mode === null) {
        setSimulation(null);
        return;
      }
      const target = selectedEdge ? selectedEdge.linkId : scenario.demoLinkId;
      setSimulation({ linkId: target, mode });
    },
    [selectedEdge, scenario.demoLinkId],
  );

  const toggleLag = useCallback((groupId: string) => {
    setExpandedLagIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  }, []);

  /** Seleção de demonstração: sempre baseada no estado real do modelo. */
  const selectDemo = useCallback(
    (kind: 'critical' | 'down' | 'no-data' | 'stale' | 'lag') => {
      const byState = (state: LinkV2EdgeModel['visual']['state']) =>
        model.edges.find((edge) => edge.visual.state === state);
      let edge: LinkV2EdgeModel | undefined;
      if (kind === 'critical') {
        edge =
          byState('critical') ??
          [...model.edges].sort(
            (a, b) => (b.visual.utilizationPercent ?? -1) - (a.visual.utilizationPercent ?? -1),
          )[0];
      } else if (kind === 'down') {
        edge = byState('down');
      } else if (kind === 'no-data') {
        edge = byState('no-data');
      } else if (kind === 'stale') {
        edge = byState('stale');
      } else {
        edge = scenario.demoLagGroupId
          ? model.edges.find((item) => item.id === `lag:${scenario.demoLagGroupId}`)
          : undefined;
      }
      if (edge) {
        setSelectedEdgeId(edge.id);
        setSelectedNodeId(null);
      }
    },
    [model.edges, scenario.demoLagGroupId],
  );

  /** Demonstra o deslocamento manual da V1 usando a API real (chave de laboratório). */
  const setManualLabel = useCallback(() => {
    const target =
      selectedEdge ??
      model.edges.find(
        (edge) =>
          edge.id === scenario.demoLinkId ||
          edge.linkId === scenario.demoLinkId ||
          edge.selectionId === scenario.demoLinkId,
      );
    if (!target) return;
    const lane = laneForDirection(target.visual.direction);
    setTrafficLabelOffset(LAB_OFFSETS_MAP_ID, target.selectionId, lane, { dx: 52, dy: -34 });
  }, [selectedEdge, model.edges, scenario.demoLinkId]);

  const clearManualLabels = useCallback(() => {
    resetTrafficLabelOffsets(LAB_OFFSETS_MAP_ID);
  }, []);

  const manualLabelCount = useMemo(() => {
    let count = 0;
    for (const edge of model.edges) {
      if (manualLabelOffset(labelOffsets, edge.selectionId, edge.visual.direction)) count += 1;
    }
    return count;
  }, [model.edges, labelOffsets]);

  return (
    <section className="mv2-lab__section" id="canvas">
      <h2>Canvases da Fase B — enlaces inteligentes e cenário denso</h2>
      <p className="mv2-lab__hint">
        React Flow real com os dois cenários mock. No visual V2 cada enlace lógico é UMA linha:
        cor pela utilização/estado, grossura pela capacidade, seta única alinhada à tangente e
        padrão de traço pelo estado. O visual V1 usa o renderer de produção (duas pistas) para
        comparação. Zoom, pan, seleção e hover são os do React Flow.
      </p>

      <div className="mv2-controls">
        <ControlGroup title="Cenário">
          <Option name="mv2-scenario" value="simple" current={scenarioId} onSelect={setScenarioId}>
            A · simples
          </Option>
          <Option name="mv2-scenario" value="dense" current={scenarioId} onSelect={setScenarioId}>
            B · denso (27 nós)
          </Option>
          <Option name="mv2-scenario" value="real" current={scenarioId} onSelect={setScenarioId}>
            C · real (25 nós)
          </Option>
        </ControlGroup>
        <ControlGroup title="Feature flag do mapa (LAB-DEMO)">
          <Option
            name="mv2-visual-mode"
            value="V2"
            current={visualMode}
            onSelect={(value) => setLabPreferences((current) => ({ ...current, visualMode: value }))}
          >
            MAP_VISUAL_V2
          </Option>
          <Option
            name="mv2-visual-mode"
            value="V1"
            current={visualMode}
            onSelect={(value) => setLabPreferences((current) => ({ ...current, visualMode: value }))}
          >
            MAP_VISUAL_V1 (padrão)
          </Option>
          <Option
            name="mv2-visual-mode-reset"
            value="reset"
            current="reset"
            onSelect={() => setLabPreferences({})}
          >
            Campo ausente (fallback)
          </Option>
        </ControlGroup>
        <ControlGroup title="Compensação de espessura">
          <Option name="mv2-stroke-mode" value="zoom" current={strokeMode} onSelect={setStrokeMode}>
            Zoom · clamp (A)
          </Option>
          <Option
            name="mv2-stroke-mode"
            value="non-scaling"
            current={strokeMode}
            onSelect={setStrokeMode}
          >
            non-scaling (B)
          </Option>
          <Option name="mv2-stroke-mode" value="none" current={strokeMode} onSelect={setStrokeMode}>
            Escala com zoom (Fase B)
          </Option>
        </ControlGroup>
        <ControlGroup title="Ícones">
          <Option name="mv2-engine" value="v1" current={iconEngine} onSelect={setIconEngine}>
            V1
          </Option>
          <Option name="mv2-engine" value="v2" current={iconEngine} onSelect={setIconEngine}>
            V2
          </Option>
        </ControlGroup>
        <ControlGroup title="Tamanho do ícone">
          {ICON_SIZE_STEPS.map((size) => (
            <Option
              key={size}
              name="mv2-icon-size"
              value={String(size)}
              current={String(iconSize)}
              onSelect={(value) => setIconSize(Number(value))}
            >
              {size} px
            </Option>
          ))}
        </ControlGroup>
        <ControlGroup title="Rótulos (V2)">
          <Option name="mv2-label-mode" value="smart" current={labelMode} onSelect={setLabelMode}>
            Inteligentes
          </Option>
          <Option name="mv2-label-mode" value="all" current={labelMode} onSelect={setLabelMode}>
            Mostrar todos
          </Option>
        </ControlGroup>
        <div className="mv2-control">
          <p className="mv2-control__title">Rótulos no V1 e offsets manuais</p>
          <div className="mv2-control__options">
            <Option name="mv2-v1-labels" value="CARD" current={v1LabelMode} onSelect={setV1LabelMode}>
              V1 detalhado
            </Option>
            <Option name="mv2-v1-labels" value="INLINE" current={v1LabelMode} onSelect={setV1LabelMode}>
              V1 em linha (arrastável)
            </Option>
            <button
              type="button"
              id="mv2-manual-set"
              className="mv2-panel__button"
              onClick={setManualLabel}
            >
              Definir rótulo manual
            </button>
            <button
              type="button"
              id="mv2-manual-clear"
              className="mv2-panel__button"
              onClick={clearManualLabels}
            >
              Limpar offsets manuais
            </button>
          </div>
          <p className="mv2-lab__note" data-testid="mv2-manual-note">
            Chave usada: <code>gmj:traffic-labels:{LAB_OFFSETS_MAP_ID}</code> · offsets ativos:{' '}
            {manualLabelCount} · o V2 lê o mesmo contrato da V1 (unidades de fluxo) e não reescreve
            nada.
          </p>
        </div>
        <ControlGroup title="CORE_SWITCH no canvas">
          <Option
            name="mv2-core-switch"
            value="SWITCH"
            current={coreSwitchCandidate}
            onSelect={setCoreSwitchCandidate}
          >
            SWITCH (provisório)
          </Option>
          <Option
            name="mv2-core-switch"
            value="CORE_SWITCH"
            current={coreSwitchCandidate}
            onSelect={setCoreSwitchCandidate}
          >
            CORE_SWITCH (novo)
          </Option>
        </ControlGroup>
        <ControlGroup title="BNG no canvas">
          <Option name="mv2-bng" value="normal" current={bngMode} onSelect={setBngMode}>
            Normal
          </Option>
          <Option name="mv2-bng" value="compact" current={bngMode} onSelect={setBngMode}>
            Compacta
          </Option>
          <Option name="mv2-bng" value="sugerida" current={bngMode} onSelect={setBngMode}>
            Preferência (≤ 24 px)
          </Option>
        </ControlGroup>
        <div className="mv2-control">
          <p className="mv2-control__title">Selecionar enlace (demonstração)</p>
          <div className="mv2-control__options">
            <button type="button" id="mv2-demo-critical" className="mv2-panel__button" onClick={() => selectDemo('critical')}>
              Crítico
            </button>
            <button type="button" id="mv2-demo-down" className="mv2-panel__button" onClick={() => selectDemo('down')}>
              DOWN
            </button>
            <button type="button" id="mv2-demo-nodata" className="mv2-panel__button" onClick={() => selectDemo('no-data')}>
              Sem dados
            </button>
            <button type="button" id="mv2-demo-stale" className="mv2-panel__button" onClick={() => selectDemo('stale')}>
              Stale
            </button>
            <button
              type="button"
              id="mv2-demo-lag"
              className="mv2-panel__button"
              disabled={scenario.demoLagGroupId === null}
              onClick={() => selectDemo('lag')}
            >
              LAG
            </button>
          </div>
        </div>
        <div className="mv2-control">
          <p className="mv2-control__title">Simular no enlace selecionado</p>
          <div className="mv2-control__options">
            <button type="button" id="mv2-sim-down" className="mv2-panel__button" onClick={() => applySimulation('down')}>
              Simular DOWN
            </button>
            <button type="button" id="mv2-sim-nodata" className="mv2-panel__button" onClick={() => applySimulation('no-data')}>
              Sem dados
            </button>
            <button type="button" id="mv2-sim-stale" className="mv2-panel__button" onClick={() => applySimulation('stale')}>
              Stale
            </button>
            <button type="button" id="mv2-sim-clear" className="mv2-panel__button" onClick={() => applySimulation(null)}>
              Limpar
            </button>
          </div>
        </div>
        <div className="mv2-control">
          <p className="mv2-control__title">Tooltip e LAG</p>
          <div className="mv2-control__options">
            <label className="mv2-option">
              <input
                type="checkbox"
                id="mv2-tooltip-toggle"
                checked={forceTooltip}
                onChange={(event) => setForceTooltip(event.target.checked)}
              />
              <span>Exibir tooltip do enlace de demonstração</span>
            </label>
            <button
              type="button"
              id="mv2-lag-toggle-toolbar"
              className="mv2-panel__button"
              disabled={scenario.demoLagGroupId === null}
              onClick={() => {
                const groupId = scenario.demoLagGroupId;
                if (groupId) toggleLag(groupId);
              }}
            >
              {scenario.demoLagGroupId && expandedLagIds.includes(scenario.demoLagGroupId)
                ? 'Recolher LAG demonstrativo'
                : 'Expandir LAG demonstrativo'}
            </button>
          </div>
        </div>
      </div>

      <div className="mv2-lab__canvas mv2-lab__canvas--v2">
        <ReactFlowProvider>
          <ReactFlow<LabFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={LAB_NODE_TYPES}
            edgeTypes={LAB_EDGE_TYPES}
            onNodesChange={onNodesChange}
            onSelectionChange={onSelectionChange}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onInit={(instance) => {
              window.setTimeout(() => setZoom(instance.getZoom()), 80);
            }}
            onMoveEnd={(_event, viewport) => setZoom(viewport.zoom)}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
            minZoom={0.25}
            maxZoom={2.4}
            defaultEdgeOptions={{ style: { stroke: '#3a5a6b', strokeWidth: 1.6 } }}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#1b2832" />
            <ZoomPresets />
            <ZoomTracker onZoom={setZoom} />
          </ReactFlow>
          {selectedEdge && (
            <LinkV2Panel
              edge={selectedEdge}
              group={selectedGroup}
              expanded={
                selectedEdge.lagGroupId !== null && expandedLagIds.includes(selectedEdge.lagGroupId)
              }
              onToggleLag={toggleLag}
              onClose={() => setSelectedEdgeId(null)}
            />
          )}
        </ReactFlowProvider>
      </div>

      <div className="mv2-legend">
        <span className="mv2-legend__item" data-state="normal">
          <i /> Normal &lt; 50%
        </span>
        <span className="mv2-legend__item" data-state="attention">
          <i /> Atenção 50–80%
        </span>
        <span className="mv2-legend__item" data-state="critical">
          <i /> Crítico ≥ 80%
        </span>
        <span className="mv2-legend__item" data-state="no-data">
          <i className="is-dashed" /> Sem dados (cinza tracejado)
        </span>
        <span className="mv2-legend__item" data-state="down">
          <i className="is-dashed" /> DOWN (vermelho tracejado)
        </span>
        <span className="mv2-legend__item" data-state="stale">
          <i className="is-dashed" /> Telemetria stale
        </span>
        <span className="mv2-legend__text">
          Espessura por capacidade: 1 Gbps = 1.2 · 10 Gbps = 2.0 · 40 Gbps = 3.0 · &gt; 40 Gbps
          = 4.5 · desconhecida = 1.6
        </span>
      </div>

      <p className="mv2-lab__note" data-testid="mv2-build-stats">
        Modelo: {mounted ? model.buildMs.toFixed(2) : '—'} ms · rótulos: {mounted ? model.labelsMs.toFixed(2) : '—'} ms ·{' '}
        {scenario.nodes.length} nós · {model.edges.length} linhas · rótulos inteligentes:{' '}
        {model.placements.size} posicionados de {model.edges.length} · offsets manuais ativos:{' '}
        {model.manualLabelCount} · modo de espessura: {strokeMode} · flag do mapa:{' '}
        {labPreferences.visualMode ?? 'ausente → V1'} (resolvida: {visualMode}). Seleção:{' '}
        {selection ? `{ kind: 'link', id: '${selection.id}' }` : '—'}. Cenário:{' '}
        {scenario.description}
      </p>
    </section>
  );
}
