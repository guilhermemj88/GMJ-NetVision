import type { HostRecord, PppSource } from '@gmj/shared';
import type { SnmpProfileIdentity } from '../snmp/profiles/types';
import { selectSnmpProfile } from '../snmp/profiles/catalog';
import type { PppRepository } from './ppp-repository';
import {
  JuniperPppSubscriberCollector,
  type PppWalkClient,
} from './juniper-ppp-subscriber-collector';

export interface PppScalarClient {
  get(
    host: string,
    oids: string[],
    options: { community: string; version: 'v2c'; port: number },
  ): Promise<Array<{ oid: string; value: string | number | Uint8Array }>>;
}

export interface PppPollOutcome {
  supported: boolean | null;
  collectedAt: string;
  error: string | null;
}

function toNonNegativeInteger(value: string | number | Uint8Array | undefined): number | null {
  if (value === undefined) return null;
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    parsed = Number(value.trim());
  } else {
    parsed = Number(Buffer.from(value).toString('utf8').trim());
  }
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function pppSourceFor(vendor: string | undefined): PppSource | null {
  const normalized = (vendor ?? '').toLowerCase();
  if (normalized.includes('mikrotik')) return 'SNMP_MIKROTIK';
  if (normalized.includes('huawei')) return 'SNMP_HUAWEI';
  return null;
}

/**
 * Polls the PPP/PPPoE online counter for a host in the same operational cycle
 * as the rest of the SNMP polling (no independent per-host loop is created).
 *
 * Capability detection is profile based: the selected vendor profile declares
 * the scalar OID when (and only when) it is validated. A timeout or read error
 * is reported as a failure without touching the last valid value; a device
 * whose profile has no PPP OID is marked unsupported.
 */
export class PppPollingService {
  private readonly subscriberCollector: JuniperPppSubscriberCollector | null;

  constructor(
    private readonly client: PppScalarClient,
    private readonly repository: PppRepository,
    walkClient?: PppWalkClient,
  ) {
    this.subscriberCollector = walkClient
      ? new JuniperPppSubscriberCollector(walkClient)
      : null;
  }

  private async pollSubscriberTable(
    device: HostRecord,
    community: string,
    table: NonNullable<ReturnType<typeof selectSnmpProfile>['pppSubscriberTable']>,
    attemptedAt: Date,
  ): Promise<PppPollOutcome> {
    if (!this.subscriberCollector) {
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: null };
    }
    const result = await this.subscriberCollector.collect(
      { deviceId: device.id, host: device.snmp!.host, port: device.snmp!.port },
      community,
      table,
    );
    if (result === null) {
      // Janela de 300 s ainda nao vencida ou coleta anterior em andamento:
      // nao faz walk, nao grava failure e nao toca pppUpdatedAt.
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: null };
    }
    if (result.online === null) {
      await this.repository.saveFailure(
        device.id,
        attemptedAt,
        result.error ?? 'Falha na coleta PPP via subscriber table',
      );
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: result.error };
    }
    await this.repository.saveReading(device.id, {
      supported: true,
      online: result.online,
      source: table.source,
      updatedAt: attemptedAt,
    });
    return { supported: true, collectedAt: attemptedAt.toISOString(), error: null };
  }

  async poll(
    device: HostRecord,
    community: string,
    identity: SnmpProfileIdentity,
  ): Promise<PppPollOutcome> {
    const attemptedAt = new Date();
    if (!device.snmpEnabled || !device.snmp?.host || device.snmp.version !== 'SNMP_V2C') {
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: null };
    }

    const profile = selectSnmpProfile(identity);

    // Estrategia por subscriber table (Juniper). Nao existe scalar de PPPoE
    // online nessa familia, entao a capability declara os dois OIDs da tabela.
    const table = profile.pppSubscriberTable;
    if (table) {
      return this.pollSubscriberTable(device, community, table, attemptedAt);
    }

    const oid = profile.pppOnlineOid;
    if (!oid) {
      await this.repository.markUnsupported(device.id, attemptedAt);
      return { supported: false, collectedAt: attemptedAt.toISOString(), error: null };
    }

    const source = pppSourceFor(profile.vendor);
    if (!source) {
      await this.repository.markUnsupported(device.id, attemptedAt);
      return { supported: false, collectedAt: attemptedAt.toISOString(), error: null };
    }

    try {
      const rows = await this.client.get(device.snmp.host, [oid], {
        community,
        version: 'v2c',
        port: device.snmp.port,
      });
      const online = toNonNegativeInteger(rows[0]?.value);
      if (online === null) {
        // The device answered but with an invalid value; preserve last valid.
        await this.repository.saveFailure(device.id, attemptedAt, 'Valor PPP inválido via SNMP');
        return { supported: null, collectedAt: attemptedAt.toISOString(), error: 'invalid value' };
      }
      await this.repository.saveReading(device.id, {
        supported: true,
        online,
        source,
        updatedAt: attemptedAt,
      });
      return { supported: true, collectedAt: attemptedAt.toISOString(), error: null };
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : 'Falha na coleta PPP via SNMP';
      await this.repository.saveFailure(device.id, attemptedAt, safeMessage);
      return { supported: null, collectedAt: attemptedAt.toISOString(), error: safeMessage };
    }
  }
}
