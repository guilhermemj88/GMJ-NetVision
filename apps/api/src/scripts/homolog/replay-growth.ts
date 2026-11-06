/** Independent replay validation. Reads the real persisted observations; does not emit events. */
import { deepStrictEqual, ok } from 'node:assert';
import { PrismaClient } from '../../generated/prisma/index.js';
import { FastGrowthNotifications } from '../../application/fast-growth-notifications';
import { CredentialVault } from '../../application/credential-vault';
import { PrismaHostRepository } from '../../infrastructure/persistence/prisma-host-repository';
import { PrismaMitigationRepository } from '../../infrastructure/bgp/mitigation/prisma-mitigation-repository';
import { listFastTrafficTargets } from '../../infrastructure/snmp/fast-traffic-targets';
import type { FastTrafficQuality } from '../../infrastructure/snmp/fast-traffic-types';
import {
  decodeNotification,
  type OutboxEntry,
} from '../../worker/mitigation/durable-mitigation-outbox';
import { assertDisposable, loadConfig, saveEvidence } from './fixture';
import type { GrowthWebhookBlock } from '../../infrastructure/bgp/mitigation/mitigation-webhook';

const c = loadConfig();
assertDisposable(c, c.databaseUrl);
const db = new PrismaClient({ datasourceUrl: c.databaseUrl });
try {
  const repository = new PrismaMitigationRepository(db),
    hosts = new PrismaHostRepository(db, new CredentialVault(c.credentialKey));
  const targets = await listFastTrafficTargets({
    profileIds: [],
    autoAllEnforce: true,
    allowedDeviceIds: [c.deviceId],
    listProfiles: () => repository.listProfiles(),
    hosts,
    direction: () => 'tx',
  });
  const g = new FastGrowthNotifications(15000),
    byInterface = new Map(targets.map((t) => [t.interfaceId, t]));
  g.refresh(targets);
  const observations = await db.mitigationTrafficObservation.findMany({
    orderBy: { collectedAt: 'asc' },
  });
  for (const row of observations)
    g.record(byInterface.get(row.interfaceId)!, {
      ...row,
      inOctets: BigInt(row.inOctets.toString()),
      outOctets: BigInt(row.outOctets.toString()),
      quality: row.quality as FastTrafficQuality,
    });
  const saved = await db.mitigationAutomationRecord.findMany({ where: { kind: 'outbox' } }),
    results = [];
  for (const record of saved) {
    const entry = record.payload as unknown as OutboxEntry;
    const { growth: expected, ...notification } = decodeNotification(entry.payload);
    const replayed = g.enrich(
      notification,
      notification.direction,
      Date.parse(notification.occurredAt!),
    );
    deepStrictEqual(replayed.growth, expected);
    const metrics = replayed.growth as GrowthWebhookBlock;
    const target = targets.find((t) =>
      t.profiles.some((p) => p.profileId === notification.profileId),
    )!;
    const stream = observations.filter((o) => o.interfaceId === target.interfaceId);
    const index = stream.findIndex(
      (o) => o.collectedAt.getTime() === Date.parse(metrics.thresholdReachedAt!),
    );
    const previous = stream[index - 1],
      crossing = stream[index];
    ok(previous && crossing && previous.txBps !== null && crossing.txBps !== null);
    ok(previous.txBps < Number(target.profiles[0]!.thresholdBps));
    ok(crossing.txBps >= Number(target.profiles[0]!.thresholdBps));
    results.push({
      eventId: notification.eventId,
      profileId: notification.profileId,
      identical: true,
      previousSample: { id: previous.id, at: previous.collectedAt, txBps: previous.txBps },
      crossingSample: { id: crossing.id, at: crossing.collectedAt, txBps: crossing.txBps },
      growth: replayed.growth,
    });
  }
  saveEvidence('growth-replay', {
    synthetic: true,
    readOnlyValidation: true,
    source: 'actual persisted FAST observations and unchanged audited sidecar',
    observations: observations.length,
    events: results.length,
    allIdentical: true,
    results,
  });
  console.log(
    'PASS: exact Growth replay for',
    results.length,
    'events from',
    observations.length,
    'real persisted synthetic observations',
  );
} finally {
  await db.$disconnect();
}
