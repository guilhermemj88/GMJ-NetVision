import { Prisma, PrismaClient } from '../../../generated/prisma/index.js';

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
}

export interface InterfaceTrafficReader {
  latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null>;
}

type RawRow = { interfaceId: string; rxBps: number; txBps: number; timestamp: Date };

export class PrismaInterfaceTrafficReader implements InterfaceTrafficReader {
  constructor(private readonly prisma = new PrismaClient()) {}

  async latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null> {
    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT m."interfaceId" AS "interfaceId", m."rxBps" AS "rxBps", m."txBps" AS "txBps",
             m."timestamp" AS "timestamp"
      FROM "InterfaceMetricSample" m
      WHERE m."interfaceId" = ${interfaceId}
      ORDER BY m."timestamp" DESC
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
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