'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  CreatePhysicalConnectionInput,
  PhysicalAsset,
  PhysicalInventory,
  PhysicalPath,
  PhysicalPort,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import { Cable, CircleDot, Link2, RefreshCw, Unplug, X } from 'lucide-react';
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
          <Field label="Portas" value={`${asset.ports.filter((port) => port.connectionId).length} / ${asset.ports.length} conectadas`} />
        </dl>
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
                <span className={port.connectionId ? 'is-connected' : ''} />
                <strong>{port.name}</strong>
                <small>{port.mappedInterface?.alias || port.label || port.side}</small>
                <em>{port.connectionId ? 'OCUPADA' : 'LIVRE'}</em>
              </button>
            ))}
            {!asset.ports.length ? <p className="physical-empty-copy">Nenhuma porta cadastrada.</p> : null}
          </div>
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
          <Field label="Lado" value={port.side} />
          <Field label="Tipo" value={port.type} />
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
