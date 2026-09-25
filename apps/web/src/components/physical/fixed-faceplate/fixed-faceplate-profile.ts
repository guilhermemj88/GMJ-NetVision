import type { PanelConnectorKind } from '../physical-panel-layout';
import type { TechnicalLed, TechnicalLedTone } from '../physical-technical';
import type {
  FixedFaceplateChrome,
  FixedFaceplateLayoutSpec,
  FixedFaceplateZone,
} from './fixed-faceplate-layout';
import { FIXED_BLOCK_GAP_PX, FIXED_COLUMN_BLOCK } from './fixed-faceplate-layout';

/**
 * Perfil **visual** de um equipamento fixo (a verdade técnica NÃO mora aqui).
 *
 * Adaptado da biblioteca visual do MagicPatterns (`EquipmentChassis` +
 * `FixedPortPanel` + `Port` + `RackEar` + `ChassisHeader` + `StatusLeds`):
 * o perfil diz apenas como desenhar — estilo de fornecedor, orelhas de rack,
 * LEDs, LCD, proporção das jaulas, respiro entre blocos e a composição dos
 * grupos. Quem declara **quantas portas existem, qual conector, qual papel e
 * qual numeração** continua sendo `apps/api/catalog/physical-catalog-v1.yaml`
 * (via `PhysicalCatalogEntry` → `buildPanelLayout`).
 *
 * Por isso não existe aqui `count`, `connector`, `interfaceName`, `panelNumber`
 * ou `PhysicalPort.id`: os grupos são referenciados pelo `groupKey` que o
 * catálogo já declara.
 */

export type FixedFaceplateVendor = 'HUAWEI' | 'MIKROTIK';

/** Composição visual de um bloco (`groupKey` existente no catálogo). */
export interface FixedFaceplateGroupPresentation {
  /** fileiras do bloco (`2` = duas fileiras de `ceil(count/2)` colunas). */
  rows?: number;
  /** colunas explícitas (sobrepõe `rows`). */
  columns?: number;
  /** legenda do bloco: `false` esconde, string substitui (senão vem do catálogo). */
  caption?: string | false;
  /** bloco desenhado na área de gerência (esquerda), como no `FixedPortPanel`. */
  management?: boolean;
}

export interface FixedFaceplateVisualProfile {
  catalogKey: string;
  vendorStyle: FixedFaceplateVendor;
  /** modelo impresso no chassi (default: modelo do template). */
  modelLabel?: string;
  /** linha de série mostrada no cabeçalho (à direita, discreta). */
  seriesLabel?: string;
  showRackEars: boolean;
  showStatusLeds?: boolean;
  /** LCD frontal (MikroTik CCR). */
  showLcd?: boolean;
  /** escala do desenho: px por unidade de grade (define o tamanho das jaulas). */
  portScalePx: number;
  /** respiro horizontal entre blocos (px). */
  groupGapPx?: number;
  /** distribuição das sobras (padrão da biblioteca: `around`). */
  justify?: 'around' | 'between';
  /** ordem de desenho dos blocos (`groupKey` do catálogo). */
  groupOrder: readonly string[];
  /** composição por bloco. */
  groupPresentation?: Readonly<Record<string, FixedFaceplateGroupPresentation>>;
  /** tamanho de jaula por conector (px) — o motor converte para unidades. */
  portSizes?: Partial<Record<PanelConnectorKind, { width: number; height: number }>>;
  /** ventilação localizada (unidades) — só para frontais que realmente têm. */
  ventilation?: readonly FixedFaceplateZone[];
  ledLabels?: readonly string[];
}

const LED_TONES: Record<string, TechnicalLedTone> = {
  PWR: 'pwr',
  ALM: 'off',
  ACT: 'act',
  RUN: 'on',
  FAN: 'fan',
};

