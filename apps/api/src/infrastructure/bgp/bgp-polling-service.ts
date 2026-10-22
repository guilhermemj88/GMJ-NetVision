import type { HostRecord } from '@gmj/shared';
import type { BgpRepository } from './bgp-repository';
import type { BgpSnmpCollector } from './bgp-snmp-collector';

export interface BgpPollOutcome {
  collectedAt: string;
  peers: number;
  error: string | null;
}

/**
 * Polling BGP periódico.
 *
 * Recebe um RESOLVEDOR de coletor: o equipamento escolhe a implementação pela
 * plataforma (Huawei → BGP4-MIB, Juniper → BGP4-V2-MIB-JUNIPER) sem espalhar
 * `if (vendor)` pela aplicação.
 */
export class BgpPollingService {
  private readonly activePolls = new Map<string, Promise<BgpPollOutcome>>();

  constructor(
    private readonly collectorFor: (device: HostRecord) => BgpSnmpCollector | null,
    private readonly repository: BgpRepository,
    private readonly fallbackCollector: BgpSnmpCollector | null = null,
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
    const collector = this.collectorFor(device) ?? this.fallbackCollector;
    if (!collector) {
      // Plataforma sem coletor homologado: não inventa leitura nem erro de rede.
      return { collectedAt: attemptedAt.toISOString(), peers: 0, error: null };
    }
    try {
      const collection = await collector.collect(device.snmp.host, {
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
