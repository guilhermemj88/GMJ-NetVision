import { Prisma, type PrismaClient } from '../../../generated/prisma/index.js';
import { USABLE_TRAFFIC_SAMPLE_SQL } from '../../persistence/traffic-sample-sql';
import type { DiagnosticInterface } from './mitigation-telemetry';

export class PrismaMitigationTelemetryReader {
  constructor(private readonly db: PrismaClient) {}
  async readInterface(id: string): Promise<DiagnosticInterface | null> {
    const rows = await this.db.$queryRaw<
      (Omit<DiagnosticInterface, 'sample'> & {
        sampleId: string | null;
        timestamp: Date | null;
        rxBps: number;
        txBps: number;
        usable: boolean;
        sampleOperStatus: string;
      })[]
    >(Prisma.sql`
      SELECT i.id, i."deviceId", i.name, i."ifIndex", i."adminStatus", i."operStatus"::text,
        m.id::text AS "sampleId", m.timestamp, m."rxBps", m."txBps", m."operStatus"::text AS "sampleOperStatus",
        (${Prisma.raw(USABLE_TRAFFIC_SAMPLE_SQL)}) AS usable
      FROM "Interface" i LEFT JOIN LATERAL (
        SELECT * FROM "InterfaceMetricSample" s WHERE s."interfaceId" = i.id ORDER BY s.timestamp DESC, s.id DESC LIMIT 1
      ) m ON true WHERE i.id = ${id}
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      deviceId: row.deviceId,
      name: row.name,
      ifIndex: row.ifIndex,
      adminStatus: row.adminStatus,
      operStatus: row.operStatus,
      sample:
        row.sampleId && row.timestamp
          ? {
              id: row.sampleId,
              at: row.timestamp,
              rx: row.rxBps,
              tx: row.txBps,
              usable: row.usable,
              operStatus: row.sampleOperStatus,
            }
          : null,
    };
  }
}
