import type { PrismaClient } from '../../../generated/prisma/index.js';
import type {
  MitigationAutoEngineDeps,
  MitigationAutoDecision,
} from '../../../worker/mitigation/mitigation-auto-engine';
import type { MitigationRepository } from './mitigation-repository';
import type { MitigationState } from './mitigation-types';
import type { FastObservationSource } from '../../../worker/mitigation/fast-observation-bridge';

/** Separate shadow state; never writes BgpMitigationRuntime, profile or actuator. */
type ShadowRuntimePort = MitigationAutoEngineDeps['runtime'];
export class PrismaFastShadowRuntime implements ShadowRuntimePort {
  constructor(
    private readonly db: PrismaClient,
    private readonly repository: Pick<MitigationRepository, 'getRuntime'>,
  ) {}
  async get(profileId: string) {
    const [shadow, physical] = await Promise.all([
      this.db.mitigationFastShadowState.findUnique({ where: { profileId } }),
      this.repository.getRuntime(profileId),
    ]);
    const physicalState = physical?.state;
    return {
      state:
        physicalState &&
        !['NORMAL', 'TRIGGER_PENDING', 'ALERT_ONLY', 'DISABLED'].includes(physicalState)
          ? physicalState
          : ((shadow?.state ?? 'NORMAL') as MitigationState),
      triggerCounter: shadow?.triggerCounter ?? 0,
      recoveryCounter: shadow?.recoveryCounter ?? 0,
      lastSampleAt: shadow?.lastSampleAt ?? null,
    };
  }
  async save(profileId: string, patch: Parameters<MitigationAutoEngineDeps['runtime']['save']>[1]) {
    await this.db.mitigationFastShadowState.upsert({
      where: { profileId },
      create: { profileId, ...patch },
      update: patch,
    });
  }
}

export async function recordFastBridgeDecisions(
  db: PrismaClient,
  mode: 'SHADOW' | 'ENFORCE',
  decisions: MitigationAutoDecision[],
  source: FastObservationSource,
) {
  for (const decision of decisions) {
    const sample = source.status().find((e) => e.profileId === decision.profileId);
    if (!sample?.sampleId || !sample.sampleAt) continue;
    // First decision per profile/source sample/mode is immutable. Repeated ticks do not create confirmations or audit spam.
    await db.mitigationFastDecision.upsert({
      where: {
        profileId_mode_sampleId: { profileId: decision.profileId, mode, sampleId: sample.sampleId },
      },
      create: {
        profileId: decision.profileId,
        mode,
        sampleId: sample.sampleId,
        sampleAt: new Date(sample.sampleAt),
        outcome: decision.outcome,
        reason: decision.reason,
        decision: JSON.parse(
          JSON.stringify({ ...decision, telemetrySource: 'FAST', mode, sample }),
        ),
      },
      update: {},
    });
  }
}
