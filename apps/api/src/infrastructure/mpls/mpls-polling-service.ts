import type { HostRecord } from '@gmj/shared';
import type { HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { MplsRepository } from './mpls-repository';

export interface MplsPollOutcome {
  supported: boolean | null;
  collectedAt: string;
  error: string | null;
}

export class MplsPollingService {
  constructor(
    private readonly collector: HuaweiVplsSnmpCollector,
    private readonly repository: MplsRepository,
  ) {}

  async poll(device: HostRecord, community: string): Promise<MplsPollOutcome> {
    const attemptedAt = new Date();
    if (!device.snmpEnabled || !device.snmp?.host || device.snmp.version !== 'SNMP_V2C') {
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: null };
    }
    try {
      const collection = await this.collector.collect(device.snmp.host, {
        community,
        version: 'v2c',
        port: device.snmp.port,
      });
      await this.repository.saveCollection(device.id, collection);
      return {
        supported: collection.supported,
        collectedAt: collection.collectedAt.toISOString(),
        error: null,
      };
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : 'Falha na coleta MPLS via SNMP';
      await this.repository.saveFailure(device.id, attemptedAt, safeMessage);
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: safeMessage };
    }
  }
}
