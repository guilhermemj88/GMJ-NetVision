import type { HostRecord } from '@gmj/shared';
import type { HuaweiBgpConfigReading, HuaweiBgpSshService } from '../huawei-bgp-ssh';

/**
 * Porta read-only para a configuração necessária ao discovery de mitigação.
 *
 * `null` significa "não foi possível ler" — nunca "vazio". O discovery usa essa
 * distinção para decidir entre POLICY_NOT_FOUND (config lida, policy ausente) e
 * READBACK_FAILED (não deu para confiar na leitura).
 */
export interface BgpMitigationConfigSnapshot {
  bgpConfiguration: string | null;
  routePolicyConfiguration: string | null;
  warnings: string[];
}

export interface BgpMitigationConfigSource {
  /** Uma leitura agregada por device — nunca um comando por peer. */
  readMitigationConfig(device: HostRecord): Promise<BgpMitigationConfigSnapshot>;
}

export class HuaweiBgpMitigationConfigSource implements BgpMitigationConfigSource {
  constructor(private readonly bgp: Pick<HuaweiBgpSshService, 'readBgpConfiguration'>) {}

  async readMitigationConfig(device: HostRecord): Promise<BgpMitigationConfigSnapshot> {
    const reading: HuaweiBgpConfigReading = await this.bgp.readBgpConfiguration(device);
    return {
      bgpConfiguration: reading.bgpConfiguration,
      routePolicyConfiguration: reading.routePolicyConfiguration,
      warnings: [...reading.warnings],
    };
  }
}
