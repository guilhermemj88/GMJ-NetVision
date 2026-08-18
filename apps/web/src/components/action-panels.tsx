'use client';

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import {
  Check,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Database,
  KeyRound,
  Link2,
  LoaderCircle,
  Map as MapIcon,
  MonitorPlay,
  Copy,
  Pencil,
  Plus,
  Radar,
  Search,
  Network,
  ServerCog,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  createLocalId,
  type CapacitySource,
  type CreateLinkInput,
  type DeviceType,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type MapMode,
  type NetworkInterface,
} from '@gmj/shared';
import {
  addDevice,
  addHostsToMap,
  createGenericNode,
  createLink,
  createNetworkMap,
  deleteNetworkMap,
  duplicateNetworkMap,
  getHosts,
  savePlaylist,
  updateNetworkMap,
  type AddDeviceInput,
} from '@/lib/api';
import { GENERIC_NODE_TYPES } from '@/lib/device-appearance';
import { useMapStore } from '@/store/map-store';
import { AssistedDiscoveryReview } from './assisted-discovery-review';
import { PublicLinksPanel } from './public-links-manager';

export function ActionPanels() {
  const panel = useMapStore((state) => state.panel);
  if (panel === 'create-link') return <CreateLinkPanel />;
  if (panel === 'add-device') return <AddDevicePanel />;
  if (panel === 'add-generic-node') return <AddGenericNodePanel />;
  if (panel === 'public-links') return <PublicLinksPanel />;
  if (panel === 'discovery') return <DiscoveryPanel />;
  if (panel === 'settings') return <SettingsPanel />;
  if (panel === 'maps') return <MapManagerPanel />;
  if (panel === 'rotation') return <RotationPanel />;
  return null;
}

