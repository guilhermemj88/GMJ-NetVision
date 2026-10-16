'use client';

/**
 * MAP-VISUAL-V2 — canvas da Fase B (React Flow real).
 *
 * Cenários A/B, visual de enlaces V1/V2, ícones V1/V2, rótulos inteligentes,
 * simulações, LAG demonstrativo, zoom presets e painel lateral mock. Tudo com
 * dados de demonstração — sem API, sem banco, sem tocar no mapa operacional.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import type { NetworkDeviceIconType } from '@/lib/device-appearance';
import {
  buildLinkV2Model,
  type LinkV2EdgeModel,
  type LinkV2Simulation,
  type LinkV2SimulationMode,
} from './v2-model';
import { LinkV2Edge, type LinkV2EdgeData } from './v2-link-edge';
import { LinkV2Panel } from './v2-link-panel';
import { scenarioById, type MockNodeStatus, type MockScenario } from './v2-scenarios';

type Engine = 'v1' | 'v2';
type EdgeVisual = 'v1' | 'v2';
type LabelMode = 'smart' | 'all';
type BngMode = 'normal' | 'compact' | 'sugerida';
type CoreSwitchCandidate = 'SWITCH' | 'CORE_SWITCH';

const ICON_SIZE_STEPS = [16, 24, 32, 48] as const;
const ZOOM_PRESETS = [25, 50, 100, 150, 220] as const;
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
  const [edgeVisual, setEdgeVisual] = useState<EdgeVisual>('v2');
  const [iconEngine, setIconEngine] = useState<Engine>('v2');
  const [iconSize, setIconSize] = useState<number>(32);
  const [coreSwitchCandidate, setCoreSwitchCandidate] = useState<CoreSwitchCandidate>('CORE_SWITCH');
  const [bngMode, setBngMode] = useState<BngMode>('sugerida');
  const [labelMode, setLabelMode] = useState<LabelMode>('smart');
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
      }),
    [scenario, nowMs, labelMode, selectedEdgeId, selectedNodeId, simulation, expandedLagIds, positionOverrides, zoom],
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
          trafficLabelMode: 'CARD',
          related: true,
          emphasized: false,
          linkScale: 100,
          labelScale: 100,
          editMode: false,
          readOnly: true,
          isPrimaryPath: true,
          autoOffset: edge.autoOffset,
        };
        return { ...common, type: 'traffic', data };
      }),
    [model, edgeVisual, selectedEdgeId, forceTooltip, scenario.demoLinkId],
  );

  const selectedEdge: LinkV2EdgeModel | null =
    model.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedGroup =
    selectedEdge?.lagGroupId !== null && selectedEdge?.lagGroupId !== undefined
      ? model.groups.find((group) => group.groupId === selectedEdge.lagGroupId) ?? null
      : null;

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

  const applySimulation = useCallback(
    (mode: LinkV2SimulationMode | null) => {
      if (mode === null) {
        setSimulation(null);
        return;
      }
      setSimulation({ linkId: selectedEdgeId ?? scenario.demoLinkId, mode });
    },
    [selectedEdgeId, scenario.demoLinkId],
  );

  const toggleLag = useCallback((groupId: string) => {
    setExpandedLagIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  }, []);

  const selectDemo = useCallback(
    (kind: 'critical' | 'down' | 'no-data' | 'stale' | 'lag') => {
      const byTag = (tag: string) => scenario.links.find((link) => link.tag === tag)?.id ?? null;
      const ids: Record<typeof kind, string | null> = {
        critical: scenario.id === 'dense' ? 'd-transit-a' : 'a-core-bng',
        down: byTag('DOWN') ?? scenario.links.find((link) => link.status === 'down')?.id ?? null,
        'no-data': byTag('sem telemetria') ?? byTag('capacidade desconhecida'),
        stale: byTag('stale'),
        lag: scenario.demoLagGroupId ? `lag:${scenario.demoLagGroupId}` : null,
      };
      const id = ids[kind];
      if (id) {
        setSelectedEdgeId(id);
        setSelectedNodeId(null);
      }
    },
    [scenario],
  );

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
        </ControlGroup>
        <ControlGroup title="Enlaces (renderer)">
          <Option name="mv2-edge-visual" value="v1" current={edgeVisual} onSelect={setEdgeVisual}>
            V1 (duas pistas)
          </Option>
          <Option name="mv2-edge-visual" value="v2" current={edgeVisual} onSelect={setEdgeVisual}>
            V2 (linha única)
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
        Modelo reconstruído em {mounted ? model.buildMs.toFixed(2) : '—'} ms ·{' '}
        {scenario.nodes.length} nós · {model.edges.length} linhas · rótulos inteligentes:{' '}
        {model.placements.size} posicionados de {model.edges.length}. Cenário:{' '}
        {scenario.description}
      </p>
    </section>
  );
}
