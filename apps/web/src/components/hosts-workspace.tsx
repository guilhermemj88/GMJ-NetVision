'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateHostInput,
  DeviceType,
  HostOrigin,
  HostRecord,
  MapSummary,
  SourceKind,
  ZabbixHostCandidate,
} from '@gmj/shared';
import { Badge, Button } from '@gmj/ui';
import {
  Check,
  ChevronRight,
  CirclePlus,
  CloudDownload,
  Edit3,
  LoaderCircle,
  MapPinned,
  Network,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  addHostToMap,
  createHost,
  deleteHost,
  getHosts,
  getMaps,
  importZabbixHosts,
  previewZabbixImport,
  testHostSource,
  updateHost,
} from '@/lib/api';
import { AssistedDiscoveryReview } from './assisted-discovery-review';

type DetailTab = 'overview' | 'interfaces' | 'monitoring' | 'access' | 'discovery';

const deviceTypes: DeviceType[] = [
  'router',
  'switch',
  'core',
  'aggregation',
  'edge',
  'olt',
  'firewall',
  'server',
  'internet',
  'ix',
  'customers',
  'generic',
];

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR') : 'Nunca';
}

function healthClass(host: HostRecord, source: SourceKind): string {
  return `source-pill source-pill--${host.sourceHealth[source].state.toLowerCase()}`;
}

function emptyHost(): CreateHostInput {
  return {
    hostname: '',
    displayName: '',
    managementIp: '',
    vendor: '',
    model: '',
    deviceType: 'generic',
    site: '',
    description: '',
    notes: '',
    origin: 'MANUAL',
    zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
    ssh: { enabled: false, host: '', port: 22, username: '' },
    snmp: {
      enabled: false,
      version: 'SNMP_V2C',
      host: '',
      port: 161,
      username: '',
      securityLevel: 'NO_AUTH_NO_PRIV',
      authProtocol: null,
      privacyProtocol: null,
    },
  };
}

function inputFromHost(host: HostRecord): CreateHostInput {
  return {
    hostname: host.hostname,
    displayName: host.displayName,
    managementIp: host.managementIp,
    vendor: host.vendor,
    model: host.model,
    deviceType: host.deviceType,
    site: host.site,
    description: host.description,
    notes: host.notes,
    origin: host.origin,
    zabbix: {
      enabled: host.useZabbix,
      hostId: host.zabbix?.hostId ?? '',
      hostName: host.zabbix?.hostName ?? '',
      primaryInterfaceId: host.zabbix?.primaryInterfaceId ?? '',
      ip: host.zabbix?.ip ?? '',
    },
    ssh: {
      enabled: host.sshEnabled,
      host: host.ssh?.host ?? host.managementIp,
      port: host.ssh?.port ?? 22,
      username: host.ssh?.username ?? '',
    },
    snmp: {
      enabled: host.snmpEnabled,
      version: host.snmp?.version ?? 'SNMP_V2C',
      host: host.snmp?.host ?? host.managementIp,
      port: host.snmp?.port ?? 161,
      username: host.snmp?.username ?? '',
      securityLevel: host.snmp?.securityLevel ?? 'NO_AUTH_NO_PRIV',
      authProtocol: host.snmp?.authProtocol ?? null,
      privacyProtocol: host.snmp?.privacyProtocol ?? null,
    },
  };
}

