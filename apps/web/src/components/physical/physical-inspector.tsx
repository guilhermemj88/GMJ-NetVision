'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CreatePhysicalConnectionInput,
  CreatePhysicalModuleInput,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnectionMedium,
  PhysicalInventory,
  PhysicalPath,
  PhysicalPort,
  UpdatePhysicalConnectionInput,
  UpdatePhysicalPortInput,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import {
  Cable,
  CircleAlert,
  CircleDot,
  Eraser,
  Link2,
  LocateFixed,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { classifyPhysicalInterface } from '@gmj/shared';
import { getHost } from '@/lib/api';
import { PORT_STATE_LABELS, friendlySlotLabel } from './physical-catalog';
import { PhysicalConnectionForm } from './physical-connection-form';
import { indexCatalogPorts } from './physical-panel-layout';
import { physicalPortNameView } from './physical-port-name';
import { buildPhysicalLldpGhosts, type PhysicalLldpGhost } from './physical-lldp';
import type { PhysicalSelection } from './physical-types';

function locateAsset(inventory: PhysicalInventory, id: string): PhysicalAsset | null {
  return (
    inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .find((asset) => asset.id === id) ?? null
  );
}

function locatePort(
  inventory: PhysicalInventory,
  id: string,
): { port: PhysicalPort; asset: PhysicalAsset; rackName: string; siteName: string } | null {
  for (const site of inventory.sites) {
    for (const rack of site.racks) {
      for (const asset of rack.assets) {
        const port = asset.ports.find((candidate) => candidate.id === id);
        if (port) return { port, asset, rackName: rack.name, siteName: site.name };
      }
    }
  }
  return null;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="physical-fact">
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );
}

interface Props {
  inventory: PhysicalInventory;
  selection: PhysicalSelection;
  path: PhysicalPath | null;
  /** Catálogo atual (papéis dos slots para rótulos amigáveis). */
  catalog?: readonly PhysicalCatalogEntry[];
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onSelectPort: (id: string) => void;
  onUpdateAsset: (id: string, placement: { startU: number; heightU: number }) => void;
  onSyncPorts: (assetId: string) => void;
  onConnect: (input: CreatePhysicalConnectionInput) => void;
  onUpdateConnection: (id: string, input: UpdatePhysicalConnectionInput) => void;
  onDeleteConnection: (id: string) => void;
  onUpdatePort: (portId: string, input: UpdatePhysicalPortInput) => void;
  onInstallModule: (assetId: string, input: CreatePhysicalModuleInput) => void;
  onRemoveModule: (moduleId: string) => void;
  /** Confirma a sugestão com o medium escolhido pelo operador (nunca inferido). */
  onConfirmLldp: (adjacencyId: string, medium: PhysicalConnectionMedium) => void;
  /** Seleciona a sugestão LLDP para o bloco de detalhe dedicado. */
  onSelectLldp?: (adjacencyId: string) => void;
  /** Navega para o POP/rack da ponta remota e seleciona a porta. */
  onNavigateToPort?: (siteId: string, rackId: string, portId: string) => void;
  /** Removes connectors fabricated for logical interfaces (old sync). */
  onReconcilePorts: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
}

const LLDP_MEDIA: readonly PhysicalConnectionMedium[] = [
  'FIBER',
  'COPPER',
  'DAC',
  'AOC',
  'UNKNOWN',
];

/**
 * Bloco de detalhe de uma sugestão LLDP selecionada.
 *
 * Mostra sempre as duas pontas (com "Não resolvido" quando falta mapeamento) e
 * só oferece confirmação quando o par está pronto e sem conflito — o medium é
 * escolhido pelo operador porque o LLDP não informa meio físico.
 */
