import type { PppSource } from '@gmj/shared';

export interface PppReadingInput {
  supported: boolean;
  online: number;
  source: PppSource;
  updatedAt: Date;
}

/**
 * Persistence contract for PPP/PPPoE online capability state.
 *
 * A collection failure must never erase the last valid reading, so the
 * repository exposes three distinct operations: a successful reading, an
 * explicit "unsupported" marker and a failure record (which leaves the last
 * valid value untouched).
 */
export interface PppRepository {
  saveReading(hostId: string, input: PppReadingInput): Promise<void>;
  markUnsupported(hostId: string, at: Date): Promise<void>;
  saveFailure(hostId: string, at: Date, safeMessage: string): Promise<void>;
  disconnect?(): Promise<void>;
}
