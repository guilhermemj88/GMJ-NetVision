'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { NetworkDeviceIcon } from '@/components/network-device-icon';
import {
  NetworkDeviceGlyphV2,
  resolveDeviceGlyphV2,
  type DeviceGlyphV2Type,
} from '@/components/network-device-glyphs-v2';
import {
  DEVICE_ICON_OPTIONS,
  DEVICE_ICON_TYPES,
  type NetworkDeviceIconType,
} from '@/lib/device-appearance';

/**
 * MAP-VISUAL-V2 — laboratório de glifos (rota /map-visual-preview).
 *
 * Compara V1 × V2, o desenho CORE_SWITCH candidato e as variantes do BNG em
 * 16/24/32/48 px. Tudo aqui é mock e apenas visual: o laboratório não escreve
 * no mapa, não altera o mapeamento global do módulo de glifos e não chama a
 * API. O V1 permanece o padrão do produto.
 */

const ICON_SIZE_STEPS = [16, 24, 32, 48] as const;

type Engine = 'v1' | 'v2';
type CoreSwitchCandidate = 'SWITCH' | 'CORE_SWITCH';
type BngMode = 'normal' | 'compact' | 'sugerida';
type LabStatus = 'up' | 'warning' | 'down' | 'unknown';

const LABEL_BY_TYPE = new Map<string, string>(
  DEVICE_ICON_OPTIONS.map((option) => [option.value, option.label]),
);

const LEGACY_TYPES = DEVICE_ICON_TYPES.filter(
  (iconType): iconType is NetworkDeviceIconType => iconType !== 'AUTO',
);

const V2_ROWS = LEGACY_TYPES.filter((iconType) => resolveDeviceGlyphV2(iconType) !== null);
const FALLBACK_ROWS = LEGACY_TYPES.filter((iconType) => resolveDeviceGlyphV2(iconType) === null);

const TYPE_NOTES: Partial<Record<NetworkDeviceIconType, string>> = {
  CORE_SWITCH:
    'Mapeamento provisório: usa o desenho SWITCH. O desenho novo é comparado na seção "CORE_SWITCH — candidato".',
  EDGE_ROUTER: 'Usa o desenho ROUTER do V2.',
};

function deviceColorClass(iconType: string): string {
  return `device-node--type-${iconType.toLowerCase().replaceAll('_', '-')}`;
}

function RadioOption<T extends string>({
  name,
  value,
  current,
  onSelect,
  children,
}: {
  name: string;
  value: T;
  current: T;
  onSelect: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <label className="mv2-option">
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        onChange={() => onSelect(value)}
      />
      <span>{children}</span>
    </label>
  );
}

function V1Sample({ iconType, size }: { iconType: NetworkDeviceIconType; size: number }) {
  return (
    <span className={`mv2-sample ${deviceColorClass(iconType)}`}>
      <NetworkDeviceIcon type={iconType} variant="2d" size={size} />
    </span>
  );
}

function V2Sample({
  glyph,
  size,
  label,
  compact = false,
  colorClass,
}: {
  glyph: DeviceGlyphV2Type;
  size: number;
  label?: string;
  compact?: boolean;
  colorClass?: string;
}) {
  return (
    <span className={`mv2-sample ${colorClass ?? ''}`}>
      <NetworkDeviceGlyphV2 type={glyph} size={size} compact={compact} />
      {label ? <span className="mv2-sample__label">{label}</span> : null}
    </span>
  );
}

/** Preferência inicial do operador: compacta nos pequenos, normal em 32/48. */
function bngCompactFor(mode: BngMode, size: number): boolean {
  if (mode === 'compact') return true;
  if (mode === 'normal') return false;
  return size <= 24;
}

interface MockDevice {
  id: string;
  name: string;
  ip: string;
  status: LabStatus;
  legacyType: NetworkDeviceIconType;
  x: number;
  y: number;
  alarms?: number;
}

