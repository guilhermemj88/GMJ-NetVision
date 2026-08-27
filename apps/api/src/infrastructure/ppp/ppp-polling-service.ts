import type { HostRecord, PppSource } from '@gmj/shared';
import type { SnmpProfileIdentity } from '../snmp/profiles/types';
import { selectSnmpProfile } from '../snmp/profiles/catalog';
import type { PppRepository } from './ppp-repository';

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
  constructor(
    private readonly client: PppScalarClient,
    private readonly repository: PppRepository,
  ) {}

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
