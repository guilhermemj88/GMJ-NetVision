import { PrismaClient } from '../../generated/prisma/index.js';

// A migration da Fase 9 (camada de midias) e preparada mas NAO aplicada em
// producao. O probe responde read-only se as tabelas existem, sem nunca
// derrubar a API: qualquer falha vira "nao pronto".
export interface MediaSchemaProbe {
  probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }>;
}

export class PrismaMediaSchemaProbe implements MediaSchemaProbe {
  constructor(private readonly prisma = new PrismaClient()) {}

  async probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }> {
    try {
      const rows = await this.prisma.$queryRaw<{ present: boolean | null }[]>`
        SELECT (
          to_regclass('public."MediaIntegration"') IS NOT NULL
          AND to_regclass('public."MediaDeliveryLog"') IS NOT NULL
        ) AS present
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
export class AlwaysReadyMediaSchemaProbe implements MediaSchemaProbe {
  async probe(): Promise<{ migrationReady: boolean; databaseReady: boolean }> {
    return { migrationReady: true, databaseReady: true };
  }
}
