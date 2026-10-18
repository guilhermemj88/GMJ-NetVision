import { Prisma, PrismaClient } from '../../../generated/prisma/index.js';
import { prismaClient } from '../../persistence/prisma-client.js';
import { USABLE_TRAFFIC_SAMPLE_SQL } from '../../persistence/traffic-sample-sql';

/**
 * Leitor READ-ONLY da telemetria REAL de interface do NetVision.
 *
 * Origem exata da métrica:
 *   tabela   : "InterfaceMetricSample"
 *   campos   : "rxBps" (Float), "txBps" (Float), "timestamp" (DateTime)
 *   escrita  : polling SNMP (PrismaHostRepository.saveSnmpSample)
 *   leitura  : amostra mais recente por interface (mesma consulta do painel BGP)
 *
 * Nenhum dado de simulação entra aqui: é a medição do equipamento.
 */
export interface InterfaceTrafficRow {
  interfaceId: string;
  rxBps: number;
  txBps: number;
  timestamp: Date;
  sampleId?: string;
  deviceId?: string;
  ifIndex?: number;
  inOctets?: bigint;
  outOctets?: bigint;
  rateStartAt?: Date | null;
  usable?: boolean;
  adminStatus?: string;
  operStatus?: string;
  currentOperStatus?: string;
}

export interface InterfaceTrafficReader {
  latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null>;
}

type RawRow = InterfaceTrafficRow;

export class PrismaInterfaceTrafficReader implements InterfaceTrafficReader {
  constructor(private readonly prisma: PrismaClient = prismaClient) {}

  async latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null> {
    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT m."interfaceId" AS "interfaceId", m."rxBps" AS "rxBps", m."txBps" AS "txBps",
             m."timestamp" AS "timestamp", m."id"::text AS "sampleId", i."deviceId", i."ifIndex",
             m."inOctets", m."outOctets", i."adminStatus", m."operStatus"::text AS "operStatus",
             i."operStatus"::text AS "currentOperStatus",
             (${Prisma.raw(USABLE_TRAFFIC_SAMPLE_SQL)}) AS usable,
             (SELECT p."timestamp" FROM "InterfaceMetricSample" p WHERE p."interfaceId" = m."interfaceId"
               AND p."timestamp" < m."timestamp" ORDER BY p."timestamp" DESC LIMIT 1) AS "rateStartAt"
      FROM "InterfaceMetricSample" m
      JOIN "Interface" i ON i."id" = m."interfaceId"
      WHERE m."interfaceId" = ${interfaceId}
      ORDER BY m."timestamp" DESC
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      interfaceId: row.interfaceId,
      rxBps: Number(row.rxBps),
      txBps: Number(row.txBps),
      timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
    };
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