export function HostsWorkspace() {
  const client = useQueryClient();
  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: () => getHosts() });
  const mapsQuery = useQuery({ queryKey: ['maps'], queryFn: getMaps });
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState<HostOrigin | 'ALL'>('ALL');
  const [source, setSource] = useState<SourceKind | 'ALL'>('ALL');
  const [sort, setSort] = useState<'hostname' | 'managementIp' | 'vendor' | 'updatedAt'>(
    'hostname',
  );
  const [descending, setDescending] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<HostRecord | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [mapHost, setMapHost] = useState<HostRecord | null>(null);

  const hosts = useMemo(() => {
    const text = search.trim().toLowerCase();
    return [...(hostsQuery.data ?? [])]
      .filter((host) => {
        const matchesText =
          !text ||
          [host.hostname, host.displayName, host.managementIp, host.vendor, host.model, host.site]
            .join(' ')
            .toLowerCase()
            .includes(text);
        const matchesOrigin = origin === 'ALL' || host.origin === origin;
        const matchesSource =
          source === 'ALL' ||
          (source === 'ZABBIX'
            ? host.useZabbix
            : source === 'SSH'
              ? host.sshEnabled
              : host.snmpEnabled);
        return matchesText && matchesOrigin && matchesSource;
      })
      .sort(
        (left, right) =>
          String(left[sort]).localeCompare(String(right[sort]), 'pt-BR', { numeric: true }) *
          (descending ? -1 : 1),
      );
  }, [descending, hostsQuery.data, origin, search, sort, source]);

  const selected = (hostsQuery.data ?? []).find((host) => host.id === selectedId) ?? null;
  const remove = useMutation({
    mutationFn: deleteHost,
    onSuccess: async () => {
      setSelectedId(null);
      await client.invalidateQueries({ queryKey: ['hosts'] });
      await client.invalidateQueries({ queryKey: ['map'] });
    },
  });

  return (
    <main className="hosts-shell">
      <section className="hosts-header">
        <div>
          <span>INVENTÁRIO GLOBAL</span>
          <h1>Hosts</h1>
          <p>Equipamentos monitorados e não monitorados, independentemente dos mapas.</p>
        </div>
        <div className="hosts-header__actions">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            <CloudDownload size={15} /> Importar do Zabbix
          </Button>
          <Button variant="primary" onClick={() => setEditing('new')}>
            <CirclePlus size={15} /> Adicionar host
          </Button>
        </div>
      </section>

      <section className="hosts-filters">
        <label className="hosts-search">
          <Search size={15} />
          <input
            placeholder="Hostname, IP, fabricante, site…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          value={origin}
          onChange={(event) => setOrigin(event.target.value as HostOrigin | 'ALL')}
        >
          <option value="ALL">Todas as origens</option>
          <option value="MANUAL">Manual</option>
          <option value="ZABBIX">Zabbix</option>
          <option value="DISCOVERY">Discovery</option>
          <option value="IMPORTED">Imported</option>
        </select>
        <select
          value={source}
          onChange={(event) => setSource(event.target.value as SourceKind | 'ALL')}
        >
          <option value="ALL">Todas as fontes</option>
          <option value="ZABBIX">Zabbix</option>
          <option value="SSH">SSH</option>
          <option value="SNMP">SNMP</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="hostname">Ordenar: hostname</option>
          <option value="managementIp">Ordenar: IP</option>
          <option value="vendor">Ordenar: fabricante</option>
          <option value="updatedAt">Ordenar: atualização</option>
        </select>
        <button
          type="button"
          className="sort-direction"
          onClick={() => setDescending((value) => !value)}
        >
          {descending ? '↓ DESC' : '↑ ASC'}
        </button>
        <span className="hosts-count">
          {hosts.length} / {hostsQuery.data?.length ?? 0}
        </span>
      </section>

      <section className="hosts-table-wrap">
        <table className="hosts-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Host / gerenciamento</th>
              <th>Identificação</th>
              <th>Origem</th>
              <th>Fontes</th>
              <th>Polling / discovery</th>
              <th>Mapas</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {hosts.map((host) => (
              <tr
                key={host.id}
                onClick={() => setSelectedId(host.id)}
                className={selectedId === host.id ? 'is-selected' : ''}
              >
                <td>
                  <span className={`host-status host-status--${host.status.toLowerCase()}`} />
                  {host.status}
                </td>
                <td>
                  <strong>{host.hostname}</strong>
                  <span>
                    {host.displayName} · {host.managementIp || 'sem IP'}
                  </span>
                </td>
                <td>
                  <strong>
                    {host.vendor || '—'} {host.model}
                  </strong>
                  <span>
                    {host.deviceType} · {host.site || 'sem site'}
                  </span>
                </td>
                <td>
                  <Badge
                    tone={
                      host.origin === 'ZABBIX'
                        ? 'auto'
                        : host.origin === 'DISCOVERY'
                          ? 'hybrid'
                          : 'manual'
                    }
                  >
                    {host.origin}
                  </Badge>
                </td>
                <td>
                  <div className="source-stack">
                    <span className={healthClass(host, 'ZABBIX')}>ZBX</span>
                    <span className={healthClass(host, 'SSH')}>SSH</span>
                    <span className={healthClass(host, 'SNMP')}>SNMP</span>
                  </div>
                </td>
                <td>
                  <span>{dateText(host.lastPollingAt)}</span>
                  <small>{dateText(host.lastDiscoveryAt)}</small>
                </td>
                <td>
                  <strong>{host.mapCount}</strong>
                </td>
                <td>
                  <button
                    type="button"
                    className="row-quick-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(host.id);
                    }}
                    aria-label={`Abrir detalhes do host ${host.hostname}`}
                  >
                    <ChevronRight size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hostsQuery.isPending && (
          <div className="hosts-empty">
            <LoaderCircle className="spin" /> Carregando inventário…
          </div>
        )}
        {!hostsQuery.isPending && hosts.length === 0 && (
          <div className="hosts-empty">
            <Network /> Nenhum host corresponde aos filtros.
          </div>
        )}
      </section>

      {selected && (
        <HostDetail
          host={selected}
          maps={mapsQuery.data ?? []}
          onClose={() => setSelectedId(null)}
          onEdit={() => setEditing(selected)}
          onMap={() => setMapHost(selected)}
          onDelete={() => {
            if (window.confirm(`Excluir ${selected.hostname} do inventário e dos mapas?`))
              remove.mutate(selected.id);
          }}
        />
      )}
      {editing && (
        <HostForm
          host={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (host) => {
            setEditing(null);
            setSelectedId(host.id);
            await client.invalidateQueries({ queryKey: ['hosts'] });
          }}
        />
      )}
      {importOpen && (
        <ZabbixImport
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            setImportOpen(false);
            await client.invalidateQueries({ queryKey: ['hosts'] });
          }}
        />
      )}
      {mapHost && (
        <AddToMap
          host={mapHost}
          maps={mapsQuery.data ?? []}
          onClose={() => setMapHost(null)}
          onAdded={async () => {
            setMapHost(null);
            await client.invalidateQueries({ queryKey: ['hosts'] });
            await client.invalidateQueries({ queryKey: ['map'] });
          }}
        />
      )}
    </main>
  );
}

