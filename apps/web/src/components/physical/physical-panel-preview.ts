import type {
  PhysicalCatalogEntry,
  PhysicalCatalogModule,
  PhysicalModule,
  PhysicalPort,
  PhysicalSlot,
} from '@gmj/shared';
import { hasFrontPanelImage } from './front-panel-image-map';
import { buildModulePanelLayout } from './physical-panel-layout';

/**
 * Modo de layout de um painel, derivado **exclusivamente** do catálogo.
 *
 * - `IMAGE`: painel frontal por imagem aprovada + mapa de hotspots validado;
 * - `FRONT_EXACT`: posição oficial do painel codificada (`panelLayout.type: FRONT`);
 * - `FRONT_APPROX`: painel fixo com geometria declarada/organizada (não oficial);
 * - `SLOT_VENDOR`: chassi modular com posição de slots declarada no catálogo;
 * - `SLOT_APPROX`: chassi modular sem geometria de slot declarada;
 * - `LOGICAL`: sem geometria declarada — o renderer usa o fallback semântico e a
 *   tela marca explicitamente "LAYOUT NÃO CONFIRMADO".
 */
export type PanelLayoutMode =
  | 'IMAGE'
  | 'FRONT_EXACT'
  | 'FRONT_APPROX'
  | 'SLOT_VENDOR'
  | 'SLOT_APPROX'
  | 'LOGICAL';

export const PANEL_LAYOUT_MODE_LABELS: Record<PanelLayoutMode, string> = {
  IMAGE: 'IMAGE · painel frontal + hotspots',
  FRONT_EXACT: 'FRONT · posição oficial',
  FRONT_APPROX: 'FRONT · organizado (não oficial)',
  SLOT_VENDOR: 'SLOTS · posição declarada',
  SLOT_APPROX: 'SLOTS · aproximado',
  LOGICAL: 'LOGICAL · semântico',
};

/** Fidelidade exibida no selo de cada painel. */
export type PanelFidelity = 'IMAGE' | 'EXACT' | 'APPROX' | 'LOGICAL';

export function panelFidelity(mode: PanelLayoutMode): PanelFidelity {
  if (mode === 'IMAGE') return 'IMAGE';
  if (mode === 'FRONT_EXACT' || mode === 'SLOT_VENDOR') return 'EXACT';
  if (mode === 'FRONT_APPROX' || mode === 'SLOT_APPROX') return 'APPROX';
  return 'LOGICAL';
}

/** Um template é modular quando declara slots de chassi. */
export function isModularTemplate(entry: PhysicalCatalogEntry): boolean {
  return entry.slots.length > 0 || entry.layoutType === 'MODULAR';
}

export function panelLayoutMode(entry: PhysicalCatalogEntry): PanelLayoutMode {
  // A imagem aprovada ganha de qualquer geometria: ela é o painel real.
  if (hasFrontPanelImage(entry.catalogKey)) return 'IMAGE';
  const declaredPanel = entry.panelLayout ?? null;
  const hasPortVisual = entry.ports.some((port) => port.visual !== null && port.visual !== undefined);
  if (isModularTemplate(entry)) {
    const slotsWithVisual = entry.slots.filter(
      (slot) => slot.visual !== null && slot.visual !== undefined,
    ).length;
    if (entry.slots.length > 0 && slotsWithVisual === entry.slots.length) return 'SLOT_VENDOR';
    return 'SLOT_APPROX';
  }
  if (declaredPanel?.type === 'FRONT') return 'FRONT_EXACT';
  if (declaredPanel || hasPortVisual) return 'FRONT_APPROX';
  return 'LOGICAL';
}

/** Aviso exibido no card: nenhum quando o painel é exato/aprovado. */
export type PanelLayoutWarning = 'none' | 'approx' | 'unconfirmed';

export function layoutWarning(entry: PhysicalCatalogEntry): PanelLayoutWarning {
  const mode = panelLayoutMode(entry);
  if (mode === 'IMAGE' || mode === 'FRONT_EXACT' || mode === 'SLOT_VENDOR') return 'none';
  if (mode === 'LOGICAL') return 'unconfirmed';
  return 'approx';
}

/** `true` quando a tela precisa avisar que o layout não é o oficial. */
export function needsLayoutWarning(entry: PhysicalCatalogEntry): boolean {
  return layoutWarning(entry) !== 'none';
}

/**
 * Portas sintéticas para o preview: mesma forma da porta persistida do módulo
 * Físico, sem tocar em banco (nada é gravado; o estado é sempre `FREE`).
 */
export function previewPorts(entry: PhysicalCatalogEntry): PhysicalPort[] {
  return entry.ports.map((port, index) => ({
    id: `preview-${entry.catalogKey}-${index + 1}`,
    assetId: `preview-${entry.catalogKey}`,
    slotId: null,
    moduleId: null,
    name: port.name,
    label: port.label,
    order: port.order,
    side: port.side,
    type: port.type,
    role: 'TEMPLATE',
    notes: port.notes ?? '',
    pairedPortId: null,
    templatePortId: null,
    mappedInterfaceId: null,
    mappedInterface: null,
    connectionId: null,
    state: 'FREE',
    operStatus: null,
    lldp: null,
    createdAt: '',
    updatedAt: '',
  }));
}

export function previewSlots(entry: PhysicalCatalogEntry): PhysicalSlot[] {
  return entry.slots.map((slot, index) => ({
    id: `preview-${entry.catalogKey}-slot-${index + 1}`,
    assetId: `preview-${entry.catalogKey}`,
    index: slot.index,
    label: slot.label,
    module: null,
    ports: [],
  }));
}

/** Placa instalada apenas para visualização do painel do módulo. */
export function previewModule(
  entry: PhysicalCatalogEntry,
  module: PhysicalCatalogModule,
  slotIndex = 0,
): { module: PhysicalModule; slot: PhysicalSlot } {
  const slots = previewSlots(entry);
  const slot = slots[slotIndex] ?? slots[0];
  const moduleId = `preview-${entry.catalogKey}-module`;
  const ports: PhysicalPort[] = module.ports.map((port, index) => ({
    id: `preview-module-${entry.catalogKey}-${index + 1}`,
    assetId: `preview-${entry.catalogKey}`,
    slotId: slot?.id ?? null,
    moduleId,
    name: port.name,
    label: port.label,
    order: port.order,
    side: port.side,
    type: port.type,
    role: 'TEMPLATE',
    notes: port.notes ?? '',
    pairedPortId: null,
    templatePortId: null,
    mappedInterfaceId: null,
    mappedInterface: null,
    connectionId: null,
    state: 'FREE',
    operStatus: null,
    lldp: null,
    createdAt: '',
    updatedAt: '',
  }));
  return {
    module: {
      id: moduleId,
      assetId: `preview-${entry.catalogKey}`,
      slotId: slot?.id ?? '',
      slotIndex: slot?.index ?? 0,
      moduleTemplateId: null,
      name: module.name,
      model: module.model,
      serial: '',
      ports,
    },
    slot:
      slot ??
      ({
        id: moduleId,
        assetId: `preview-${entry.catalogKey}`,
        index: 0,
        label: '',
        module: null,
        ports: [],
      } satisfies PhysicalSlot),
  };
}

/** Painel de uma placa declarado pelo catálogo (para o preview). */
export function previewModuleLayout(entry: PhysicalCatalogEntry, module: PhysicalCatalogModule) {
  const { module: physicalModule } = previewModule(entry, module);
  return buildModulePanelLayout({ module: physicalModule, catalogModule: module });
}
