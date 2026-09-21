'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CreatePhysicalConnectionInput,
  CreatePhysicalModuleInput,
  PhysicalAsset,
  PhysicalInventory,
  PhysicalLldpSuggestion,
  PhysicalPath,
  PhysicalPort,
  UpdatePhysicalPortInput,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import {
  Cable,
  CircleAlert,
  CircleDot,
  Link2,
  Plug,
  RefreshCw,
  Unplug,
  X,
} from 'lucide-react';
import { getHost } from '@/lib/api';
import { PORT_STATE_LABELS } from './physical-catalog';
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
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onSelectPort: (id: string) => void;
  onUpdateAsset: (id: string, placement: { startU: number; heightU: number }) => void;
  onSyncPorts: (assetId: string) => void;
  onConnect: (input: CreatePhysicalConnectionInput) => void;
  onDeleteConnection: (id: string) => void;
  onUpdatePort: (portId: string, input: UpdatePhysicalPortInput) => void;
  onInstallModule: (assetId: string, input: CreatePhysicalModuleInput) => void;
  onRemoveModule: (moduleId: string) => void;
  onConfirmLldp: (adjacencyId: string) => void;
}

export function PhysicalInspector({
  inventory,
  selection,
  path,
  canEdit,
  busy,
  onClose,
  onSelectPort,
  onUpdateAsset,
  onSyncPorts,
  onConnect,
  onDeleteConnection,
  onUpdatePort,
  onInstallModule,
  onRemoveModule,
  onConfirmLldp,
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
  const [startU, setStartU] = useState(1);
  const [heightU, setHeightU] = useState(1);
  const [destinationId, setDestinationId] = useState('');
  const [medium, setMedium] = useState<CreatePhysicalConnectionInput['medium']>('UNKNOWN');
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!asset) return;
    setStartU(asset.startU);
    setHeightU(asset.heightU);
  }, [asset]);

  useEffect(() => {
    setDestinationId('');
    setLabel('');
  }, [locatedPort?.port.id]);

  const [moduleDrafts, setModuleDrafts] = useState<
    Record<string, { moduleTemplateId: string; name: string }>
  >({});
  const [interfaceId, setInterfaceId] = useState('');
  const [portNotes, setPortNotes] = useState('');

  useEffect(() => {
    setInterfaceId(locatedPort?.port.mappedInterfaceId ?? '');
    setPortNotes(locatedPort?.port.notes ?? '');
  }, [locatedPort?.port.id, locatedPort?.port.mappedInterfaceId, locatedPort?.port.notes]);

  const deviceQuery = useQuery({
    queryKey: ['physical-device-interfaces', locatedPort?.asset.deviceId ?? ''],
    queryFn: () => getHost(locatedPort?.asset.deviceId as string),
    enabled: canEdit && Boolean(locatedPort?.asset.deviceId),
  });

  const assetSuggestions = useMemo<PhysicalLldpSuggestion[]>(() => {
    if (!asset) return [];
    return inventory.lldpSuggestions.filter(
      (item) => item.local?.assetId === asset.id || item.remote?.assetId === asset.id,
    );
  }, [asset, inventory.lldpSuggestions]);

  const freeTargets = useMemo(() => {
    if (!locatedPort) return [];
    return inventory.sites.flatMap((site) =>
      site.racks.flatMap((rack) =>
        rack.assets.flatMap((candidateAsset) =>
          candidateAsset.ports
            .filter((port) => !port.connectionId && port.id !== locatedPort.port.id)
            .map((port) => ({
              port,
              label: `${site.name} / ${rack.name} / ${candidateAsset.name} / ${port.name}`,
            })),
        ),
      ),
    );
  }, [inventory, locatedPort]);

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
          </section>
        ) : null}
        <section className="physical-inspector__section physical-inspector__section--grow">
          <h3>PORTAS</h3>
          <div className="physical-port-list">
            {asset.ports.map((port) => (
              <button key={port.id} type="button" onClick={() => onSelectPort(port.id)}>
                <span className={port.state === 'CONNECTED' ? 'is-connected' : port.state === 'LLDP_DETECTED' ? 'is-lldp' : port.state === 'MAPPED' ? 'is-mapped' : ''} />
                <strong>{port.name}</strong>
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
                return (
                  <div key={slot.id} className={`physical-slot-row ${slot.module ? 'is-occupied' : ''}`}>
                    <header>
                      <strong>{slot.label || `Slot ${slot.index}`}</strong>
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
          {assetSuggestions.length ? (
            <ul className="physical-lldp-list">
              {assetSuggestions.map((suggestion) => (
                <li key={suggestion.adjacencyId} className={`physical-lldp physical-lldp--${suggestion.state.toLowerCase()}`}>
                  <div>
                    <strong>
                      {suggestion.local?.portName ?? suggestion.localPortName} →{' '}
                      {suggestion.remote
                        ? `${suggestion.remote.assetName} / ${suggestion.remote.portName}`
                        : `${suggestion.remoteHostname} / ${suggestion.remotePortName}`}
                    </strong>
                    <small>
                      {suggestion.state} · {suggestion.confidence} · {suggestion.reason}
                    </small>
                  </div>
                  {canEdit && suggestion.state === 'READY' ? (
                    <Button compact variant="secondary" type="button" disabled={busy} onClick={() => onConfirmLldp(suggestion.adjacencyId)}>
                      <Link2 size={13} /> Confirmar conexão física
                    </Button>
                  ) : null}
                </li>
              ))}
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
    return (
      <aside className="physical-inspector">
        {header('PORTA FÍSICA', `${portAsset.name} / ${port.name}`, `${siteName} · ${rackName}`)}
        <dl className="physical-facts">
          <Field
            label="Estado"
            value={
              <span className={`physical-state physical-state--${port.state.toLowerCase()}`}>
                {PORT_STATE_LABELS[port.state]}
              </span>
            }
          />
          <Field label="Lado" value={port.side} />
          <Field label="Tipo" value={port.type} />
          <Field label="Origem" value={port.role} />
          <Field label="Interface" value={port.mappedInterface?.name ?? 'Não mapeada'} />
          <Field
            label="Operacional"
            value={port.mappedInterface ? (
              <span className={`physical-oper physical-oper--${port.mappedInterface.operStatus.toLowerCase()}`}>
                {port.mappedInterface.operStatus}
              </span>
            ) : '—'}
          />
          <Field label="Destino direto" value={remote ? `${remote.assetName} / ${remote.portName}` : 'Porta livre'} />
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
                      <span>{step.portName} · {step.side}</span>
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
            <label className="physical-field">
              Destino
              <select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
                <option value="">Selecione uma porta livre</option>
                {freeTargets.map((target) => <option key={target.port.id} value={target.port.id}>{target.label}</option>)}
              </select>
            </label>
            <div className="physical-form-row">
              <label className="physical-field">
                Meio
                <select value={medium} onChange={(event) => setMedium(event.target.value as CreatePhysicalConnectionInput['medium'])}>
                  <option value="UNKNOWN">Não informado</option>
                  <option value="FIBER">Fibra</option>
                  <option value="COPPER">Cobre</option>
                  <option value="DAC">DAC</option>
                  <option value="AOC">AOC</option>
                </select>
              </label>
              <label className="physical-field">
                Label
                <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Opcional" />
              </label>
            </div>
            <Button compact variant="primary" disabled={!destinationId || busy} onClick={() => onConnect({ portAId: port.id, portBId: destinationId, medium, label })}>
              <Link2 size={13} /> Confirmar conexão
            </Button>
          </section>
        ) : null}
      </aside>
    );
  }

  if (connection) {
    return (
      <aside className="physical-inspector">
        {header('CONEXÃO FÍSICA', connection.label || connection.id, connection.medium)}
        <section className="physical-connection-ends">
          <div><span>A</span><strong>{connection.a.assetName}</strong><small>{connection.a.portName} · {connection.a.rackName}</small></div>
          <Link2 size={16} />
          <div><span>B</span><strong>{connection.b.assetName}</strong><small>{connection.b.portName} · {connection.b.rackName}</small></div>
        </section>
        <dl className="physical-facts">
          <Field label="Meio" value={connection.medium} />
          <Field label="Comprimento" value={connection.lengthMeters === null ? '—' : `${connection.lengthMeters} m`} />
          <Field label="Observações" value={connection.notes} />
        </dl>
        {canEdit ? (
          <section className="physical-inspector__section">
            <Button compact variant="secondary" disabled={busy} onClick={() => onDeleteConnection(connection.id)}>
              <Unplug size={13} /> Desconectar
            </Button>
          </section>
        ) : null}
      </aside>
    );
  }

  return <aside className="physical-inspector physical-inspector--empty">Item não encontrado.</aside>;
}
