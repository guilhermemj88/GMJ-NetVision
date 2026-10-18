import type { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaObserverTrafficStore } from './prisma-observer-traffic-store';
import type {
  FastBridgeReader,
  FastBridgeMapping,
} from '../../worker/mitigation/fast-observation-bridge';

export interface ObserverHealthProof {
  observationOnly?: boolean;
  executionAvailable?: boolean;
  healthy?: boolean;
  mode?: string;
  running?: boolean;
  entries?: Array<{
    deviceId: string;
    interfaceId: string;
    profileIds: string[];
    quality: string;
    lastCollectedAt: string | null;
    lastValidAt: string | null;
  }>;
}
export async function readObserverHealth(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<ObserverHealthProof> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== '/health' ||
    parsed.username ||
    parsed.password ||
    parsed.search
  )
    throw Error('Observer health must be explicit loopback /health');
  const response = await fetcher(url, { signal: AbortSignal.timeout(800), redirect: 'error' });
  if (!response.ok) throw Error('Observer health unavailable');
  return response.json() as Promise<ObserverHealthProof>;
}

/** Two databases, no joins or baseline transfer. A SHARE lock binds each read to live inventory. */
export class PrismaFastBridgeReader implements FastBridgeReader {
  constructor(
    private readonly operational: PrismaClient,
    private readonly observation: PrismaClient,
    private readonly health: () => Promise<ObserverHealthProof>,
  ) {}
  async snapshot(interfaceId: string, profileId: string) {
    return this.operational.$transaction(
      async (tx) => {
        const mappings = await tx.$queryRaw<
          FastBridgeMapping[]
        >`SELECT id, "deviceId", name, "ifIndex", "adminStatus", "operStatus"::text, "speedBps" FROM "Interface" WHERE id = ${interfaceId} FOR SHARE`;
        const mapping = mappings[0] ?? null;
        const proof = await this.health();
        const rows = await this.observation.$transaction(
          async (source) => {
            const settings = await source.$queryRaw<
              Array<{ transaction_read_only: string }>
            >`SHOW transaction_read_only`;
            if (settings[0]?.transaction_read_only !== 'on')
              throw Error('Observation reader must use a database-enforced read-only role');
            return source.mitigationTrafficObservation.findMany({
              where: { interfaceId },
              orderBy: { collectedAt: 'desc' },
              take: 2,
            });
          },
          { timeout: 1500 },
        );
        const mapped = rows.map((row) => PrismaObserverTrafficStore.toObservation(row));
        const current = mapped[0] ?? null,
          previous = mapped[1] ?? null;
        const entry = proof.entries?.find(
          (e) =>
            e.interfaceId === interfaceId &&
            e.deviceId === mapping?.deviceId &&
            e.profileIds.includes(profileId),
        );
        const collectorAvailable =
          proof.observationOnly === true &&
          proof.executionAvailable === false &&
          proof.healthy === true &&
          proof.running === true &&
          proof.mode === 'OBSERVE' &&
          entry?.quality === 'VALID' &&
          !!current &&
          entry.lastCollectedAt === current.collectedAt.toISOString() &&
          entry.lastValidAt === entry.lastCollectedAt;
        return { mapping, current, previous, collectorAvailable };
      },
      { timeout: 3000 },
    );
  }
}
