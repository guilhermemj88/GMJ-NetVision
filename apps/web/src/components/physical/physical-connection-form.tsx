'use client';

import { useMemo, useState } from 'react';
import type { PhysicalConnectionMedium, PhysicalInventory } from '@gmj/shared';
import { Button } from '@gmj/ui';
import { Link2, Search } from 'lucide-react';

interface Props {
  inventory: PhysicalInventory;
  /** Porta de origem: nunca aparece como destino. */
  sourcePortId: string;
  busy: boolean;
  onSubmit: (portBId: string, medium: PhysicalConnectionMedium, label: string) => void;
}

/**
 * Seleção hierárquica de destino para uma conexão manual:
 * POP/Site → Rack → Equipamento → Porta.
 *
 * Independente do LLDP (sugestão continua sendo sugestão). Portas livres vêm
 * primeiro; ocupadas ficam ocultas por padrão e podem ser exibidas por toggle.
 */
export function PhysicalConnectionForm({ inventory, sourcePortId, busy, onSubmit }: Props) {
  const [siteId, setSiteId] = useState('');
  const [rackId, setRackId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [portId, setPortId] = useState('');
  const [search, setSearch] = useState('');
  const [showOccupied, setShowOccupied] = useState(false);
  const [medium, setMedium] = useState<PhysicalConnectionMedium>('UNKNOWN');
  const [label, setLabel] = useState('');

  const source = useMemo(() => {
    for (const candidateSite of inventory.sites) {
      for (const candidateRack of candidateSite.racks) {
        for (const candidateAsset of candidateRack.assets) {
          if (candidateAsset.ports.some((port) => port.id === sourcePortId)) {
            return {
              siteId: candidateSite.id,
              rackId: candidateRack.id,
              assetId: candidateAsset.id,
            };
          }
        }
      }
    }
    return null;
  }, [inventory, sourcePortId]);

  const site = inventory.sites.find((candidate) => candidate.id === siteId) ?? null;
  const rack = site?.racks.find((candidate) => candidate.id === rackId) ?? null;
  const asset = rack?.assets.find((candidate) => candidate.id === assetId) ?? null;

  const assets = useMemo(() => {
    const list = rack?.assets ?? [];
    const normalized = search.trim().toLocaleLowerCase('pt-BR');
    if (!normalized) return list;
    return list.filter((candidate) =>
      [candidate.name, candidate.device?.hostname, candidate.device?.model, candidate.kind]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('pt-BR')
        .includes(normalized),
    );
  }, [rack, search]);

  const ports = useMemo(() => {
    if (!asset) return [];
    return asset.ports
      .filter((port) => port.id !== sourcePortId)
      .filter((port) => showOccupied || !port.connectionId)
      .sort((left, right) => {
        if (Boolean(left.connectionId) !== Boolean(right.connectionId)) {
          return left.connectionId ? 1 : -1;
        }
        return left.order - right.order;
      });
  }, [asset, showOccupied, sourcePortId]);

  const resetBelow = (level: 'site' | 'rack' | 'asset') => {
    if (level === 'site') {
      setRackId('');
      setAssetId('');
      setPortId('');
    } else if (level === 'rack') {
      setAssetId('');
      setPortId('');
    } else {
      setPortId('');
    }
  };

  const local = Boolean(source && siteId === source.siteId);
  const remoteHint =
    source && site
      ? local
        ? 'Destino no mesmo POP (local)'
        : 'Destino em outro POP (conexão externa)'
      : '';

  return (
    <div className="physical-form">
      <label className="physical-field">
        POP / Site
        <select
          value={siteId}
          aria-label="POP de destino"
          onChange={(event) => {
            setSiteId(event.target.value);
            resetBelow('site');
          }}
        >
          <option value="">Selecione o POP</option>
          {inventory.sites.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="physical-field">
        Rack
        <select
          value={rackId}
          aria-label="Rack de destino"
          disabled={!site}
          onChange={(event) => {
            setRackId(event.target.value);
            resetBelow('rack');
          }}
        >
          <option value="">Selecione o rack</option>
          {(site?.racks ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="physical-field">
        Equipamento
        {rack ? (
          <span className="physical-connection-form__search">
            <Search size={12} />
            <input
              value={search}
              placeholder="Buscar equipamento"
              aria-label="Buscar equipamento de destino"
              onChange={(event) => {
                setSearch(event.target.value);
                setAssetId('');
                setPortId('');
              }}
            />
          </span>
        ) : null}
        <select
          value={assetId}
          aria-label="Equipamento de destino"
          disabled={!rack}
          onChange={(event) => {
            setAssetId(event.target.value);
            resetBelow('asset');
          }}
        >
          <option value="">Selecione o equipamento</option>
          {assets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="physical-field">
        Porta
        <select
          value={portId}
          aria-label="Porta de destino"
          disabled={!asset}
          onChange={(event) => setPortId(event.target.value)}
        >
          <option value="">Selecione a porta</option>
          {ports.map((candidate) => (
            <option key={candidate.id} value={candidate.id} disabled={Boolean(candidate.connectionId)}>
              {candidate.name}
              {candidate.connectionId ? ' (ocupada)' : ' · livre'}
            </option>
          ))}
        </select>
        {asset ? (
          <span className="physical-form__hint">
            {showOccupied ? 'Exibindo portas ocupadas também' : 'Portas ocupadas ocultas'}
          </span>
        ) : null}
      </label>
      <label className="physical-field physical-form__check">
        <input
          type="checkbox"
          checked={showOccupied}
          onChange={(event) => setShowOccupied(event.target.checked)}
        />
        Mostrar portas ocupadas
      </label>
      {remoteHint ? <p className="physical-form__hint">{remoteHint}</p> : null}
      <div className="physical-form-row">
        <label className="physical-field">
          Meio
          <select
            value={medium}
            aria-label="Meio da conexão"
            onChange={(event) =>
              setMedium(event.target.value as PhysicalConnectionMedium)
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
          Label
          <input
            value={label}
            aria-label="Label da conexão"
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Opcional"
          />
        </label>
      </div>
      <Button
        compact
        variant="primary"
        disabled={!portId || busy}
        onClick={() => onSubmit(portId, medium, label)}
      >
        <Link2 size={13} /> Confirmar conexão
      </Button>
    </div>
  );
}
