import type { HostRecord } from '@gmj/shared';
import { bgpCapabilitiesFor, isHuaweiVrpDevice } from './bgp-vendor';
import type { BgpSshDiscoveryProvider, BgpSshDiscoveryReading } from './bgp-ssh-discovery';
import type { BgpSnmpCollector } from './bgp-snmp-collector';

export interface BgpPlatformProvidersOptions {
  huaweiSsh: BgpSshDiscoveryProvider;
  juniperSsh: BgpSshDiscoveryProvider;
  huaweiSnmp: BgpSnmpCollector;
  juniperSnmp: BgpSnmpCollector;
}

/**
 * ÚNICO lugar que traduz plataforma → implementação.
 *
 * Fora daqui, a aplicação só conhece `BgpSshDiscoveryProvider` e
 * `BgpSnmpCollector`; nenhum `if (vendor.includes(...))` é espalhado.
 *
 * Plataforma não homologada mantém o comportamento LEGADO (Huawei BGP4-MIB):
 * é o que já acontecia antes e não introduz leitura nova em equipamento
 * desconhecido. Juniper só é usada quando o cadastro diz Juniper.
 */
export class BgpPlatformProviders implements BgpSshDiscoveryProvider {
  constructor(private readonly options: BgpPlatformProvidersOptions) {}

  async discover(device: HostRecord): Promise<BgpSshDiscoveryReading> {
    if (this.isJuniper(device)) return this.options.juniperSsh.discover(device);
    // P4 (2a auditoria): descoberta BGP envia CLI Huawei. Plataforma nao
    // homologada (OLT, fabricante ausente ou contraditorio) nao abre sessao —
    // devolve leitura vazia com aviso em vez de cair no transporte Huawei.
    if (!isHuaweiVrpDevice(device)) {
      return {
        peers: [],
        localAs: null,
        localAsAmbiguous: false,
        ipv6Supported: false,
        logicalUnitFallback: false,
        warnings: [
          'Plataforma nao homologada para CLI BGP (fabricante/modelo); nenhum comando foi enviado',
        ],
      };
    }
    return this.options.huaweiSsh.discover(device);
  }

  /** Coletor do polling periódico para este equipamento. */
  snmpFor(device: HostRecord): BgpSnmpCollector {
    if (this.isJuniper(device)) return this.options.juniperSnmp;
    return this.options.huaweiSnmp;
  }

  /** `true` quando o equipamento tem perfil Junos homologado (read-only). */
  isJuniper(device: Pick<HostRecord, 'vendor' | 'model'>): boolean {
    return bgpCapabilitiesFor(device.vendor, device.model).platform === 'JUNIPER_JUNOS';
  }
}
