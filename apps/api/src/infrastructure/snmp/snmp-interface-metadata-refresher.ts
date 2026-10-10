import type { HostRecord } from '@gmj/shared';
import type {
  MitigationInterfaceMetadataRefresh,
  MitigationInterfaceMetadataRefresher,
} from '../bgp/mitigation/mitigation-interface-refresher';
import type { SnmpService } from './snmp-service';

/**
 * Adapter da porta de refresh: reusa o SnmpService (SNMP IF-MIB + SSH
 * `display interface description`) SEM coleta optica por interface.
 */
export class SnmpInterfaceMetadataRefresher implements MitigationInterfaceMetadataRefresher {
  constructor(
    private readonly snmp: Pick<SnmpService, 'discoverAndPersistInterfaceMetadata'>,
  ) {}

  async refresh(device: HostRecord): Promise<MitigationInterfaceMetadataRefresh> {
    const interfaces = await this.snmp.discoverAndPersistInterfaceMetadata(device);
    return { interfaces: interfaces.length };
  }
}
