import type { SnmpVarBind } from '../../domain/ports';
import { selectSnmpProfile } from './profiles/catalog';
import type {
  SnmpCandidateAttempt,
  SnmpMetricCandidate,
  SnmpProfileDiagnostic,
  SnmpProfileIdentity,
  SnmpProfileMetricName,
} from './profiles/types';

interface ProfileSnmpClient {
  walk(
    host: string,
    oid: string,
    options: { community: string; version: 'v2c'; port: number },
  ): Promise<SnmpVarBind[]>;
}

interface SnmpConnectionOptions {
  community: string;
  version: 'v2c';
  port: number;
}

function oidSuffix(oid: string, base: string): string {
  return oid.slice(base.length).replace(/^\./, '');
}

export function parseValidatedMetricValue(
  value: string | number | Uint8Array,
  candidate: Pick<SnmpMetricCandidate, 'scale' | 'validRange'>,
): number | null {
  const raw = value instanceof Uint8Array
    ? Number(Buffer.from(value).toString('utf8').trim())
    : Number(value);
  const scaled = raw * candidate.scale;
  return Number.isFinite(scaled)
    && scaled >= candidate.validRange.min
    && scaled <= candidate.validRange.max
    ? scaled
    : null;
}

export class SnmpProfileMetricService {
  private readonly selectedCandidates = new Map<string, string>();
  private readonly diagnostics = new Map<string, SnmpProfileDiagnostic>();

  constructor(private readonly client: ProfileSnmpClient) {}

  getDiagnostic(deviceId: string): SnmpProfileDiagnostic | null {
    return this.diagnostics.get(deviceId) ?? null;
  }

  async collect(
    deviceId: string,
    host: string,
    options: SnmpConnectionOptions,
    identity: SnmpProfileIdentity,
  ): Promise<{ cpuPercent?: number; diagnostic: SnmpProfileDiagnostic }> {
    const profile = selectSnmpProfile(identity);
    const diagnostic: SnmpProfileDiagnostic = {
      deviceId,
      profileId: profile.id,
      identity,
      metrics: {},
      checkedAt: new Date().toISOString(),
    };
    const result: { cpuPercent?: number; diagnostic: SnmpProfileDiagnostic } = { diagnostic };

    for (const metricName of ['cpu'] satisfies SnmpProfileMetricName[]) {
      const definition = profile.metrics[metricName];
      if (!definition) continue;
      const cacheKey = `${deviceId}:${metricName}`;
      const cachedOid = this.selectedCandidates.get(cacheKey);
      const candidates = [...definition.candidates].sort((left, right) =>
        Number(right.oid === cachedOid) - Number(left.oid === cachedOid),
      );
      const attempts: SnmpCandidateAttempt[] = [];
      let selectedValue: number | null = null;
      let selectedOid: string | null = null;

      for (const candidate of candidates) {
        const attempt = await this.tryCandidate(host, options, candidate);
        attempts.push(attempt);
        if (attempt.status !== 'SELECTED' || attempt.value === undefined) continue;
        selectedValue = attempt.value;
        selectedOid = candidate.oid;
        this.selectedCandidates.set(cacheKey, candidate.oid);
        break;
      }
      diagnostic.metrics[metricName] = {
        attempts,
        selectedOid,
        value: selectedValue,
        unit: definition.unit,
      };
      if (metricName === 'cpu' && selectedValue !== null) result.cpuPercent = selectedValue;
    }

    this.diagnostics.set(deviceId, diagnostic);
    return result;
  }

  private async tryCandidate(
    host: string,
    options: SnmpConnectionOptions,
    candidate: SnmpMetricCandidate,
  ): Promise<SnmpCandidateAttempt> {
    try {
      const rows = await this.client.walk(host, candidate.oid, options);
      const valid = rows.flatMap((row) => {
        const value = parseValidatedMetricValue(row.value, candidate);
        return value === null ? [] : [{ index: oidSuffix(row.oid, candidate.oid), value }];
      });
      if (!rows.length) return { oid: candidate.oid, status: 'NO_DATA', rows: 0 };
      if (!valid.length) return { oid: candidate.oid, status: 'INVALID_VALUE', rows: rows.length };

      if (candidate.selection === 'SINGLE_VALID_ROW') {
        return valid.length === 1
          ? { oid: candidate.oid, status: 'SELECTED', value: valid[0]!.value, rows: rows.length }
          : { oid: candidate.oid, status: 'AMBIGUOUS', rows: valid.length };
      }

      const entityNames = candidate.entityNameOid
        ? await this.client.walk(host, candidate.entityNameOid, options)
        : [];
      const names = new Map(entityNames.map((row) => [
        oidSuffix(row.oid, candidate.entityNameOid!),
        row.value instanceof Uint8Array
          ? Buffer.from(row.value).toString('utf8').trim()
          : String(row.value).trim(),
      ]));
      for (const pattern of candidate.preferredEntityPatterns ?? []) {
        const preferred = valid.filter((row) => pattern.test(names.get(row.index) ?? ''));
        if (preferred.length === 1) {
          return {
            oid: candidate.oid,
            status: 'SELECTED',
            value: preferred[0]!.value,
            rows: rows.length,
          };
        }
        if (preferred.length > 1) return { oid: candidate.oid, status: 'AMBIGUOUS', rows: preferred.length };
      }
      return valid.length === 1
        ? { oid: candidate.oid, status: 'SELECTED', value: valid[0]!.value, rows: rows.length }
        : { oid: candidate.oid, status: 'AMBIGUOUS', rows: valid.length };
    } catch {
      return { oid: candidate.oid, status: 'ERROR' };
    }
  }
}