function HostDetail({
  host,
  maps,
  onClose,
  onEdit,
  onMap,
  onDelete,
}: {
  host: HostRecord;
  maps: MapSummary[];
  onClose: () => void;
  onEdit: () => void;
  onMap: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [discoveryMap, setDiscoveryMap] = useState(host.mapIds[0] ?? '');
  return (
    <aside className="host-detail">
      <header>
        <div>
          <span>{host.origin}</span>
          <h2>{host.displayName}</h2>
          <p>
            {host.hostname} · {host.managementIp || 'sem IP'}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <nav>
        {(['overview', 'interfaces', 'monitoring', 'access', 'discovery'] as DetailTab[]).map(
          (item) => (
            <button
              type="button"
              key={item}
              className={tab === item ? 'is-active' : ''}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ),
        )}
      </nav>
      <div className="host-detail__body">
        {tab === 'overview' && (
          <>
            <dl className="detail-grid">
              <div>
                <dt>Fabricante</dt>
                <dd>{host.vendor || '—'}</dd>
              </div>
              <div>
                <dt>Modelo</dt>
                <dd>{host.model || '—'}</dd>
              </div>
              <div>
                <dt>Tipo</dt>
                <dd>{host.deviceType}</dd>
              </div>
              <div>
                <dt>Site</dt>
                <dd>{host.site || '—'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{host.status}</dd>
              </div>
              <div>
                <dt>Mapas</dt>
                <dd>{host.mapCount}</dd>
              </div>
            </dl>
            <section className="detail-copy">
              <h3>Descrição</h3>
              <p>{host.description || 'Sem descrição.'}</p>
              <h3>Observações</h3>
              <p>{host.notes || 'Sem observações.'}</p>
            </section>
          </>
        )}
        {tab === 'interfaces' && (
          <div className="interface-list">
            <header>
              <strong>{host.interfaces.length} interfaces</strong>
              <span>Zabbix + SNMP + SSH</span>
            </header>
            {host.interfaces.map((networkInterface) => (
              <article key={networkInterface.id}>
                <div>
                  <strong>{networkInterface.name}</strong>
                  <span>{networkInterface.alias || networkInterface.description}</span>
                </div>
                <dl>
                  <div>
                    <dt>ifIndex</dt>
                    <dd>{networkInterface.ifIndex}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{networkInterface.operStatus}</dd>
                  </div>
                  <div>
                    <dt>Velocidade</dt>
                    <dd>{(networkInterface.speedBps / 1e9).toFixed(1)} Gbps</dd>
                  </div>
                  <div>
                    <dt>Itens</dt>
                    <dd>
                      {
                        [
                          networkInterface.rxItemId,
                          networkInterface.txItemId,
                          networkInterface.statusItemId,
                        ].filter(Boolean).length
                      }
                      /3
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
        {tab === 'monitoring' && (
          <>
            <SourceCards host={host} />
            <dl className="detail-grid">
              <div>
                <dt>Último polling</dt>
                <dd>{dateText(host.lastPollingAt)}</dd>
              </div>
              <div>
                <dt>Atualização</dt>
                <dd>{dateText(host.updatedAt)}</dd>
              </div>
              <div>
                <dt>CPU</dt>
                <dd>{host.cpuPercent?.toFixed(1) ?? '—'}%</dd>
              </div>
              <div>
                <dt>Memória</dt>
                <dd>{host.memoryPercent?.toFixed(1) ?? '—'}%</dd>
              </div>
            </dl>
          </>
        )}
        {tab === 'access' && <AccessPanel host={host} />}
        {tab === 'discovery' && (
          <>
            <label className="discovery-map-select">
              Mapa para expansão
              <select
                value={discoveryMap}
                onChange={(event) => setDiscoveryMap(event.target.value)}
              >
                <option value="">Selecione um mapa</option>
                {maps
                  .filter((map) => host.mapIds.includes(map.id))
                  .map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.name}
                    </option>
                  ))}
              </select>
            </label>
            {discoveryMap ? (
              <AssistedDiscoveryReview host={host} mapId={discoveryMap} />
            ) : (
              <div className="discovery-empty">
                <MapPinned />
                <strong>Host fora do mapa selecionado</strong>
                <p>Adicione o host a um mapa para descobrir a topologia de forma incremental.</p>
              </div>
            )}
          </>
        )}
      </div>
      <footer>
        <Button compact variant="ghost" onClick={onDelete}>
          <Trash2 size={14} /> Excluir
        </Button>
        <Button compact variant="secondary" onClick={onMap}>
          <MapPinned size={14} /> Adicionar ao mapa
        </Button>
        <Button compact variant="primary" onClick={onEdit}>
          <Edit3 size={14} /> Editar
        </Button>
      </footer>
    </aside>
  );
}

function SourceCards({ host }: { host: HostRecord }) {
  return (
    <div className="source-cards">
      {(['ZABBIX', 'SSH', 'SNMP'] as SourceKind[]).map((source) => {
        const health = host.sourceHealth[source];
        return (
          <article key={source} className={healthClass(host, source)}>
            <span>{source}</span>
            <strong>{health.state}</strong>
            <small>
              {health.lastErrorSafe ??
                (health.lastSuccess
                  ? `Sucesso ${dateText(health.lastSuccess)}`
                  : 'Sem teste recente')}
            </small>
          </article>
        );
      })}
    </div>
  );
}

function AccessPanel({ host }: { host: HostRecord }) {
  const [results, setResults] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const test = async (source: 'zabbix' | 'ssh' | 'snmp') => {
    setPending(source);
    try {
      const result = await testHostSource(host.id, source);
      setResults((current) => ({
        ...current,
        [source]: `${result.state}: ${result.message}${result.version ? ` · ${result.version}` : ''}`,
      }));
    } catch {
      setResults((current) => ({ ...current, [source]: 'Falha segura ao testar conexão' }));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="access-list">
      <SourceCards host={host} />
      {(['zabbix', 'ssh', 'snmp'] as const).map((source) => {
        const summary = source === 'zabbix' ? host.zabbix : source === 'ssh' ? host.ssh : host.snmp;
        const enabled =
          source === 'zabbix'
            ? host.useZabbix
            : source === 'ssh'
              ? host.sshEnabled
              : host.snmpEnabled;
        return (
          <article key={source}>
            <div>
              <ServerCog size={17} />
              <strong>{source.toUpperCase()}</strong>
              <span>
                {enabled
                  ? summary
                    ? 'Configurado · segredo protegido'
                    : 'Habilitado'
                  : 'Desabilitado'}
              </span>
            </div>
            <Button
              compact
              variant="ghost"
              disabled={!enabled || pending !== null}
              onClick={() => void test(source)}
            >
              {pending === source ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <ShieldCheck size={13} />
              )}{' '}
              Testar
            </Button>
            {results[source] && <small>{results[source]}</small>}
          </article>
        );
      })}
    </div>
  );
}

function HostForm({
  host,
  onClose,
  onSaved,
}: {
  host: HostRecord | null;
  onClose: () => void;
  onSaved: (host: HostRecord) => void;
}) {
  const [form, setForm] = useState<CreateHostInput>(() =>
    host ? inputFromHost(host) : emptyHost(),
  );
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => (host ? updateHost(host.id, form) : createHost(form)),
    onSuccess: onSaved,
    onError: () =>
      setError('Não foi possível salvar. Verifique os campos e a chave de criptografia.'),
  });
  const basic = (key: keyof CreateHostInput, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="modal-backdrop">
      <section className="host-form-modal">
        <header>
          <div>
            <span>{host ? 'EDITAR HOST' : 'NOVO HOST'}</span>
            <h2>{host?.hostname ?? 'Cadastro manual'}</h2>
          </div>
          <button type="button" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="host-form-scroll">
          <fieldset>
            <legend>Identificação</legend>
            <div className="form-grid host-form-grid">
              <label>
                Hostname
                <input
                  required
                  value={form.hostname}
                  onChange={(event) => basic('hostname', event.target.value)}
                />
              </label>
              <label>
                Nome amigável
                <input
                  required
                  value={form.displayName}
                  onChange={(event) => basic('displayName', event.target.value)}
                />
              </label>
              <label>
                IP de gerenciamento
                <input
                  value={form.managementIp}
                  onChange={(event) => basic('managementIp', event.target.value)}
                />
              </label>
              <label>
                Fabricante
                <input
                  value={form.vendor}
                  onChange={(event) => basic('vendor', event.target.value)}
                />
              </label>
              <label>
                Modelo
                <input
                  value={form.model}
                  onChange={(event) => basic('model', event.target.value)}
                />
              </label>
              <label>
                Tipo
                <select
                  value={form.deviceType}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      deviceType: event.target.value as DeviceType,
                    }))
                  }
                >
                  {deviceTypes.map((type) => (
                    <option value={type} key={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Site
                <input value={form.site} onChange={(event) => basic('site', event.target.value)} />
              </label>
              <label>
                Origem
                <select
                  value={form.origin}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, origin: event.target.value as HostOrigin }))
                  }
                >
                  <option>MANUAL</option>
                  <option>ZABBIX</option>
                  <option>DISCOVERY</option>
                  <option>IMPORTED</option>
                </select>
              </label>
              <label className="form-span-2">
                Descrição
                <textarea
                  value={form.description}
                  onChange={(event) => basic('description', event.target.value)}
                />
              </label>
              <label className="form-span-2">
                Observações
                <textarea
                  value={form.notes}
                  onChange={(event) => basic('notes', event.target.value)}
                />
              </label>
            </div>
          </fieldset>
          <AccessField
            title="Zabbix"
            enabled={form.zabbix.enabled}
            onToggle={(enabled) =>
              setForm((current) => ({ ...current, zabbix: { ...current.zabbix, enabled } }))
            }
          >
            <label>
              Host ID
              <input
                value={form.zabbix.hostId}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    zabbix: { ...current.zabbix, hostId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              Nome no Zabbix
              <input
                value={form.zabbix.hostName}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    zabbix: { ...current.zabbix, hostName: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              Interface ID principal
              <input
                value={form.zabbix.primaryInterfaceId}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    zabbix: { ...current.zabbix, primaryInterfaceId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              IP no Zabbix
              <input
                value={form.zabbix.ip}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    zabbix: { ...current.zabbix, ip: event.target.value },
                  }))
                }
              />
            </label>
          </AccessField>
          <AccessField
            title="SSH"
            enabled={form.ssh.enabled}
            onToggle={(enabled) =>
              setForm((current) => ({ ...current, ssh: { ...current.ssh, enabled } }))
            }
          >
            <label>
              Host
              <input
                value={form.ssh.host}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ssh: { ...current.ssh, host: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              Porta
              <input
                type="number"
                value={form.ssh.port}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ssh: { ...current.ssh, port: Number(event.target.value) },
                  }))
                }
              />
            </label>
            <label>
              Usuário
              <input
                value={form.ssh.username}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ssh: { ...current.ssh, username: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                placeholder={
                  host?.ssh?.credentialConfigured ? '•••••••• (mantida)' : 'Não configurada'
                }
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ssh: {
                      ...current.ssh,
                      ...(event.target.value ? { password: event.target.value } : {}),
                    },
                  }))
                }
              />
            </label>
          </AccessField>
          <AccessField
            title="SNMP"
            enabled={form.snmp.enabled}
            onToggle={(enabled) =>
              setForm((current) => ({ ...current, snmp: { ...current.snmp, enabled } }))
            }
          >
            <label>
              Versão
              <select
                value={form.snmp.version}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    snmp: {
                      ...current.snmp,
                      version: event.target.value as 'SNMP_V2C' | 'SNMP_V3',
                    },
                  }))
                }
              >
                <option value="SNMP_V2C">v2c</option>
                <option value="SNMP_V3">v3</option>
              </select>
            </label>
            <label>
              Host
              <input
                value={form.snmp.host}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    snmp: { ...current.snmp, host: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              Porta
              <input
                type="number"
                value={form.snmp.port}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    snmp: { ...current.snmp, port: Number(event.target.value) },
                  }))
                }
              />
            </label>
            {form.snmp.version === 'SNMP_V2C' ? (
              <label>
                Community
                <input
                  type="password"
                  placeholder={
                    host?.snmp?.credentialConfigured ? '•••••••• (mantida)' : 'Não configurada'
                  }
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      snmp: {
                        ...current.snmp,
                        ...(event.target.value ? { community: event.target.value } : {}),
                      },
                    }))
                  }
                />
              </label>
            ) : (
              <>
                <label>
                  Usuário
                  <input
                    value={form.snmp.username}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: { ...current.snmp, username: event.target.value },
                      }))
                    }
                  />
                </label>
                <label>
                  Nível
                  <select
                    value={form.snmp.securityLevel}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: {
                          ...current.snmp,
                          securityLevel: event.target.value as typeof current.snmp.securityLevel,
                        },
                      }))
                    }
                  >
                    <option value="NO_AUTH_NO_PRIV">noAuth/noPriv</option>
                    <option value="AUTH_NO_PRIV">auth/noPriv</option>
                    <option value="AUTH_PRIV">auth/priv</option>
                  </select>
                </label>
                <label>
                  Protocolo auth
                  <select
                    value={form.snmp.authProtocol ?? ''}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: {
                          ...current.snmp,
                          authProtocol: event.target.value
                            ? (event.target.value as 'MD5' | 'SHA' | 'SHA256')
                            : null,
                        },
                      }))
                    }
                  >
                    <option value="">Nenhum</option>
                    <option value="MD5">MD5</option>
                    <option value="SHA">SHA</option>
                    <option value="SHA256">SHA-256</option>
                  </select>
                </label>
                <label>
                  Senha auth
                  <input
                    type="password"
                    placeholder="••••••••"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: {
                          ...current.snmp,
                          ...(event.target.value ? { authPassword: event.target.value } : {}),
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  Protocolo priv
                  <select
                    value={form.snmp.privacyProtocol ?? ''}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: {
                          ...current.snmp,
                          privacyProtocol: event.target.value
                            ? (event.target.value as 'DES' | 'AES' | 'AES256')
                            : null,
                        },
                      }))
                    }
                  >
                    <option value="">Nenhum</option>
                    <option value="DES">DES</option>
                    <option value="AES">AES</option>
                    <option value="AES256">AES-256</option>
                  </select>
                </label>
                <label>
                  Senha priv
                  <input
                    type="password"
                    placeholder="••••••••"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        snmp: {
                          ...current.snmp,
                          ...(event.target.value ? { privacyPassword: event.target.value } : {}),
                        },
                      }))
                    }
                  />
                </label>
              </>
            )}
          </AccessField>
        </div>
        {error && <div className="form-error">{error}</div>}
        <footer>
          <span>
            <ShieldCheck size={13} /> Segredos são criptografados e nunca retornados pela API.
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!form.hostname || !form.displayName || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircle className="spin" size={14} />} Salvar host
          </Button>
        </footer>
      </section>
    </div>
  );
}

