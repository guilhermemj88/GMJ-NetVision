'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhysicalAsset, PhysicalInterfaceSyncReport } from '@gmj/shared';
import { Button } from '@gmj/ui';
import {
  Cable,
  CirclePlus,
  Eye,
  EyeOff,
  PanelRight,
  Plus,
  Radio,
  Search,
  Server,
  Warehouse,
  X,
} from 'lucide-react';
import { useAuth } from '@/app/providers';
import {
  confirmPhysicalLldp,
  createPhysicalAsset,
  createPhysicalConnection,
  createPhysicalPort,
  createPhysicalRack,
  createPhysicalSite,
  deletePhysicalAsset,
  deletePhysicalConnection,
  getHosts,
  getPhysicalCatalog,
  getPhysicalInventory,
  getPhysicalPath,
  installPhysicalModule,
  pairPhysicalPorts,
  reconcilePhysicalPorts,
  removePhysicalModule,
  syncPhysicalPorts,
  updatePhysicalAsset,
  updatePhysicalPort,
} from '@/lib/api';
import { PhysicalAssetDialog, type PhysicalAssetDialogResult } from './physical-asset-dialog';
import { PORT_STATE_LABELS } from './physical-catalog';
import { PhysicalInspector } from './physical-inspector';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import type { PhysicalConnectionMode, PhysicalSelection } from './physical-types';

type CreateDialog = 'site' | 'rack' | 'asset' | null;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="physical-modal" role="dialog" aria-modal="true" aria-label={title}>
      <button className="physical-modal__backdrop" type="button" onClick={onClose} aria-label="Fechar" />
      <div className="physical-modal__panel">
        <header><div><span>INVENTÁRIO FÍSICO</span><h2>{title}</h2></div><button type="button" onClick={onClose}><X size={16} /></button></header>
        {children}
      </div>
    </div>
  );
}

