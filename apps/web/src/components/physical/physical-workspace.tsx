'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhysicalAssetKind } from '@gmj/shared';
import { Button } from '@gmj/ui';
import {
  Cable,
  CirclePlus,
  Eye,
  EyeOff,
  PanelRight,
  Plus,
  Search,
  Server,
  Warehouse,
  X,
} from 'lucide-react';
import { useAuth } from '@/app/providers';
import {
  createPhysicalAsset,
  createPhysicalConnection,
  createPhysicalPort,
  createPhysicalRack,
  createPhysicalSite,
  deletePhysicalConnection,
  getHosts,
  getPhysicalInventory,
  getPhysicalPath,
  pairPhysicalPorts,
  syncPhysicalPorts,
  updatePhysicalAsset,
} from '@/lib/api';
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
  const inventory = inventoryQuery.data;
  const [siteId, setSiteId] = useState('');
  const [rackId, setRackId] = useState('');
  const [selection, setSelection] = useState<PhysicalSelection>(null);
  const [mode, setMode] = useState<PhysicalConnectionMode>('selected');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<CreateDialog>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const site = inventory?.sites.find((candidate) => candidate.id === siteId) ?? inventory?.sites[0];
  const rack = site?.racks.find((candidate) => candidate.id === rackId) ?? site?.racks[0];

  useEffect(() => {
    if (!site) return;
    if (site.id !== siteId) setSiteId(site.id);
    const firstRack = site.racks[0];
    if (firstRack && !site.racks.some((candidate) => candidate.id === rackId)) setRackId(firstRack.id);
  }, [rackId, site, siteId]);

  const selectedPortId = selection?.kind === 'port' ? selection.id : '';
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
      setNotice(error instanceof Error ? error.message : 'Falha ao atualizar o inventário físico');
    } finally {
      setBusy(false);
    }
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

  async function submitAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rack) return;
    const data = new FormData(event.currentTarget);
    const kind = String(data.get('kind')) as PhysicalAssetKind;
    const ports = Number(data.get('ports')) || 0;
    const deviceId = String(data.get('deviceId') ?? '') || null;
    await run(async () => {
      const passive = kind === 'DIO' || kind === 'PATCH_PANEL';
      const created = await createPhysicalAsset(rack.id, {
        name: String(data.get('name')),
        kind,
        startU: Number(data.get('startU')),
        heightU: Number(data.get('heightU')),
        deviceId,
        ...(!passive && ports > 0
          ? { genericPorts: { count: ports, prefix: String(data.get('prefix') ?? '') } }
          : {}),
      });
      if (passive) {
        for (let index = 1; index <= ports; index += 1) {
          const name = String(index).padStart(2, '0');
          const type = kind === 'DIO' ? 'FIBER' as const : 'RJ45' as const;
          const front = await createPhysicalPort(created.id, { name, order: index, side: 'FRONT', type });
          const rear = await createPhysicalPort(created.id, { name, order: index, side: 'REAR', type });
          await pairPhysicalPorts(front.id, rear.id);
        }
      } else if (deviceId && data.get('syncInterfaces') === 'on') {
        await syncPhysicalPorts(created.id);
      }
      return created;
    }, (created) => { setSelection({ kind: 'asset', id: created.id }); setDialog(null); });
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
        </div>
        <div className="physical-mode" aria-label="Exibição de conexões">
          <button type="button" className={mode === 'hidden' ? 'is-active' : ''} onClick={() => setMode('hidden')}><EyeOff size={13} /> Ocultas</button>
          <button type="button" className={mode === 'selected' ? 'is-active' : ''} onClick={() => setMode('selected')}><PanelRight size={13} /> Selecionado</button>
          <button type="button" className={mode === 'all' ? 'is-active' : ''} onClick={() => setMode('all')}><Eye size={13} /> Todas</button>
        </div>
        {canEdit && rack ? <Button compact variant="primary" onClick={() => setDialog('asset')}><CirclePlus size={14} /> Equipamento</Button> : null}
      </header>

      {notice ? <div className="physical-notice" role="alert">{notice}<button type="button" onClick={() => setNotice(null)}><X size={13} /></button></div> : null}

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
          onSyncPorts={(id) => void run(() => syncPhysicalPorts(id))}
          onConnect={(input) => void run(() => createPhysicalConnection(input), (created) => setSelection({ kind: 'connection', id: created.id }))}
          onDeleteConnection={(id) => void run(() => deletePhysicalConnection(id), () => setSelection(null))}
        />
      </div>

      {dialog === 'site' ? <Modal title="Novo POP" onClose={() => setDialog(null)}><form className="physical-form" onSubmit={(event) => void submitSite(event)}><label className="physical-field">Nome<input name="name" required maxLength={120} autoFocus /></label><label className="physical-field">Código<input name="code" maxLength={40} placeholder="Ex.: CTO" /></label><footer><Button compact variant="ghost" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button compact variant="primary" disabled={busy}>Criar POP</Button></footer></form></Modal> : null}
      {dialog === 'rack' && site ? <Modal title={`Novo rack · ${site.name}`} onClose={() => setDialog(null)}><form className="physical-form" onSubmit={(event) => void submitRack(event)}><label className="physical-field">Nome<input name="name" required maxLength={120} autoFocus /></label><label className="physical-field">Unidades U<input name="units" type="number" min={1} max={100} defaultValue={42} required /></label><footer><Button compact variant="ghost" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button compact variant="primary" disabled={busy}>Criar rack</Button></footer></form></Modal> : null}
      {dialog === 'asset' && rack ? <Modal title={`Adicionar equipamento · ${rack.name}`} onClose={() => setDialog(null)}><form className="physical-form" onSubmit={(event) => void submitAsset(event)}><label className="physical-field">Nome<input name="name" required maxLength={160} autoFocus /></label><div className="physical-form-row"><label className="physical-field">Tipo<select name="kind" defaultValue="GENERIC"><option value="GENERIC">Genérico</option><option value="NETWORK">Rede</option><option value="SERVER">Servidor</option><option value="OLT">OLT</option><option value="DIO">DIO</option><option value="PATCH_PANEL">Patch panel</option><option value="POWER">Energia</option></select></label><label className="physical-field">Device real<select name="deviceId" defaultValue=""><option value="">Não vinculado</option>{hostsQuery.data?.map((host) => <option key={host.id} value={host.id}>{host.displayName || host.hostname}</option>)}</select></label></div><div className="physical-form-row"><label className="physical-field">Start U<input name="startU" type="number" min={1} max={rack.units} defaultValue={1} required /></label><label className="physical-field">Altura U<input name="heightU" type="number" min={1} max={rack.units} defaultValue={1} required /></label></div><div className="physical-form-row"><label className="physical-field">Portas / canais<input name="ports" type="number" min={0} max={512} defaultValue={0} /></label><label className="physical-field">Prefixo<input name="prefix" maxLength={40} placeholder="GE, LAN, porta..." /></label></div><label className="physical-check"><input name="syncInterfaces" type="checkbox" /> Sincronizar interfaces do Device após criar</label><p className="physical-form__hint">Para DIO e patch panel, cada canal cria terminações FRONT e REAR pareadas. Nenhum layout de fabricante é presumido.</p><footer><Button compact variant="ghost" type="button" onClick={() => setDialog(null)}>Cancelar</Button><Button compact variant="primary" disabled={busy}>Adicionar ao rack</Button></footer></form></Modal> : null}
    </main>
  );
}
