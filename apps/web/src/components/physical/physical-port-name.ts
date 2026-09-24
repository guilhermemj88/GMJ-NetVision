import type { PhysicalCatalogPort, PhysicalInterfaceReference, PhysicalPort } from '@gmj/shared';

/**
 * Identidade apresentada de uma porta do módulo físico.
 *
 * A regra de produto é: **a interface CLI é o nome principal** e o conector
 * (`QSFP28`, `SFP28`, `RJ45`…) é característica física, nunca identidade.
 *
 * Prioridade:
 *
 * 1. `mappedInterface.name` — nome real reportado pelo equipamento (sync);
 * 2. `catalogPort.interfaceName` — nome CLI declarado no catálogo (`interfaceNamePattern`);
 * 3. `port.name` — identidade persistida (rótulo físico do painel quando o
 *    catálogo não declara nome de interface).
 *
 * Nada aqui altera `PhysicalPort.id`, âncora de cabo, seleção, LLDP ou breakout:
 * é só o texto apresentado.
 */
export interface PhysicalPortNameSource {
  /** `PhysicalPort.name` (identidade persistida da porta). */
  portName: string;
  /** `PhysicalPort.label` (rótulo físico do painel, quando declarado). */
  portLabel?: string | null;
  /** `PhysicalCatalogPort.label` (rótulo físico/cage declarado no catálogo). */
  catalogLabel?: string | null;
  /** `PhysicalCatalogPort.panelNumber` (número físico do painel, ex.: `0`–`55`). */
  panelNumber?: number | null;
  /** `PhysicalCatalogPort.interfaceName` (nome CLI esperado, quando confirmado). */
  catalogInterfaceName?: string | null;
  /** `PhysicalPort.mappedInterface?.name` (nome real da interface do Device). */
  mappedInterfaceName?: string | null;
}

/** Nome de interface conhecido (mapeado ou declarado), sem fallback. */
export function physicalPortInterfaceName(source: PhysicalPortNameSource): string | null {
  const mapped = source.mappedInterfaceName?.trim();
  if (mapped) return mapped;
  const declared = source.catalogInterfaceName?.trim();
  if (declared) return declared;
  return null;
}

/** Nome apresentado ao usuário: interface CLI → catálogo → identidade persistida. */
export function physicalPortDisplayName(source: PhysicalPortNameSource): string {
  return physicalPortInterfaceName(source) ?? source.portName.trim();
}

/**
 * Rótulo físico do painel (cage) **quando difere** do nome apresentado.
 * `QSFP28-6` continua existindo para correlação/inspector, mas nunca como nome
 * principal de uma porta que já tem interface.
 */
export function physicalPortPanelLabel(source: PhysicalPortNameSource): string | null {
  const displayName = physicalPortDisplayName(source);
  // Catálogo → rótulo persistido → identidade persistida (que hoje carrega o
  // rótulo físico quando o catálogo não declara nome de interface).
  for (const candidate of [source.catalogLabel, source.portLabel, source.portName]) {
    const label = candidate?.trim();
    if (label && label !== displayName) return label;
  }
  return null;
}

/** Último número de um nome (`XGigabitEthernet0/0/12` → `12`). */
export function lastOrdinal(value: string): string | null {
  const match = /(\d+)(?!.*\d)/.exec(value.trim());
  return match ? match[1]! : null;
}

/**
 * Rótulo curto desenhado dentro do conector: o ordinal da **interface CLI**
 * quando existir (`100GE1/0/7` → `7`), senão o **número físico do painel**
 * declarado no catálogo (`0`–`55` no F1A-8H20Q) e, por último, o ordinal do
 * próprio nome persistido.
 */
export function physicalPortCompactLabel(source: PhysicalPortNameSource): string | null {
  if (physicalPortInterfaceName(source)) return lastOrdinal(physicalPortDisplayName(source));
  if (source.panelNumber !== null && source.panelNumber !== undefined) {
    return String(source.panelNumber);
  }
  return lastOrdinal(physicalPortDisplayName(source));
}

/**
 * Prefixo hierárquico da interface (`100GE1/0/7` → `100GE1/0/`), usado nas
 * legendas de grupo do painel técnico. `null` quando a porta não tem nome de
 * interface (só rótulo físico): nesse caso o desenho continua no rótulo do
 * catálogo.
 */
export function physicalPortInterfacePrefix(source: PhysicalPortNameSource): string | null {
  const name = physicalPortInterfaceName(source);
  if (!name) return null;
  const ordinal = lastOrdinal(name);
  if (!ordinal) return null;
  const index = name.lastIndexOf(ordinal);
  const prefix = name.slice(0, index);
  return prefix.length ? prefix : null;
}

/** Visão pronta para desenhar/inspector: nada é recalculado no JSX. */
export interface PhysicalPortNameView {
  /** Texto principal (`100GE1/0/1`). */
  displayName: string;
  /** Nome de interface conhecido, quando existir. */
  interfaceName: string | null;
  /** Rótulo físico do painel quando difere do nome principal (`QSFP28-1`). */
  panelLabel: string | null;
  /** Ordinal curto para dentro do conector. */
  compactLabel: string | null;
  /** Prefixo da interface para legendas de grupo. */
  interfacePrefix: string | null;
}

export function physicalPortNameView(
  port: Pick<PhysicalPort, 'name' | 'label'> & { mappedInterface?: PhysicalInterfaceReference | null },
  catalogPort?: Pick<PhysicalCatalogPort, 'label' | 'interfaceName' | 'panelNumber'> | null,
): PhysicalPortNameView {
  const source: PhysicalPortNameSource = {
    portName: port.name,
    portLabel: port.label,
    catalogLabel: catalogPort?.label ?? null,
    catalogInterfaceName: catalogPort?.interfaceName ?? null,
    panelNumber: catalogPort?.panelNumber ?? null,
    mappedInterfaceName: port.mappedInterface?.name ?? null,
  };
  return {
    displayName: physicalPortDisplayName(source),
    interfaceName: physicalPortInterfaceName(source),
    panelLabel: physicalPortPanelLabel(source),
    compactLabel: physicalPortCompactLabel(source),
    interfacePrefix: physicalPortInterfacePrefix(source),
  };
}
