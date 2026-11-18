import type { HostRecord } from '@gmj/shared';
import { bgpCapabilitiesFor } from './bgp-vendor';
import type {
  BgpPeerConfigurationReading,
  BgpSshDiscoveryProvider,
  BgpSshDiscoveryReading,
} from './bgp-ssh-discovery';
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
    return this.options.huaweiSsh.discover(device);
  }

  /**
   * Só o provider da plataforma pode (e sabe) ler a configuração por peer;
   * quando ele não implementa, o resultado é `null` — nunca uma leitura
   * inventada em equipamento de outro fabricante.
   */
  async readPeerConfiguration(
    device: HostRecord,
  ): Promise<Map<string, BgpPeerConfigurationReading> | null> {
    const provider = this.isJuniper(device) ? this.options.juniperSsh : this.options.huaweiSsh;
    return (await provider.readPeerConfiguration?.(device)) ?? null;
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
