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

/**
 * Probe da tabela da exclusao PREVENTIVA por peer.
 *
 * Ela nasce em migration propria (20260930200000) e pode nao estar aplicada
 * mesmo com o schema do perfil pronto. Enquanto isso, essas escritas ficam no
 * espelho em memoria e a UI mostra `persisted: false` - nunca falha aberta.
 */
export interface BgpMitigationPeerExclusionSchemaProbe {
  probe(): Promise<boolean>;
}

export class PrismaMitigationPeerExclusionSchemaProbe
  implements BgpMitigationPeerExclusionSchemaProbe
{
  constructor(private readonly prisma = new PrismaClient()) {}

  async probe(): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<{ present: boolean | null }[]>`
        SELECT to_regclass('public."BgpMitigationPeerExclusion"') IS NOT NULL AS present
      `;
      return rows[0]?.present === true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Em DEMO_MODE o repositorio e em memoria: a tabela nunca e exigida. */
export class AlwaysReadyMitigationPeerExclusionSchemaProbe
  implements BgpMitigationPeerExclusionSchemaProbe
{
  async probe(): Promise<boolean> {
    return true;
  }
}
