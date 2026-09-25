'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalPort,
  PhysicalRack,
} from '@gmj/shared';
import { getPhysicalCatalog } from '@/lib/api';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import type { PhysicalSelection } from './physical-types';
import {
  PHYSICAL_TIMESTAMP,
  physicalAsset,
  physicalConnection,
  physicalPort,
  physicalRack,
  physicalTemplate,
} from './physical-fixtures';
import {
  FIXED_FACEPLATE_PROFILE_KEYS,
  fixedFaceplateProfileFor,
} from './fixed-faceplate/fixed-faceplate-profile';

/**
 * Galeria da **biblioteca visual** no Rack Lab (só bancada).
 *
 * Consome o catálogo REAL (`GET /api/physical/catalog`) e monta um rack virtual
 * com um equipamento por SKU migrado, renderizado pelo MESMO
 * `PhysicalRackCanvas` do rack de produção — nenhum renderer paralelo aqui.
 * Contadores, conectores, `groupKey` e nomes continuam vindo do catálogo; a
 * bancada só liga/desliga estados para revisão visual (UP/DOWN, LLDP, interface
 * mapeada e cabo ancorado).
 */

interface GalleryOptions {
  states: boolean;
  lldp: boolean;
  mapped: boolean;
}

interface Gallery {
  rack: PhysicalRack;
  connections: PhysicalConnection[];
  catalog: PhysicalCatalogEntry[];
}

/** Ordem de revisão: Huawei lado a lado, depois os CCR da MikroTik. */
function galleryOrder(entry: PhysicalCatalogEntry): number {
  const profile = fixedFaceplateProfileFor(entry.catalogKey);
  if (!profile) return 99;
  return profile.vendorStyle === 'HUAWEI' ? 0 : 1;
}

function buildGallery(entries: readonly PhysicalCatalogEntry[], options: GalleryOptions): Gallery {
  const selected = entries
    .filter((entry) => FIXED_FACEPLATE_PROFILE_KEYS.includes(entry.catalogKey))
    .sort((left, right) => galleryOrder(left) - galleryOrder(right));

  const assets: PhysicalAsset[] = selected.map((entry, index) => {
    const assetId = `lib-${entry.catalogKey}`;
    const ports: PhysicalPort[] = entry.ports.map((port, portIndex) => {
      const decorations: Partial<PhysicalPort> = {};
      if (options.states && portIndex === 0) {
        decorations.state = 'CONNECTED';
        decorations.connectionId = 'lib-cable';
      }
      if (options.lldp && portIndex === 1) {
        decorations.state = 'LLDP_DETECTED';
        decorations.lldp = {
          adjacencyId: `lib-adj-${portIndex}`,
          remoteHostname: 'SW-SPINE-01',
          remotePortName: 'ge-0/0/1',
          confidence: 'HIGH',
          resolved: true,
          ambiguous: false,
          source: 'LLDP',
          observedAt: PHYSICAL_TIMESTAMP,
        };
      }
      if (options.mapped && portIndex < 3) {
        decorations.state = decorations.state ?? 'MAPPED';
        decorations.mappedInterfaceId = `lib-if-${entry.catalogKey}-${portIndex + 1}`;
        decorations.mappedInterface = {
          id: `lib-if-${entry.catalogKey}-${portIndex + 1}`,
          deviceId: `lib-device-${entry.catalogKey}`,
          name: `GE1/0/${portIndex + 1}`,
          ifIndex: portIndex + 1,
          alias: null,
          operStatus: 'UP' as const,
        };
      }
      return physicalPort({
        id: `${assetId}-${portIndex + 1}`,
        assetId,
        name: port.name,
        label: port.label ?? port.name,
        order: port.order,
        side: 'DEVICE',
        type: port.type,
        ...decorations,
      });
    });
    return physicalAsset({
      id: assetId,
      name: entry.model || entry.name,
      kind: entry.kind,
      startU: index + 1,
      heightU: Math.max(1, entry.heightU),
      templateId: `template-${entry.catalogKey}`,
      template: physicalTemplate({
        id: `template-${entry.catalogKey}`,
        catalogKey: entry.catalogKey,
        name: entry.name,
        category: entry.category,
        manufacturer: entry.manufacturer,
        family: entry.family,
        model: entry.model,
        kind: entry.kind,
        heightU: Math.max(1, entry.heightU),
      }),
      ports,
    });
  });

  const connections: PhysicalConnection[] = [];
  const [first, second] = assets;
  if (options.states && first && second && first.ports[0] && second.ports[0]) {
    connections.push(
      physicalConnection({
        id: 'lib-cable',
        label: 'CIR-BIB-01',
        medium: 'FIBER',
        portAId: first.ports[0].id,
        portBId: second.ports[0].id,
        notes: 'Cabo de bancada entre os dois primeiros SKUs da galeria',
        a: {
          portId: first.ports[0].id,
          portName: first.ports[0].name,
          side: 'DEVICE',
          assetId: first.id,
          assetName: first.name,
          rackId: 'lib-rack',
          rackName: 'Biblioteca fixa',
          siteId: 'lib-site',
          siteName: 'LAB',
        },
        b: {
          portId: second.ports[0].id,
          portName: second.ports[0].name,
          side: 'DEVICE',
          assetId: second.id,
          assetName: second.name,
          rackId: 'lib-rack',
          rackName: 'Biblioteca fixa',
          siteId: 'lib-site',
          siteName: 'LAB',
        },
      }),
    );
  }

  return {
    rack: physicalRack({
      id: 'lib-rack',
      name: 'Biblioteca fixa (catálogo real)',
      units: Math.max(6, assets.length + 2),
      assets,
    }),
    connections,
    catalog: [...entries],
  };
}

