import { useId } from "react";
import type { ReactNode, SVGProps } from "react";

/**
 * MAP-VISUAL-V2 — glifos de equipamento (sem orb, sem círculo envolvente).
 *
 * Contrato (igual ao network-device-icon.tsx atual):
 *  - viewBox 0 0 64 64, grade de 8 px, área segura 8..56
 *  - fill none, stroke currentColor, linecap/linejoin round
 *  - zero cor embutida: a cor vem do tipo via CSS (.device-node__icon)
 *  - até 6 primitivas por glifo
 *
 * Pontos sólidos (portas/LEDs) são traços de comprimento zero com linecap
 * round ("h.01"): renderizam como ponto sem usar fill.
 */

export const DEVICE_GLYPH_V2_TYPES = [
  "CORE_ROUTER",
  "ROUTER",
  "SWITCH",
  "CORE_SWITCH",
  "AGGREGATION",
  "OLT",
  "CLOUD",
  "IX",
  "PNI",
  "CLUSTER",
  "BNG",
] as const;

export type DeviceGlyphV2Type = (typeof DEVICE_GLYPH_V2_TYPES)[number];

/**
 * Tipos do v1 que passam a usar um glifo v2. Fora daqui: cai no glifo v1.
 *
 * Só entram equivalências inequívocas. CARRIER e PEER ficam de fora de
 * propósito: carrier pode ser operadora externa e peer pode ser sessão BGP
 * ou organização, não necessariamente nuvem ou interconexão física.
 *
 * Este mapa NÃO altera taxonomia nem valores persistidos: ele só escolhe o
 * desenho de tipos que já existem. PNI só aparece quando o tipo for
 * escolhido manualmente (picker); o resolvedor AUTO não deve inferi-lo.
 */
const LEGACY_TO_V2: Record<string, DeviceGlyphV2Type> = {
  CORE_ROUTER: "CORE_ROUTER",
  EDGE_ROUTER: "ROUTER",
  ROUTER: "ROUTER",
  // PROVISÓRIO: o glifo CORE_SWITCH já existe abaixo, mas só entra em uso
  // depois de aprovado no preview. Para ativar: trocar "SWITCH" por
  // "CORE_SWITCH" nesta linha.
  CORE_SWITCH: "SWITCH",
  SWITCH: "SWITCH",
  AGGREGATION: "AGGREGATION",
  OLT: "OLT",
  CLOUD: "CLOUD",
  IX: "IX",
  PNI: "PNI",
  CLUSTER: "CLUSTER",
  BNG: "BNG",
};

export function resolveDeviceGlyphV2(legacyType: string): DeviceGlyphV2Type | null {
  return LEGACY_TO_V2[legacyType] ?? null;
}

/** Espessura efetiva: em tamanhos pequenos 2.2/64 vira menos de 1 px. */
export function glyphStrokeWidth(size: number): number {
  if (size <= 20) return 3;
  if (size <= 28) return 2.6;
  return 2.2;
}

type GlyphRenderer = (sw: number, compact: boolean) => ReactNode;

/** Ponto sólido via traço de comprimento zero. */
const dot = (sw: number) => sw * 1.6;

