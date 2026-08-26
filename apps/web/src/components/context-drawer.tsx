'use client';

import { useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Cable,
  ChevronRight,
  CircleGauge,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  List,
  Network,
  Route,
  Pencil,
  Radar,
  ServerCog,
  Trash2,
  X,
} from 'lucide-react';
import {
  aggregateLinkMetrics,
  automaticLinkCapacity,
  autoCurvatures,
  defaultVisualPaths,
  formatBitsPerSecond,
  formatDuration,
  type CapacitySource,
  type DirectionalLinkMetric,
  type LinkAggregationMode,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type LinkMetricSource,
  type LinkTrafficMode,
  type LinkVisualPath,
  type MapNode,
  type NetworkInterface,
  type NetworkLink,
} from '@gmj/shared';
import { useMutation } from '@tanstack/react-query';
import { deleteLink as deleteLinkRequest, updateLink as updateLinkRequest } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { MetricCharts } from './metric-charts';
import { OpticalHistoryCharts } from './optical-history-charts';
import { AssistedDiscoveryReview } from './assisted-discovery-review';
import { InterfaceMultiPicker, InterfacePicker } from './interface-picker';
import { VerifyHostButton } from './verify-host-button';
import { MplsPanel } from './mpls-panel';

function trafficValidation(metric: DirectionalLinkMetric): string {
  const tx = metric.txBps == null ? 'TX indisponível' : `TX ${formatBitsPerSecond(metric.txBps)}`;
  const rx =
    metric.observedRxBps == null
      ? 'RX observado indisponível'
      : `RX observado ${formatBitsPerSecond(metric.observedRxBps)}`;
  if (metric.consistency === 'UNKNOWN' || metric.deltaPercent == null) {
    return `${tx} / ${rx} · sem validação entre pontas`;
  }
  const state = metric.consistency === 'CONSISTENT' ? 'consistente' : 'divergente';
  return `${tx} / ${rx} · ${state} (${metric.deltaPercent.toFixed(1)}%)`;
}

export function ContextDrawer() {
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const setSelection = useMapStore((state) => state.setSelection);
  const readOnly = useMapStore((state) => state.readOnly);
  if (!map || !selection) return null;

  if (selection.kind === 'link') {
    const link = map.links.find((item) => item.id === selection.id);
    return link ? (
      <LinkDrawer link={link} readOnly={readOnly} onClose={() => setSelection(null)} />
    ) : null;
  }
  if (selection.kind === 'interface') {
    const device = map.devices.find((item) => item.id === selection.deviceId);
    const networkInterface = device?.interfaces.find((item) => item.id === selection.id);
    return device && networkInterface ? (
      <InterfaceDrawer
        networkInterface={networkInterface}
        deviceId={device.id}
        deviceName={device.name}
        snmpEnabled={device.snmpEnabled}
        readOnly={readOnly}
        onBack={() => setSelection({ kind: 'device', id: device.id })}
        onClose={() => setSelection(null)}
      />
    ) : null;
  }
  if (selection.kind === 'node') {
    const node = map.nodes.find((item) => item.id === selection.id);
    return node ? <GenericNodeDrawer node={node} onClose={() => setSelection(null)} /> : null;
  }
  const device = map.devices.find((item) => item.id === selection.id);
  return device ? (
    <DeviceDrawer deviceId={device.id} readOnly={readOnly} onClose={() => setSelection(null)} />
  ) : null;
}

