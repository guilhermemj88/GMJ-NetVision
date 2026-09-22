/**
 * Physical vs logical interface classification.
 *
 * The physical (DCIM) layer only owns *chassis connectors*: the ports you can
 * touch and cable. Everything a device creates on top of them — VLANs, bridges,
 * sub-interfaces, tunnels, aggregation groups, breakout lanes — is a logical
 * interface and must never become a `PhysicalPort`, otherwise a single switch
 * with hundreds of `Vlanif` would fabricate hundreds of fake connectors.
 *
 * Rules come from the vendor naming conventions documented for the project:
 *
 * - sub-interface / unit suffix (`100GE1/0/1.100`, `ge-0/0/0.0`, `lo0.0`) → LOGICAL;
 * - breakout lane suffix (`et-0/0/0:0`, `100GE1/0/1:1`) → LOGICAL, because the
 *   breakout channel is part of the base connector, not an extra one;
 * - MikroTik: `ether1`, `sfp-sfpplus1`, `sfp28-1`, `qsfp28-*` → PHYSICAL;
 *   `vlan100`, `bridge1`, `bonding1`, `eoip*`, `pppoe*`, `wireguard*`, `vrrp*` → LOGICAL;
 * - Juniper: `ge-0/0/0`, `xe-0/0/1`, `et-0/0/0` → PHYSICAL;
 *   `ge-0/0/0.0`, `xe-0/0/1.100`, `irb.100`, `lo0.0`, `ae0` → LOGICAL.
 *
 * PHYSICAL is a *candidate*: it still needs a template port or an explicit
 * mapping to become a persisted connector.
 */

export type PhysicalInterfaceClass = 'PHYSICAL' | 'LOGICAL' | 'UNKNOWN';

export interface PhysicalInterfaceClassification {
  classification: PhysicalInterfaceClass;
  /**
   * Canonical chassis connector key (`eth:1`, `ge:0/0/0`, `sfpplus1`), used to
   * correlate template ports with real interfaces across vendor spellings.
   * For breakout lanes it is the key of the **cage**, never a fake extra
   * connector. `null` for pure logical interfaces and UNKNOWN.
   */
  connectorKey: string | null;
  /** Set when the name is one lane of a breakout cage (`qsfp28-1-2`, `et-0/0/0:1`). */
  breakout: { cageKey: string; lane: number } | null;
  /** Why the interface was classified that way (shown in reports/UI). */
  reason: string;
}

const UNIT_SUFFIX = /\.\d+$/;
const BREAKOUT_LANE_SUFFIX = /:(\d+)$/;

/**
 * Breakout lanes: one cage, several channels. `qsfp28-1-1..4` are lanes 1..4 of
 * the cage `qsfp28-1`; the same reasoning applies to SFP-DD/QSFP56 cages.
 */
const BREAKOUT_LANE_PATTERNS: Array<{ pattern: RegExp; family: number; cage: number; lane: number }> = [
  {
    pattern: /^(qsfp28|qsfp56|qsfpdd|qsfpplus|qsfp|sfp28|sfpplus)-(\d+)-(\d+)$/,
    family: 1,
    cage: 2,
    lane: 3,
  },
];

/** Interface families that never represent a chassis connector. */
const LOGICAL_FAMILIES: RegExp[] = [
  /^vlan\d*$/,
  /^vlanif\d+$/,
  /^svlan\d+$/,
  /^br\d+$/,
  /^bridge\d+$/,
  /^virbr\d+$/,
  /^vmbr\d+$/,
  /^bond\d+$/,
  /^bonding\d+$/,
  /^lagg\d+$/,
  /^ae\d+$/,
  /^reth\d*$/,
  /^lag\d+$/,
  /^eoip[\w-]*$/,
  /^pppoe[\w-]*$/,
  /^ppp[\w-]*$/,
  /^wireguard\d*$/,
  /^wg\d+$/,
  /^vrrp\d*$/,
  /^irb\d*$/,
  /^lo\d*$/,
  /^loopback\d*$/,
  /^tunnel\d*$/,
  /^tun\d+$/,
  /^gre\d*$/,
  /^ipip\d*$/,
  /^sit\d*$/,
  /^vti\d*$/,
  /^ipsec\d*$/,
  /^virtual-ethernet[\w/.-]*$/,
  /^virt(ual)?[\w-]*$/,
  /^nve\d*$/,
  /^vxlan\d*$/,
  /^vtep\d*$/,
  /^bvi\d+$/,
  /^svi\d+$/,
  /^dialer\d+$/,
  /^cellular\d+$/,
  /^lte\d+$/,
  /^wwan\d+$/,
  /^docker\d*$/,
  /^sstp[\w-]*$/,
  /^l2tp[\w-]*$/,
  /^ovpn[\w-]*$/,
  /^openvpn[\w-]*$/,
  /^erspan\d+$/,
  /^tap\d+$/,
  /^veth[\w.-]*$/,
  /^port-?channel\d+$/,
  /^po\d+$/,
  /^eth-?trunk\d+$/,
  /^bundle-ether\d+$/,
  /^be\d+$/,
  /^trunk\d+$/,
];

