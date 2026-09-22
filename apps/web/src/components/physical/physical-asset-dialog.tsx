'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type {
  CreatePhysicalAssetInput,
  PhysicalCatalogCategory,
  PhysicalCatalogEntry,
  PhysicalPortType,
  PhysicalRack,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import { CircleAlert, ShieldCheck } from 'lucide-react';
import {
  CATEGORY_LABELS,
  catalogCategories,
  catalogManufacturers,
  catalogModels,
  catalogSpec,
  findCatalogEntry,
  portTypeSummary,
  structureBadge,
} from './physical-catalog';

export interface PhysicalAssetDialogResult {
  input: CreatePhysicalAssetInput;
  /**
   * DIO/patch panel chosen without a confirmed channel structure: the operator
   * informed the channel count and the workspace creates FRONT/REAR pairs.
   */
  passiveChannels: number;
  /** Run the interface sync right after creating the asset. */
  syncInterfaces: boolean;
}

interface HostOption {
  id: string;
  hostname: string;
  displayName?: string | null;
}

interface Props {
  rack: PhysicalRack;
  hosts: readonly HostOption[];
  catalog: readonly PhysicalCatalogEntry[];
  /**
   * Devices that already belong to another physical asset: the link is 1:1, so
   * they stay visible but cannot be selected again.
   */
  linkedDeviceIds?: readonly string[];
  busy: boolean;
  canSync: boolean;
  onCancel: () => void;
  onSubmit: (result: PhysicalAssetDialogResult) => void;
}

const PORT_TYPES: PhysicalPortType[] = ['RJ45', 'SFP', 'SFP_PLUS', 'QSFP', 'FIBER', 'OTHER'];

function occupiedSummary(rack: PhysicalRack): string {
  const used = new Set<number>();
  for (const asset of rack.assets) {
    for (let offset = 0; offset < asset.heightU; offset += 1) used.add(asset.startU + offset);
  }
  if (!used.size) return 'Rack livre';
  const units = [...used].sort((a, b) => a - b);
  return `Ocupado em U${units.join(', U')}`;
}