function AccessField({
  title,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={enabled ? 'access-field is-enabled' : 'access-field'}>
      <legend>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span />
          {title}
        </label>
        <small>{enabled ? 'Habilitado' : 'Desabilitado'}</small>
      </legend>
      {enabled && <div className="form-grid host-form-grid">{children}</div>}
    </fieldset>
  );
}

function ZabbixImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const preview = useQuery({
    queryKey: ['zabbix-import-preview'],
    queryFn: previewZabbixImport,
    staleTime: 0,
  });
  const [search, setSearch] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () =>
      (preview.data?.hosts ?? []).filter(
        (host) =>
          (!onlyNew || !host.alreadyRegistered) &&
          [host.hostname, host.displayName, host.managementIp, host.vendor]
            .join(' ')
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [onlyNew, preview.data, search],
  );
  const mutation = useMutation({
    mutationFn: () => importZabbixHosts(preview.data!.id, [...selected]),
    onSuccess: onImported,
  });
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="modal-backdrop">
      <section className="zabbix-import">
        <header>
          <div>
            <span>PREVIEW · ZABBIX {preview.data?.version}</span>
            <h2>Importar hosts</h2>
            <p>Somente a seleção entrará no inventário. Nenhum mapa será alterado.</p>
          </div>
          <button type="button" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="import-tools">
          <label>
            <Search size={14} />
            <input
              placeholder="Pesquisar no Zabbix…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={onlyNew}
              onChange={(event) => setOnlyNew(event.target.checked)}
            />{' '}
            Apenas não cadastrados
          </label>
          <Button
            compact
            variant="ghost"
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current);
                visible.forEach((host) => next.add(host.hostId));
                return next;
              })
            }
          >
            Selecionar todos visíveis
          </Button>
        </div>
        <div className="import-list">
          {preview.isPending && (
            <div className="hosts-empty">
              <LoaderCircle className="spin" /> Consultando host.get e item.get…
            </div>
          )}
          {preview.isError && (
            <div className="hosts-empty">Falha segura ao consultar o Zabbix.</div>
          )}
          {visible.map((host) => (
            <ImportRow
              key={host.hostId}
              host={host}
              checked={selected.has(host.hostId)}
              onToggle={() => toggle(host.hostId)}
            />
          ))}
        </div>
        <footer>
          <span>{selected.size} selecionado(s)</span>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!preview.data || selected.size === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <CloudDownload size={14} />
            )}{' '}
            Importar selecionados
          </Button>
        </footer>
      </section>
    </div>
  );
}