function DrawerShell({
  children,
  eyebrow,
  title,
  status,
  verifyHost,
  onClose,
  onBack,
}: {
  children: React.ReactNode;
  eyebrow: string;
  title: string;
  status?: string;
  verifyHost?: { hostId: string; enabled: boolean };
  onClose: () => void;
  onBack?: () => void;
}) {
  return (
    <aside className="context-drawer">
      <header className="drawer-header">
        {onBack && (
          <button type="button" aria-label="Voltar" onClick={onBack}>
            <ArrowLeft size={17} />
          </button>
        )}
        <div className="drawer-header__identity">
          <span>{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        {verifyHost && (
          <VerifyHostButton hostId={verifyHost.hostId} enabled={verifyHost.enabled} compact />
        )}
        {status && <Badge tone={status}>{status}</Badge>}
        <button type="button" aria-label="Fechar" className="drawer-close" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="drawer-scroll">{children}</div>
    </aside>
  );
}

function DeviceDrawer({
  deviceId,
  readOnly,
  onClose,
}: {
  deviceId: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<
    'overview' | 'interfaces' | 'mpls' | 'monitoring' | 'access' | 'discovery'
  >('overview');
  const map = useMapStore((state) => state.map);
  const setSelection = useMapStore((state) => state.setSelection);
  const device = map?.devices.find((item) => item.id === deviceId);
  if (!device) return null;
  const count = (status: NetworkInterface['operStatus']) =>
    device.interfaces.filter((item) => item.operStatus === status).length;
  const totalRx = device.interfaces.reduce((sum, item) => sum + item.rxBps, 0);
  const totalTx = device.interfaces.reduce((sum, item) => sum + item.txBps, 0);
  const activeTab = readOnly && (tab === 'access' || tab === 'discovery') ? 'overview' : tab;

  return (
    <DrawerShell
      eyebrow="EQUIPAMENTO"
      title={device.name}
      status={device.status}
      {...(!readOnly ? { verifyHost: { hostId: device.id, enabled: device.snmpEnabled } } : {})}
      onClose={onClose}
    >
      <div className="drawer-tabs">
        <button
          type="button"
          className={activeTab === 'overview' ? 'is-active' : ''}
          onClick={() => setTab('overview')}
        >
          <Activity size={14} /> Visão geral
        </button>
        <button
          type="button"
          className={activeTab === 'interfaces' ? 'is-active' : ''}
          onClick={() => setTab('interfaces')}
        >
          <List size={14} /> Interfaces <em>{device.interfaces.length}</em>
        </button>
        <button
          type="button"
          className={activeTab === 'mpls' ? 'is-active' : ''}
          onClick={() => setTab('mpls')}
        >
          <Route size={14} /> MPLS
        </button>
        <button
          type="button"
          className={activeTab === 'monitoring' ? 'is-active' : ''}
          onClick={() => setTab('monitoring')}
        >
          <CircleGauge size={14} /> Monitoring
        </button>
        {!readOnly && (
          <button
            type="button"
            className={activeTab === 'access' ? 'is-active' : ''}
            onClick={() => setTab('access')}
          >
            <ServerCog size={14} /> Access
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className={activeTab === 'discovery' ? 'is-active' : ''}
            onClick={() => setTab('discovery')}
          >
            <Radar size={14} /> Discovery
          </button>
        )}
      </div>
      {activeTab === 'overview' ? (
        <>
          <section className="drawer-section">
            <SectionTitle icon={<ServerCog size={14} />} label="IDENTIDADE" />
            <div className="info-grid">
              <Info label="Hostname" value={device.hostname} mono />
              <Info label="IP de gestão" value={device.ip} mono />
              <Info label="Fabricante" value={device.vendor} />
              <Info label="Modelo" value={device.model} />
              <Info label="Site" value={device.site} />
              <Info label="Origem" value={device.source} />
            </div>
            <div className="uptime-row">
              <Clock3 size={14} /> Uptime <strong>{formatDuration(device.uptimeSeconds)}</strong>
              <span>Atualizado agora</span>
            </div>
          </section>
          <section className="drawer-section">
            <SectionTitle icon={<Cable size={14} />} label="SAÚDE DAS INTERFACES" />
            <div className="interface-summary">
              <div>
                <strong>{device.interfaces.length}</strong>
                <span>Total</span>
              </div>
              <div className="up">
                <strong>{count('UP')}</strong>
                <span>Up</span>
              </div>
              <div className="down">
                <strong>{count('DOWN')}</strong>
                <span>Down</span>
              </div>
              <div className="warning">
                <strong>{count('WARNING')}</strong>
                <span>Warning</span>
              </div>
            </div>
            <div className="throughput-pair">
              <div>
                <ArrowDownToLine size={15} />
                <span>
                  RX TOTAL<small>{formatBitsPerSecond(totalRx)}</small>
                </span>
              </div>
              <div>
                <ArrowUpFromLine size={15} />
                <span>
                  TX TOTAL<small>{formatBitsPerSecond(totalTx)}</small>
                </span>
              </div>
            </div>
          </section>
          <section className="drawer-section">
            <SectionTitle icon={<CircleGauge size={14} />} label="RECURSOS" />
            <ResourceBar
              icon={<Cpu size={15} />}
              label="CPU"
              value={device.cpuPercent ?? 0}
              available={device.cpuPercent !== undefined}
            />
            <ResourceBar
              icon={<HardDrive size={15} />}
              label="Memória"
              value={device.memoryPercent ?? 0}
              available={device.memoryPercent !== undefined}
            />
          </section>
          <div className="drawer-actions">
            {!readOnly && (
              <Button variant="secondary" onClick={() => setTab('discovery')}>
                <Radar size={15} /> Descobrir vizinhos
              </Button>
            )}
            <Button variant="ghost" onClick={() => setTab('interfaces')}>
              Ver interfaces <ChevronRight size={15} />
            </Button>
          </div>
        </>
      ) : activeTab === 'interfaces' ? (
        <InterfaceList
          interfaces={device.interfaces}
          onSelect={(item) => setSelection({ kind: 'interface', id: item.id, deviceId: device.id })}
        />
      ) : activeTab === 'mpls' ? (
        <MplsPanel hostId={device.id} readOnly={readOnly} />
      ) : activeTab === 'monitoring' ? (
        <>
          <section className="drawer-section">
            <SectionTitle icon={<Activity size={14} />} label="FONTES DE MONITORAMENTO" />
            <div className="drawer-source-health">
              {(['ZABBIX', 'SSH', 'SNMP'] as const).map((source) => (
                <div
                  key={source}
                  className={`source-pill source-pill--${device.sourceHealth[source].state.toLowerCase()}`}
                >
                  <span>{source}</span>
                  <strong>{device.sourceHealth[source].state}</strong>
                  <small>{device.sourceHealth[source].lastErrorSafe ?? 'Sem erro recente'}</small>
                </div>
              ))}
            </div>
          </section>
          <section className="drawer-section">
            <SectionTitle icon={<Clock3 size={14} />} label="COLETA" />
            <div className="info-grid">
              <Info
                label="Último polling"
                value={
                  device.lastPollingAt
                    ? new Date(device.lastPollingAt).toLocaleString('pt-BR')
                    : 'Nunca'
                }
              />
              <Info
                label="Último discovery"
                value={
                  device.lastDiscoveryAt
                    ? new Date(device.lastDiscoveryAt).toLocaleString('pt-BR')
                    : 'Nunca'
                }
              />
              <Info label="Métricas" value={device.useZabbix ? 'Preferir Zabbix' : device.source} />
              <Info label="Interfaces" value={`${device.interfaces.length} normalizadas`} />
            </div>
          </section>
        </>
      ) : activeTab === 'access' ? (
        <section className="drawer-section drawer-access">
          <SectionTitle icon={<ServerCog size={14} />} label="ACESSOS COMPLEMENTARES" />
          <Info
            label="Zabbix"
            value={
              device.useZabbix
                ? `Configurado · host ${device.zabbix?.hostId ?? '—'}`
                : 'Desabilitado'
            }
          />
          <Info
            label="SSH"
            value={
              device.sshEnabled
                ? device.ssh?.credentialConfigured
                  ? 'Configurado · segredo protegido'
                  : 'Habilitado sem credencial'
                : 'Desabilitado'
            }
          />
          <Info
            label="SNMP"
            value={
              device.snmpEnabled
                ? `${device.snmp?.version ?? ''} · ${device.snmp?.credentialConfigured ? 'segredo protegido' : 'sem credencial'}`
                : 'Desabilitado'
            }
          />
          <p>Nenhuma senha, community ou token é exposto neste drawer.</p>
        </section>
      ) : (
        <section className="drawer-section drawer-discovery">
          <SectionTitle icon={<Radar size={14} />} label="DESCOBERTA ASSISTIDA" />
          <Info
            label="Última descoberta"
            value={
              device.lastDiscoveryAt
                ? new Date(device.lastDiscoveryAt).toLocaleString('pt-BR')
                : 'Nunca'
            }
          />
          <AssistedDiscoveryReview host={device} mapId={map!.id} />
        </section>
      )}
    </DrawerShell>
  );
}

function InterfaceList({
  interfaces,
  onSelect,
}: {
  interfaces: NetworkInterface[];
  onSelect: (value: NetworkInterface) => void;
}) {
  return (
    <section className="interface-list">
      <div className="interface-list__head">
        <span>NOME / DESCRIÇÃO</span>
        <span>TRÁFEGO</span>
        <span>STATUS</span>
      </div>
      {interfaces.map((item) => (
        <button type="button" key={item.id} onClick={() => onSelect(item)}>
          <span className={`port-dot status-${item.operStatus.toLowerCase()}`} />
          <span className="interface-list__name">
            <strong>{item.name}</strong>
            <small>{item.alias || 'Sem descrição configurada'}</small>
          </span>
          <span className="interface-list__traffic">
            <small>↓ {formatBitsPerSecond(item.rxBps)}</small>
            <small>↑ {formatBitsPerSecond(item.txBps)}</small>
          </span>
          <Badge tone={item.operStatus}>{item.operStatus}</Badge>
          <ChevronRight size={14} />
        </button>
      ))}
    </section>
  );
}

function InterfaceDrawer({
  networkInterface: item,
  deviceId,
  deviceName,
  snmpEnabled,
  readOnly,
  onBack,
  onClose,
}: {
  networkInterface: NetworkInterface;
  deviceId: string;
  deviceName: string;
  snmpEnabled: boolean;
  readOnly: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <DrawerShell
      eyebrow={`${deviceName} / INTERFACE`}
      title={item.name}
      status={item.operStatus}
      {...(!readOnly ? { verifyHost: { hostId: deviceId, enabled: snmpEnabled } } : {})}
      onBack={onBack}
      onClose={onClose}
    >
      <section className="drawer-section">
        <SectionTitle icon={<Cable size={14} />} label="DETALHES DA PORTA" />
        <div className="info-grid">
          <Info label="Descrição / ifAlias" value={item.alias || '—'} />
          <Info label="ifDescr" value={item.description || '—'} />
          <Info label="ifIndex" value={String(item.ifIndex)} mono />
          <Info label="MAC" value={item.mac || '—'} mono />
          <Info label="MTU" value={String(item.mtu)} mono />
          <Info label="Velocidade" value={formatBitsPerSecond(item.speedBps)} />
          <Info label="Admin / Oper" value={`${item.adminStatus} / ${item.operStatus}`} />
          <Info label="Fontes" value={item.dataSources?.join(' + ') || '—'} />
        </div>
      </section>
      <InterfaceOpticalDetails networkInterface={item} />
      {!readOnly && <OpticalHistoryCharts networkInterface={item} />}
      <section className="drawer-section live-metrics">
        <SectionTitle icon={<Activity size={14} />} label="MÉTRICAS ATUAIS" />
        <div className="metric-hero">
          <div className="rx">
            <span>RX ATUAL</span>
            <strong>{formatBitsPerSecond(item.rxBps)}</strong>
            <small>{item.rxUtilization.toFixed(1)}% utilização</small>
          </div>
          <div className="tx">
            <span>TX ATUAL</span>
            <strong>{formatBitsPerSecond(item.txBps)}</strong>
            <small>{item.txUtilization.toFixed(1)}% utilização</small>
          </div>
        </div>
        <div className="counter-row">
          <Counter label="Erros RX agora" value={item.rxErrors} total={item.rxErrorsTotal} />
          <Counter label="Erros TX agora" value={item.txErrors} total={item.txErrorsTotal} />
          <Counter label="Discards RX agora" value={item.rxDiscards} total={item.rxDiscardsTotal} />
          <Counter label="Discards TX agora" value={item.txDiscards} total={item.txDiscardsTotal} />
        </div>
      </section>
      {!readOnly && <MetricCharts networkInterface={item} />}
    </DrawerShell>
  );
}

export function InterfaceOpticalDetails({
  networkInterface: item,
}: {
  networkInterface: NetworkInterface;
}) {
  const lanes = (item.opticalLanes ?? [])
    .filter(
      (lane) => lane.rxPowerDbm != null || lane.txPowerDbm != null || lane.biasCurrentMa != null,
    )
    .sort((left, right) => left.lane - right.lane);
  const multiLane = lanes.length > 1;

  return (
    <section className="drawer-section">
      <SectionTitle icon={<CircleGauge size={14} />} label="ÓPTICO" />
      <div className="info-grid">
        {multiLane ? (
          <Info label="RX/TX óptico" value="multi-lane" mono />
        ) : (
          <>
            <Info label="RX óptico" value={formatOpticalPower(item.rxPowerDbm)} mono />
            <Info label="TX óptico" value={formatOpticalPower(item.txPowerDbm)} mono />
          </>
        )}
        <Info
          label="Fonte"
          value={(lanes.length ? item.opticalLaneSource : item.opticalSource) ?? 'N/D'}
        />
        <Info
          label="Atualizado"
          value={formatOpticalTimestamp(
            lanes.length ? item.opticalLanesUpdatedAt : item.opticalUpdatedAt,
          )}
        />
      </div>
      {lanes.length > 0 && (
        <div className="info-grid">
          {lanes.map((lane) => (
            <Info
              key={lane.lane}
              label={`Lane ${lane.lane}`}
              value={`RX ${formatOpticalPower(lane.rxPowerDbm)} · TX ${formatOpticalPower(lane.txPowerDbm)}${lane.biasCurrentMa == null ? '' : ` · Bias ${lane.biasCurrentMa.toFixed(2)} mA`}`}
              mono
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LinkDrawer({
  link,
  readOnly,
  onClose,
}: {
  link: NetworkLink;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(link.label);
  const [sourceInterfaceId, setSourceInterfaceId] = useState(link.sourceInterfaceId ?? '');
  const [targetInterfaceId, setTargetInterfaceId] = useState(link.targetInterfaceId ?? '');
  const [aggregationMode, setAggregationMode] = useState<LinkAggregationMode>(
    link.aggregationMode ?? 'NONE',
  );
  const [sourceMetricIds, setSourceMetricIds] = useState<string[]>(
    (link.metricSources ?? [])
      .filter((entry) => entry.side === 'SOURCE')
      .map((entry) => entry.interfaceId),
  );
  const [targetMetricIds, setTargetMetricIds] = useState<string[]>(
    (link.metricSources ?? [])
      .filter((entry) => entry.side === 'TARGET')
      .map((entry) => entry.interfaceId),
  );
  const [visualPaths, setVisualPaths] = useState<LinkVisualPath[]>(
    link.visualPaths?.length ? link.visualPaths : defaultVisualPaths(1),
  );
  const initialUnit = link.capacityBps >= 1_000_000_000 ? 'GBPS' : 'MBPS';
  const [capacitySource, setCapacitySource] = useState<CapacitySource>(link.capacitySource);
  const [capacityUnit, setCapacityUnit] = useState<'MBPS' | 'GBPS'>(initialUnit);
  const [capacity, setCapacity] = useState(
    link.capacityBps / (initialUnit === 'GBPS' ? 1_000_000_000 : 1_000_000),
  );
  const [visualStyle, setVisualStyle] = useState<LinkDisplayStyle | ''>(link.visualStyle ?? '');
  const [metricDisplay, setMetricDisplay] = useState<LinkMetricDisplay | ''>(
    link.metricDisplay ?? '',
  );
  const [trafficMode, setTrafficMode] = useState<LinkTrafficMode>(link.trafficMode);
  const [singleEndedSide, setSingleEndedSide] = useState<'SOURCE' | 'TARGET'>(
    link.sourceInterfaceId ? 'SOURCE' : 'TARGET',
  );
  const [customColor, setCustomColor] = useState<string | null>(link.customColor);
  const [animationEnabled, setAnimationEnabled] = useState<boolean | null>(link.animationEnabled);
  const map = useMapStore((state) => state.map);
  const editMode = useMapStore((state) => state.editMode);
  const removeLink = useMapStore((state) => state.removeLink);
  const replaceLink = useMapStore((state) => state.replaceLink);
  const showToast = useMapStore((state) => state.showToast);
  const source = map?.devices.find((item) => item.id === link.sourceDeviceId);
  const target = map?.devices.find((item) => item.id === link.targetDeviceId);
  const sourceNode = map?.nodes.find((item) => item.id === link.sourceNodeId);
  const targetNode = map?.nodes.find((item) => item.id === link.targetNodeId);
  const sourceInterface = source?.interfaces.find((item) => item.id === link.sourceInterfaceId);
  const targetInterface = target?.interfaces.find((item) => item.id === link.targetInterfaceId);
  const monitoredSide =
    source && !target ? 'SOURCE' : target && !source ? 'TARGET' : singleEndedSide;
  const findInterface = (
    deviceId: string | null | undefined,
    interfaceId: string | null | undefined,
  ): NetworkInterface | undefined => {
    if (!interfaceId) return undefined;
    const scoped = deviceId
      ? map?.devices
          .find((device) => device.id === deviceId)
          ?.interfaces.find((item) => item.id === interfaceId)
      : undefined;
    return (
      scoped ??
      map?.devices.flatMap((device) => device.interfaces).find((item) => item.id === interfaceId)
    );
  };
  const sumMode = trafficMode === 'BIDIRECTIONAL' && aggregationMode === 'SUM';
  const referenceSourceInterfaceId =
    sumMode && sourceMetricIds.length ? sourceMetricIds[0] : sourceInterfaceId;
  const referenceTargetInterfaceId =
    sumMode && targetMetricIds.length ? targetMetricIds[0] : targetInterfaceId;
  const effectiveSourceInterfaceId =
    trafficMode === 'BIDIRECTIONAL' || monitoredSide === 'SOURCE'
      ? referenceSourceInterfaceId
      : '';
  const effectiveTargetInterfaceId =
    trafficMode === 'BIDIRECTIONAL' || monitoredSide === 'TARGET'
      ? referenceTargetInterfaceId
      : '';
  const metricSources: LinkMetricSource[] = sumMode
    ? [
        ...sourceMetricIds.map((interfaceId) => ({ interfaceId, side: 'SOURCE' as const })),
        ...targetMetricIds.map((interfaceId) => ({ interfaceId, side: 'TARGET' as const })),
      ]
    : [];
  const editedReferenceSource = findInterface(link.sourceDeviceId, effectiveSourceInterfaceId);
  const editedReferenceTarget = findInterface(link.targetDeviceId, effectiveTargetInterfaceId);
  const autoCapacityBps = automaticLinkCapacity(
    editedReferenceSource,
    editedReferenceTarget,
    trafficMode,
    link.autoCapacityBps,
  );
  const capacityBps =
    capacitySource === 'AUTO'
      ? autoCapacityBps
      : capacity * (capacityUnit === 'GBPS' ? 1_000_000_000 : 1_000_000);
  const metrics = aggregateLinkMetrics(
    {
      sourceDeviceId: link.sourceDeviceId,
      targetDeviceId: link.targetDeviceId,
      sourceInterfaceId: effectiveSourceInterfaceId || null,
      targetInterfaceId: effectiveTargetInterfaceId || null,
      aggregationMode: sumMode ? 'SUM' : 'NONE',
      metricSources,
      trafficMode,
      capacityBps,
    },
    findInterface,
  );
  const editedLink: NetworkLink = {
    ...link,
    label,
    sourceInterfaceId: effectiveSourceInterfaceId || null,
    targetInterfaceId: effectiveTargetInterfaceId || null,
    capacityBps,
    autoCapacityBps,
    capacitySource,
    trafficMode,
    customColor,
    animationEnabled,
    visualStyle: visualStyle || null,
    metricDisplay: metricDisplay || null,
    aggregationMode: sumMode ? 'SUM' : 'NONE',
    metricSources,
    visualPaths,
    directions: metrics.directions,
    txBps: metrics.txBps,
    rxBps: metrics.rxBps,
    txUtilization: metrics.txUtilization,
    rxUtilization: metrics.rxUtilization,
    rxErrors: metrics.rxErrors,
    txErrors: metrics.txErrors,
    rxDiscards: metrics.rxDiscards,
    txDiscards: metrics.txDiscards,
    status: metrics.status,
    updatedAt: new Date().toISOString(),
  };
  const updateMutation = useMutation({
    mutationFn: () =>
      updateLinkRequest(link.mapId, link.id, {
        sourceInterfaceId: effectiveSourceInterfaceId || null,
        targetInterfaceId: effectiveTargetInterfaceId || null,
        label,
        capacityBps,
        autoCapacityBps,
        capacitySource,
        trafficMode,
        customColor,
        animationEnabled,
        metricSource: link.metricSource,
        visualStyle: visualStyle || null,
        metricDisplay: metricDisplay || null,
        aggregationMode: sumMode ? 'SUM' : 'NONE',
        metricSources,
        visualPaths,
      }),
    onSuccess: (updated) => {
      replaceLink(updated);
      setEditing(false);
      showToast('Enlace atualizado');
    },
    onError: () => {
      replaceLink(editedLink);
      setEditing(false);
      showToast('Enlace atualizado localmente');
    },
  });
  const remove = () => {
    removeLink(link.id);
    void deleteLinkRequest(link.mapId, link.id).catch(() => undefined);
    showToast('Enlace removido');
  };
  const updateVisualPath = (index: number, patch: Partial<LinkVisualPath>) => {
    setVisualPaths((current) =>
      current.map((path, pathIndex) => (pathIndex === index ? { ...path, ...patch } : path)),
    );
  };
  const resizeVisualPaths = (count: number) => {
    const curvatures = autoCurvatures(count);
    setVisualPaths((current) =>
      Array.from({ length: count }, (_, index) => ({
        ...(current[index] ?? { order: index, label: null, customColor: null, enabled: true }),
        order: index,
        curvature: curvatures[index] ?? 0,
      })),
    );
  };
  const aToB = link.directions.A_TO_B;
  const bToA = link.directions.B_TO_A;

  return (
    <DrawerShell eyebrow="ENLACE" title={link.label} status={link.status} onClose={onClose}>
      <div className="link-route">
        <Endpoint
          label="PONTA A"
          device={source?.name ?? sourceNode?.label ?? '—'}
          networkInterface={sourceInterface?.name ?? '—'}
          rxDbm={sourceInterface?.rxPowerDbm}
          txDbm={sourceInterface?.txPowerDbm}
        />
        <div className="link-route__line">
          <span />
          <Cable size={16} />
          <span />
        </div>
        <Endpoint
          label="PONTA B"
          device={target?.name ?? targetNode?.label ?? '—'}
          networkInterface={targetInterface?.name ?? '—'}
          rxDbm={targetInterface?.rxPowerDbm}
          txDbm={targetInterface?.txPowerDbm}
        />
      </div>
      <section className="drawer-section">
        <SectionTitle
          icon={<Activity size={14} />}
          label={
            link.trafficMode === 'SINGLE_ENDED'
              ? 'TRÁFEGO DA INTERFACE MONITORADA'
              : 'TRÁFEGO BIDIRECIONAL'
          }
        />
        <div className="metric-hero">
          <div className="rx">
            <span>{link.trafficMode === 'SINGLE_ENDED' ? 'RX observado' : 'A ← B'}</span>
            <strong>
              {formatBitsPerSecond(link.trafficMode === 'SINGLE_ENDED' ? link.rxBps : bToA.bps)}
            </strong>
            <small>
              {(link.trafficMode === 'SINGLE_ENDED'
                ? link.rxUtilization
                : bToA.utilization
              ).toFixed(1)}
              % utilização
            </small>
          </div>
          <div className="tx">
            <span>{link.trafficMode === 'SINGLE_ENDED' ? 'TX observado' : 'A → B'}</span>
            <strong>
              {formatBitsPerSecond(link.trafficMode === 'SINGLE_ENDED' ? link.txBps : aToB.bps)}
            </strong>
            <small>
              {(link.trafficMode === 'SINGLE_ENDED'
                ? link.txUtilization
                : aToB.utilization
              ).toFixed(1)}
              % utilização
            </small>
          </div>
        </div>
        <div className="capacity-bar">
          <span
            style={{ width: `${Math.min(100, Math.max(aToB.utilization, bToA.utilization))}%` }}
          />
          <small>
            Capacidade {formatBitsPerSecond(link.capacityBps)} · {link.capacitySource}
          </small>
        </div>
      </section>
      <section className="drawer-section">
        <SectionTitle icon={<Database size={14} />} label="ORIGEM E QUALIDADE" />
        <div className="info-grid">
          <Info label="Descoberta" value={link.discoverySource.replace('_', ' / ')} />
          <Info label="Métricas" value={link.metricSource} />
          {link.trafficMode === 'SINGLE_ENDED' ? (
            <Info label="Validação entre pontas" value="N/D — enlace unilateral" />
          ) : (
            <>
              <Info label="A → B (validação)" value={trafficValidation(aToB)} />
              <Info label="B → A (validação)" value={trafficValidation(bToA)} />
            </>
          )}
          <Info label="Erros RX / TX" value={`${link.rxErrors} / ${link.txErrors}`} />
          <Info label="Discards RX / TX" value={`${link.rxDiscards} / ${link.txDiscards}`} />
        </div>
      </section>
      {editing && !readOnly && (
        <section className="drawer-section edit-link-form">
          <div className="edit-link-form__section">
            <SectionTitle icon={<Activity size={14} />} label="FONTES DE TRÁFEGO" />
            {trafficMode === 'BIDIRECTIONAL' && (
              <label>
                Agregação
                <select
                  value={aggregationMode}
                  onChange={(event) =>
                    setAggregationMode(event.target.value as LinkAggregationMode)
                  }
                >
                  <option value="NONE">Interface única (padrão)</option>
                  <option value="SUM">Somar interfaces</option>
                </select>
              </label>
            )}
            {sumMode ? (
              <>
                {source && (
                  <div className="form-field">
                    <span>Interfaces da ponta A (soma)</span>
                    <InterfaceMultiPicker
                      interfaces={source.interfaces}
                      value={sourceMetricIds}
                      onChange={setSourceMetricIds}
                    />
                  </div>
                )}
                {target && (
                  <div className="form-field">
                    <span>Interfaces da ponta B (soma)</span>
                    <InterfaceMultiPicker
                      interfaces={target.interfaces}
                      value={targetMetricIds}
                      onChange={setTargetMetricIds}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                {source && (trafficMode === 'BIDIRECTIONAL' || monitoredSide === 'SOURCE') && (
                  <div className="form-field">
                    <span>Interface da ponta A</span>
                    <InterfacePicker
                      interfaces={source.interfaces}
                      value={sourceInterfaceId}
                      onChange={setSourceInterfaceId}
                    />
                  </div>
                )}
                {target && (trafficMode === 'BIDIRECTIONAL' || monitoredSide === 'TARGET') && (
                  <div className="form-field">
                    <span>Interface da ponta B</span>
                    <InterfacePicker
                      interfaces={target.interfaces}
                      value={targetInterfaceId}
                      onChange={setTargetInterfaceId}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          <label>
            Label
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            Modo de telemetria
            <select
              value={trafficMode}
              onChange={(event) => setTrafficMode(event.target.value as LinkTrafficMode)}
            >
              <option value="BIDIRECTIONAL">Bidirecional</option>
              <option value="SINGLE_ENDED">Uma ponta monitorada</option>
            </select>
          </label>
          {trafficMode === 'SINGLE_ENDED' && source && target && (
            <label>
              Ponta monitorada
              <select
                value={singleEndedSide}
                onChange={(event) => setSingleEndedSide(event.target.value as 'SOURCE' | 'TARGET')}
              >
                <option value="SOURCE">Ponta A</option>
                <option value="TARGET">Ponta B</option>
              </select>
            </label>
          )}
          <label>
            Cor do enlace
            <select
              value={customColor === null ? 'AUTO' : 'CUSTOM'}
              onChange={(event) => setCustomColor(event.target.value === 'AUTO' ? null : '#40c8e8')}
            >
              <option value="AUTO">Automática</option>
              <option value="CUSTOM">Personalizada</option>
            </select>
          </label>
          {customColor !== null && (
            <label>
              Seletor de cor
              <input
                type="color"
                value={customColor}
                onChange={(event) => setCustomColor(event.target.value)}
              />
            </label>
          )}
          <label>
            Animação
            <select
              value={animationEnabled === null ? 'INHERIT' : animationEnabled ? 'ON' : 'OFF'}
              onChange={(event) =>
                setAnimationEnabled(
                  event.target.value === 'INHERIT' ? null : event.target.value === 'ON',
                )
              }
            >
              <option value="INHERIT">Herdar do mapa</option>
              <option value="ON">Ligada</option>
              <option value="OFF">Desligada</option>
            </select>
          </label>
          <label>
            Origem da capacidade
            <select
              value={capacitySource}
              onChange={(event) => setCapacitySource(event.target.value as CapacitySource)}
            >
              <option value="AUTO">Automática pelas interfaces</option>
              <option value="MANUAL">Manual</option>
            </select>
          </label>
          <label>
            Capacidade
            <input
              type="number"
              min="0.01"
              value={capacity}
              disabled={capacitySource === 'AUTO'}
              onChange={(event) => setCapacity(Number(event.target.value))}
            />
          </label>
          <label>
            Unidade
            <select
              value={capacityUnit}
              disabled={capacitySource === 'AUTO'}
              onChange={(event) => setCapacityUnit(event.target.value as 'MBPS' | 'GBPS')}
            >
              <option value="MBPS">Mbps</option>
              <option value="GBPS">Gbps</option>
            </select>
          </label>
          <label>
            Visual deste enlace
            <select
              value={visualStyle}
              onChange={(event) => setVisualStyle(event.target.value as LinkDisplayStyle | '')}
            >
              <option value="">Herdar do mapa</option>
              <option value="FLOW">Flow</option>
              <option value="WEATHERMAP">Weathermap</option>
              <option value="HYBRID">Hybrid</option>
              <option value="MINIMAL">Minimal</option>
            </select>
          </label>
          <label>
            Métrica deste enlace
            <select
              value={metricDisplay}
              onChange={(event) => setMetricDisplay(event.target.value as LinkMetricDisplay | '')}
            >
              <option value="">Herdar do mapa</option>
              <option value="THROUGHPUT">Throughput</option>
              <option value="UTILIZATION">Utilização</option>
              <option value="BOTH">Ambos</option>
              <option value="NONE">Nenhuma</option>
            </select>
          </label>
          <div className="edit-link-form__section">
            <SectionTitle icon={<Route size={14} />} label="FORMA DO ENLACE" />
            <label>
              Quantidade de caminhos
              <select
                value={visualPaths.length}
                onChange={(event) => resizeVisualPaths(Number(event.target.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            {visualPaths.map((path, index) => (
              <div key={path.order} className="visual-path-editor">
                <div className="visual-path-editor__header">
                  <strong>Caminho {index + 1}</strong>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={path.enabled}
                      onChange={(event) => updateVisualPath(index, { enabled: event.target.checked })}
                    />
                    Ativo
                  </label>
                </div>
                <div className="visual-path-grid">
                  <label>
                    Nome
                    <input
                      value={path.label ?? ''}
                      placeholder="Principal / Backup…"
                      onChange={(event) =>
                        updateVisualPath(index, { label: event.target.value || null })
                      }
                    />
                  </label>
                  <label>
                    Cor
                    <select
                      value={path.customColor === null ? 'AUTO' : 'CUSTOM'}
                      onChange={(event) =>
                        updateVisualPath(index, {
                          customColor: event.target.value === 'AUTO' ? null : '#40c8e8',
                        })
                      }
                    >
                      <option value="AUTO">Automática</option>
                      <option value="CUSTOM">Personalizada</option>
                    </select>
                  </label>
                  {path.customColor !== null && (
                    <label>
                      Seletor de cor
                      <input
                        type="color"
                        value={path.customColor}
                        onChange={(event) =>
                          updateVisualPath(index, { customColor: event.target.value })
                        }
                      />
                    </label>
                  )}
                  <label>
                    Curvatura / offset
                    <input
                      type="number"
                      step="1"
                      value={path.curvature}
                      onChange={(event) =>
                        updateVisualPath(index, { curvature: Number(event.target.value) })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <div className="edit-link-form__actions">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => updateMutation.mutate()}>
              Salvar alterações
            </Button>
          </div>
        </section>
      )}
      {editMode && !readOnly && !editing && (
        <div className="drawer-actions">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil size={15} /> Editar enlace
          </Button>
          <Button variant="danger" onClick={remove}>
            <Trash2 size={15} /> Excluir
          </Button>
        </div>
      )}
    </DrawerShell>
  );
}

function GenericNodeDrawer({ node, onClose }: { node: MapNode; onClose: () => void }) {
  return (
    <DrawerShell
      eyebrow="NODE CONCEITUAL"
      title={node.label ?? node.genericType ?? 'Node'}
      status="UNKNOWN"
      onClose={onClose}
    >
      <section className="drawer-section">
        <SectionTitle icon={<Network size={14} />} label="TOPOLOGIA" />
        <div className="info-grid">
          <Info label="Tipo / ícone" value={node.genericType ?? 'GENERIC'} />
          <Info
            label="Posição"
            value={`${Math.round(node.position.x)} × ${Math.round(node.position.y)}`}
          />
          <Info label="Trava" value={node.locked ? 'Bloqueado' : 'Livre'} />
        </div>
      </section>
    </DrawerShell>
  );
}

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <h3 className="section-title">
      {icon}
      {label}
    </h3>
  );
}
function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}
function ResourceBar({
  icon,
  label,
  value,
  available,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  available: boolean;
}) {
  return (
    <div className="resource-bar">
      {icon}
      <span>{label}</span>
      <div>
        <i style={{ width: `${value}%` }} />
      </div>
      <strong>{available ? `${value.toFixed(0)}%` : 'N/D'}</strong>
    </div>
  );
}
function formatOpticalPower(value: number | null | undefined): string {
  return value == null ? 'N/D' : `${value.toFixed(2)} dBm`;
}

function formatOpticalTimestamp(value: string | null | undefined): string {
  if (!value) return 'N/D';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'N/D' : date.toLocaleString('pt-BR');
}

function Counter({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number | undefined;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toLocaleString('pt-BR')}</strong>
      {total !== undefined && <small>Total: {total.toLocaleString('pt-BR')}</small>}
    </div>
  );
}
function Endpoint({
  label,
  device,
  networkInterface,
  rxDbm,
  txDbm,
}: {
  label: string;
  device: string;
  networkInterface: string;
  rxDbm?: number | null | undefined;
  txDbm?: number | null | undefined;
}) {
  return (
    <div className="endpoint">
      <span>{label}</span>
      <strong>{device}</strong>
      <small>{networkInterface}</small>
      {(rxDbm != null || txDbm != null) && (
        <em>
          RX {formatOpticalPower(rxDbm)} · TX {formatOpticalPower(txDbm)}
        </em>
      )}
    </div>
  );
}