function PanelShell({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  const setPanel = useMapStore((state) => state.setPanel);
  return (
    <div
      className="panel-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}
    >
      <section className="action-panel" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <span>{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

type LinkEndpoint =
  | { kind: 'device'; id: string; name: string; interfaces: NetworkInterface[] }
  | { kind: 'node'; id: string; name: string };

function CreateLinkPanel() {
  const map = useMapStore((state) => state.map);
  const pending = useMapStore((state) => state.pendingLink);
  const setPendingLink = useMapStore((state) => state.setPendingLink);
  const setPanel = useMapStore((state) => state.setPanel);
  const addLinkToStore = useMapStore((state) => state.addLink);
  const showToast = useMapStore((state) => state.showToast);
  const endpoints: LinkEndpoint[] =
    map?.nodes.flatMap((node): LinkEndpoint[] => {
      if (node.deviceId) {
        const device = map.devices.find((item) => item.id === node.deviceId);
        return device
          ? [{ kind: 'device', id: device.id, name: device.name, interfaces: device.interfaces }]
          : [];
      }
      return [{ kind: 'node', id: node.id, name: node.label || node.genericType || 'Node' }];
    }) ?? [];
  const [sourceId, setSourceId] = useState(pending?.sourceId ?? endpoints[0]?.id ?? '');
  const [targetId, setTargetId] = useState(
    pending?.targetId ?? endpoints[1]?.id ?? endpoints[0]?.id ?? '',
  );
  const source = endpoints.find((item) => item.id === sourceId);
  const target = endpoints.find((item) => item.id === targetId);
  const [sourceInterfaceId, setSourceInterfaceId] = useState('');
  const [targetInterfaceId, setTargetInterfaceId] = useState('');
  const [capacity, setCapacity] = useState(100);
  const [capacityUnit, setCapacityUnit] = useState<'Mbps' | 'Gbps'>('Gbps');
  const [capacitySource, setCapacitySource] = useState<CapacitySource>('AUTO');
  const [label, setLabel] = useState('LINK');
  const [metricSource, setMetricSource] = useState<'DEMO' | 'ZABBIX'>('DEMO');
  const [visualStyle, setVisualStyle] = useState<LinkDisplayStyle | null>(null);
  const [metricDisplay, setMetricDisplay] = useState<LinkMetricDisplay | null>(null);
  const selectedSourceInterface =
    source?.kind === 'device'
      ? source.interfaces.find(
          (item) => item.id === (sourceInterfaceId || source.interfaces[0]?.id),
        )
      : undefined;
  const selectedTargetInterface =
    target?.kind === 'device'
      ? target.interfaces.find(
          (item) => item.id === (targetInterfaceId || target.interfaces[0]?.id),
        )
      : undefined;
  const autoCapacityBps = Math.max(
    1,
    Math.min(
      selectedSourceInterface?.speedBps ?? 1_000_000_000,
      selectedTargetInterface?.speedBps ?? 1_000_000_000,
    ),
  );
  const manualCapacityBps = capacity * (capacityUnit === 'Gbps' ? 1_000_000_000 : 1_000_000);

  const input: CreateLinkInput | null =
    source && target
      ? {
          ...(source.kind === 'device'
            ? {
                sourceDeviceId: source.id,
                sourceInterfaceId: sourceInterfaceId || source.interfaces[0]?.id || '',
              }
            : { sourceNodeId: source.id }),
          ...(target.kind === 'device'
            ? {
                targetDeviceId: target.id,
                targetInterfaceId: targetInterfaceId || target.interfaces[0]?.id || '',
              }
            : { targetNodeId: target.id }),
          capacityBps: capacitySource === 'AUTO' ? autoCapacityBps : manualCapacityBps,
          autoCapacityBps,
          capacitySource,
          label,
          metricSource,
          visualStyle,
          metricDisplay,
        }
      : null;

  const canSubmit =
    Boolean(input) &&
    sourceId !== targetId &&
    (source?.kind !== 'device' || Boolean(input?.sourceInterfaceId)) &&
    (target?.kind !== 'device' || Boolean(input?.targetInterfaceId));

  const mutation = useMutation({
    mutationFn: async () => {
      if (!input) throw new Error('Selecione os endpoints');
      return createLink(map?.id ?? '', input);
    },
    onSuccess: (link) => {
      if (input) addLinkToStore(input, link);
      setPendingLink(null);
      setPanel(null);
      showToast('Enlace criado');
    },
    onError: () => {
      if (input) {
        addLinkToStore(input);
        setPendingLink(null);
        setPanel(null);
        showToast('Enlace criado localmente (API offline)');
      }
    },
  });

  return (
    <PanelShell eyebrow="EDITOR MANUAL" title="Criar enlace">
      <div className="panel-body">
        <div className="link-form-route">
          <div className="form-column">
            <label>
              Origem
              <select
                value={sourceId}
                onChange={(event) => {
                  setSourceId(event.target.value);
                  setSourceInterfaceId('');
                }}
              >
                {endpoints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {source?.kind === 'device' && (
              <label>
                Interface
                <select
                  value={sourceInterfaceId || source.interfaces[0]?.id}
                  onChange={(event) => setSourceInterfaceId(event.target.value)}
                >
                  {source.interfaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}{item.alias ? ` · ${item.alias}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="link-form-route__connector">
            <span />
            <Link2 size={19} />
            <span />
          </div>
          <div className="form-column">
            <label>
              Destino
              <select
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setTargetInterfaceId('');
                }}
              >
                {endpoints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {target?.kind === 'device' && (
              <label>
                Interface
                <select
                  value={targetInterfaceId || target.interfaces[0]?.id}
                  onChange={(event) => setTargetInterfaceId(event.target.value)}
                >
                  {target.interfaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}{item.alias ? ` · ${item.alias}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        <div className="capacity-source-picker">
          <span>Origem da capacidade</span>
          <button
            type="button"
            className={capacitySource === 'AUTO' ? 'is-active' : ''}
            onClick={() => setCapacitySource('AUTO')}
          >
            Automática pela interface
          </button>
          <button
            type="button"
            className={capacitySource === 'MANUAL' ? 'is-active' : ''}
            onClick={() => setCapacitySource('MANUAL')}
          >
            Manual (sobrescreve)
          </button>
          <small>Detectada: {(autoCapacityBps / 1_000_000_000).toFixed(0)} Gbps</small>
        </div>
        <div className="form-grid form-grid--link-options">
          <label>
            Capacidade
            <input
              type="number"
              min="0.1"
              step="0.1"
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
              onChange={(event) => setCapacityUnit(event.target.value as 'Mbps' | 'Gbps')}
            >
              <option>Gbps</option>
              <option>Mbps</option>
            </select>
          </label>
          <label>
            Label
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            Fonte de métricas
            <select
              value={metricSource}
              onChange={(event) => setMetricSource(event.target.value as 'DEMO' | 'ZABBIX')}
            >
              <option value="DEMO">Demo</option>
              <option value="ZABBIX">Zabbix</option>
            </select>
          </label>
          <label>
            Estilo visual
            <select
              value={visualStyle ?? ''}
              onChange={(event) =>
                setVisualStyle((event.target.value || null) as LinkDisplayStyle | null)
              }
            >
              <option value="">Herdar do mapa</option>
              <option value="FLOW">Flow</option>
              <option value="WEATHERMAP">Weathermap</option>
              <option value="HYBRID">Hybrid</option>
              <option value="MINIMAL">Minimal</option>
            </select>
          </label>
          <label>
            Métrica exibida
            <select
              value={metricDisplay ?? ''}
              onChange={(event) =>
                setMetricDisplay((event.target.value || null) as LinkMetricDisplay | null)
              }
            >
              <option value="">Herdar do mapa</option>
              <option value="THROUGHPUT">Throughput</option>
              <option value="UTILIZATION">Utilização %</option>
              <option value="BOTH">Ambos</option>
              <option value="NONE">Nenhum</option>
            </select>
          </label>
        </div>
        <div className="panel-note">
          <ShieldCheck size={16} />
          <span>
            O enlace pode conectar equipamentos (com interface) ou nodes conceituais. A coleta de
            métricas é independente da origem da topologia.
          </span>
        </div>
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={!canSubmit || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}{' '}
          Criar link
        </Button>
      </footer>
    </PanelShell>
  );
}

function AddGenericNodePanel() {
  const map = useMapStore((state) => state.map);
  const setPanel = useMapStore((state) => state.setPanel);
  const addGenericNodeToStore = useMapStore((state) => state.addGenericNode);
  const showToast = useMapStore((state) => state.showToast);
  const [type, setType] = useState<string>(GENERIC_NODE_TYPES[0]?.value ?? 'CLOUD');
  const [label, setLabel] = useState('INTERNET');

  const mutation = useMutation({
    mutationFn: () =>
      createGenericNode(map?.id ?? '', {
        type,
        label,
        position: { x: 700, y: 700 },
      }),
    onSuccess: (node) => {
      addGenericNodeToStore(node);
      setPanel(null);
      showToast('Node conceitual adicionado');
    },
    onError: () => {
      addGenericNodeToStore({
        id: createLocalId('node'),
        mapId: map?.id ?? '',
        deviceId: null,
        nodeKind: 'GENERIC',
        genericType: type,
        label,
        position: { x: 700, y: 700 },
        locked: false,
        positionSource: 'MANUAL',
      });
      setPanel(null);
      showToast('Node adicionado localmente (API offline)');
    },
  });

  return (
    <PanelShell eyebrow="EDITOR MANUAL" title="Novo node conceitual">
      <div className="panel-body">
        <div className="form-grid">
          <label>
            Tipo / ícone
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {GENERIC_NODE_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nome
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
        </div>
        <div className="panel-note">
          <Network size={16} />
          <span>
            Nodes conceituais representam topologia (Internet, IX, clientes, datacenter…) sem um
            host monitorado. Eles não entram no inventário e não são consultados por SNMP/SSH.
          </span>
        </div>
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={!label.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{' '}
          Adicionar
        </Button>
      </footer>
    </PanelShell>
  );
}

function AddDevicePanel() {
  const map = useMapStore((state) => state.map);
  const setPanel = useMapStore((state) => state.setPanel);
  const addDeviceToStore = useMapStore((state) => state.addDevice);
  const showToast = useMapStore((state) => state.showToast);
  const [mode, setMode] = useState<'existing' | 'manual'>('existing');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const { data: hosts = [] } = useQuery({
    queryKey: ['hosts'],
    queryFn: () => getHosts(),
  });
  const availableHosts = (hosts ?? []).filter(
    (host) => !map?.nodes.some((node) => node.deviceId === host.id),
  );
  const filteredHosts = availableHosts.filter((host) => {
    const text = search.trim().toLowerCase();
    if (!text) return true;
    return [host.hostname, host.displayName, host.managementIp, host.vendor, host.model]
      .join(' ')
      .toLowerCase()
      .includes(text);
  });
  const [form, setForm] = useState<AddDeviceInput>({
    name: 'NEW-DEVICE-01',
    hostname: 'new-device-01',
    ip: '10.99.0.1',
    vendor: '',
    model: '',
    site: 'Novo site',
    deviceType: 'generic',
    position: { x: 700, y: 700 },
  });

  const update = (key: keyof AddDeviceInput, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const manualMutation = useMutation({
    mutationFn: () => addDevice(map?.id ?? '', form),
    onSuccess: ({ device, node }) => {
      addDeviceToStore(device, form.position, node);
      setPanel(null);
      showToast('Equipamento adicionado');
    },
    onError: () => {
      const timestamp = new Date().toISOString();
      const id = createLocalId('device');
      addDeviceToStore(
        {
          id,
          ...form,
          displayName: form.name,
          managementIp: form.ip,
          description: '',
          notes: '',
          origin: 'MANUAL',
          status: 'UNKNOWN',
          source: 'MANUAL',
          discoveryMethod: 'MANUAL',
          useZabbix: false,
          zabbix: null,
          sshEnabled: false,
          ssh: null,
          snmpEnabled: false,
          snmp: null,
          sourceHealth: {
            ZABBIX: {
              state: 'DISABLED',
              lastSuccess: null,
              lastFailure: null,
              lastErrorSafe: null,
            },
            SSH: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
            SNMP: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
          },
          lastPollingAt: null,
          lastDiscoveryAt: null,
          uptimeSeconds: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          mapIds: map ? [map.id] : [],
          mapCount: map ? 1 : 0,
          interfaces: [
            {
              id: `${id}-if-1`,
              deviceId: id,
              name: 'GE0/0/1',
              alias: '',
              description: 'Manual interface',
              ifIndex: 1,
              mac: '',
              mtu: 1500,
              speedBps: 1_000_000_000,
              adminStatus: 'UP',
              operStatus: 'UNKNOWN',
              rxBps: 0,
              txBps: 0,
              rxUtilization: 0,
              txUtilization: 0,
              rxErrors: 0,
              txErrors: 0,
              rxDiscards: 0,
              txDiscards: 0,
            },
          ],
        },
        form.position,
      );
      setPanel(null);
      showToast('Equipamento adicionado localmente');
    },
  });

  const existingMutation = useMutation({
    mutationFn: async () => {
      if (!map) throw new Error('Mapa não carregado');
      const result = await addHostsToMap(map.id, selected, {
        x: 520 + (map.nodes.length % 5) * 110,
        y: 320 + (map.nodes.length % 4) * 90,
      });
      return result;
    },
    onSuccess: (result) => {
      result.created.forEach(({ device, node }) => {
        addDeviceToStore(device, node.position, node);
      });
      setPanel(null);
      showToast(
        result.created.length > 0
          ? `${result.created.length} host${result.created.length > 1 ? 's' : ''} adicionado${result.created.length > 1 ? 's' : ''} ao mapa`
          : 'Nenhum host foi adicionado',
      );
    },
    onError: () => {
      setPanel(null);
      showToast('Não foi possível adicionar os hosts selecionados');
    },
  });

  const types: DeviceType[] = [
    'core',
    'router',
    'switch',
    'aggregation',
    'edge',
    'olt',
    'firewall',
    'server',
    'generic',
  ];

  return (
    <PanelShell eyebrow="EDITOR MANUAL" title="Adicionar equipamento">
      <div className="panel-body">
        <div className="segmented-control" role="tablist" aria-label="Tipo de equipamento">
          <button
            type="button"
            className={mode === 'existing' ? 'is-active' : ''}
            onClick={() => setMode('existing')}
          >
            Host existente
          </button>
          <button
            type="button"
            className={mode === 'manual' ? 'is-active' : ''}
            onClick={() => setMode('manual')}
          >
            Novo manual
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="existing-host-picker">
            <label className="hosts-search hosts-search--compact">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar hostname, IP, fabricante…"
              />
            </label>

            <div className="host-selection-toolbar">
              <button
                type="button"
                className="tiny-button"
                onClick={() =>
                  setSelected(
                    selected.length === filteredHosts.length ? [] : filteredHosts.map((host) => host.id),
                  )
                }
              >
                {selected.length === filteredHosts.length ? 'Desmarcar todos' : 'Selecionar todos'}
              </button>
              <span>{selected.length} selecionado{selected.length === 1 ? '' : 's'}</span>
            </div>

            <div className="host-selection-list">
              {filteredHosts.length === 0 && (
                <div className="hosts-empty hosts-empty--tight">
                  <Network /> Nenhum host disponível no inventário.
                </div>
              )}
              {filteredHosts.map((host) => {
                const checked = selected.includes(host.id);
                return (
                  <label key={host.id} className={`host-select-row ${checked ? 'is-checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(host.id)
                            ? current.filter((id) => id !== host.id)
                            : [...current, host.id],
                        )
                      }
                    />
                    <div>
                      <strong>{host.hostname}</strong>
                      <span>
                        {host.managementIp} · {host.vendor || '—'} · {host.model || '—'}
                      </span>
                    </div>
                    <small>{host.useZabbix ? 'Zabbix' : host.sshEnabled ? 'SSH' : host.snmpEnabled ? 'SNMP' : 'Manual'}</small>
                  </label>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="panel-body form-grid form-grid--device">
            <label>
              Nome
              <input value={form.name} onChange={(event) => update('name', event.target.value)} />
            </label>
            <label>
              Hostname
              <input value={form.hostname} onChange={(event) => update('hostname', event.target.value)} />
            </label>
            <label>
              IP de gestão
              <input value={form.ip} onChange={(event) => update('ip', event.target.value)} />
            </label>
            <label>
              Tipo
              <select value={form.deviceType} onChange={(event) => update('deviceType', event.target.value)}>
                {types.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label>
              Fabricante
              <input
                value={form.vendor}
                onChange={(event) => update('vendor', event.target.value)}
                placeholder="Huawei, Cisco…"
              />
            </label>
            <label>
              Modelo
              <input value={form.model} onChange={(event) => update('model', event.target.value)} />
            </label>
            <label className="span-2">
              Site
              <input value={form.site} onChange={(event) => update('site', event.target.value)} />
            </label>
            <div className="panel-note span-2">
              <Plus size={16} />
              <span>
                O equipamento será criado no centro do viewport e poderá ser movido livremente.
              </span>
            </div>
          </div>
        )}
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        {mode === 'existing' ? (
          <Button
            variant="primary"
            disabled={selected.length === 0 || existingMutation.isPending}
            onClick={() => existingMutation.mutate()}
          >
            <Plus size={15} /> Adicionar selecionados
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!form.name || !form.hostname || !form.ip || manualMutation.isPending}
            onClick={() => manualMutation.mutate()}
          >
            <Plus size={15} /> Adicionar
          </Button>
        )}
      </footer>
    </PanelShell>
  );
}

function DiscoveryPanel() {
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const setPanel = useMapStore((state) => state.setPanel);
  const devices =
    map?.nodes.flatMap((node) => {
      const device = map.devices.find((item) => item.id === node.deviceId);
      return device ? [device] : [];
    }) ?? [];
  const [deviceId, setDeviceId] = useState(
    selection?.kind === 'device' ? selection.id : (devices[0]?.id ?? ''),
  );
  const source = devices.find((device) => device.id === deviceId);
  return (
    <PanelShell eyebrow="TOPOLOGY ENGINE" title="Descoberta assistida">
      <div className="panel-body discovery-panel">
        <div className="discovery-source">
          <div>
            <Radar size={20} />
            <span>
              <small>SEED DEVICE</small>
              <strong>{source?.name ?? 'Selecione'}</strong>
            </span>
          </div>
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          <div className="method-order">
            <Badge tone="info">PREVIEW</Badge>
            <span>SNMP</span>
            <ChevronRight size={12} />
            <span>SSH</span>
          </div>
        </div>
        {source && map ? (
          <AssistedDiscoveryReview host={source} mapId={map.id} onApplied={() => setPanel(null)} />
        ) : (
          <div className="discovery-empty">
            <Radar size={28} />
            <strong>Mapa sem equipamento inicial</strong>
          </div>
        )}
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Fechar
        </Button>
      </footer>
    </PanelShell>
  );
}

function SettingsPanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  return (
    <PanelShell eyebrow="CONFIGURAÇÕES" title="Fontes e modo do mapa">
      <div className="panel-body settings-panel">
        <h3>MODO DO MAPA</h3>
        <div className="mode-options">
          <div>
            <span>MANUAL</span>
            <p>Controle integral do operador.</p>
          </div>
          <div>
            <span>AUTO</span>
            <p>Topologia gerenciada pela descoberta.</p>
          </div>
          <div className="is-active">
            <Check size={15} />
            <span>HYBRID</span>
            <p>Descobre mudanças e preserva ajustes manuais.</p>
          </div>
        </div>
        <h3>FONTES DE DADOS</h3>
        <div className="integration-row">
          <span className="integration-icon">
            <Database size={20} />
          </span>
          <div>
            <strong>Zabbix</strong>
            <small>Métricas e inventário · backend only</small>
          </div>
          <Badge tone="neutral">NÃO CONFIGURADO</Badge>
          <Button compact variant="secondary" disabled>
            Importar hosts
          </Button>
        </div>
        <div className="integration-row">
          <span className="integration-icon">
            <ServerCog size={20} />
          </span>
          <div>
            <strong>LLDP / SNMP</strong>
            <small>Descoberta de topologia · v2c e v3</small>
          </div>
          <Badge tone="info">PREPARADO</Badge>
        </div>
        <div className="integration-row">
          <span className="integration-icon">
            <KeyRound size={20} />
          </span>
          <div>
            <strong>LLDP / SSH</strong>
            <small>Driver Huawei VRP disponível</small>
          </div>
          <Badge tone="info">PREPARADO</Badge>
        </div>
        <div className="panel-note">
          <ShieldCheck size={17} />
          <span>
            Tokens, communities e senhas nunca são enviados ao navegador. O schema armazena apenas
            payloads AES-256-GCM.
          </span>
        </div>
      </div>
      <footer>
        <Button variant="primary" onClick={() => setPanel(null)}>
          Concluído
        </Button>
      </footer>
    </PanelShell>
  );
}

function MapManagerPanel() {
  const maps = useMapStore((state) => state.maps);
  const currentMap = useMapStore((state) => state.map);
  const activeMapId = useMapStore((state) => state.activeMapId);
  const setActiveMap = useMapStore((state) => state.setActiveMap);
  const setMap = useMapStore((state) => state.setMap);
  const upsertMapSummary = useMapStore((state) => state.upsertMapSummary);
  const removeMapSummary = useMapStore((state) => state.removeMapSummary);
  const showToast = useMapStore((state) => state.showToast);
  const setPanel = useMapStore((state) => state.setPanel);
  const [selectedId, setSelectedId] = useState(activeMapId ?? maps[0]?.id ?? '');
  const selected = maps.find((map) => map.id === selectedId);
  const [name, setName] = useState(selected?.name ?? '');
  const [description, setDescription] = useState(selected?.description ?? '');
  const [mode, setMode] = useState<MapMode>(selected?.mode ?? 'HYBRID');
  const [creating, setCreating] = useState<'EMPTY' | 'DUPLICATE' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const item = maps.find((map) => map.id === selectedId);
    if (!item) return;
    setName(item.name);
    setDescription(item.description);
    setMode(item.mode);
  }, [maps, selectedId]);

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await updateNetworkMap(selected.id, { name, description, mode });
      upsertMapSummary(updated);
      if (currentMap?.id === updated.id) setMap(updated);
      showToast('Mapa atualizado');
    } catch {
      showToast('Não foi possível atualizar o mapa');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const created = await createNetworkMap({
        name: name || 'Novo mapa',
        description,
        mode,
        sourceMapId: creating === 'DUPLICATE' ? selectedId || null : null,
      });
      upsertMapSummary(created);
      setMap(created);
      setSelectedId(created.id);
      setCreating(null);
      showToast(creating === 'DUPLICATE' ? 'Mapa duplicado' : 'Mapa vazio criado');
    } catch {
      showToast('API necessária para criar mapas persistentes');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const created = await duplicateNetworkMap(
        selected.id,
        `${selected.name} — Cópia`,
        selected.description,
      );
      upsertMapSummary(created);
      setMap(created);
      setSelectedId(created.id);
      showToast('Mapa duplicado');
    } catch {
      showToast('Não foi possível duplicar o mapa');
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async () => {
    if (!selected) return;
    try {
      const updated = await updateNetworkMap(selected.id, { isDefault: true });
      upsertMapSummary(updated);
      showToast('Mapa padrão atualizado');
    } catch {
      showToast('Não foi possível definir o mapa padrão');
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`Excluir o mapa “${selected.name}”?`)) return;
    try {
      await deleteNetworkMap(selected.id);
      removeMapSummary(selected.id);
      setSelectedId(maps.find((map) => map.id !== selected.id)?.id ?? '');
      showToast('Mapa excluído; equipamentos globais preservados');
    } catch {
      showToast('O último mapa não pode ser excluído');
    }
  };

  return (
    <PanelShell eyebrow="MAP ENGINE" title="Gerenciar mapas">
      <div className="panel-body map-manager">
        <aside className="map-manager__list">
          <div className="map-manager__list-head">
            <span>MAPAS</span>
            <strong>{maps.length}</strong>
          </div>
          {maps.map((item) => (
            <button
              type="button"
              key={item.id}
              className={selectedId === item.id ? 'is-active' : ''}
              onClick={() => {
                setSelectedId(item.id);
                setCreating(null);
              }}
            >
              <MapIcon size={16} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.nodeCount} nodes · {item.linkCount} links
                </small>
              </span>
              {item.isDefault && <Star size={12} />}
            </button>
          ))}
          <Button
            compact
            variant="secondary"
            onClick={() => {
              setCreating('EMPTY');
              setName('Novo mapa');
              setDescription('');
              setMode('HYBRID');
            }}
          >
            <Plus size={14} /> Novo mapa
          </Button>
        </aside>
        <section className="map-manager__editor">
          <div className="map-manager__eyebrow">
            {creating === 'EMPTY'
              ? 'NOVO MAPA VAZIO'
              : creating === 'DUPLICATE'
                ? 'DUPLICAR MAPA'
                : 'PROPRIEDADES'}
          </div>
          <label>
            Nome
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Descrição
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            Modo
            <select value={mode} onChange={(event) => setMode(event.target.value as MapMode)}>
              <option value="MANUAL">Manual</option>
              <option value="AUTO">Auto</option>
              <option value="HYBRID">Hybrid</option>
            </select>
          </label>
          {creating && (
            <div className="map-create-options">
              <button
                type="button"
                className={creating === 'EMPTY' ? 'is-active' : ''}
                onClick={() => setCreating('EMPTY')}
              >
                <Plus size={18} />
                <strong>Mapa vazio</strong>
                <span>Começar sem nodes ou links</span>
              </button>
              <button
                type="button"
                className={creating === 'DUPLICATE' ? 'is-active' : ''}
                onClick={() => setCreating('DUPLICATE')}
              >
                <Copy size={18} />
                <strong>Duplicar atual</strong>
                <span>Copiar topologia e preferências</span>
              </button>
            </div>
          )}
          {!creating && selected && (
            <div className="map-manager__actions">
              <Button
                compact
                variant="ghost"
                onClick={() => {
                  setActiveMap(selected.id);
                  setPanel(null);
                }}
              >
                <MapIcon size={14} /> Abrir
              </Button>
              <Button compact variant="ghost" onClick={() => void duplicate()}>
                <Copy size={14} /> Duplicar
              </Button>
              <Button
                compact
                variant="ghost"
                disabled={selected.isDefault}
                onClick={() => void makeDefault()}
              >
                <Star size={14} /> Tornar padrão
              </Button>
              <Button compact variant="danger" onClick={() => void remove()}>
                <Trash2 size={14} /> Excluir
              </Button>
            </div>
          )}
        </section>
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Fechar
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim() || busy}
          onClick={() => void (creating ? create() : save())}
        >
          {creating ? <Plus size={15} /> : <Pencil size={15} />}
          {creating ? 'Criar mapa' : 'Salvar alterações'}
        </Button>
      </footer>
    </PanelShell>
  );
}

function RotationPanel() {
  const maps = useMapStore((state) => state.maps);
  const startRotation = useMapStore((state) => state.startRotation);
  const setPanel = useMapStore((state) => state.setPanel);
  const [mapIds, setMapIds] = useState(() => maps.map((map) => map.id));
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [hideTopBar, setHideTopBar] = useState(false);
  const [hideControls, setHideControls] = useState(false);
  const [pauseOnInteraction, setPauseOnInteraction] = useState(true);

  const toggle = (mapId: string) =>
    setMapIds((current) =>
      current.includes(mapId) ? current.filter((id) => id !== mapId) : [...current, mapId],
    );
  const move = (mapId: string, offset: number) =>
    setMapIds((current) => {
      const index = current.indexOf(mapId);
      const nextIndex = index + offset;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  const start = () => {
    if (mapIds.length === 0) return;
    startRotation({
      mapIds,
      intervalSeconds,
      hideTopBar,
      hideControls,
      pauseOnInteraction,
    });
    void savePlaylist({
      id: 'noc-main',
      name: 'NOC Principal',
      rotationIntervalSeconds: intervalSeconds,
      mapIds,
      isDefault: true,
    }).catch(() => undefined);
  };

  return (
    <PanelShell eyebrow="PRESENTATION ENGINE" title="NOC Rotation Mode">
      <div className="panel-body rotation-config">
        <section>
          <h3>MAPAS E ORDEM DA ROTAÇÃO</h3>
          <div className="rotation-map-list">
            {maps.map((map) => {
              const order = mapIds.indexOf(map.id);
              return (
                <div key={map.id} className={order >= 0 ? 'is-selected' : ''}>
                  <button type="button" className="rotation-check" onClick={() => toggle(map.id)}>
                    {order >= 0 && <Check size={13} />}
                  </button>
                  <MapIcon size={15} />
                  <span>
                    <strong>{map.name}</strong>
                    <small>{map.description}</small>
                  </span>
                  {order >= 0 && <Badge tone="info">{order + 1}</Badge>}
                  <button type="button" disabled={order <= 0} onClick={() => move(map.id, -1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    disabled={order < 0 || order === mapIds.length - 1}
                    onClick={() => move(map.id, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
        <section className="rotation-options">
          <h3>INTERVALO</h3>
          <select
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value))}
          >
            <option value={30}>30 segundos</option>
            <option value={60}>1 minuto</option>
            <option value={120}>2 minutos</option>
            <option value={300}>5 minutos</option>
            <option value={600}>10 minutos</option>
          </select>
          <h3>APRESENTAÇÃO</h3>
          <ToggleOption
            label="Ocultar barra superior"
            checked={hideTopBar}
            onChange={setHideTopBar}
          />
          <ToggleOption
            label="Ocultar controles do mapa"
            checked={hideControls}
            onChange={setHideControls}
          />
          <ToggleOption
            label="Pausar quando houver interação"
            checked={pauseOnInteraction}
            onChange={setPauseOnInteraction}
          />
        </section>
      </div>
      <footer>
        <span className="rotation-summary">{mapIds.length} mapa(s) selecionado(s)</span>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={mapIds.length === 0} onClick={start}>
          <MonitorPlay size={15} /> Iniciar NOC Mode
        </Button>
      </footer>
    </PanelShell>
  );
}

function ToggleOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-option">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={checked ? 'is-active' : ''}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      {label}
    </label>
  );
}