function ImportRow({
  host,
  checked,
  onToggle,
}: {
  host: ZabbixHostCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={host.alreadyRegistered ? 'import-row is-registered' : 'import-row'}>
      <input
        type="checkbox"
        checked={checked}
        disabled={host.alreadyRegistered}
        onChange={onToggle}
      />
      <span className="import-row__check">{checked && <Check size={13} />}</span>
      <div>
        <strong>{host.hostname}</strong>
        <span>{host.displayName}</span>
      </div>
      <dl>
        <div>
          <dt>IP</dt>
          <dd>{host.managementIp || '—'}</dd>
        </div>
        <div>
          <dt>Fabricante</dt>
          <dd>{host.vendor || '—'}</dd>
        </div>
        <div>
          <dt>Interfaces</dt>
          <dd>{host.interfaceCount}</dd>
        </div>
      </dl>
      <Badge tone={host.alreadyRegistered ? 'manual' : 'auto'}>
        {host.alreadyRegistered ? 'JÁ CADASTRADO' : 'NOVO'}
      </Badge>
    </label>
  );
}

function AddToMap({
  host,
  maps,
  onClose,
  onAdded,
}: {
  host: HostRecord;
  maps: MapSummary[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const available = maps.filter((map) => !host.mapIds.includes(map.id));
  const [mapId, setMapId] = useState(available[0]?.id ?? '');
  const mutation = useMutation({
    mutationFn: () =>
      addHostToMap(host.id, mapId, { x: 480 + host.mapCount * 40, y: 360 + host.mapCount * 40 }),
    onSuccess: onAdded,
  });
  return (
    <div className="modal-backdrop">
      <section className="compact-modal">
        <header>
          <MapPinned />
          <div>
            <span>MAP NODE</span>
            <h2>Adicionar {host.hostname}</h2>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label>
          Mapa existente
          <select value={mapId} onChange={(event) => setMapId(event.target.value)}>
            <option value="">Selecione</option>
            {available.map((map) => (
              <option key={map.id} value={map.id}>
                {map.name}
              </option>
            ))}
          </select>
        </label>
        <p>Será criada apenas a presença visual do host. O inventário global não será duplicado.</p>
        <footer>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!mapId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <MapPinned size={14} /> Adicionar ao mapa
          </Button>
        </footer>
      </section>
    </div>
  );
}