/** LEDs do chassi (aparência; o estado real vem do backend quando existir). */
export function fixedFaceplateProfileLeds(profile: FixedFaceplateVisualProfile): TechnicalLed[] {
  return (profile.ledLabels ?? ['PWR', 'ALM', 'ACT']).map((label) => ({
    label,
    tone: LED_TONES[label] ?? 'off',
  }));
}

/** Escala comum da biblioteca visual (SFP+ ≈ 18px, QSFP28 ≈ 25px, COMBO = 36px). */
const LIBRARY_SCALE_PX = 5.6;

/** Jaula COMBO (RJ45 + SFP na mesma gaveta) da biblioteca visual. */
const COMBO_PORT_SIZE = { width: 36, height: 16 } as const;

function huaweiSwitch(input: {
  catalogKey: string;
  model: string;
  series: string;
  groupOrder: readonly string[];
  groupPresentation: Record<string, FixedFaceplateGroupPresentation>;
}): FixedFaceplateVisualProfile {
  return {
    catalogKey: input.catalogKey,
    vendorStyle: 'HUAWEI',
    modelLabel: input.model,
    seriesLabel: input.series,
    showRackEars: true,
    showStatusLeds: true,
    showLcd: false,
    portScalePx: LIBRARY_SCALE_PX,
    groupGapPx: 14,
    justify: 'around',
    groupOrder: input.groupOrder,
    groupPresentation: input.groupPresentation,
  };
}

function mikrotikCcr(input: {
  catalogKey: string;
  model: string;
  series: string;
  lcd: boolean;
  groupOrder: readonly string[];
  groupPresentation: Record<string, FixedFaceplateGroupPresentation>;
}): FixedFaceplateVisualProfile {
  return {
    catalogKey: input.catalogKey,
    vendorStyle: 'MIKROTIK',
    modelLabel: input.model,
    seriesLabel: input.series,
    showRackEars: true,
    showStatusLeds: true,
    showLcd: input.lcd,
    portScalePx: LIBRARY_SCALE_PX,
    groupGapPx: 14,
    justify: 'around',
    groupOrder: input.groupOrder,
    groupPresentation: input.groupPresentation,
    portSizes: { COMBO: COMBO_PORT_SIZE },
  };
}

/** Grupo de gerência (console/serial) desenhado na área da esquerda. */
const MANAGEMENT_GROUP: FixedFaceplateGroupPresentation = { rows: 1, management: true };

/**
 * Perfis aprovados (SKUs exatos do catálogo). Os SKUs ausentes continuam no
 * renderer técnico anterior — a migração é incremental.
 */
