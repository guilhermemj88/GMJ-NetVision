import { createHash, randomUUID } from 'node:crypto';
import type {
  MitigationDirectionChangeDto,
  MitigationDirectionPreviewDto,
  MitigationTelemetryReportDto,
} from '@gmj/shared';
import type { MitigationProfileRecord } from './mitigation-repository';
import { resolveTelemetryDirection } from './mitigation-telemetry';

export class DirectionReviewError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}
export function directionProfileRevision(p: MitigationProfileRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(p)
            .sort()
            .map((k) => [k, p[k as keyof typeof p]]),
        ),
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    )
    .digest('hex');
}
export interface DirectionReviewStore {
  listProfiles(): Promise<MitigationProfileRecord[]>;
  apply(input: {
    id: string;
    actorId: string;
    revisions: Record<string, string>;
    changes: MitigationDirectionChangeDto[];
  }): Promise<void>;
}
type Pending = {
  dto: MitigationDirectionPreviewDto;
  actorId: string;
  revisions: Record<string, string>;
  changes: MitigationDirectionChangeDto[];
};

/** No command/runtime/sweep port. Only non-AUTO profiles may be configured here. */
export class MitigationDirectionReview {
  private readonly previews = new Map<string, Pending>();
  constructor(
    private readonly deps: {
      store: DirectionReviewStore;
      telemetry(): Promise<MitigationTelemetryReportDto>;
      envDirections: Record<string, 'rx' | 'tx'>;
      now?: () => Date;
    },
  ) {}
  async preview(
    actorId: string,
    changes: MitigationDirectionChangeDto[],
  ): Promise<MitigationDirectionPreviewDto> {
    const now = (this.deps.now ?? (() => new Date()))();
    for (const [id, p] of this.previews)
      if (new Date(p.dto.expiresAt) <= now) this.previews.delete(id);
    if (
      !changes.length ||
      changes.length > 100 ||
      new Set(changes.map((c) => c.profileId)).size !== changes.length
    )
      throw new DirectionReviewError('INVALID_DIRECTION_BATCH', 400);
    if (this.previews.size >= 200) throw new DirectionReviewError('TOO_MANY_PREVIEWS', 429);
    const [records, diagnostics] = await Promise.all([
      this.deps.store.listProfiles(),
      this.deps.telemetry(),
    ]);
    const revisions: Record<string, string> = {};
    const rows: MitigationDirectionPreviewDto['changes'] = [];
    for (const change of changes) {
      const p = records.find((p) => p.id === change.profileId);
      if (!p) throw new DirectionReviewError('PROFILE_NOT_FOUND', 404);
      if (p.mode === 'AUTO')
        throw new DirectionReviewError('AUTO_DIRECTION_REQUIRES_SEPARATE_AUTHORIZATION');
      if (change.direction !== null && change.direction !== 'RX' && change.direction !== 'TX')
        throw new DirectionReviewError('INVALID_DIRECTION', 400);
      const d = diagnostics.entries.find((d) => d.profileId === p.id);
      revisions[p.id] = directionProfileRevision(p);
      const resolved = resolveTelemetryDirection(p.id, change.direction, this.deps.envDirections);
      rows.push({
        profileId: p.id,
        customer: null,
        addressFamily: p.addressFamily,
        interfaceName: d?.interfaceName ?? null,
        mode: p.mode,
        before: p.autoTrafficDirection,
        after: change.direction,
        effectiveAfter: resolved.direction,
        sourceAfter: resolved.source,
        impact:
          p.mode === 'DISABLED'
            ? 'DISABLED_PRESERVED'
            : resolved.direction
              ? 'SHADOW_EVALUATION_ONLY'
              : 'DIRECTION_STILL_REQUIRED',
        rxBps: d?.rxBps ?? null,
        txBps: d?.txBps ?? null,
      });
    }
    const dto = {
      previewId: randomUUID(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      changes: rows,
    };
    this.previews.set(dto.previewId, {
      dto,
      actorId,
      revisions,
      changes: changes.map((c) => ({ ...c })),
    });
    return dto;
  }
  async apply(
    actorId: string,
    previewId: string,
    confirmed: boolean,
  ): Promise<{ applied: number }> {
    const pending = this.previews.get(previewId);
    if (!confirmed) throw new DirectionReviewError('EXPLICIT_CONFIRMATION_REQUIRED', 400);
    if (
      !pending ||
      pending.actorId !== actorId ||
      new Date(pending.dto.expiresAt) <= (this.deps.now ?? (() => new Date()))()
    )
      throw new DirectionReviewError('DIRECTION_PREVIEW_EXPIRED');
    // One use, including failure. Re-preview after any concurrent edit.
    this.previews.delete(previewId);
    await this.deps.store.apply({
      id: previewId,
      actorId,
      revisions: pending.revisions,
      changes: pending.changes,
    });
    return { applied: pending.changes.length };
  }
}
