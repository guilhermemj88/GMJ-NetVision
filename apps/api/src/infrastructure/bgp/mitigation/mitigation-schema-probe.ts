import { PrismaClient } from '../../../generated/prisma/index.js';

// A migration da mitigacao ainda NAO esta aplicada em producao. O probe responde
// read-only se as tabelas existem, sem nunca derrubar a API: qualquer falha
// (banco fora, tabela ausente) vira "nao pronto" em vez de excecao.
export interface BgpMitigationSchemaProbe {
  probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }>;
}

export class PrismaMitigationSchemaProbe implements BgpMitigationSchemaProbe {
  constructor(private readonly prisma = new PrismaClient()) {}

  async probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }> {
    try {
      const rows = await this.prisma.$queryRaw<{ present: boolean | null }[]>`
        SELECT to_regclass('public."BgpMitigationProfile"') IS NOT NULL AS present
      `;
      return { migrationReady: rows[0]?.present === true, databaseReady: true };
    } catch {
      return { migrationReady: false, databaseReady: false };
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Em DEMO_MODE o repositorio e em memoria: nada depende de migration. */
export class AlwaysReadyMitigationSchemaProbe implements BgpMitigationSchemaProbe {
  async probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }> {
    return { migrationReady: true, databaseReady: true };
  }
}
