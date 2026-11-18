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

/**
 * Prefixos de modelo que identificam a plataforma. Servem para detectar
 * CONTRADICAO entre fabricante e modelo (M2): "Huawei + MX204" e "Juniper +
 * NE8000" nao identificam plataforma nenhuma — e o codigo falha fechado em vez
 * de mandar comando Huawei para o equipamento errado.
 */
const JUNIPER_MODEL = /^(?:MX|ACX|EX|QFX|SRX|PTX)\d/;
const HUAWEI_MODEL = /^(?:S\d|NE\d|CE\d|AR\d|USG|MA\d|EA\d|CX\d)/;

export function bgpPlatformFor(
  vendor: string | null | undefined,
  model: string | null | undefined,
): BgpPlatform {
  const vendorValue = (vendor ?? '').trim().toLowerCase();
  const modelValue = (model ?? '').trim().toUpperCase();

  if (/^huawei/.test(vendorValue)) {
    return JUNIPER_MODEL.test(modelValue) ? 'UNSUPPORTED' : 'HUAWEI_VRP';
  }
  if (/junos|juniper/.test(vendorValue)) {
    return HUAWEI_MODEL.test(modelValue) ? 'UNSUPPORTED' : 'JUNIPER_JUNOS';
  }
  // Fabricante ausente ou desconhecido NUNCA e homologado — nem com modelo que
  // "parece" de uma plataforma conhecida: modelo sozinho nao identifica vendor.
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

/**
 * Modelos Huawei que NAO sao VRP de switch/roteador: OLT (MA5600/MA5800),
 * BRAS/EA, CX e ME respondem a outra CLI e nao devem receber comando VRP.
 */
const NON_VRP_MODEL = /^(?:MA\d{3,}|EA\d{3,}|CX\d{3,}|ME\d{3,})/;

/**
 * `true` somente quando o equipamento e comprovadamente um Huawei VRP de
 * switch/roteador. Usado por tudo que ENVIA comando Huawei (administracao BGP,
 * mitigacao e fallback CLI do MPLS): vendor ausente ou contraditorio, OLT e
 * modelo nao-VRP resultam em `false` (fail-closed).
 */
export function isHuaweiVrpDevice(device: {
  vendor?: string | null;
  model?: string | null;
  deviceType?: string | null;
}): boolean {
  if (device.deviceType === 'olt') return false;
  if (NON_VRP_MODEL.test((device.model ?? '').trim().toUpperCase())) return false;
  return bgpPlatformFor(device.vendor, device.model) === 'HUAWEI_VRP';
}