export function PhysicalWorkspace() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const inventoryQuery = useQuery({ queryKey: ['physical'], queryFn: getPhysicalInventory });
  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: () => getHosts(), enabled: canEdit });
  const catalogQuery = useQuery({ queryKey: ['physical-catalog'], queryFn: getPhysicalCatalog });
  const inventory = inventoryQuery.data;
  const [siteId, setSiteId] = useState('');
  const [rackId, setRackId] = useState('');
  const [selection, setSelection] = useState<PhysicalSelection>(null);
  const [mode, setMode] = useState<PhysicalConnectionMode>('selected');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<CreateDialog>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ level: 'error' | 'warning' | 'info'; message: string } | null>(null);

  const site = inventory?.sites.find((candidate) => candidate.id === siteId) ?? inventory?.sites[0];
  const rack = site?.racks.find((candidate) => candidate.id === rackId) ?? site?.racks[0];

  useEffect(() => {
    if (!site) return;
    if (site.id !== siteId) setSiteId(site.id);
    const firstRack = site.racks[0];
    if (firstRack && !site.racks.some((candidate) => candidate.id === rackId)) setRackId(firstRack.id);
  }, [rackId, site, siteId]);

  const selectedPortId = selection?.kind === 'port' ? selection.id : '';
  /** A Device belongs to a single physical asset: the others are shown disabled. */
  const linkedDeviceIds = useMemo(
    () =>
      (inventory?.sites ?? [])
        .flatMap((candidateSite) => candidateSite.racks)
        .flatMap((candidateRack) => candidateRack.assets)
        .map((asset) => asset.deviceId)
        .filter((id): id is string => Boolean(id)),
    [inventory],
  );
  const pathQuery = useQuery({
    queryKey: ['physical-path', selectedPortId],
    queryFn: () => getPhysicalPath(selectedPortId),
    enabled: Boolean(selectedPortId),
  });

  const searchResults = useMemo(() => {
    if (!inventory || !query.trim()) return [];
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    return inventory.sites.flatMap((candidateSite) =>
      candidateSite.racks.flatMap((candidateRack) =>
        candidateRack.assets.flatMap((asset) => {
          const assetMatch = [asset.name, asset.kind, asset.device?.hostname, asset.device?.model]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase('pt-BR')
            .includes(normalized);
          const matchingPorts = asset.ports.filter((port) =>
            [port.name, port.label, port.mappedInterface?.name, port.mappedInterface?.alias]
              .filter(Boolean)
              .join(' ')
              .toLocaleLowerCase('pt-BR')
              .includes(normalized),
          );
          if (!assetMatch && !matchingPorts.length) return [];
          return [{ site: candidateSite, rack: candidateRack, asset, ports: matchingPorts }];
        }),
      ),
    ).slice(0, 30);
  }, [inventory, query]);

  async function run<T>(task: () => Promise<T>, complete?: (result: T) => void): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await task();
      await queryClient.invalidateQueries({ queryKey: ['physical'] });
      complete?.(result);
    } catch (error) {
      setNotice({ level: 'error', message: error instanceof Error ? error.message : 'Falha ao atualizar o inventário físico' });
    } finally {
      setBusy(false);
    }
  }

  /** Warning notice: the action worked, but something needs the operator's attention. */
  function warn(message: string) {
    setNotice({ level: 'warning', message });
  }

  function describeSync(report: PhysicalInterfaceSyncReport): string {
    const parts = [`${report.mapped} portas mapeadas`];
    if (report.created) parts.push(`${report.created} criadas`);
    if (report.skippedLogical) parts.push(`${report.skippedLogical} interfaces lógicas ignoradas`);
    if (report.skippedByPolicy) parts.push(`${report.skippedByPolicy} mantidas pelo template`);
    if (report.skippedUnknown) parts.push(`${report.skippedUnknown} nomes não reconhecidos ignorados`);
    return parts.join(' · ');
  }

  async function submitSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(
      () => createPhysicalSite({ name: String(data.get('name')), code: String(data.get('code') ?? '') }),
      (created) => { setSiteId(created.id); setRackId(''); setDialog(null); },
    );
  }

  async function submitRack(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!site) return;
    const data = new FormData(event.currentTarget);
    await run(
      () => createPhysicalRack(site.id, { name: String(data.get('name')), units: Number(data.get('units')) }),
      (created) => { setRackId(created.id); setDialog(null); },
    );
  }

  /**
   * Creates the equipment and then, optionally, syncs its interfaces.
   *
   * The create request is never repeated: when the sync fails the asset is kept
   * (already persisted), the selection moves to it and the operator sees a
   * warning instead of a create failure.
   */
  async function submitAsset(result: PhysicalAssetDialogResult) {
    if (!rack) return;
    const { input, passiveChannels, syncInterfaces } = result;
    setBusy(true);
    setNotice(null);
    let created: PhysicalAsset;
    try {
      created = await createPhysicalAsset(rack.id, input);
      if (passiveChannels > 0) {
        const type = input.kind === 'DIO' ? ('FIBER' as const) : ('RJ45' as const);
        for (let index = 1; index <= passiveChannels; index += 1) {
          const name = String(index).padStart(2, '0');
          const front = await createPhysicalPort(created.id, { name, order: index, side: 'FRONT', type });
          const rear = await createPhysicalPort(created.id, { name, order: index, side: 'REAR', type });
          await pairPhysicalPorts(front.id, rear.id);
        }
      }
    } catch (error) {
      setNotice({
        level: 'error',
        message: error instanceof Error ? error.message : 'Falha ao criar o equipamento',
      });
      setBusy(false);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: ['physical'] });
    setSelection({ kind: 'asset', id: created.id });
    setDialog(null);

    if (syncInterfaces) {
      try {
        const report = await syncPhysicalPorts(created.id);
        await queryClient.invalidateQueries({ queryKey: ['physical'] });
        warn(`Equipamento criado. ${describeSync(report)}`);
      } catch (error) {
        warn(
          `Equipamento criado, mas a sincronização de interfaces falhou: ${
            error instanceof Error ? error.message : 'erro desconhecido'
          }. Use “Sincronizar portas das interfaces” para tentar novamente.`,
        );
      }
    }
    setBusy(false);
  }

  async function syncPorts(assetId: string) {
    await run(async () => {
      const report = await syncPhysicalPorts(assetId);
      setNotice(
        report.badPorts.length
          ? {
              level: 'warning',
              message: `Sincronizado (${describeSync(report)}). ${report.badPorts.length} conectores foram criados para interfaces lógicas por uma sincronização antiga e podem ser reconciliados no inspetor.`,
            }
          : { level: 'warning', message: `Interfaces sincronizadas: ${describeSync(report)}` },
      );
      return report;
    });
  }

  async function reconcilePorts(assetId: string) {
    await run(async () => {
      const result = await reconcilePhysicalPorts(assetId);
      setNotice({
        level: result.kept ? 'warning' : 'info',
        message: result.removed
          ? `${result.removed} conector(es) de interfaces lógicas removido(s)${
              result.kept ? `; ${result.kept} mantido(s) por ter cabo` : ''
            }.`
          : 'Nenhum conector lógico removível encontrado.',
      });
      return result;
    });
  }

  function deleteAsset(assetId: string) {
    void run(
      () => deletePhysicalAsset(assetId),
      () => {
        setSelection(null);
        setNotice({ level: 'info', message: 'Equipamento removido. O Device vinculado foi mantido.' });
      },
    );
  }

  function openResult(result: (typeof searchResults)[number], portId?: string) {
    setSiteId(result.site.id);
    setRackId(result.rack.id);
    setSelection(portId ? { kind: 'port', id: portId } : { kind: 'asset', id: result.asset.id });
  }

  if (inventoryQuery.isLoading) {
    return <main className="physical-shell physical-loading"><span className="map-loading__radar" /><strong>Carregando inventário físico</strong></main>;
  }
  if (inventoryQuery.isError || !inventory) {
    return <main className="physical-shell physical-loading"><strong>Falha ao carregar a visão física</strong><Button compact variant="secondary" onClick={() => void inventoryQuery.refetch()}>Tentar novamente</Button></main>;
  }

  return (
    <main className="physical-shell">
      <header className="physical-toolbar">
        <div><span>INFRAESTRUTURA POR POP</span><h1>Físico</h1><p>{site?.name ?? 'Nenhum POP'}{rack ? ` · ${rack.name} · ${rack.units}U` : ''}</p></div>
        <div className="physical-toolbar__summary">
          <span><Server size={13} /> {rack?.assets.length ?? 0} equipamentos</span>
          <span><Cable size={13} /> {inventory.connections.filter((item) => item.a.rackId === rack?.id || item.b.rackId === rack?.id).length} cabos</span>
          <span title={inventory.lldpObservedAt ? `Último LLDP: ${new Date(inventory.lldpObservedAt).toLocaleString('pt-BR')}` : 'Nenhum LLDP coletado'}>
            <Radio size={13} /> {inventory.lldpSuggestions.length} LLDP
          </span>
        </div>
        <div className="physical-legend" aria-label="Legenda de estado das portas">
          {(['FREE', 'MAPPED', 'LLDP_DETECTED', 'CONNECTED'] as const).map((state) => (
            <span key={state} className={`physical-state physical-state--${state.toLowerCase()}`}>
              {PORT_STATE_LABELS[state]}
            </span>
          ))}
        </div>
        <div className="physical-mode" aria-label="Exibição de conexões">
          <button type="button" className={mode === 'hidden' ? 'is-active' : ''} onClick={() => setMode('hidden')}><EyeOff size={13} /> Ocultas</button>
          <button type="button" className={mode === 'selected' ? 'is-active' : ''} onClick={() => setMode('selected')}><PanelRight size={13} /> Selecionado</button>
          <button type="button" className={mode === 'all' ? 'is-active' : ''} onClick={() => setMode('all')}><Eye size={13} /> Todas</button>
        </div>
        {canEdit && rack ? <Button compact variant="primary" onClick={() => setDialog('asset')}><CirclePlus size={14} /> Equipamento</Button> : null}
      </header>

      {notice ? <div className={`physical-notice physical-notice--${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>{notice.message}<button type="button" onClick={() => setNotice(null)}><X size={13} /></button></div> : null}

      <div className="physical-layout">
        <aside className="physical-sidebar">
          <section>
            <div className="physical-sidebar__heading"><span>POP / SITE</span>{canEdit ? <button type="button" onClick={() => setDialog('site')} title="Adicionar POP"><Plus size={14} /></button> : null}</div>
            <select value={site?.id ?? ''} onChange={(event) => { setSiteId(event.target.value); setRackId(''); setSelection(null); }}>
              {inventory.sites.map((item) => <option key={item.id} value={item.id}>{item.name}{item.code ? ` · ${item.code}` : ''}</option>)}
            </select>
          </section>
          <section className="physical-sidebar__racks">
            <div className="physical-sidebar__heading"><span>RACKS</span>{canEdit && site ? <button type="button" onClick={() => setDialog('rack')} title="Adicionar rack"><Plus size={14} /></button> : null}</div>
            {site?.racks.map((item) => (
              <button key={item.id} type="button" className={item.id === rack?.id ? 'is-active' : ''} onClick={() => { setRackId(item.id); setSelection(null); }}>
                <Warehouse size={14} /><span><strong>{item.name}</strong><small>{item.units}U · {item.assets.length} itens</small></span>
              </button>
            ))}
            {site && !site.racks.length ? <p>Nenhum rack neste POP.</p> : null}
          </section>
          <section className="physical-search">
            <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Equipamento ou porta" /></label>
            {query.trim() ? <div className="physical-search__results">{searchResults.map((result) => (
              <div key={result.asset.id}><button type="button" onClick={() => openResult(result)}><strong>{result.asset.name}</strong><small>{result.site.name} / {result.rack.name}</small></button>{result.ports.slice(0, 5).map((port) => <button key={port.id} type="button" className="is-port" onClick={() => openResult(result, port.id)}>{port.name}<small>{port.label || port.side}</small></button>)}</div>
            ))}{!searchResults.length ? <p>Nenhum resultado.</p> : null}</div> : null}
          </section>
        </aside>

        <section className="physical-stage">
          {rack ? (
            <PhysicalRackCanvas
              rack={rack}
              connections={inventory.connections}
              mode={mode}
              selection={selection}
              path={pathQuery.data ?? null}
              onSelectAsset={(id) => setSelection({ kind: 'asset', id })}
              onSelectPort={(id) => setSelection({ kind: 'port', id })}
              onSelectConnection={(id) => setSelection({ kind: 'connection', id })}
              onClear={() => setSelection(null)}
            />
          ) : (
            <div className="physical-stage__empty"><Warehouse size={28} /><strong>{site ? 'Crie o primeiro rack deste POP' : 'Crie o primeiro POP'}</strong>{canEdit ? <Button compact variant="primary" onClick={() => setDialog(site ? 'rack' : 'site')}><Plus size={14} /> {site ? 'Novo rack' : 'Novo POP'}</Button> : null}</div>
          )}
        </section>

        <PhysicalInspector
          inventory={inventory}
          selection={selection}
          path={pathQuery.data ?? null}
          canEdit={canEdit}
          busy={busy}
          onClose={() => setSelection(null)}
          onSelectPort={(id) => setSelection({ kind: 'port', id })}
          onUpdateAsset={(id, placement) => void run(() => updatePhysicalAsset(id, placement))}
          onSyncPorts={(id) => void syncPorts(id)}
          onReconcilePorts={(id) => void reconcilePorts(id)}
          onDeleteAsset={(id) => void deleteAsset(id)}
          onConnect={(input) => void run(() => createPhysicalConnection(input), (created) => setSelection({ kind: 'connection', id: created.id }))}
          onDeleteConnection={(id) => void run(() => deletePhysicalConnection(id), () => setSelection(null))}
          onUpdatePort={(id, input) => void run(() => updatePhysicalPort(id, input))}
          onInstallModule={(assetId, input) => void run(() => installPhysicalModule(assetId, input))}
          onRemoveModule={(moduleId) => void run(() => removePhysicalModule(moduleId))}
          onConfirmLldp={(adjacencyId) =>
            void run(
              () => confirmPhysicalLldp(adjacencyId),
              (created) => setSelection({ kind: 'connection', id: created.id }),
            )
          }
        />
      </div>

      {dialog === 'site' ? <Modal title="Novo POP" onClose={() => setDialog(null)}><form className="physical-form" onSubmit={(event) => void submitSite(event)}><label className="physical-field">Nome<input name="name" required maxLength={120} autoFocus /></label><label className="physical-field">Código<input name="code" maxLength={40} placeholder="Ex.: CTO" /></label><footer><Button compact variant="ghost" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button compact variant="primary" type="submit" disabled={busy}>Criar POP</Button></footer></form></Modal> : null}
      {dialog === 'rack' && site ? <Modal title={`Novo rack · ${site.name}`} onClose={() => setDialog(null)}><form className="physical-form" onSubmit={(event) => void submitRack(event)}><label className="physical-field">Nome<input name="name" required maxLength={120} autoFocus /></label><label className="physical-field">Unidades U<input name="units" type="number" min={1} max={100} defaultValue={42} required /></label><footer><Button compact variant="ghost" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button compact variant="primary" type="submit" disabled={busy}>Criar rack</Button></footer></form></Modal> : null}
      {dialog === 'asset' && rack ? (
        <Modal title={`Adicionar equipamento · ${rack.name}`} onClose={() => setDialog(null)}>
          {catalogQuery.isError ? (
            <p className="physical-form__hint">
              Não foi possível carregar o catálogo de equipamentos. Recarregue a página para tentar novamente.
            </p>
          ) : (
            <PhysicalAssetDialog
              rack={rack}
              hosts={hostsQuery.data ?? []}
              linkedDeviceIds={linkedDeviceIds}
              catalog={catalogQuery.data ?? []}
              busy={busy}
              canSync={canEdit}
              onCancel={() => setDialog(null)}
              onSubmit={(result) => void submitAsset(result)}
            />
          )}
        </Modal>
      ) : null}
    </main>
  );
}