const MOCK_DEVICES: MockDevice[] = [
  { id: 'internet', name: 'INTERNET · AS28126', ip: '200.219.0.0/16', status: 'up', legacyType: 'CLOUD', x: 60, y: 130 },
  { id: 'edge', name: 'NE-8000-BORDA-01', ip: '10.255.0.1', status: 'up', legacyType: 'CORE_ROUTER', x: 330, y: 40 },
  { id: 'ix', name: 'IX-SP-01', ip: '187.16.0.1', status: 'unknown', legacyType: 'IX', x: 330, y: 230 },
  { id: 'core', name: 'SW-CORE-01', ip: '10.255.1.1', status: 'up', legacyType: 'CORE_SWITCH', x: 640, y: 130 },
  { id: 'bng', name: 'BNG-BRAS-01', ip: '10.255.2.1', status: 'up', legacyType: 'BNG', x: 950, y: 40 },
  { id: 'agg', name: 'AGG-SUL-03', ip: '10.255.3.3', status: 'warning', legacyType: 'AGGREGATION', x: 950, y: 230, alarms: 2 },
  { id: 'olt', name: 'OLT-CENTRO-VILA-NOVA-01', ip: '10.255.9.11', status: 'warning', legacyType: 'OLT', x: 1260, y: 130, alarms: 1 },
  { id: 'dist', name: 'SW-DIST-02', ip: '10.255.4.2', status: 'down', legacyType: 'SWITCH', x: 640, y: 330 },
  { id: 'clientes', name: 'CLIENTES-SUL', ip: '100.64.0.0/12', status: 'up', legacyType: 'CUSTOMERS', x: 950, y: 400 },
];

const MOCK_EDGES: Edge[] = [
  { id: 'e-internet-edge', source: 'internet', target: 'edge' },
  { id: 'e-edge-core', source: 'edge', target: 'core' },
  { id: 'e-edge-ix', source: 'edge', target: 'ix' },
  { id: 'e-core-bng', source: 'core', target: 'bng' },
  { id: 'e-core-agg', source: 'core', target: 'agg' },
  { id: 'e-agg-olt', source: 'agg', target: 'olt' },
  { id: 'e-core-dist', source: 'core', target: 'dist' },
  { id: 'e-bng-clientes', source: 'bng', target: 'clientes' },
  { id: 'e-dist-clientes', source: 'dist', target: 'clientes' },
];

interface LabNodeData extends Record<string, unknown> {
  name: string;
  ip: string;
  status: LabStatus;
  legacyType: NetworkDeviceIconType;
  /** Nulo = V1 (engine V1 ou tipo sem desenho V2 — fallback). */
  glyph: DeviceGlyphV2Type | null;
  iconSize: number;
  bngCompact: boolean;
  alarms: number | undefined;
}

type LabFlowNode = Node<LabNodeData, 'labDevice'>;

const HANDLE_SIDES = ['left', 'right', 'top', 'bottom'] as const;
const POSITION_BY_SIDE = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
} as const;

function LabDeviceNode({ data, selected }: NodeProps<LabFlowNode>) {
  return (
    <div
      className={`device-node device-node--icon_2d ${deviceColorClass(data.legacyType)} status-${data.status} ${selected ? 'is-selected' : ''} ${data.glyph ? 'mv2-node--flat' : ''}`}
      title={`${data.name} · ${data.ip} · ${data.status}`}
    >
      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={POSITION_BY_SIDE[side]}
          isConnectable={false}
        />
      ))}
      <div className="device-node__icon">
        {data.glyph ? (
          <NetworkDeviceGlyphV2
            type={data.glyph}
            size={data.iconSize}
            compact={data.bngCompact}
          />
        ) : (
          <NetworkDeviceIcon type={data.legacyType} variant="2d" size={data.iconSize} />
        )}
        <span className="status-pulse" />
      </div>
      <div className="device-node__copy">
        <strong>{data.name}</strong>
        <span>{data.ip}</span>
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

