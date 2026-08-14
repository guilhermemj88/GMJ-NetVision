'use client';

import { useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import {
  Check,
  ChevronRight,
  Database,
  KeyRound,
  Link2,
  LoaderCircle,
  Plus,
  Radar,
  ServerCog,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { CreateLinkInput, DeviceType, DiscoveredNeighbor } from '@gmj/shared';
import { addDevice, createLink, discoverNeighbors, type AddDeviceInput } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export function ActionPanels() {
  const panel = useMapStore((state) => state.panel);
  if (panel === 'create-link') return <CreateLinkPanel />;
  if (panel === 'add-device') return <AddDevicePanel />;
  if (panel === 'discovery') return <DiscoveryPanel />;
  if (panel === 'settings') return <SettingsPanel />;
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

function CreateLinkPanel() {
  const map = useMapStore((state) => state.map);
  const pending = useMapStore((state) => state.pendingLink);
  const setPendingLink = useMapStore((state) => state.setPendingLink);
  const setPanel = useMapStore((state) => state.setPanel);
  const addLinkToStore = useMapStore((state) => state.addLink);
  const showToast = useMapStore((state) => state.showToast);
  const devices = map?.devices ?? [];
  const [sourceId, setSourceId] = useState(pending?.sourceDeviceId ?? devices[0]?.id ?? '');
  const [targetId, setTargetId] = useState(pending?.targetDeviceId ?? devices[1]?.id ?? '');
  const source = devices.find((item) => item.id === sourceId);
  const target = devices.find((item) => item.id === targetId);
  const [sourceInterfaceId, setSourceInterfaceId] = useState('');
  const [targetInterfaceId, setTargetInterfaceId] = useState('');
  const [capacity, setCapacity] = useState(100);
  const [label, setLabel] = useState('100G BACKBONE');
  const [metricSource, setMetricSource] = useState<'DEMO' | 'ZABBIX'>('DEMO');

  const input: CreateLinkInput | null =
    source && target
      ? {
          sourceDeviceId: source.id,
          sourceInterfaceId: sourceInterfaceId || source.interfaces[0]?.id || '',
          targetDeviceId: target.id,
          targetInterfaceId: targetInterfaceId || target.interfaces[0]?.id || '',
          capacityBps: capacity * 1_000_000_000,
          label,
          metricSource,
        }
      : null;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!input || !input.sourceInterfaceId || !input.targetInterfaceId)
        throw new Error('Selecione as interfaces');
      return createLink(input);
    },
    onSuccess: (link) => {
      if (input) addLinkToStore(input, link);
      setPendingLink(null);
      setPanel(null);
      showToast('Enlace criado');
    },
    onError: () => {
      if (input?.sourceInterfaceId && input.targetInterfaceId) {
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
                {devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interface
              <select
                value={sourceInterfaceId || source?.interfaces[0]?.id}
                onChange={(event) => setSourceInterfaceId(event.target.value)}
              >
                {source?.interfaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.alias}
                  </option>
                ))}
              </select>
            </label>
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
                {devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interface
              <select
                value={targetInterfaceId || target?.interfaces[0]?.id}
                onChange={(event) => setTargetInterfaceId(event.target.value)}
              >
                {target?.interfaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.alias}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Capacidade
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={capacity}
              onChange={(event) => setCapacity(Number(event.target.value))}
            />
            <small>Gbps</small>
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
        </div>
        <div className="panel-note">
          <ShieldCheck size={16} />
          <span>
            O enlace representa exatamente as duas interfaces selecionadas. A coleta de métricas é
            independente da origem da topologia.
          </span>
        </div>
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={!input || sourceId === targetId || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}{' '}
          Criar link
        </Button>
      </footer>
    </PanelShell>
  );
}

function AddDevicePanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  const addDeviceToStore = useMapStore((state) => state.addDevice);
  const showToast = useMapStore((state) => state.showToast);
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
  const mutation = useMutation({
    mutationFn: () => addDevice(form),
    onSuccess: (device) => {
      addDeviceToStore(device, form.position);
      setPanel(null);
      showToast('Equipamento adicionado');
    },
    onError: () => {
      const timestamp = new Date().toISOString();
      const id = `local-${crypto.randomUUID()}`;
      addDeviceToStore(
        {
          id,
          ...form,
          status: 'UNKNOWN',
          source: 'MANUAL',
          discoveryMethod: 'MANUAL',
          uptimeSeconds: 0,
          updatedAt: timestamp,
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
      <div className="panel-body form-grid form-grid--device">
        <label>
          Nome
          <input value={form.name} onChange={(event) => update('name', event.target.value)} />
        </label>
        <label>
          Hostname
          <input
            value={form.hostname}
            onChange={(event) => update('hostname', event.target.value)}
          />
        </label>
        <label>
          IP de gestão
          <input value={form.ip} onChange={(event) => update('ip', event.target.value)} />
        </label>
        <label>
          Tipo
          <select
            value={form.deviceType}
            onChange={(event) => update('deviceType', event.target.value)}
          >
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
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={!form.name || !form.hostname || !form.ip || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          <Plus size={15} /> Adicionar
        </Button>
      </footer>
    </PanelShell>
  );
}

function DiscoveryPanel() {
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const setPanel = useMapStore((state) => state.setPanel);
  const addLinkToStore = useMapStore((state) => state.addLink);
  const showToast = useMapStore((state) => state.showToast);
  const initialDeviceId =
    selection?.kind === 'device'
      ? selection.id
      : (map?.devices.find((item) => item.id === 'core-01')?.id ?? map?.devices[0]?.id ?? '');
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mutation = useMutation({
    mutationFn: () => discoverNeighbors(deviceId),
    onSuccess: (review) =>
      setSelected(
        new Set(
          review.neighbors.filter((item) => item.matchStatus === 'MATCHED').map((item) => item.id),
        ),
      ),
  });
  const source = map?.devices.find((item) => item.id === deviceId);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const accept = () => {
    if (!map || !source || !mutation.data) return;
    let added = 0;
    mutation.data.neighbors
      .filter((neighbor) => selected.has(neighbor.id) && neighbor.matchedDeviceId)
      .forEach((neighbor) => {
        const target = map.devices.find((item) => item.id === neighbor.matchedDeviceId);
        const sourceInterface =
          source.interfaces.find((item) => item.name === neighbor.localPort) ??
          source.interfaces[0];
        const targetInterface =
          target?.interfaces.find((item) => item.name === neighbor.remotePort) ??
          target?.interfaces[0];
        if (
          !target ||
          !sourceInterface ||
          !targetInterface ||
          map.links.some(
            (link) =>
              (link.sourceDeviceId === source.id && link.targetDeviceId === target.id) ||
              (link.sourceDeviceId === target.id && link.targetDeviceId === source.id),
          )
        )
          return;
        addLinkToStore({
          sourceDeviceId: source.id,
          sourceInterfaceId: sourceInterface.id,
          targetDeviceId: target.id,
          targetInterfaceId: targetInterface.id,
          capacityBps: Math.min(sourceInterface.speedBps, targetInterface.speedBps),
          label: 'LLDP DISCOVERED',
          metricSource: 'DEMO',
        });
        added += 1;
      });
    setPanel(null);
    showToast(added ? `${added} enlace(s) adicionado(s)` : 'Vizinhos já presentes no mapa');
  };
  return (
    <PanelShell eyebrow="TOPOLOGY ENGINE" title="Descobrir vizinhos">
      <div className="panel-body discovery-panel">
        <div className="discovery-source">
          <div>
            <Radar size={20} />
            <span>
              <small>SEED DEVICE</small>
              <strong>{source?.name ?? 'Selecione'}</strong>
            </span>
          </div>
          <select
            value={deviceId}
            onChange={(event) => {
              setDeviceId(event.target.value);
              mutation.reset();
            }}
          >
            {map?.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          <div className="method-order">
            <Badge tone="info">AUTO</Badge>
            <span>SNMP</span>
            <ChevronRight size={12} />
            <span>SSH</span>
            <ChevronRight size={12} />
            <span>Manual</span>
          </div>
          <Button variant="primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Sparkles size={15} />
            )}{' '}
            Consultar LLDP
          </Button>
        </div>
        {!mutation.data && !mutation.isPending && (
          <div className="discovery-empty">
            <Radar size={34} />
            <strong>Pronto para descobrir</strong>
            <span>A consulta normaliza LLDP e mostra sugestões antes de alterar o mapa.</span>
          </div>
        )}
        {mutation.isPending && (
          <div className="discovery-empty">
            <LoaderCircle className="spin" size={30} />
            <strong>Consultando equipamento…</strong>
            <span>SNMP primeiro; SSH como fallback.</span>
          </div>
        )}
        {mutation.data && (
          <div className="neighbor-results">
            <div className="neighbor-results__title">
              <strong>{mutation.data.neighbors.length} vizinhos encontrados</strong>
              <span>Revise antes de adicionar</span>
            </div>
            {mutation.data.neighbors.map((neighbor) => (
              <NeighborRow
                key={neighbor.id}
                neighbor={neighbor}
                selected={selected.has(neighbor.id)}
                sourceName={source?.name ?? ''}
                onToggle={() => toggle(neighbor.id)}
                onRegister={() => {
                  setPanel('add-device');
                }}
              />
            ))}
            {mutation.data.warnings.map((warning) => (
              <small className="discovery-warning" key={warning}>
                {warning}
              </small>
            ))}
          </div>
        )}
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setPanel(null)}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={!mutation.data || selected.size === 0} onClick={accept}>
          <Check size={15} /> Adicionar selecionados ({selected.size})
        </Button>
      </footer>
    </PanelShell>
  );
}

function NeighborRow({
  neighbor,
  selected,
  sourceName,
  onToggle,
  onRegister,
}: {
  neighbor: DiscoveredNeighbor;
  selected: boolean;
  sourceName: string;
  onToggle: () => void;
  onRegister: () => void;
}) {
  return (
    <div className={`neighbor-row ${selected ? 'is-selected' : ''}`}>
      <button
        type="button"
        className="neighbor-check"
        onClick={onToggle}
        disabled={neighbor.matchStatus !== 'MATCHED'}
      >
        {selected && <Check size={13} />}
      </button>
      <div className="neighbor-route">
        <span>
          <strong>{sourceName}</strong>
          <small>{neighbor.localPort}</small>
        </span>
        <Link2 size={16} />
        <span>
          <strong>{neighbor.remoteSystemName}</strong>
          <small>{neighbor.remotePort}</small>
        </span>
      </div>
      <Badge
        tone={
          neighbor.matchStatus === 'MATCHED'
            ? 'up'
            : neighbor.matchStatus === 'AMBIGUOUS'
              ? 'warning'
              : 'neutral'
        }
      >
        {neighbor.matchStatus}
      </Badge>
      {neighbor.matchStatus === 'UNMATCHED' && (
        <Button compact variant="secondary" onClick={onRegister}>
          Cadastrar
        </Button>
      )}
    </div>
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
