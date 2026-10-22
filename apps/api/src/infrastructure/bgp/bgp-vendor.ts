/** Plataformas BGP suportadas. Qualquer outra coisa é NÃO SUPORTADA. */
export type BgpPlatform = 'HUAWEI_VRP' | 'JUNIPER_JUNOS' | 'UNSUPPORTED';

/**
 * Capacidades por plataforma. Conhecer o AS local de um peer NUNCA habilita
 * comando administrativo: Juniper é READ-ONLY nesta fase.
 */
export interface BgpCapabilities {
  platform: BgpPlatform;
  /** Coletor SNMP periódico. */
  snmpCollector: 'BGP4_MIB' | 'BGP4_V2_JUNIPER' | null;
  sshDiscovery: boolean;
  /** Habilitar/desabilitar vizinho (escrita). */
  adminActions: boolean;
  /** Consulta de rotas anunciadas (somente leitura). */
  advertisedRoutes: boolean;
  /** Mitigação DDoS (escrita). */
  mitigation: boolean;
}

const HUAWEI: BgpCapabilities = {
  platform: 'HUAWEI_VRP',
  snmpCollector: 'BGP4_MIB',
  sshDiscovery: true,
  adminActions: true,
  advertisedRoutes: true,
  mitigation: true,
};

const JUNIPER: BgpCapabilities = {
  platform: 'JUNIPER_JUNOS',
  snmpCollector: 'BGP4_V2_JUNIPER',
  sshDiscovery: true,
  adminActions: false,
  advertisedRoutes: true,
  mitigation: false,
};

const UNSUPPORTED: BgpCapabilities = {
  platform: 'UNSUPPORTED',
  snmpCollector: null,
  sshDiscovery: false,
  adminActions: false,
  advertisedRoutes: false,
  mitigation: false,
};

export function bgpPlatformFor(
  vendor: string | null | undefined,
  model: string | null | undefined,
): BgpPlatform {
  const vendorValue = (vendor ?? '').trim().toLowerCase();
  const modelValue = (model ?? '').trim().toUpperCase();
  if (/^huawei/.test(vendorValue)) return 'HUAWEI_VRP';
  if (/junos|juniper/.test(vendorValue)) return 'JUNIPER_JUNOS';
  // Modelo sozinho não homologa: só aceitamos MX/ACX/EX quando o vendor já é Juniper.
  if (!vendorValue && /^(?:MX|ACX|EX|QFX|SRX)\d/.test(modelValue)) return 'UNSUPPORTED';
  return 'UNSUPPORTED';
}

export function bgpCapabilitiesFor(
  vendor: string | null | undefined,
  model: string | null | undefined,
): BgpCapabilities {
  switch (bgpPlatformFor(vendor, model)) {
    case 'HUAWEI_VRP':
      return HUAWEI;
    case 'JUNIPER_JUNOS':
      return JUNIPER;
    default:
      return UNSUPPORTED;
  }
}