const GLYPHS: Record<DeviceGlyphV2Type, GlyphRenderer> = {
  // Core: pilha de três chassis
  CORE_ROUTER: (sw) => (
    <>
      <rect x="10" y="10" width="44" height="12" rx="4" />
      <rect x="10" y="26" width="44" height="12" rx="4" />
      <rect x="10" y="42" width="44" height="12" rx="4" />
      <path d="M44 16h.01M44 32h.01M44 48h.01" strokeWidth={dot(sw)} />
    </>
  ),

  // Roteador: setas cruzadas nas quatro direções
  ROUTER: () => (
    <>
      <path d="M14 32H50M32 14V50" />
      <path d="M20 26L14 32L20 38M44 26L50 32L44 38M26 20L32 14L38 20M26 44L32 50L38 44" />
    </>
  ),

  // Switch: caixa com portas e seta dupla
  SWITCH: () => (
    <>
      <rect x="8" y="15" width="48" height="18" rx="4" />
      <path d="M18 21v6M28 21v6M38 21v6M48 21v6" />
      <path d="M16 44H48M22 39L16 44L22 49M42 39L48 44L42 49" />
    </>
  ),

  // Agregador: três entradas convergem em uma saída
  AGGREGATION: () => (
    <>
      <circle cx="11" cy="18" r="3" />
      <circle cx="11" cy="32" r="3" />
      <circle cx="11" cy="46" r="3" />
      <path d="M14.5 19.5L34 32M14 32H34M14.5 44.5L34 32" />
      <path d="M34 32H54M47 25L54 32L47 39" />
    </>
  ),

  // OLT: chassi modular com slots e PONs
  OLT: (sw) => (
    <>
      <rect x="10" y="12" width="44" height="40" rx="4" />
      <path d="M10 25.5H54M10 38.5H54" />
      <path d="M18 18.5H32M18 32H32M18 45H32" />
      <path d="M44 18.5h.01M44 32h.01M44 45h.01" strokeWidth={dot(sw)} />
    </>
  ),

  // Cloud / upstream
  CLOUD: () => (
    <path d="M18 46H46A9 9 0 0 0 46 28A14 14 0 0 0 20 30A8 8 0 0 0 18 46Z" />
  ),

  // IX: hub com quatro pontas
  IX: () => (
    <>
      <circle cx="32" cy="32" r="5" />
      <circle cx="14" cy="16" r="4" />
      <circle cx="50" cy="16" r="4" />
      <circle cx="14" cy="48" r="4" />
      <circle cx="50" cy="48" r="4" />
      <path d="M28 28L17.5 19M36 28L46.5 19M28 36L17.5 45M36 36L46.5 45" />
    </>
  ),

  // PNI: hexágono com dois elos entrelaçados
  PNI: () => (
    <>
      <path d="M32 8L52 20V44L32 56L12 44V20Z" />
      <circle cx="27" cy="32" r="6" />
      <circle cx="37" cy="32" r="6" />
    </>
  ),

  // Cluster: três nós ligados
  CLUSTER: () => (
    <>
      <circle cx="32" cy="15" r="6" />
      <circle cx="14" cy="47" r="6" />
      <circle cx="50" cy="47" r="6" />
      <path d="M29 20.5L17 41.5M35 20.5L47 41.5M20 47H44" />
    </>
  ),

  // BNG / BRAS: chassi no topo distribuindo para três assinantes
  // Variante compact (opt-in): tronco curto e um único assinante.
  BNG: (sw, compact) => (
    <>
      <rect x="10" y="10" width="44" height="16" rx="4" />
      <path d="M46 18h.01" strokeWidth={dot(sw)} />
      {compact ? (
        <>
          <path d="M32 26V40" />
          <path d="M32 50h.01" strokeWidth={dot(sw)} />
        </>
      ) : (
        <>
          <path d="M32 26V36M32 36L16 47M32 36V47M32 36L48 47" />
          <path d="M16 52h.01M32 52h.01M48 52h.01" strokeWidth={dot(sw)} />
        </>
      )}
    </>
  ),

  // Core switch (proposta): switch com segunda camada atrás, indicando núcleo
  CORE_SWITCH: () => (
    <>
      <path d="M16 18V12H56V32" />
      <rect x="8" y="18" width="44" height="18" rx="4" />
      <path d="M17 24v6M26 24v6M35 24v6M44 24v6" />
      <path d="M14 47H46M20 42L14 47L20 52M40 42L46 47L40 52" />
    </>
  ),
};

export type NetworkDeviceGlyphV2Props = Omit<
  SVGProps<SVGSVGElement>,
  "children" | "viewBox" | "type"
> & {
  type: DeviceGlyphV2Type;
  size?: number;
  /** Se omitido, usa glyphStrokeWidth(size). */
  strokeWidth?: number;
  title?: string;
  /** Variante simplificada para tamanhos pequenos. Opt-in, nunca automática. */
  compact?: boolean;
};

export function NetworkDeviceGlyphV2({
  type,
  size = 32,
  strokeWidth,
  title,
  compact = false,
  ...rest
}: NetworkDeviceGlyphV2Props) {
  const sw = strokeWidth ?? glyphStrokeWidth(size);
  const titleId = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      data-glyph={type}
      {...rest}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {GLYPHS[type](sw, compact)}
    </svg>
  );
}
