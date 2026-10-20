import { createHash, randomUUID } from 'node:crypto';
import type {
  MitigationDirectionChangeDto,
  MitigationDirectionPreviewDto,
  MitigationInterfaceDirectionChangeDto,
  MitigationInterfaceDirectionPreviewRow,
  MitigationTelemetryReportDto,
} from '@gmj/shared';
import type { MitigationProfileRecord } from './mitigation-repository';
import { resolveTelemetryDirection } from './mitigation-telemetry';
import type { MitigationAutoTrafficDirection } from './mitigation-types';

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
/**
 * Revisao otimista da INTERFACE: qualquer edicao concorrente (direcao, perfis
 * da interface ou modo AUTO) invalida o preview.
 */
export function directionInterfaceRevision(input: {
  interfaceId: string;
  direction: MitigationAutoTrafficDirection | null;
  affectedProfileIds: string[];
  autoProfileIds: string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        interfaceId: input.interfaceId,
        direction: input.direction,
        affectedProfileIds: [...input.affectedProfileIds].sort(),
        autoProfileIds: [...input.autoProfileIds].sort(),
      }),
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
    interfaceRevisions: Record<string, string>;
    interfaceChanges: MitigationInterfaceDirectionChangeDto[];
  }): Promise<void>;
}
type Pending = {
  dto: MitigationDirectionPreviewDto;
  actorId: string;
  revisions: Record<string, string>;
  changes: MitigationDirectionChangeDto[];
  interfaceRevisions: Record<string, string>;
  interfaceChanges: MitigationInterfaceDirectionChangeDto[];
};

/**
 * Revisao de direcao de telemetria (preview + apply explicito).
 *
 * Escopo MINIMO: escreve apenas `autoTrafficDirection` (perfil) ou
 * `Interface.mitigationTrafficDirection`. Nunca toca modo, proveniencia,
 * runtime, sweep ou equipamento. Toda aplicacao e auditada (autor, momento,
 * antes/depois) e protegida por revisao otimista.
 *
 * Perfis AUTO exigem autorizacao separada; interfaces que hospedam perfil AUTO
 * tambem sao recusadas (a direcao herdada nao pode sobrescrever um override
 * explicito de um perfil ja autorizado).
 */
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
    interfaceChanges: MitigationInterfaceDirectionChangeDto[] = [],
  ): Promise<MitigationDirectionPreviewDto> {
    const now = (this.deps.now ?? (() => new Date()))();
    for (const [id, p] of this.previews)
      if (new Date(p.dto.expiresAt) <= now) this.previews.delete(id);
    const total = changes.length + interfaceChanges.length;
    if (!total || total > 100) throw new DirectionReviewError('INVALID_DIRECTION_BATCH', 400);
    if (new Set(changes.map((c) => c.profileId)).size !== changes.length)
      throw new DirectionReviewError('INVALID_DIRECTION_BATCH', 400);
    if (new Set(interfaceChanges.map((c) => c.interfaceId)).size !== interfaceChanges.length)
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
      const resolved = resolveTelemetryDirection(
        p.id,
        change.direction,
        this.deps.envDirections,
        p.interfaceTrafficDirection,
      );
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
    const interfaceRevisions: Record<string, string> = {};
    const interfaceRows: MitigationInterfaceDirectionPreviewRow[] = [];
    for (const change of interfaceChanges) {
      if (
        change.direction !== null &&
        change.direction !== 'RX' &&
        change.direction !== 'TX'
      )
        throw new DirectionReviewError('INVALID_DIRECTION', 400);
      const affected = records.filter((p) => p.interfaceId === change.interfaceId);
      if (!affected.length) throw new DirectionReviewError('INTERFACE_NOT_FOUND', 404);
      const autoProfileIds = affected.filter((p) => p.mode === 'AUTO').map((p) => p.id);
      if (autoProfileIds.length)
        throw new DirectionReviewError('INTERFACE_HAS_AUTO_PROFILE', 409);
      if (affected.some((p) => changes.some((c) => c.profileId === p.id)))
        throw new DirectionReviewError('CONFLICTING_DIRECTION_BATCH', 400);
      const before = affected[0]!.interfaceTrafficDirection;
      interfaceRevisions[change.interfaceId] = directionInterfaceRevision({
        interfaceId: change.interfaceId,
        direction: before,
        affectedProfileIds: affected.map((p) => p.id),
        autoProfileIds,
      });
      const d = diagnostics.entries.find((entry) =>
        affected.some((p) => p.id === entry.profileId),
      );
      interfaceRows.push({
        interfaceId: change.interfaceId,
        deviceId: affected[0]!.deviceId,
        interfaceName: d?.interfaceName ?? null,
        before,
        after: change.direction,
        affectedProfileIds: affected.map((p) => p.id),
        autoProfileIds,
        impact:
          change.direction === null
            ? 'DIRECTION_STILL_REQUIRED'
            : 'INHERITED_BY_PROFILES_SHADOW_EVALUATION_ONLY',
        rxBps: d?.rxBps ?? null,
        txBps: d?.txBps ?? null,
      });
    }
    const dto: MitigationDirectionPreviewDto = {
      previewId: randomUUID(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      changes: rows,
      ...(interfaceRows.length ? { interfaceChanges: interfaceRows } : {}),
    };
    this.previews.set(dto.previewId, {
      dto,
      actorId,
      revisions,
      changes: changes.map((c) => ({ ...c })),
      interfaceRevisions,
      interfaceChanges: interfaceChanges.map((c) => ({ ...c })),
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
      interfaceRevisions: pending.interfaceRevisions,
      interfaceChanges: pending.interfaceChanges,
    });
    return { applied: pending.changes.length + pending.interfaceChanges.length };
  }
}
