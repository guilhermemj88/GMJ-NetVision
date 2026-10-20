import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AuthUser } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  directionInterfaceRevision,
  directionProfileRevision,
  MitigationDirectionReview,
} from './mitigation-direction-review';
import { resolveTelemetryDirection } from './mitigation-telemetry';
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
  // Segundo perfil da MESMA interface: o lote por interface alcanca todos.
  const p2 = await repository.upsertProfile({
    deviceId: 'd',
    interfaceId: 'i',
    policyName: 'policy-2',
    mode: 'ALERT_ONLY',
  });
  // Interface que hospeda um perfil AUTO: lote recusado (fail-closed).
  const auto = await repository.upsertProfile({
    deviceId: 'd',
    interfaceId: 'i-auto',
    policyName: 'policy-auto',
    mode: 'AUTO',
  });
  let now = new Date('2026-10-18T12:00:00Z');
  let applied = 0;
  const audits: Record<string, unknown>[] = [];
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
          audits.push({
            target: 'PROFILE',
            profileId: c.profileId,
            before: record.autoTrafficDirection,
            after: c.direction,
            actorId: input.actorId,
            at: now.toISOString(),
          });
          await repository.setProfileAutoTrafficDirection(c.profileId, c.direction);
        }
        for (const c of input.interfaceChanges) {
          const affected = (await repository.listProfiles()).filter(
            (record) => record.interfaceId === c.interfaceId,
          );
          const expected = directionInterfaceRevision({
            interfaceId: c.interfaceId,
            direction: affected[0]?.interfaceTrafficDirection ?? null,
            affectedProfileIds: affected.map((record) => record.id),
            autoProfileIds: affected
              .filter((record) => record.mode === 'AUTO')
              .map((record) => record.id),
          });
          if (expected !== input.interfaceRevisions[c.interfaceId]) throw Error('stale');
          audits.push({
            target: 'INTERFACE',
            interfaceId: c.interfaceId,
            before: affected[0]?.interfaceTrafficDirection ?? null,
            after: c.direction,
            affectedProfileIds: affected.map((record) => record.id),
            actorId: input.actorId,
            at: now.toISOString(),
          });
          await repository.setInterfaceAutoTrafficDirection(c.interfaceId, c.direction);
        }
        applied++;
      },
    },
  });
  return {
    repository,
    p,
    p2,
    auto,
    review,
    expire: () => {
      now = new Date(now.getTime() + 300001);
    },
    applied: () => applied,
    audits: () => audits,
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

describe('direction review por INTERFACE (heranca em lote)', () => {
  it('aplica em lote e todos os perfis da interface herdam sem tocar modo/proveniencia', async () => {
    const h = await harness();
    const preview = await h.review.preview('operator', [], [{ interfaceId: 'i', direction: 'TX' }]);
    expect(preview.changes).toEqual([]);
    expect(preview.interfaceChanges?.[0]).toMatchObject({
      interfaceId: 'i',
      before: null,
      after: 'TX',
      affectedProfileIds: [h.p.id, h.p2.id],
      autoProfileIds: [],
      impact: 'INHERITED_BY_PROFILES_SHADOW_EVALUATION_ONLY',
    });
    expect(h.applied()).toBe(0);
    await expect(h.review.apply('operator', preview.previewId, false)).rejects.toThrow(
      'EXPLICIT_CONFIRMATION_REQUIRED',
    );
    expect(await h.review.apply('operator', preview.previewId, true)).toEqual({ applied: 1 });
    expect(await h.repository.getProfile(h.p.id)).toMatchObject({
      interfaceTrafficDirection: 'TX',
      autoTrafficDirection: null,
      mode: 'ALERT_ONLY',
      autoPromotedBySweep: false,
    });
    expect(await h.repository.getProfile(h.p2.id)).toMatchObject({
      interfaceTrafficDirection: 'TX',
    });
    // A heranca e o que o motor resolve: perfil sem override usa a interface.
    const record = (await h.repository.getProfile(h.p.id))!;
    expect(
      resolveTelemetryDirection(
        record.id,
        record.autoTrafficDirection,
        { [record.id]: 'rx' },
        record.interfaceTrafficDirection,
      ),
    ).toEqual({ direction: 'RX', source: 'ENV' });
    expect(
      resolveTelemetryDirection(record.id, record.autoTrafficDirection, {}, record.interfaceTrafficDirection),
    ).toEqual({ direction: 'TX', source: 'INTERFACE' });
    expect(h.audits()).toEqual([
      expect.objectContaining({
        target: 'INTERFACE',
        interfaceId: 'i',
        before: null,
        after: 'TX',
        actorId: 'operator',
      }),
    ]);
    await expect(h.review.apply('operator', preview.previewId, true)).rejects.toThrow(
      'DIRECTION_PREVIEW_EXPIRED',
    );
  });

  it('limpar a direcao da interface devolve os perfis ao fail-closed', async () => {
    const h = await harness();
    const first = await h.review.preview('u', [], [{ interfaceId: 'i', direction: 'TX' }]);
    await h.review.apply('u', first.previewId, true);
    const clear = await h.review.preview('u', [], [{ interfaceId: 'i', direction: null }]);
    expect(clear.interfaceChanges?.[0]).toMatchObject({
      before: 'TX',
      after: null,
      impact: 'DIRECTION_STILL_REQUIRED',
    });
    await h.review.apply('u', clear.previewId, true);
    const record = (await h.repository.getProfile(h.p.id))!;
    expect(record.interfaceTrafficDirection).toBeNull();
    expect(
      resolveTelemetryDirection(record.id, record.autoTrafficDirection, {}, record.interfaceTrafficDirection),
    ).toEqual({ direction: null, source: null });
  });

  it('recusa interface com perfil AUTO, interface inexistente e lote conflitante', async () => {
    const h = await harness();
    await expect(
      h.review.preview('u', [], [{ interfaceId: 'i-auto', direction: 'TX' }]),
    ).rejects.toThrow('INTERFACE_HAS_AUTO_PROFILE');
    await expect(
      h.review.preview('u', [], [{ interfaceId: 'nope', direction: 'TX' }]),
    ).rejects.toThrow('INTERFACE_NOT_FOUND');
    await expect(
      h.review.preview(
        'u',
        [{ profileId: h.p.id, direction: 'RX' }],
        [{ interfaceId: 'i', direction: 'TX' }],
      ),
    ).rejects.toThrow('CONFLICTING_DIRECTION_BATCH');
    await expect(
      h.review.preview(
        'u',
        [],
        [
          { interfaceId: 'i', direction: 'TX' },
          { interfaceId: 'i', direction: 'RX' },
        ],
      ),
    ).rejects.toThrow('INVALID_DIRECTION_BATCH');
    expect(await h.repository.getProfile(h.auto.id)).toMatchObject({
      mode: 'AUTO',
      interfaceTrafficDirection: null,
    });
  });

  it('revisao da interface invalida quando outra edicao acontece entre preview e apply', async () => {
    const h = await harness();
    const preview = await h.review.preview('u', [], [{ interfaceId: 'i', direction: 'TX' }]);
    await h.repository.setInterfaceAutoTrafficDirection('i', 'RX');
    await expect(h.review.apply('u', preview.previewId, true)).rejects.toThrow('stale');
    expect(await h.repository.getProfile(h.p.id)).toMatchObject({
      interfaceTrafficDirection: 'RX',
    });
  });
});