export function PhysicalAssetDialog({
  rack,
  hosts,
  catalog,
  linkedDeviceIds = [],
  busy,
  canSync,
  onCancel,
  onSubmit,
}: Props) {
  const linkedDevices = useMemo(() => new Set(linkedDeviceIds), [linkedDeviceIds]);
  const categories = useMemo(() => catalogCategories(catalog), [catalog]);
  const [category, setCategory] = useState<PhysicalCatalogCategory | ''>(categories[0] ?? '');
  const manufacturers = useMemo(
    () => catalogManufacturers(catalog, category),
    [catalog, category],
  );
  const [manufacturer, setManufacturer] = useState(manufacturers[0] ?? '');
  const models = useMemo(
    () => catalogModels(catalog, category, manufacturer),
    [catalog, category, manufacturer],
  );
  const [catalogKey, setCatalogKey] = useState(models[0]?.catalogKey ?? '');
  const selection = findCatalogEntry(catalog, catalogKey);
  const [name, setName] = useState('');
  const [startU, setStartU] = useState(1);
  const [heightU, setHeightU] = useState(selection?.heightU ?? 1);
  const [portCount, setPortCount] = useState(0);
  const [prefix, setPrefix] = useState('');
  const [portType, setPortType] = useState<PhysicalPortType>('RJ45');
  const [deviceId, setDeviceId] = useState('');
  const [syncInterfaces, setSyncInterfaces] = useState(false);

  const badge = selection ? structureBadge(selection) : null;
  const structureConfirmed = Boolean(selection?.structureConfirmed);
  const isPassive = selection?.kind === 'DIO' || selection?.kind === 'PATCH_PANEL';
  const templateHasPorts = Boolean(selection?.ports.length);
  /** Structure must be completed by hand when the catalog does not describe it. */
  const needsManualStructure = !structureConfirmed || (!templateHasPorts && !isPassive);
  const needsChannelCount = isPassive && !templateHasPorts;

  function selectCategory(next: PhysicalCatalogCategory | '') {
    const nextManufacturers = catalogManufacturers(catalog, next);
    const nextManufacturer = nextManufacturers[0] ?? '';
    const nextModels = catalogModels(catalog, next, nextManufacturer);
    const nextSelection = nextModels[0] ?? null;
    setCategory(next);
    setManufacturer(nextManufacturer);
    setCatalogKey(nextSelection?.catalogKey ?? '');
    setHeightU(nextSelection?.heightU ?? 1);
    setPortCount(0);
  }

  function selectManufacturer(next: string) {
    const nextModels = catalogModels(catalog, category, next);
    const nextSelection = nextModels[0] ?? null;
    setManufacturer(next);
    setCatalogKey(nextSelection?.catalogKey ?? '');
    setHeightU(nextSelection?.heightU ?? 1);
    setPortCount(0);
  }

  function selectModel(nextKey: string) {
    const nextSelection = findCatalogEntry(catalog, nextKey);
    setCatalogKey(nextKey);
    setHeightU(nextSelection?.heightU ?? 1);
    setPortCount(0);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection) return;
    const finalName = name.trim() || selection.name;
    const manualPorts = needsManualStructure && portCount > 0 && !needsChannelCount;
    onSubmit({
      input: {
        name: finalName,
        kind: selection.kind,
        startU,
        heightU: structureConfirmed ? selection.heightU : heightU,
        catalogKey: selection.catalogKey,
        applyTemplate: structureConfirmed && (templateHasPorts || selection.slots.length > 0),
        ...(deviceId ? { deviceId } : {}),
        ...(manualPorts
          ? { genericPorts: { count: portCount, ...(prefix ? { prefix } : {}), type: portType } }
          : {}),
      },
      passiveChannels: needsChannelCount ? portCount : 0,
      syncInterfaces: Boolean(deviceId) && syncInterfaces,
    });
  }

  return (
    <form className="physical-form" onSubmit={submit}>
      <div className="physical-form-row">
        <label className="physical-field">
          Categoria
          <select value={category} onChange={(event) => selectCategory(event.target.value as PhysicalCatalogCategory)}>
            {categories.map((item) => (
              <option key={item} value={item}>
                {CATEGORY_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="physical-field">
          Fabricante
          <select value={manufacturer} onChange={(event) => selectManufacturer(event.target.value)}>
            {manufacturers.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="physical-field">
        Modelo / template
        <select value={catalogKey} onChange={(event) => selectModel(event.target.value)}>
          {models.map((entry) => (
            <option key={entry.catalogKey} value={entry.catalogKey}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      {selection && badge ? (
        <div className={`physical-catalog-card physical-catalog-card--${badge.tone}`}>
          <span className="physical-catalog-card__badge">
            {badge.tone === 'verified' ? <ShieldCheck size={11} /> : <CircleAlert size={11} />}
            {badge.label}
          </span>
          <p>{selection.description}</p>
          <dl>
            <div>
              <dt>Altura</dt>
              <dd>{structureConfirmed ? `${selection.heightU}U` : 'a informar'}</dd>
            </div>
            <div>
              <dt>Estrutura</dt>
              <dd>{catalogSpec(selection)}</dd>
            </div>
            {selection.family ? (
              <div>
                <dt>Família</dt>
                <dd>
                  {selection.family}
                  {selection.model ? ` · ${selection.model}` : ''}
                </dd>
              </div>
            ) : null}
            {templateHasPorts ? (
              <div>
                <dt>Portas do template</dt>
                <dd>{portTypeSummary(selection)}</dd>
              </div>
            ) : null}
            {selection.slots.length ? (
              <div>
                <dt>Slots</dt>
                <dd>{selection.slots.map((slot) => slot.label || `Slot ${slot.index}`).join(', ')}</dd>
              </div>
            ) : null}
          </dl>
          {selection.referenceUrl ? (
            <a href={selection.referenceUrl} target="_blank" rel="noreferrer">
              Documentação oficial do fabricante
            </a>
          ) : null}
        </div>
      ) : (
        <p className="physical-form__hint">
          Nenhum template disponível para esta combinação. Bootstrap o catálogo ou cadastre um template.
        </p>
      )}

      <div className="physical-form-row">
        <label className="physical-field">
          Nome no rack
          <input
            name="name"
            required
            maxLength={160}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={selection?.name ?? 'Ex.: SW-POP01'}
          />
        </label>
        <label className="physical-field">
          Device real
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            <option value="">Não vinculado</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id} disabled={linkedDevices.has(host.id)}>
                {host.displayName || host.hostname}
                {linkedDevices.has(host.id) ? ' · já vinculado a outro equipamento' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="physical-form-row">
        <label className="physical-field">
          Start U
          <input
            name="startU"
            type="number"
            min={1}
            max={rack.units}
            required
            value={startU}
            onChange={(event) => setStartU(Number.isNaN(event.target.valueAsNumber) ? 1 : event.target.valueAsNumber)}
          />
        </label>
        <label className="physical-field">
          Altura U
          <input
            name="heightU"
            type="number"
            min={1}
            max={rack.units}
            required
            disabled={structureConfirmed}
            value={structureConfirmed ? selection?.heightU ?? 1 : heightU}
            onChange={(event) => setHeightU(Number.isNaN(event.target.valueAsNumber) ? 1 : event.target.valueAsNumber)}
          />
        </label>
      </div>

      {needsChannelCount || (needsManualStructure && !needsChannelCount) ? (
        <div className={`physical-form-row ${needsChannelCount ? '' : 'physical-form-row--triple'}`}>
          <label className="physical-field">
            {needsChannelCount ? 'Canais' : 'Portas a criar'}
            <input
              name="ports"
              type="number"
              min={0}
              max={512}
              value={portCount}
              onChange={(event) => setPortCount(Number.isNaN(event.target.valueAsNumber) ? 0 : event.target.valueAsNumber)}
            />
          </label>
          {!needsChannelCount ? (
            <>
              <label className="physical-field">
                Prefixo
                <input
                  name="prefix"
                  maxLength={40}
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                  placeholder="Ethernet, GE, LAN..."
                />
              </label>
              <label className="physical-field">
                Tipo
                <select value={portType} onChange={(event) => setPortType(event.target.value as PhysicalPortType)}>
                  {PORT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {needsChannelCount ? (
        <p className="physical-form__hint">
          Passivo sem estrutura de fabricante presumida: cada canal cria terminações FRONT e REAR pareadas.
        </p>
      ) : null}
      {needsManualStructure && !needsChannelCount ? (
        <p className="physical-form__hint">
          A altura e as portas deste modelo ainda não foram confirmadas em documentação oficial. Informe os valores
          reais; o template não inventa posições.
        </p>
      ) : null}
      {!needsManualStructure && selection?.slots.length ? (
        <p className="physical-form__hint">
          Os {selection.slots.length} slots serão criados vazios; as placas são instaladas depois, no inspetor.
        </p>
      ) : null}

      <p className="physical-form__hint">{occupiedSummary(rack)}</p>

      {deviceId && canSync ? (
        <label className="physical-check">
          <input
            type="checkbox"
            checked={syncInterfaces}
            onChange={(event) => setSyncInterfaces(event.target.checked)}
          />
          Sincronizar interfaces do Device após criar
        </label>
      ) : null}

      <footer>
        <Button compact variant="ghost" type="button" onClick={onCancel}>
          Cancelar
        </Button>
        <Button compact variant="primary" type="submit" disabled={busy || !selection}>
          Adicionar ao rack
        </Button>
      </footer>
    </form>
  );
}