export function MapVisualLab() {
  const [engine, setEngine] = useState<Engine>('v2');
  const [coreSwitchCandidate, setCoreSwitchCandidate] = useState<CoreSwitchCandidate>('SWITCH');
  const [bngMode, setBngMode] = useState<BngMode>('sugerida');
  const [canvasIconSize, setCanvasIconSize] = useState<number>(32);

  const nodes = useMemo<LabFlowNode[]>(
    () =>
      MOCK_DEVICES.map((device) => {
        const glyph =
          engine === 'v2'
            ? device.legacyType === 'CORE_SWITCH' && coreSwitchCandidate === 'CORE_SWITCH'
              ? 'CORE_SWITCH'
              : resolveDeviceGlyphV2(device.legacyType)
            : null;
        return {
          id: device.id,
          type: 'labDevice' as const,
          position: { x: device.x, y: device.y },
          data: {
            name: device.name,
            ip: device.ip,
            status: device.status,
            legacyType: device.legacyType,
            glyph,
            iconSize: canvasIconSize,
            bngCompact: device.legacyType === 'BNG' && bngCompactFor(bngMode, canvasIconSize),
            alarms: device.alarms,
          },
        };
      }),
    [engine, coreSwitchCandidate, bngMode, canvasIconSize],
  );

  return (
    <div className="mv2-lab">
      <header className="mv2-lab__header">
        <div>
          <h1 className="mv2-lab__title">MAP-VISUAL-V2 · Laboratório de glifos</h1>
          <p className="mv2-lab__subtitle">
            Comparação V1 × V2 no React Flow real, com o desenho <strong>CORE_SWITCH</strong>{' '}
            candidato e as variantes <strong>BNG normal/compacta</strong> em 16, 24, 32 e 48 px.
            Todos os nós e estados são demonstrativos; nenhum dado real é exibido, gravado ou
            enviado.
          </p>
        </div>
        <div className="mv2-lab__chips">
          <span className="mv2-chip mv2-chip--ok">V1 intacta</span>
          <span className="mv2-chip mv2-chip--ok">nada publicado</span>
          <span className="mv2-chip mv2-chip--warn">mapeamento CORE_SWITCH provisório</span>
        </div>
      </header>

      <section className="mv2-lab__section" id="controles">
        <h2>Controles do canvas</h2>
        <p className="mv2-lab__hint">
          Os controles abaixo afetam apenas a topologia de demonstração desta página. Nenhuma
          escolha é persistida nem altera o mapeamento global{' '}
          <code>resolveDeviceGlyphV2</code>.
        </p>
        <div className="mv2-controls">
          <div className="mv2-control">
            <p className="mv2-control__title">Motor de ícones no canvas</p>
            <div className="mv2-control__options">
              <RadioOption name="mv2-engine" value="v1" current={engine} onSelect={setEngine}>
                V1 (atual)
              </RadioOption>
              <RadioOption name="mv2-engine" value="v2" current={engine} onSelect={setEngine}>
                V2 (novo)
              </RadioOption>
            </div>
          </div>
          <div className="mv2-control">
            <p className="mv2-control__title">Tamanho do ícone no canvas</p>
            <div className="mv2-control__options">
              {ICON_SIZE_STEPS.map((size) => (
                <RadioOption
                  key={size}
                  name="mv2-icon-size"
                  value={String(size)}
                  current={String(canvasIconSize)}
                  onSelect={(value) => setCanvasIconSize(Number(value))}
                >
                  {size} px
                </RadioOption>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mv2-lab__section" id="catalogo">
        <h2>Catálogo V1 × V2 · 16/24/32/48 px</h2>
        <p className="mv2-lab__hint">
          Contrato visual do V2: viewBox 0 0 64 64, traço <code>currentColor</code>, sem cor
          embutida e traço mais grosso nos tamanhos pequenos (3 px até 20, 2.6 px até 28, 2.2 px
          acima). No V1 o traço é fixo — a comparação mostra a diferença de peso em cada tamanho.
        </p>
        <div className="mv2-catalog">
          <div className="mv2-catalog__row mv2-catalog__row--head">
            <span className="mv2-catalog__head-cell mv2-catalog__head-cell--type">
              Tipo (legado)
            </span>
            <span className="mv2-catalog__head-cell">V1 · 32 px</span>
            <span className="mv2-catalog__head-cell">V2 · 16 px</span>
            <span className="mv2-catalog__head-cell">V2 · 24 px</span>
            <span className="mv2-catalog__head-cell">V2 · 32 px</span>
            <span className="mv2-catalog__head-cell">V2 · 48 px</span>
          </div>

          <div className="mv2-catalog__group">Tipos legados com glifo V2 (11)</div>
          {V2_ROWS.map((legacyType) => {
            const glyph = resolveDeviceGlyphV2(legacyType) as DeviceGlyphV2Type;
            return (
              <div className="mv2-catalog__row" key={legacyType}>
                <div className="mv2-catalog__type">
                  <strong>{LABEL_BY_TYPE.get(legacyType) ?? legacyType}</strong>
                  <code>{legacyType}</code>
                  {TYPE_NOTES[legacyType] ? <em>{TYPE_NOTES[legacyType]}</em> : null}
                </div>
                <div className="mv2-catalog__cell">
                  <V1Sample iconType={legacyType} size={32} />
                </div>
                {ICON_SIZE_STEPS.map((size) =>
                  legacyType === 'CORE_SWITCH' ? (
                    <div className="mv2-catalog__cell" key={size}>
                      <span className="mv2-sample__pair">
                        <V2Sample
                          glyph={glyph}
                          size={size}
                          label="prov."
                          colorClass={deviceColorClass(legacyType)}
                        />
                        <V2Sample
                          glyph="CORE_SWITCH"
                          size={size}
                          label="novo"
                          colorClass={deviceColorClass(legacyType)}
                        />
                      </span>
                    </div>
                  ) : (
                    <div className="mv2-catalog__cell" key={size}>
                      <V2Sample glyph={glyph} size={size} colorClass={deviceColorClass(legacyType)} />
                    </div>
                  ),
                )}
              </div>
            );
          })}

          <div className="mv2-catalog__group">
            Sem glifo V2 — fallback para o V1 (12)
          </div>
          {FALLBACK_ROWS.map((legacyType) => (
            <div className="mv2-catalog__row" key={legacyType}>
              <div className="mv2-catalog__type">
                <strong>{LABEL_BY_TYPE.get(legacyType) ?? legacyType}</strong>
                <code>{legacyType}</code>
                <em>Sem desenho V2: o resolvedor devolve null e o mapa continua no glifo V1.</em>
              </div>
              <div className="mv2-catalog__cell">
                <V1Sample iconType={legacyType} size={32} />
              </div>
              {ICON_SIZE_STEPS.map((size) => (
                <div className="mv2-catalog__cell" key={size}>
                  <span className="mv2-catalog__miss">—</span>
                </div>
              ))}
            </div>
          ))}

          <div className="mv2-catalog__group">PNI — glifo novo, sem tipo legado ainda</div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>PNI</strong>
              <code>PNI (somente V2)</code>
              <em>
                Não é opção do picker nesta fase; o resolvedor AUTO nunca infere PNI. Selecionável
                apenas quando a taxonomia for aprovada.
              </em>
            </div>
            <div className="mv2-catalog__cell">
              <span className="mv2-catalog__miss">—</span>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample glyph="PNI" size={size} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mv2-lab__section" id="core-switch">
        <h2>CORE_SWITCH — candidato × desenho em uso</h2>
        <p className="mv2-lab__hint">
          O glifo novo representa um switch de núcleo com <strong>dois chassis</strong> (camada
          traseira + frontal) e seta dupla. O mapeamento global continua{' '}
          <code>CORE_SWITCH → SWITCH</code> (provisório): compare os dois desenhos e use o
          seletor para avaliar o candidato no React Flow abaixo.
        </p>
        <div className="mv2-compare">
          <div className="mv2-card">
            <div className="mv2-card__head">
              <span className="mv2-card__title">SWITCH — em uso (provisório)</span>
              <span className="mv2-card__badge">desenho atual</span>
            </div>
            <div className="mv2-card__hero">
              <V2Sample glyph="SWITCH" size={112} colorClass={deviceColorClass('CORE_SWITCH')} />
              <span className="mv2-card__hero-caption">
                Um chassi, quatro portas e seta dupla. É o desenho que o equipamento CORE_SWITCH
                recebe hoje por meio do mapeamento provisório.
              </span>
            </div>
            <div className="mv2-strip">
              {ICON_SIZE_STEPS.map((size) => (
                <V2Sample
                  key={size}
                  glyph="SWITCH"
                  size={size}
                  label={`${size} px`}
                  colorClass={deviceColorClass('CORE_SWITCH')}
                />
              ))}
            </div>
          </div>
          <div className="mv2-card mv2-card--candidate">
            <div className="mv2-card__head">
              <span className="mv2-card__title">CORE_SWITCH — novo</span>
              <span className="mv2-card__badge">candidato · avaliação</span>
            </div>
            <div className="mv2-card__hero">
              <V2Sample glyph="CORE_SWITCH" size={112} colorClass={deviceColorClass('CORE_SWITCH')} />
              <span className="mv2-card__hero-caption">
                Segunda camada atrás do chassi frontal: sugere núcleo sem depender de cor,
                distinguindo de SWITCH também em zoom baixo.
              </span>
            </div>
            <div className="mv2-strip">
              {ICON_SIZE_STEPS.map((size) => (
                <V2Sample
                  key={size}
                  glyph="CORE_SWITCH"
                  size={size}
                  label={`${size} px`}
                  colorClass={deviceColorClass('CORE_SWITCH')}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="mv2-controls">
          <div className="mv2-control">
            <p className="mv2-control__title">Desenho aplicado ao CORE_SWITCH no canvas</p>
            <div className="mv2-control__options">
              <RadioOption
                name="mv2-core-switch"
                value="SWITCH"
                current={coreSwitchCandidate}
                onSelect={setCoreSwitchCandidate}
              >
                SWITCH (provisório atual)
              </RadioOption>
              <RadioOption
                name="mv2-core-switch"
                value="CORE_SWITCH"
                current={coreSwitchCandidate}
                onSelect={setCoreSwitchCandidate}
              >
                CORE_SWITCH (novo)
              </RadioOption>
            </div>
          </div>
        </div>
        <p className="mv2-lab__note">
          Trocar o seletor muda apenas o nó SW-CORE-01 desta página. A linha{' '}
          <code>CORE_SWITCH: &quot;SWITCH&quot;</code> do módulo oficial foi preservada — a
          ativação global só depois da aprovação visual.
        </p>
      </section>

      <section className="mv2-lab__section" id="bng">
        <h2>BNG — normal × compacta em 16/24/32/48 px</h2>
        <p className="mv2-lab__hint">
          A variante <strong>compacta</strong> é um opt-in do componente (<code>compact</code>);
          ela nunca é escolhida automaticamente. A terceira linha mostra a preferência inicial do
          operador: compacta nos pequenos, normal em 32/48 px.
        </p>
        <div className="mv2-matrix">
          <div className="mv2-catalog__row mv2-catalog__row--head">
            <span className="mv2-catalog__head-cell mv2-catalog__head-cell--type">Variante</span>
            {ICON_SIZE_STEPS.map((size) => (
              <span className="mv2-catalog__head-cell" key={size}>
                {size} px
              </span>
            ))}
            <span className="mv2-catalog__head-cell">112 px (detalhe)</span>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Normal</strong>
              <code>compact=false</code>
              <em>Chassi + tronco ramificando para três assinantes.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label="normal"
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact={false} colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Compacta</strong>
              <code>compact=true</code>
              <em>Tronco curto e um único assinante: menos traços nos tamanhos pequenos.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label="compacta"
                  compact
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Preferência (compacta ≤ 24 px)</strong>
              <code>sugerida · não automática</code>
              <em>O que o seletor do canvas aplica quando escolhido.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label={bngCompactFor('sugerida', size) ? 'compacta' : 'normal'}
                  compact={bngCompactFor('sugerida', size)}
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact={false} colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
        </div>
        <div className="mv2-controls">
          <div className="mv2-control">
            <p className="mv2-control__title">Variante aplicada ao BNG no canvas</p>
            <div className="mv2-control__options">
              <RadioOption name="mv2-bng" value="normal" current={bngMode} onSelect={setBngMode}>
                Normal
              </RadioOption>
              <RadioOption name="mv2-bng" value="compact" current={bngMode} onSelect={setBngMode}>
                Compacta
              </RadioOption>
              <RadioOption name="mv2-bng" value="sugerida" current={bngMode} onSelect={setBngMode}>
                Preferência (≤ 24 px compacta)
              </RadioOption>
            </div>
          </div>
        </div>
      </section>

      <section className="mv2-lab__section" id="canvas">
        <h2>React Flow real — topologia de demonstração</h2>
        <p className="mv2-lab__hint">
          Nove nós mock (incluindo nomes longos, estados UP/WARNING/DOWN/UNKNOWN e alarms). No V2
          o glifo fica plano, sem orbe/anel; no V1 o nó mantém exatamente o visual de produção.
          Arraste os nós e use o zoom para avaliar a silhueta em cada tamanho.
        </p>
        <div className="mv2-lab__canvas">
          <ReactFlowProvider>
            <ReactFlow<LabFlowNode, Edge>
              nodes={nodes}
              edges={MOCK_EDGES}
              nodeTypes={LAB_NODE_TYPES}
              nodesConnectable={false}
              nodesDraggable
              elementsSelectable
              fitView
              fitViewOptions={{ padding: 0.18, maxZoom: 1.2 }}
              minZoom={0.35}
              maxZoom={2.4}
              defaultEdgeOptions={{ style: { stroke: '#3a5a6b', strokeWidth: 1.6 } }}
              proOptions={{ hideAttribution: true }}
              colorMode="dark"
            >
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#1b2832" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        <p className="mv2-lab__note">
          Canvas isolado: nenhuma conexão com o mapa real, nenhuma chamada de API e nenhuma
          escrita no banco. Seleção, hover e status pulse continuam funcionando.
        </p>
      </section>

      <section className="mv2-lab__section" id="notas">
        <h2>Notas e limites desta fase</h2>
        <ul className="mv2-notes">
          <li>
            Mapeamento global segue provisório: <code>resolveDeviceGlyphV2(&apos;CORE_SWITCH&apos;)</code>{' '}
            continua devolvendo <code>SWITCH</code>. Nada foi alterado no módulo oficial por este
            laboratório.
          </li>
          <li>
            Doze tipos legados ainda não têm desenho V2 e caem no glifo V1 (fallback) — nenhum
            equipamento muda de aparência sem decisão explícita.
          </li>
          <li>
            PNI existe como glifo V2, mas não entra no picker nem no resolvedor AUTO nesta fase.
          </li>
          <li>
            Classificação AUTO, tipos persistidos, posições e equipamentos existentes não foram
            tocados.
          </li>
          <li>
            A variante compacta do BNG é opt-in; a preferência “compacta ≤ 24 px / normal ≥ 32 px”
            é apenas uma opção de avaliação deste laboratório.
          </li>
          <li>
            Vetores SVG não perdem definição em telas 2x; o que define a legibilidade é o tamanho
            final em px — por isso a matriz fixa 16/24/32/48.
          </li>
          <li>
            Todos os nós, enlaces, estados e alarmes são mock e permanecem no navegador; nenhum
            tráfego sintético vai para a API ou para os equipamentos.
          </li>
        </ul>
      </section>

      <footer className="mv2-lab__footer">
        MAP-VISUAL-V2 · laboratório interno · rota disponível apenas em desenvolvimento local ou
        build de preview (<code>NEXT_PUBLIC_PREVIEW_MODE=true</code>). Em produção a página
        responde 404. Nenhum deploy, merge ou restart faz parte deste laboratório.
      </footer>
    </div>
  );
}