function LldpSuggestionDetail({
  ghost,
  canEdit,
  busy,
  medium,
  onMediumChange,
  onConfirm,
  onNavigateToPort,
}: {
  ghost: PhysicalLldpGhost;
  canEdit: boolean;
  busy: boolean;
  medium: PhysicalConnectionMedium;
  onMediumChange: (medium: PhysicalConnectionMedium) => void;
  onConfirm: (adjacencyId: string, medium: PhysicalConnectionMedium) => void;
  onNavigateToPort?: ((siteId: string, rackId: string, portId: string) => void) | undefined;
}) {
  const describe = (side: PhysicalLldpGhost['from']) =>
    side
      ? `${side.siteName} / ${side.rackName} / ${side.assetName} / ${side.portName}`
      : 'Não resolvido';
  const canConfirm = ghost.confirmable && canEdit;

  return (
    <>
      <dl className="physical-facts">
        <Field label="Estado" value={ghost.state} />
        <Field label="Confiança" value={ghost.confidence} />
        <Field
          label="Observado em"
          value={new Date(ghost.observedAt).toLocaleString('pt-BR')}
        />
        <Field label="Local" value={describe(ghost.from)} />
        <Field label="Remoto" value={describe(ghost.to)} />
        <Field label="Adjacências" value={ghost.adjacencyIds.join(', ')} />
      </dl>
      <p className="physical-warning">
        <CircleAlert size={12} /> {ghost.reason}
      </p>
      {ghost.conflict !== 'NONE' ? (
        <p className="physical-warning">
          <CircleAlert size={12} /> {ghost.conflictDetail}
        </p>
      ) : null}
      {ghost.to && onNavigateToPort && ghost.to.siteId && ghost.to.rackId ? (
        <Button
          compact
          variant="ghost"
          onClick={() => onNavigateToPort(ghost.to!.siteId, ghost.to!.rackId, ghost.to!.portId)}
        >
          <LocateFixed size={13} /> Ir para a ponta remota
        </Button>
      ) : null}
      <section className="physical-inspector__section">
        <h3>REGISTRAR CABO FÍSICO</h3>
        {canConfirm ? (
          <div className="physical-lldp-confirm">
            <label>
              Medium
              <select
                value={medium}
                onChange={(event) => onMediumChange(event.target.value as PhysicalConnectionMedium)}
              >
                {LLDP_MEDIA.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <Button
              compact
              variant="primary"
              disabled={busy}
              onClick={() => onConfirm(ghost.adjacencyId, medium)}
            >
              <Link2 size={13} /> Confirmar conexão física
            </Button>
            <p className="physical-empty-copy">
              LLDP é evidência: o cabo só passa a existir depois desta confirmação e do 201 da API.
            </p>
          </div>
        ) : (
          <p className="physical-empty-copy">
            {ghost.conflict !== 'NONE'
              ? ghost.conflictDetail
              : 'Confirmação indisponível: é preciso mapear as duas pontas físicas antes.'}
          </p>
        )}
      </section>
    </>
  );
}

export function PhysicalInspector({
  inventory,
  selection,
  path,
  catalog = [],
  canEdit,
  busy,
  onClose,
  onSelectPort,
  onUpdateAsset,
  onSyncPorts,
  onConnect,
  onUpdateConnection,
  onDeleteConnection,
  onUpdatePort,
  onInstallModule,
  onRemoveModule,
  onConfirmLldp,
  onSelectLldp,
  onNavigateToPort,
  onReconcilePorts,
  onDeleteAsset,
}: Props) {
  const asset = selection?.kind === 'asset' ? locateAsset(inventory, selection.id) : null;
  const locatedPort = selection?.kind === 'port' ? locatePort(inventory, selection.id) : null;
  const connection =
    selection?.kind === 'connection'
      ? inventory.connections.find((candidate) => candidate.id === selection.id) ?? null
      : locatedPort?.port.connectionId
        ? inventory.connections.find(
            (candidate) => candidate.id === locatedPort.port.connectionId,
          ) ?? null
        : null;
  const catalogIndex = useMemo(() => {
    const result = new Map<string, ReturnType<typeof indexCatalogPorts>>();
    for (const entry of catalog) result.set(entry.catalogKey, indexCatalogPorts(entry.ports));
    return result;
  }, [catalog]);

  /**
   * Conector do catálogo correspondente à porta persistida. A correlação é por
   * nome (`exact` e depois `loose`), nunca por posição — o mesmo critério já
   * usado pelo desenho do painel.
   */
  const catalogPortFor = (portAsset: PhysicalAsset, port: PhysicalPort) => {
    const ports = portAsset.template?.catalogKey
      ? catalogIndex.get(portAsset.template.catalogKey)
      : undefined;
    return (
      ports?.exact.get(port.name.trim().toLowerCase()) ??
      ports?.loose.get(port.name.trim().toLowerCase().replace(/[\s_.\-/]+/g, '')) ??
      null
    );
  };

  /** Nome apresentado de uma porta pelo `PhysicalPort.id` (interface CLI quando existir). */
  const displayPortName = (portId: string, fallback: string) => {
    const found = locatePort(inventory, portId);
    if (!found) return fallback;
    return physicalPortNameView(found.port, catalogPortFor(found.asset, found.port)).displayName;
  };

  const [startU, setStartU] = useState(1);
  const [heightU, setHeightU] = useState(1);
  /** Medium da confirmação LLDP: escolha do operador, nunca inferida. */
  const [lldpMedium, setLldpMedium] = useState<PhysicalConnectionMedium>('FIBER');

  useEffect(() => {
    if (!asset) return;
    setStartU(asset.startU);
    setHeightU(asset.heightU);
  }, [asset]);

  /** Rascunho de edição da conexão (meio/label/comprimento/observações). */
  const [connectionDraft, setConnectionDraft] = useState<{
    medium: PhysicalConnectionMedium;
    label: string;
    notes: string;
    lengthMeters: string;
  }>({ medium: 'UNKNOWN', label: '', notes: '', lengthMeters: '' });
  const [editingConnection, setEditingConnection] = useState(false);

  const connectionDraftSource = useMemo(
    () =>
      connection
        ? {
            medium: connection.medium,
            label: connection.label,
            notes: connection.notes,
            lengthMeters: connection.lengthMeters === null ? '' : String(connection.lengthMeters),
          }
        : null,
    [connection],
  );

  useEffect(() => {
    setEditingConnection(false);
    if (!connectionDraftSource) return;
    setConnectionDraft(connectionDraftSource);
  }, [connectionDraftSource]);

  const [moduleDrafts, setModuleDrafts] = useState<
    Record<string, { moduleTemplateId: string; name: string }>
  >({});
  const [interfaceId, setInterfaceId] = useState('');
  const [portNotes, setPortNotes] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
  }, [asset?.id]);

  /**
   * Connectors the old sync created for logical interfaces (VLAN, bridge,
   * sub-interface). They are shown as a warning and removed only on demand.
   */
  const logicalPorts = useMemo(
    () =>
      (asset?.ports ?? []).filter(
        (port) =>
          port.mappedInterface &&
          classifyPhysicalInterface(port.mappedInterface.name).classification === 'LOGICAL',
      ),
    [asset],
  );

  useEffect(() => {
    setInterfaceId(locatedPort?.port.mappedInterfaceId ?? '');
    setPortNotes(locatedPort?.port.notes ?? '');
  }, [locatedPort?.port.id, locatedPort?.port.mappedInterfaceId, locatedPort?.port.notes]);

  const deviceQuery = useQuery({
    queryKey: ['physical-device-interfaces', locatedPort?.asset.deviceId ?? ''],
    queryFn: () => getHost(locatedPort?.asset.deviceId as string),
    enabled: canEdit && Boolean(locatedPort?.asset.deviceId),
  });

  /**
   * Sugestões LLDP agrupadas por par físico: as adjacências espelhadas (A→B e
   * B→A) viram um único registro visual, preservando os adjacencyIds originais.
   */
  const lldpGhosts = useMemo(() => buildPhysicalLldpGhosts(inventory), [inventory]);

  const selectedGhost = useMemo<PhysicalLldpGhost | null>(() => {
    if (selection?.kind !== 'lldp') return null;
    return (
      lldpGhosts.find(
        (ghost) =>
          ghost.adjacencyId === selection.id || ghost.adjacencyIds.includes(selection.id),
      ) ?? null
    );
  }, [lldpGhosts, selection]);

  const assetGhosts = useMemo<PhysicalLldpGhost[]>(() => {
    if (!asset) return [];
    return lldpGhosts.filter(
      (ghost) => ghost.from?.assetId === asset.id || ghost.to?.assetId === asset.id,
    );
  }, [asset, lldpGhosts]);

  if (!selection) {
    return (
      <aside className="physical-inspector physical-inspector--empty">
        <CircleDot size={20} />
        <strong>Nada selecionado</strong>
        <p>Selecione um equipamento, uma porta ou um cabo para inspecionar o caminho físico.</p>
      </aside>
    );
  }

  const header = (eyebrow: string, title: string, subtitle?: string) => (
    <header className="physical-inspector__header">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <button type="button" aria-label="Fechar detalhes" onClick={onClose}>
        <X size={16} />
      </button>
    </header>
  );

  if (selection.kind === 'lldp') {
    if (!selectedGhost) {
      return (
        <aside className="physical-inspector physical-inspector--empty">
          <strong>Sugestão LLDP não encontrada</strong>
          <p>Ela pode ter sido confirmada ou substituída por uma coleta mais recente.</p>
        </aside>
      );
    }
    return (
      <aside className="physical-inspector">
        {header(
          'SUGESTÃO LLDP',
          `${displayPortName(
            selectedGhost.from?.portId ?? '',
            selectedGhost.from?.portName ?? selectedGhost.localPortName,
          )} → ${
            selectedGhost.to
              ? displayPortName(selectedGhost.to.portId, selectedGhost.to.portName)
              : 'Não resolvido'
          }`,
          `Estado ${selectedGhost.state} · confiança ${selectedGhost.confidence}`,
        )}
        <LldpSuggestionDetail
          ghost={selectedGhost}
          canEdit={canEdit}
          busy={busy}
          medium={lldpMedium}
          onMediumChange={setLldpMedium}
          onConfirm={onConfirmLldp}
          onNavigateToPort={onNavigateToPort}
        />
      </aside>
    );
  }

  if (asset) {
    return (
      <aside className="physical-inspector">
        {header('EQUIPAMENTO FÍSICO', asset.name, `${asset.kind} · ${asset.heightU}U`)}
        <dl className="physical-facts">
          <Field label="Posição" value={`U${asset.startU}–U${asset.startU + asset.heightU - 1}`} />
          <Field label="Device" value={asset.device?.displayName ?? 'Não vinculado'} />
          <Field label="Modelo" value={asset.template?.model || asset.device?.model || 'Genérico'} />
          <Field
            label="Template"
            value={asset.template ? `${asset.template.name} · ${asset.template.origin}` : 'Sem template'}
          />
          <Field
            label="Portas"
            value={`${asset.ports.filter((port) => port.connectionId).length} / ${asset.ports.length} conectadas`}
          />
          <Field label="Slots" value={asset.slots.length ? `${asset.slots.filter((slot) => slot.module).length} / ${asset.slots.length} ocupados` : '—'} />
        </dl>
        {asset.template && !asset.template.structureConfirmed ? (
          <p className="physical-warning">
            <CircleAlert size={12} /> Estrutura deste modelo não confirmada em documentação oficial: complete alturas e
            portas manualmente.
          </p>
        ) : null}
        {canEdit ? (
          <section className="physical-inspector__section">
            <h3>POSIÇÃO NO RACK</h3>
            <div className="physical-placement-form">
              <label>
                Start U
                <input type="number" min={1} value={startU} onChange={(event) => setStartU(event.target.valueAsNumber)} />
              </label>
              <label>
                Altura
                <input type="number" min={1} value={heightU} onChange={(event) => setHeightU(event.target.valueAsNumber)} />
              </label>
              <Button compact variant="secondary" disabled={busy} onClick={() => onUpdateAsset(asset.id, { startU, heightU })}>
                Salvar
              </Button>
            </div>
            {asset.deviceId ? (
              <Button compact variant="ghost" disabled={busy} onClick={() => onSyncPorts(asset.id)}>
                <RefreshCw size={13} /> Sincronizar portas das interfaces
              </Button>
            ) : null}
            {logicalPorts.length ? (
              <>
                <p className="physical-warning">
                  <CircleAlert size={12} /> {logicalPorts.length} porta(s) vinculadas a interfaces lógicas
                  (VLAN, bridge, sub-interface) — normalmente criadas por uma sincronização antiga.
                </p>
                <Button compact variant="secondary" type="button" disabled={busy} onClick={() => onReconcilePorts(asset.id)}>
                  <Eraser size={13} /> Reconciliar portas lógicas
                </Button>
              </>
            ) : null}
            <Button
              compact
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirmDelete) onDeleteAsset(asset.id);
                else setConfirmDelete(true);
              }}
            >
              <Trash2 size={13} /> {confirmDelete ? 'Confirmar exclusão do equipamento' : 'Excluir equipamento'}
            </Button>
            {confirmDelete ? (
              <p className="physical-form__hint">
                Os cabos precisam ser desconectados antes da exclusão; o Device vinculado é mantido.
              </p>
            ) : null}
          </section>
        ) : null}
        <section className="physical-inspector__section physical-inspector__section--grow">
          <h3>PORTAS</h3>
          <div className="physical-port-list">
            {asset.ports.map((port) => (
              <button key={port.id} type="button" onClick={() => onSelectPort(port.id)}>
                <span className={port.state === 'CONNECTED' ? 'is-connected' : port.state === 'LLDP_DETECTED' ? 'is-lldp' : port.state === 'MAPPED' ? 'is-mapped' : ''} />
                <strong>{physicalPortNameView(port, catalogPortFor(asset, port)).displayName}</strong>
                <small>{port.mappedInterface?.alias || port.label || port.side}</small>
                <em className={`physical-state physical-state--${port.state.toLowerCase()}`}>{PORT_STATE_LABELS[port.state]}</em>
              </button>
            ))}
            {!asset.ports.length ? <p className="physical-empty-copy">Nenhuma porta cadastrada.</p> : null}
          </div>
        </section>
        {asset.slots.length ? (
          <section className="physical-inspector__section">
            <h3>SLOTS E MÓDULOS</h3>
            <div className="physical-slot-rows">
              {asset.slots.map((slot) => {
                const allowed =
                  asset.template?.slots.find((item) => item.index === slot.index)?.moduleKeys ?? [];
                const options = (asset.template?.modules ?? []).filter(
                  (module) => !allowed.length || (module.catalogKey && allowed.includes(module.catalogKey)),
                );
                const draft = moduleDrafts[slot.id] ?? { moduleTemplateId: '', name: '' };
                const chosen = options.find((module) => module.id === draft.moduleTemplateId) ?? null;
                const catalogEntry = asset.template?.catalogKey
                  ? (catalog.find((entry) => entry.catalogKey === asset.template?.catalogKey) ?? null)
                  : null;
                const catalogSlot = catalogEntry?.slots.find((item) => item.index === slot.index) ?? null;
                const slotTitle = friendlySlotLabel(
                  slot.index,
                  catalogSlot?.slotRole ?? null,
                  slot.label,
                );
                return (
                  <div key={slot.id} className={`physical-slot-row ${slot.module ? 'is-occupied' : ''}`}>
                    <header>
                      <strong>{slotTitle}</strong>
                      <small>
                        {slot.module
                          ? `${slot.module.name}${slot.module.model ? ` · ${slot.module.model}` : ''}`
                          : 'Vazio'}
                      </small>
                    </header>
                    {slot.module ? (
                      <div className="physical-slot-row__actions">
                        <span>{slot.module.ports.length} portas</span>
                        {canEdit ? (
                          <Button compact variant="ghost" disabled={busy} onClick={() => onRemoveModule(slot.module?.id ?? '')}>
                            <Unplug size={13} /> Remover placa
                          </Button>
                        ) : null}
                      </div>
                    ) : canEdit ? (
                      <div className="physical-module-form">
                        <select
                          value={draft.moduleTemplateId}
                          aria-label={`Placa do ${slot.label || `slot ${slot.index}`}`}
                          onChange={(event) =>
                            setModuleDrafts((current) => ({
                              ...current,
                              [slot.id]: { ...draft, moduleTemplateId: event.target.value },
                            }))
                          }
                        >
                          <option value="">Placa genérica (informe o nome)</option>
                          {options.map((module) => (
                            <option key={module.id} value={module.id}>
                              {module.name}
                              {module.model ? ` · ${module.model}` : ''}
                            </option>
                          ))}
                        </select>
                        {!draft.moduleTemplateId ? (
                          <input
                            value={draft.name}
                            maxLength={160}
                            placeholder="Nome da placa"
                            aria-label={`Nome da placa do ${slot.label || `slot ${slot.index}`}`}
                            onChange={(event) =>
                              setModuleDrafts((current) => ({
                                ...current,
                                [slot.id]: { ...draft, name: event.target.value },
                              }))
                            }
                          />
                        ) : null}
                        <Button
                          compact
                          variant="secondary"
                          type="button"
                          disabled={busy || (!draft.moduleTemplateId && !draft.name.trim())}
                          onClick={() =>
                            onInstallModule(asset.id, {
                              slotId: slot.id,
                              moduleTemplateId: draft.moduleTemplateId || null,
                              name: chosen?.name ?? draft.name.trim(),
                              ...(chosen?.model ? { model: chosen.model } : {}),
                            })
                          }
                        >
                          <Plug size={13} /> Instalar placa
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <section className="physical-inspector__section">
          <h3>SUGESTÕES LLDP</h3>
          {assetGhosts.length ? (
            <ul className="physical-lldp-list">
              {assetGhosts.map((ghost) => {
                const relatedSide = ghost.from?.assetId === asset.id ? ghost.from : ghost.to;
                const otherSide = ghost.from?.assetId === asset.id ? ghost.to : ghost.from;
                return (
                  <li
                    key={ghost.key}
                    className={[
                      'physical-lldp',
                      `physical-lldp--${ghost.state.toLowerCase()}`,
                      ghost.conflict !== 'NONE' ? 'is-conflict' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <button
                      type="button"
                      className="physical-lldp__open"
                      onClick={() => onSelectLldp?.(ghost.adjacencyId)}
                    >
                      <strong>
                        {relatedSide
                          ? displayPortName(relatedSide.portId, relatedSide.portName)
                          : ghost.localPortName}{' '}
                        →{' '}
                        {otherSide
                          ? `${otherSide.assetName} / ${displayPortName(
                              otherSide.portId,
                              otherSide.portName,
                            )}`
                          : `${ghost.remoteHostname} / ${ghost.remotePortName}`}
                      </strong>
                      <small>
                        {ghost.state} · {ghost.confidence} ·{' '}
                        {new Date(ghost.observedAt).toLocaleString('pt-BR')}
                      </small>
                      <small>{ghost.conflict !== 'NONE' ? ghost.conflictDetail : ghost.reason}</small>
                    </button>
                    {canEdit && ghost.confirmable ? (
                      <Button
                        compact
                        variant="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => onConfirmLldp(ghost.adjacencyId, 'FIBER')}
                      >
                        <Link2 size={13} /> Confirmar conexão física
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="physical-empty-copy">
              Nenhuma adjacência LLDP para este equipamento. Use o descobrimento LLDP existente na visão de topologia.
            </p>
          )}
        </section>
      </aside>
    );
  }

  if (locatedPort) {
    const { port, asset: portAsset, rackName, siteName } = locatedPort;
    const remote = connection
      ? connection.portAId === port.id
        ? connection.b
        : connection.a
      : null;
    /**
     * Identidade operacional da porta: interface CLI (mapeada ou declarada no
     * catálogo) como nome principal; conector e porta física são detalhe.
     */
    const catalogPorts = portAsset.template?.catalogKey
      ? catalogIndex.get(portAsset.template.catalogKey)
      : undefined;
    const catalogPort =
      catalogPorts?.exact.get(port.name.trim().toLowerCase()) ??
      catalogPorts?.loose.get(port.name.trim().toLowerCase().replace(/[\s_.\-/]+/g, '')) ??
      null;
    const naming = physicalPortNameView(port, catalogPort);
    return (
      <aside className="physical-inspector">
        {header('PORTA FÍSICA', `${portAsset.name} / ${naming.displayName}`, `${siteName} · ${rackName}`)}
        <dl className="physical-facts">
          <Field
            label="Estado"
            value={
              <span className={`physical-state physical-state--${port.state.toLowerCase()}`}>
                {PORT_STATE_LABELS[port.state]}
              </span>
            }
          />
          <Field label="Interface" value={naming.interfaceName ?? 'Não mapeada'} />
          <Field
            label="Operacional"
            value={port.mappedInterface ? (
              <span className={`physical-oper physical-oper--${port.mappedInterface.operStatus.toLowerCase()}`}>
                {port.mappedInterface.operStatus}
              </span>
            ) : '—'}
          />
          <Field label="Conector" value={catalogPort?.connector ?? port.type} />
          <Field label="Porta física" value={naming.panelLabel ?? port.name} />
          <Field
            label="Velocidade"
            value={catalogPort?.speeds?.length ? catalogPort.speeds.join(' / ') : '—'}
          />
          <Field label="Lado" value={port.side} />
          <Field label="Origem" value={port.role} />
          <Field
            label="Destino direto"
            value={
              remote
                ? `${remote.assetName} / ${displayPortName(remote.portId, remote.portName)}`
                : 'Porta livre'
            }
          />
        </dl>

        {port.lldp ? (
          <section className="physical-inspector__section">
            <h3>VIZINHO LLDP</h3>
            <dl className="physical-facts">
              <Field label="Remoto" value={`${port.lldp.remoteHostname} / ${port.lldp.remotePortName}`} />
              <Field label="Correlação" value={`${port.lldp.confidence}${port.lldp.ambiguous ? ' (ambígua)' : ''}`} />
              <Field label="Coletado em" value={new Date(port.lldp.observedAt).toLocaleString('pt-BR')} />
            </dl>
            {port.lldp.resolved && !port.lldp.ambiguous ? (
              <p className="physical-form__hint">
                Vínculo sugerido pelo LLDP não cria cabo automaticamente: confirme a conexão física na seção SUGESTÕES
                LLDP do equipamento.
              </p>
            ) : (
              <p className="physical-warning">
                <CircleAlert size={12} /> Adjacência não correlacionada com uma porta física: resolva o vínculo na visão
                de topologia.
              </p>
            )}
          </section>
        ) : null}

        {canEdit ? (
          <section className="physical-inspector__section">
            <h3>VÍNCULO COM INTERFACE</h3>
            <label className="physical-field">
              Interface do Device
              <select
                value={interfaceId}
                onChange={(event) => setInterfaceId(event.target.value)}
                disabled={!portAsset.deviceId || deviceQuery.isLoading}
              >
                <option value="">
                  {portAsset.deviceId ? 'Sem vínculo' : 'Equipamento sem Device vinculado'}
                </option>
                {(deviceQuery.data?.interfaces ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.alias ? ` · ${item.alias}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="physical-field">
              Observações da porta
              <input
                value={portNotes}
                maxLength={2000}
                onChange={(event) => setPortNotes(event.target.value)}
                placeholder="Ex.: fibra para o POP Norte"
              />
            </label>
            <Button
              compact
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={() => onUpdatePort(port.id, { mappedInterfaceId: interfaceId || null, notes: portNotes })}
            >
              Salvar porta
            </Button>
          </section>
        ) : null}

        {path ? (
          <section className="physical-inspector__section">
            <h3>CAMINHO FÍSICO</h3>
            <ol className="physical-path">
              {path.steps.map((step, index) => (
                <li key={`${step.kind}-${index}`} className={`physical-path--${step.kind.toLowerCase()}`}>
                  {step.kind === 'PORT' ? (
                    <>
                      <strong>{step.assetName}</strong>
                      {/* identificação apresentada: interface CLI quando existir */}
                      <span>{displayPortName(step.portId, step.portName)} · {step.side}</span>
                      <small>{step.siteName} / {step.rackName}</small>
                    </>
                  ) : step.kind === 'CABLE' ? (
                    <><Cable size={12} /><span>{step.medium}{step.label ? ` · ${step.label}` : ''}</span></>
                  ) : (
                    <><Link2 size={12} /><span>Pass-through interno · {step.assetName}</span></>
                  )}
                </li>
              ))}
            </ol>
            {path.loopDetected ? <p className="physical-warning">Loop físico detectado; o traçado foi interrompido.</p> : null}
          </section>
        ) : null}

        {!connection && canEdit ? (
          <section className="physical-inspector__section">
            <h3>CONECTAR PORTA</h3>
            <p className="physical-form__hint">
              Escolha POP → Rack → Equipamento → Porta. O LLDP continua sendo apenas sugestão.
            </p>
            <PhysicalConnectionForm
              inventory={inventory}
              sourcePortId={port.id}
              busy={busy}
              onSubmit={(portBId, targetMedium, targetLabel) =>
                onConnect({ portAId: port.id, portBId, medium: targetMedium, label: targetLabel })
              }
            />
          </section>
        ) : null}
      </aside>
    );
  }

  if (connection) {
    const end = (side: 'a' | 'b') => connection[side];
    const navigate = (siteId: string, rackId: string, portId: string) => {
      if (onNavigateToPort) onNavigateToPort(siteId, rackId, portId);
    };
    return (
      <aside className="physical-inspector">
        {header(
          'CONEXÃO FÍSICA',
          `${displayPortName(connection.a.portId, connection.a.portName)} → ${displayPortName(
            connection.b.portId,
            connection.b.portName,
          )}`,
          connection.medium,
        )}
        <section className="physical-connection-ends">
          <div>
            <span>A</span>
            <strong>{connection.a.assetName}</strong>
            <small>
              {displayPortName(connection.a.portId, connection.a.portName)} · {connection.a.siteName}
            </small>
          </div>
          <Link2 size={16} />
          <div>
            <span>B</span>
            <strong>{connection.b.assetName}</strong>
            <small>
              {displayPortName(connection.b.portId, connection.b.portName)} · {connection.b.siteName}
            </small>
          </div>
        </section>
        <section className="physical-inspector__section">
          <h3>ORIGEM</h3>
          <dl className="physical-facts">
            <Field label="POP/Site" value={end('a').siteName} />
            <Field label="Rack" value={end('a').rackName} />
            <Field label="Equipamento" value={end('a').assetName} />
            <Field label="Porta" value={displayPortName(end('a').portId, end('a').portName)} />
          </dl>
          {onNavigateToPort ? (
            <Button
              compact
              variant="ghost"
              disabled={busy}
              onClick={() => navigate(end('a').siteId, end('a').rackId, end('a').portId)}
            >
              <LocateFixed size={13} /> Ir para a origem
            </Button>
          ) : null}
        </section>
        <section className="physical-inspector__section">
          <h3>DESTINO</h3>
          <dl className="physical-facts">
            <Field label="POP/Site" value={end('b').siteName} />
            <Field label="Rack" value={end('b').rackName} />
            <Field label="Equipamento" value={end('b').assetName} />
            <Field label="Porta" value={displayPortName(end('b').portId, end('b').portName)} />
          </dl>
          {onNavigateToPort ? (
            <Button
              compact
              variant="ghost"
              disabled={busy}
              onClick={() => navigate(end('b').siteId, end('b').rackId, end('b').portId)}
            >
              <LocateFixed size={13} /> Ir para o destino
            </Button>
          ) : null}
        </section>
        <section className="physical-inspector__section">
          <h3>DETALHES</h3>
          <dl className="physical-facts">
            <Field label="Meio" value={connection.medium} />
            <Field
              label="Comprimento"
              value={connection.lengthMeters === null ? '—' : `${connection.lengthMeters} m`}
            />
            <Field label="Label" value={connection.label} />
            <Field label="Observações" value={connection.notes} />
          </dl>
        </section>
        {canEdit ? (
          <section className="physical-inspector__section">
            {editingConnection ? (
              <div className="physical-form">
                <div className="physical-form-row">
                  <label className="physical-field">
                    Meio
                    <select
                      value={connectionDraft.medium}
                      onChange={(event) =>
                        setConnectionDraft((current) => ({
                          ...current,
                          medium: event.target.value as PhysicalConnectionMedium,
                        }))
                      }
                    >
                      <option value="UNKNOWN">Não informado</option>
                      <option value="FIBER">Fibra</option>
                      <option value="COPPER">Cobre</option>
                      <option value="DAC">DAC</option>
                      <option value="AOC">AOC</option>
                    </select>
                  </label>
                  <label className="physical-field">
                    Comprimento (m)
                    <input
                      type="number"
                      min={0}
                      value={connectionDraft.lengthMeters}
                      onChange={(event) =>
                        setConnectionDraft((current) => ({
                          ...current,
                          lengthMeters: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <label className="physical-field">
                  Label
                  <input
                    value={connectionDraft.label}
                    maxLength={240}
                    onChange={(event) =>
                      setConnectionDraft((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="physical-field">
                  Observações
                  <input
                    value={connectionDraft.notes}
                    maxLength={2000}
                    onChange={(event) =>
                      setConnectionDraft((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="physical-form-row">
                  <Button
                    compact
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      onUpdateConnection(connection.id, {
                        medium: connectionDraft.medium,
                        label: connectionDraft.label,
                        notes: connectionDraft.notes,
                        lengthMeters:
                          connectionDraft.lengthMeters.trim() === ''
                            ? null
                            : Number(connectionDraft.lengthMeters),
                      })
                    }
                  >
                    Salvar conexão
                  </Button>
                  <Button
                    compact
                    variant="ghost"
                    type="button"
                    onClick={() => setEditingConnection(false)}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                compact
                variant="secondary"
                disabled={busy}
                onClick={() => setEditingConnection(true)}
              >
                <Pencil size={13} /> Editar conexão
              </Button>
            )}
            <Button
              compact
              variant="ghost"
              disabled={busy}
              onClick={() => onDeleteConnection(connection.id)}
            >
              <Unplug size={13} /> Desconectar
            </Button>
          </section>
        ) : null}
      </aside>
    );
  }

  return <aside className="physical-inspector physical-inspector--empty">Item não encontrado.</aside>;
}
