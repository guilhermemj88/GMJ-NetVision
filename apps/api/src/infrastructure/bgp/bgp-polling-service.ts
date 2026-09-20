import type { HostRecord } from '@gmj/shared';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSnmpCollector } from './huawei-bgp-snmp';

export interface BgpPollOutcome {
  collectedAt: string;
  peers: number;
  error: string | null;
}

export class BgpPollingService {
  private readonly activePolls = new Map<string, Promise<BgpPollOutcome>>();

  constructor(
    private readonly collector: HuaweiBgpSnmpCollector,
    private readonly repository: BgpRepository,
  ) {}

  async poll(device: HostRecord, community: string): Promise<BgpPollOutcome> {
    const running = this.activePolls.get(device.id);
    if (running) return running;
    const poll = this.pollUnlocked(device, community).finally(() => {
      if (this.activePolls.get(device.id) === poll) this.activePolls.delete(device.id);
    });
    this.activePolls.set(device.id, poll);
    return poll;
  }

  private async pollUnlocked(device: HostRecord, community: string): Promise<BgpPollOutcome> {
    const attemptedAt = new Date();
    if (!device.snmpEnabled || !device.snmp?.host || device.snmp.version !== 'SNMP_V2C') {
      return { collectedAt: attemptedAt.toISOString(), peers: 0, error: null };
    }
    try {
      const collection = await this.collector.collect(device.snmp.host, {
        community,
        version: 'v2c',
        port: device.snmp.port,
      });
      await this.repository.saveCollection(device.id, collection);
      return {
        collectedAt: collection.collectedAt.toISOString(),
        peers: collection.peers.length,
        error: collection.errors.length ? collection.errors.join('; ') : null,
      };
    } catch (error) {
      return {
        collectedAt: attemptedAt.toISOString(),
        peers: 0,
        error: error instanceof Error ? error.message : 'Falha na coleta BGP via SNMP',
      };
    }
  }
}
