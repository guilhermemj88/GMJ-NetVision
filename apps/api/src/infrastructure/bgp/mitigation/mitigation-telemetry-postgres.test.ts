import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { PrismaDirectionReviewStore } from './prisma-direction-review-store';
import { MitigationDirectionReview } from './mitigation-direction-review';
import { PrismaMitigationTelemetryReader } from './prisma-mitigation-telemetry-reader';

const url = process.env.TELEMETRY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !['localhost', '127.0.0.1'].includes(u.hostname) ||
    u.pathname !== '/netvision_ddos_telemetry_test'
  )
    throw Error('Refusing non-isolated telemetry test database');
}
describe.skipIf(!url)('real isolated PostgreSQL direction transaction and atomic sample', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid' } } });
  const deviceId = 'telemetry-' + randomUUID();
  const interfaceId = deviceId + '-if';
  const store = new PrismaDirectionReviewStore(db);
  const review = new MitigationDirectionReview({
    store,
    envDirections: {},
    telemetry: async () => ({ generatedAt: new Date().toISOString(), entries: [] }),
  });
  let ids: string[] = [];
  beforeAll(async () => {
    await db.device.create({
      data: {
        id: deviceId,
        name: 'isolated',
        displayName: 'isolated',
        hostname: 'isolated',
        ip: '127.0.0.1',
        managementIp: '127.0.0.1',
        deviceType: 'ROUTER',
        source: 'MANUAL',
      },
    });
    await db.interface.create({
      data: {
        id: interfaceId,
        deviceId,
        name: 'Eth-Trunk1.3024',
        ifIndex: 151,
        adminStatus: 'UP',
        operStatus: 'UP',
        speedBps: 300_000_000_000n,
      },
    });
    ids = await Promise.all(
      ['IPV4', 'IPV6'].map(
        async (af) =>
          (
            await db.bgpMitigationProfile.create({
              data: {
                deviceId,
                interfaceId,
                policyName: 'policy-' + af,
                addressFamily: af as 'IPV4' | 'IPV6',
                mode: 'ALERT_ONLY',
              },
            })
          ).id,
      ),
    );
  });
  afterAll(async () => {
    await db.mitigationDirectionAudit.deleteMany({ where: { actorId: deviceId } });
    await db.device.deleteMany({ where: { id: deviceId } });
    await db.$disconnect();
  });
  it('commits all directions plus audit once; modes, provenance and samples remain unchanged', async () => {
    const preview = await review.preview(
      deviceId,
      ids.map((profileId) => ({ profileId, direction: 'TX' })),
    );
    await review.apply(deviceId, preview.previewId, true);
    expect(
      await db.mitigationDirectionAudit.count({
        where: { id: preview.previewId, actorId: deviceId },
      }),
    ).toBe(1);
    expect(
      (await db.bgpMitigationProfile.findMany({ where: { id: { in: ids } } })).every(
        (p) =>
          p.autoTrafficDirection === 'TX' &&
          p.mode === 'ALERT_ONLY' &&
          !p.autoPromotedBySweep &&
          p.triggerSamples === 3,
      ),
    ).toBe(true);
    await expect(review.apply(deviceId, preview.previewId, true)).rejects.toThrow();
    expect(await db.bgpMitigationEvent.count({ where: { profileId: { in: ids } } })).toBe(0);
  });
  it('rejects concurrent promotion atomically without partial batch writes', async () => {
    const preview = await review.preview(
      deviceId,
      ids.map((profileId) => ({ profileId, direction: 'RX' })),
    );
    await db.bgpMitigationProfile.update({
      where: { id: ids[1]! },
      data: { mode: 'AUTO', autoPromotedBySweep: true },
    });
    await expect(review.apply(deviceId, preview.previewId, true)).rejects.toThrow(
      'DIRECTION_PREVIEW_STALE',
    );
    expect(
      (await db.bgpMitigationProfile.findMany({ where: { id: { in: ids } } })).every(
        (p) => p.autoTrafficDirection === 'TX',
      ),
    ).toBe(true);
    expect(await db.mitigationDirectionAudit.count({ where: { id: preview.previewId } })).toBe(0);
  });
  it('allows one concurrent preview only and rejects the second stale revision', async () => {
    const changes = [{ profileId: ids[0]!, direction: 'RX' as const }];
    const a = await review.preview(deviceId, changes),
      b = await review.preview(deviceId, changes);
    const results = await Promise.allSettled([
      review.apply(deviceId, a.previewId, true),
      review.apply(deviceId, b.previewId, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not fall back to older valid traffic when latest row is invalid', async () => {
    const reader = new PrismaMitigationTelemetryReader(db);
    const at = Date.now();
    for (const [offset, rate] of [
      [-10000, 2000000000],
      [0, -1],
    ])
      await db.interfaceMetricSample.create({
        data: {
          interfaceId,
          timestamp: new Date(at + offset!),
          inOctets: 100n,
          outOctets: 200n,
          rxBps: rate!,
          txBps: rate!,
          operStatus: 'UP',
        },
      });
    const row = await reader.readInterface(interfaceId);
    expect(row?.sample).toMatchObject({ usable: false, rx: -1, tx: -1 });
    expect(row?.ifIndex).toBe(151);
  });
});