const PROFILES: readonly FixedFaceplateVisualProfile[] = [
  // ---------------------------------------------------------------- Huawei
  huaweiSwitch({
    catalogKey: 'huawei-s6730-h24x6c',
    model: 'S6730-H24X6C',
    series: 'CloudEngine S6730',
    groupOrder: ['sfpplus-10g', 'qsfp28-uplink'],
    groupPresentation: { 'sfpplus-10g': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6730-h24x6c-v2',
    model: 'S6730-H24X6C-V2',
    series: 'CloudEngine S6730',
    groupOrder: ['sfpplus-10g', 'qsfp28-uplink'],
    groupPresentation: { 'sfpplus-10g': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6730-h48x6c',
    model: 'S6730-H48X6C',
    series: 'CloudEngine S6730',
    groupOrder: ['sfpplus-10g', 'qsfp28-uplink'],
    groupPresentation: { 'sfpplus-10g': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6730-h48x6c-v2',
    model: 'S6730-H48X6C-V2',
    series: 'CloudEngine S6730',
    groupOrder: ['sfpplus-10g', 'qsfp28-uplink'],
    groupPresentation: { 'sfpplus-10g': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6750-h48x8c',
    model: 'S6750-H48X8C',
    series: 'CloudEngine S6750',
    groupOrder: ['sfp28-service', 'qsfp28-uplink'],
    groupPresentation: { 'sfp28-service': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6750-h48y8c',
    model: 'S6750-H48Y8C',
    series: 'CloudEngine S6750',
    groupOrder: ['sfp28-service', 'qsfp28-uplink'],
    groupPresentation: { 'sfp28-service': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6750-h48y8c-b',
    model: 'S6750-H48Y8C-B',
    series: 'CloudEngine S6750',
    groupOrder: ['sfp28-service', 'qsfp28-uplink'],
    groupPresentation: { 'sfp28-service': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),
  huaweiSwitch({
    catalogKey: 'huawei-s6750-h36c',
    model: 'S6750-H36C',
    series: 'CloudEngine S6750',
    groupOrder: ['qsfp28-service', 'qsfp28-uplink'],
    groupPresentation: { 'qsfp28-service': { rows: 2 }, 'qsfp28-uplink': { rows: 2 } },
  }),

  // -------------------------------------------------------------- MikroTik
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr1009-7g-1c-1splus',
    model: 'CCR1009-7G-1C-1S+',
    series: 'MikroTik CCR1000',
    lcd: false,
    groupOrder: ['ether', 'combo', 'sfpplus', 'console'],
    groupPresentation: {
      ether: { rows: 1, caption: 'GE' },
      combo: { rows: 1, caption: 'COMBO' },
      sfpplus: { rows: 1, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr1009-8g-1s-1splus',
    model: 'CCR1009-8G-1S-1S+',
    series: 'MikroTik CCR1000',
    lcd: false,
    groupOrder: ['ether', 'sfp', 'sfpplus', 'console'],
    groupPresentation: {
      ether: { rows: 1, caption: 'GE' },
      sfp: { rows: 1, caption: 'SFP' },
      sfpplus: { rows: 1, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr1036-12g-4s',
    model: 'CCR1036-12G-4S',
    series: 'MikroTik CCR1000',
    lcd: true,
    groupOrder: ['ether', 'sfp', 'console'],
    groupPresentation: {
      ether: { rows: 2, caption: 'GE' },
      sfp: { rows: 2, caption: 'SFP' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr1036-8g-2splus',
    model: 'CCR1036-8G-2S+',
    series: 'MikroTik CCR1000',
    lcd: true,
    groupOrder: ['ether', 'sfpplus', 'console'],
    groupPresentation: {
      ether: { rows: 2, caption: 'GE' },
      sfpplus: { rows: 2, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr1072-1g-8splus',
    model: 'CCR1072-1G-8S+',
    series: 'MikroTik CCR1000',
    lcd: true,
    groupOrder: ['ether', 'sfpplus', 'console'],
    groupPresentation: {
      ether: { rows: 1, caption: 'MGMT' },
      sfpplus: { rows: 2, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr2004-16g-2splus',
    model: 'CCR2004-16G-2S+',
    series: 'MikroTik CCR2000',
    lcd: false,
    groupOrder: ['ether', 'sfpplus', 'console'],
    groupPresentation: {
      ether: { rows: 2, caption: 'GE' },
      sfpplus: { rows: 2, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr2004-1g-12splus2xs',
    model: 'CCR2004-1G-12S+2XS',
    series: 'MikroTik CCR2000',
    lcd: false,
    groupOrder: ['ether', 'sfpplus', 'sfp28', 'console'],
    groupPresentation: {
      ether: { rows: 1, caption: 'MGMT' },
      sfpplus: { rows: 2, caption: 'SFP+' },
      sfp28: { rows: 2, caption: 'SFP28' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr2116-12g-4splus',
    model: 'CCR2116-12G-4S+',
    series: 'MikroTik CCR2000',
    lcd: true,
    groupOrder: ['ether-service', 'ether-management', 'sfpplus', 'console'],
    groupPresentation: {
      'ether-service': { rows: 2, caption: 'GE' },
      'ether-management': { rows: 1, caption: 'MGMT' },
      sfpplus: { rows: 2, caption: 'SFP+' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
  mikrotikCcr({
    catalogKey: 'mikrotik-ccr2216-1g-12xs-2xq',
    model: 'CCR2216-1G-12XS-2XQ',
    series: 'MikroTik CCR2000',
    lcd: true,
    groupOrder: ['ether', 'sfp28', 'qsfp28', 'console'],
    groupPresentation: {
      ether: { rows: 1, caption: 'MGMT' },
      sfp28: { rows: 2, caption: 'SFP28' },
      qsfp28: { rows: 2, caption: 'QSFP28' },
      console: { ...MANAGEMENT_GROUP, caption: 'SERIAL' },
    },
  }),
];

const BY_KEY = new Map(PROFILES.map((profile) => [profile.catalogKey, profile]));

/** Todos os SKUs com perfil visual (transparência para UI/testes). */
export const FIXED_FACEPLATE_PROFILE_KEYS: readonly string[] = PROFILES.map(
  (profile) => profile.catalogKey,
);

/** `true` quando o SKU já tem perfil visual da biblioteca. */
export function hasFixedFaceplateProfile(catalogKey: string | null | undefined): boolean {
  return Boolean(catalogKey && BY_KEY.has(catalogKey));
}

/** Perfil visual do SKU (ou `null`: segue o renderer anterior). */
export function fixedFaceplateProfileFor(
  catalogKey: string | null | undefined,
): FixedFaceplateVisualProfile | null {
  if (!catalogKey) return null;
  return BY_KEY.get(catalogKey) ?? null;
}

/**
 * Legenda de um bloco: override do perfil (`GE`, `MGMT`, `SERIAL`) ou o rótulo
 * derivado do catálogo (família + faixa). `null` = bloco sem legenda.
 */
export function fixedFaceplateGroupCaption(
  profile: FixedFaceplateVisualProfile,
  region: { key: string; label: string },
): string | null {
  const caption = profile.groupPresentation?.[region.key]?.caption;
  if (caption === false) return null;
  return caption ?? region.label;
}

/**
 * Monta o layout visual (bandas/regiões) do SKU a partir do perfil.
 *
 * A ordem dos blocos é: gerência (console/serial) primeiro, depois a ordem
 * declarada no perfil. Grupos do catálogo não citados no perfil entram no fim
 * pelo próprio motor — nenhuma porta fica fora do desenho.
 */
export function fixedFaceplateSpecFor(
  profile: FixedFaceplateVisualProfile,
  chrome: FixedFaceplateChrome,
): FixedFaceplateLayoutSpec {
  const management = profile.groupOrder.filter(
    (key) => profile.groupPresentation?.[key]?.management,
  );
  const ordered = [
    ...management,
    ...profile.groupOrder.filter((key) => !management.includes(key)),
  ];
  return {
    chassis: { width: chrome.chassisWidthUnits, height: 0 },
    chrome: { top: chrome.chromeTopUnits, bottom: chrome.chromeBottomUnits },
    ports: {
      // a região útil começa depois das orelhas, do respiro do corpo e do LCD
      x: chrome.earUnits + chrome.padUnits + chrome.lcdUnits,
      y: chrome.chromeTopUnits,
      width: chrome.regionWidthUnits,
      height: 0,
    },
    bands: [
      {
        groups: ordered.map((groupKey) => {
          const presentation = profile.groupPresentation?.[groupKey];
          return {
            groupKey,
            // `exactOptionalPropertyTypes`: só entra o que o perfil declara
            ...(presentation?.rows ? { rows: presentation.rows } : {}),
            ...(presentation?.columns ? { columns: presentation.columns } : {}),
            ...(presentation?.management ? { gapX: 0.9 } : {}),
          };
        }),
      },
    ],
    groupGap: (profile.groupGapPx ?? 14) / chrome.scale,
    justify: profile.justify ?? 'around',
    // quebras de 8 colunas do painel real (respiro maior entre os blocos)
    columnBlock: FIXED_COLUMN_BLOCK,
    blockGap: FIXED_BLOCK_GAP_PX / chrome.scale,
  };
}