export function FixedLibraryGallery() {
  const catalogQuery = useQuery({ queryKey: ['physical-catalog'], queryFn: getPhysicalCatalog });
  const [states, setStates] = useState(true);
  const [lldp, setLldp] = useState(false);
  const [mapped, setMapped] = useState(false);
  const [zoom, setZoom] = useState(0.75);
  const [selection, setSelection] = useState<PhysicalSelection>(null);

  const entries = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const gallery = useMemo(() => buildGallery(entries, { states, lldp, mapped }), [
    entries,
    states,
    lldp,
    mapped,
  ]);
  const migrated = gallery.rack.assets.length;

  return (
    <section className="physical-preview__filters" data-lab="fixed-library">
      <h2 className="physical-preview__section-title">BIBLIOTECA FIXA — CATÁLOGO REAL</h2>
      <p className="physical-preview__status">
        {catalogQuery.isLoading
          ? 'Carregando catálogo…'
          : catalogQuery.isError
            ? 'Catálogo indisponível (a API precisa estar no ar).'
            : `${migrated} SKUs com perfil visual, renderizados pelo MESMO canvas do rack de produção.`}
      </p>
      <div className="physical-preview__filters-row">
        <label className="physical-preview__debug">
          <input
            type="checkbox"
            checked={states}
            onChange={(event) => setStates(event.target.checked)}
          />
          Estado/cabo
        </label>
        <label className="physical-preview__debug">
          <input
            type="checkbox"
            checked={lldp}
            onChange={(event) => setLldp(event.target.checked)}
          />
          LLDP
        </label>
        <label className="physical-preview__debug">
          <input
            type="checkbox"
            checked={mapped}
            onChange={(event) => setMapped(event.target.checked)}
          />
          Interface mapeada
        </label>
        <button type="button" onClick={() => setSelection(null)}>
          Limpar seleção
        </button>
        <label>
          Zoom
          <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
            <option value={0.45}>45%</option>
            <option value={0.55}>55%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
          </select>
        </label>
      </div>
      <div className="physical-preview__filters-row">
        {gallery.rack.assets.slice(0, 6).map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() =>
              setSelection({ kind: 'port', id: asset.ports[0]?.id ?? asset.id })
            }
          >
            Selecionar porta 1 · {asset.name}
          </button>
        ))}
      </div>
      <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <PhysicalRackCanvas
          rack={gallery.rack}
          connections={gallery.connections}
          mode="all"
          selection={selection}
          path={null}
          visualMode="TECHNICAL"
          catalog={gallery.catalog}
          onSelectAsset={() => setSelection(null)}
          onSelectPort={(id) => setSelection({ kind: 'port', id })}
          onSelectConnection={(id) => setSelection({ kind: 'connection', id })}
          onClear={() => setSelection(null)}
        />
      </div>
    </section>
  );
}
