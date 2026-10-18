import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AuthUser } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { directionProfileRevision, MitigationDirectionReview } from './mitigation-direction-review';
import { registerMitigationRoutes } from '../../../mitigation-routes';
import type { BgpMitigationService } from './mitigation-service';

async function harness() {
  const repository = new InMemoryMitigationRepository();
  const p = await repository.upsertProfile({
    deviceId: 'd',
    interfaceId: 'i',
    policyName: 'policy',
    mode: 'ALERT_ONLY',
  });
  let now = new Date('2026-10-18T12:00:00Z');
  let applied = 0;
  const review = new MitigationDirectionReview({
    now: () => now,
    envDirections: { [p.id]: 'rx' },
    telemetry: async () => ({ generatedAt: now.toISOString(), entries: [] }),
    store: {
      listProfiles: () => repository.listProfiles(),
      apply: async (input) => {
        for (const c of input.changes) {
          const record = (await repository.getProfile(c.profileId))!;
          if (directionProfileRevision(record) !== input.revisions[c.profileId])
            throw Error('stale');
          await repository.setProfileAutoTrafficDirection(c.profileId, c.direction);
        }
        applied++;
      },
    },
  });
  return {
    repository,
    p,
    review,
    expire: () => {
      now = new Date(now.getTime() + 300001);
    },
    applied: () => applied,
  };
}
describe('direction review safety', () => {
  it('requires preview/explicit confirmation/actor and does not change mode or provenance', async () => {
    const h = await harness();
    const preview = await h.review.preview('operator', [{ profileId: h.p.id, direction: 'TX' }]);
    expect(h.applied()).toBe(0);
    expect(preview.changes[0]).toMatchObject({
      effectiveAfter: 'TX',
      impact: 'SHADOW_EVALUATION_ONLY',
      mode: 'ALERT_ONLY',
    });
    await expect(h.review.apply('operator', preview.previewId, false)).rejects.toThrow(
      'EXPLICIT_CONFIRMATION_REQUIRED',
    );
    await expect(h.review.apply('other', preview.previewId, true)).rejects.toThrow(
      'DIRECTION_PREVIEW_EXPIRED',
    );
    await h.review.apply('operator', preview.previewId, true);
    expect(await h.repository.getProfile(h.p.id)).toMatchObject({
      autoTrafficDirection: 'TX',
      mode: 'ALERT_ONLY',
      autoPromotedBySweep: false,
      triggerSamples: 3,
    });
    await expect(h.review.apply('operator', preview.previewId, true)).rejects.toThrow(
      'DIRECTION_PREVIEW_EXPIRED',
    );
  });
  it('shows ENV after clearing, refuses AUTO and duplicate IDs, expires previews', async () => {
    const h = await harness();
    const preview = await h.review.preview('u', [{ profileId: h.p.id, direction: null }]);
    expect(preview.changes[0]).toMatchObject({ effectiveAfter: 'RX', sourceAfter: 'ENV' });
    h.expire();
    await expect(h.review.apply('u', preview.previewId, true)).rejects.toThrow(
      'DIRECTION_PREVIEW_EXPIRED',
    );
    await expect(
      h.review.preview('u', [
        { profileId: h.p.id, direction: 'RX' },
        { profileId: h.p.id, direction: 'TX' },
      ]),
    ).rejects.toThrow('INVALID_DIRECTION_BATCH');
    await h.repository.setProfileMode(h.p.id, 'AUTO');
    await expect(h.review.preview('u', [{ profileId: h.p.id, direction: 'TX' }])).rejects.toThrow(
      'AUTO_DIRECTION_REQUIRES_SEPARATE_AUTHORIZATION',
    );
  });
  it('enforces permissions, strict API payloads and prevents bypass via legacy PATCH', async () => {
    const h = await harness();
    let user: AuthUser | null = null;
    const app = Fastify();
    app.setErrorHandler((e, _, reply) =>
      reply
        .code(e instanceof ZodError ? 400 : 500)
        .send({ message: e instanceof Error ? e.message : 'error' }),
    );
    registerMitigationRoutes(app, {
      service: {} as BgpMitigationService,
      directionReview: h.review,
      currentUser: async () => user,
    });
    try {
      const body = { changes: [{ profileId: h.p.id, direction: 'TX' }] };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/bgp/mitigation/directions/preview',
            payload: body,
          })
        ).statusCode,
      ).toBe(401);
      user = { id: 'viewer', role: 'VIEWER' } as AuthUser;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/bgp/mitigation/directions/preview',
            payload: body,
          })
        ).statusCode,
      ).toBe(403);
      user = { id: 'operator', role: 'OPERATOR' } as AuthUser;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/bgp/mitigation/directions/preview',
            payload: { ...body, mode: 'AUTO' },
          })
        ).statusCode,
      ).toBe(400);
      const r = await app.inject({
        method: 'POST',
        url: '/api/bgp/mitigation/directions/preview',
        payload: body,
      });
      expect(r.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/bgp/mitigation/directions/apply',
            payload: { previewId: r.json().previewId, confirmed: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/bgp/mitigation/profiles/' + h.p.id,
            payload: { autoTrafficDirection: 'RX' },
          })
        ).json().code,
      ).toBe('DIRECTION_REVIEW_REQUIRED');
    } finally {
      await app.close();
    }
  });
});