interface PhysicalFamilyRule {
  pattern: RegExp;
  family: string;
  /** index captured from the name, `null` means "use the whole suffix" */
  index: number;
}

/**
 * Interface families that are candidate chassis connectors. Ordered: the first
 * match wins, so the most specific spellings come first.
 */
const PHYSICAL_FAMILIES: PhysicalFamilyRule[] = [
  { pattern: /^ether(net)?[\s-]*(\d+(?:\/\d+)*)$/, family: 'eth', index: 2 },
  { pattern: /^eth(\d+(?:\/\d+)*)$/, family: 'eth', index: 1 },
  { pattern: /^eno(\d+)$/, family: 'eth', index: 1 },
  { pattern: /^ens(\d+[a-z]?)$/, family: 'eth', index: 1 },
  { pattern: /^enp(\d+[a-z]?\d*(?:s\d+)?)$/, family: 'eth', index: 1 },
  { pattern: /^em(\d+)$/, family: 'eth', index: 1 },
  { pattern: /^fa(?:stethernet)?[\s-]*(\d+(?:\/\d+)*)$/, family: 'fa', index: 1 },
  { pattern: /^(?:gi|gigabitethernet|ge)[\s-]*(\d+(?:\/\d+)*)$/, family: 'ge', index: 1 },
  { pattern: /^(?:xe|10gige|10ge)[\s-]*(\d+(?:\/\d+)*)$/, family: 'xe', index: 1 },
  { pattern: /^10gbe[\s-]*(\d+)$/, family: 'xe', index: 1 },
  { pattern: /^xgigabitethernet[\s-]*(\d+(?:\/\d+)*)$/, family: '10ge', index: 1 },
  { pattern: /^xge[\s-]*(\d+(?:\/\d+)*)$/, family: 'xe', index: 1 },
  { pattern: /^(?:te|tengigabitethernet|tengige)[\s-]*(\d+(?:\/\d+)*)$/, family: 'te', index: 1 },
  { pattern: /^(?:tw|twe|twentyfivegige|25ge|twentyfivegigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '25ge', index: 1 },
  { pattern: /^(?:fo|fortygige|40ge|fortygigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '40ge', index: 1 },
  { pattern: /^(?:fi|fiftygige|50ge|fiftygigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '50ge', index: 1 },
  { pattern: /^(?:hu|hundredgige|100ge|hundredgigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '100ge', index: 1 },
  { pattern: /^(?:twohundredgige|200ge|twohundredgigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '200ge', index: 1 },
  { pattern: /^(?:fourhundredgige|400ge|fourhundredgigabitethernet)[\s-]*(\d+(?:\/\d+)*)$/, family: '400ge', index: 1 },
  { pattern: /^et-(\d+(?:\/\d+)*)$/, family: 'et', index: 1 },
  { pattern: /^sfp-?sfpplus-?(\d+)$/, family: 'sfpplus', index: 1 },
  { pattern: /^sfp\s*\+[\s-]*(\d+(?:\/\d+)*)$/, family: 'sfpplus', index: 1 },
  { pattern: /^sfpplus-?(\d+)$/, family: 'sfpplus', index: 1 },
  { pattern: /^sfp28-?(\d+)$/, family: 'sfp28', index: 1 },
  { pattern: /^sfp-?(\d+(?:\/\d+)*)$/, family: 'sfp', index: 1 },
  { pattern: /^qsfp-?dd(?:-\d+)?-?(\d+)$/, family: 'qsfpdd', index: 1 },
  { pattern: /^qsfpplus-?(\d+)$/, family: 'qsfpplus', index: 1 },
  { pattern: /^qsfp\+[\s-]*(\d+)$/, family: 'qsfpplus', index: 1 },
  { pattern: /^qsfp28-?(\d+)$/, family: 'qsfp28', index: 1 },
  { pattern: /^qsfp56-?(\d+)$/, family: 'qsfp56', index: 1 },
  { pattern: /^qsfp[\s-]*(\d+)$/, family: 'qsfp', index: 1 },
  { pattern: /^combo-?(\d+)$/, family: 'combo', index: 1 },
  { pattern: /^pon-?(\d+)$/, family: 'pon', index: 1 },
  { pattern: /^ge-?rj45-?(\d+)$/, family: 'geRj45', index: 1 },
  { pattern: /^ge-?sfp-?(\d+)$/, family: 'geSfp', index: 1 },
  { pattern: /^swp(\d+)$/, family: 'swp', index: 1 },
  { pattern: /^(?:mgmt|fxp|me|vme)(\d*)$/, family: 'mgmt', index: 1 },
];

function connectorKey(family: string, index: string): string {
  return index ? `${family}:${index}` : family;
}

/**
 * Classifies an interface name and, when it is a candidate connector, returns
 * its canonical connector key.
 */
export function classifyPhysicalInterface(name: string): PhysicalInterfaceClassification {
  const trimmed = name.trim();
  if (!trimmed) {
    return { classification: 'UNKNOWN', connectorKey: null, breakout: null, reason: 'Nome de interface vazio' };
  }
  if (UNIT_SUFFIX.test(trimmed)) {
    return {
      classification: 'LOGICAL',
      connectorKey: null,
      breakout: null,
      reason: 'Sub-interface (unidade .N) pertence à interface base',
    };
  }
  const base = trimmed.toLowerCase();

  // Breakout lanes point to the cage of the base connector and never create one.
  for (const rule of BREAKOUT_LANE_PATTERNS) {
    const match = rule.pattern.exec(base);
    if (!match) continue;
    const family = match[rule.family] ?? '';
    const cageKey = connectorKey(family, match[rule.cage] ?? '');
    return {
      classification: 'LOGICAL',
      connectorKey: cageKey,
      breakout: { cageKey, lane: Number(match[rule.lane] ?? 0) },
      reason: 'Canal de breakout: pertence ao cage físico, não é um conector extra',
    };
  }
  const colonLane = BREAKOUT_LANE_SUFFIX.exec(base);
  if (colonLane) {
    const cageName = base.slice(0, colonLane.index);
    const cage = classifyPhysicalInterface(cageName);
    return {
      classification: 'LOGICAL',
      connectorKey: cage.connectorKey,
      breakout: cage.connectorKey
        ? { cageKey: cage.connectorKey, lane: Number(colonLane[1] ?? 0) }
        : null,
      reason: 'Canal de breakout (:N): pertence ao cage físico, não é um conector extra',
    };
  }

  if (LOGICAL_FAMILIES.some((pattern) => pattern.test(base))) {
    return {
      classification: 'LOGICAL',
      connectorKey: null,
      breakout: null,
      reason: 'Interface lógica (não é conector do chassi)',
    };
  }
  for (const rule of PHYSICAL_FAMILIES) {
    const match = rule.pattern.exec(base);
    if (!match) continue;
    const index = match[rule.index] ?? '';
    return {
      classification: 'PHYSICAL',
      connectorKey: connectorKey(rule.family, index),
      breakout: null,
      reason: `Conector físico candidato (família ${rule.family})`,
    };
  }
  return {
    classification: 'UNKNOWN',
    connectorKey: null,
    breakout: null,
    reason: 'Nome não reconhecido: não cria conector sem confirmação',
  };
}

/** Cage + lane when the interface is one channel of a breakout. */
export function breakoutLane(
  name: string,
): { cageKey: string; lane: number } | null {
  return classifyPhysicalInterface(name).breakout;
}

/**
 * Name of the physical cage that owns a breakout lane: `qsfp28-1-2` →
 * `qsfp28-1`, `et-0/0/0:1` → `et-0/0/0`. `null` when the name is not a lane.
 */
export function breakoutCageName(name: string): string | null {
  const classified = classifyPhysicalInterface(name);
  if (!classified.breakout) return null;
  const trimmed = name.trim();
  const { lane } = classified.breakout;
  if (new RegExp(`:${lane}$`).test(trimmed)) return trimmed.replace(new RegExp(`:${lane}$`), '');
  return trimmed.replace(new RegExp(`-${lane}$`), '');
}

/** Convenience helper: canonical connector key or `null`. */
export function physicalConnectorKey(name: string): string | null {
  return classifyPhysicalInterface(name).connectorKey;
}

/** True when the interface may be shown as/created into a physical connector. */
export function isPhysicalConnectorCandidate(name: string): boolean {
  return classifyPhysicalInterface(name).classification === 'PHYSICAL';
}
