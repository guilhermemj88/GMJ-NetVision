import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore, type AutomationStore } from './automation-store';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';
import { AutomationMitigationBaselineStore } from './baseline-store';
import { baselineRecordId } from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';

const url = process.env.MITIGATION_BASELINE_TEST_DATABASE_URL;
if (url) {
  const p = new URL(url);
  if (
    p.hostname !== '127.0.0.1' ||
    p.port !== '55077' ||
    p.pathname !== '/mitigation_baseline_test'
  )
    throw Error('DISPOSABLE_BASELINE_DATABASE_REQUIRED');
}

describe.skipIf(!url)(
  'F1: durable manual-removal quarantine, real PostgreSQL16 and fake Huawei',
  () => {
    let db = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
    // A real Prisma connection failure on refused loopback port, never a remote DB.
    const unavailableUrl = new URL(
      url ?? 'postgresql://unused@127.0.0.1:55077/mitigation_baseline_test',
    );
    unavailableUrl.port = '1';
    unavailableUrl.searchParams.set('connect_timeout', '1');
    const unavailableDb = new PrismaClient({ datasourceUrl: unavailableUrl.toString() });
    let failRelease = false,
      failIntent = false,
      databaseUnavailable = false;
    const store: AutomationStore = {
      transaction: (work) => {
        if (databaseUnavailable) return new PrismaAutomationStore(unavailableDb).transaction(work);
        return new PrismaAutomationStore(db).transaction((tx) =>
          work({
            ...tx,
            put: async (id, kind, status, payload) => {
              if (failRelease && kind === 'mitigation-baseline' && status === 'RELEASED')
                throw Error('injected RELEASED failure');
              if (failIntent && kind === 'mitigation-baseline' && status === 'REMOVING')
                throw Error('injected removal intent failure');
              return tx.put(id, kind, status, payload);
            },
          }),
        );
      },
    };
    beforeEach(async () => {
      failRelease = false;
      failIntent = false;
      databaseUnavailable = false;
      await db.mitigationAutomationRecord.deleteMany();
    });
    afterAll(async () => {
      await db.$disconnect();
      await unavailableDb.$disconnect();
    });
    const reconnect = async () => {
      await db.$disconnect();
      db = new PrismaClient({ datasourceUrl: url! });
    };
    const activate = async (h: Awaited<ReturnType<typeof createPilotHarness>>) => {
      for (let i = 0; i < 3; i++) {
        h.sample(9_500_000_000n);
        await h.lifecycle.tickPilot();
      }
      expect((await h.scope())?.phase).toBe('ACTIVE');
    };

    it('A-F: failed RELEASED + DB reconnect/restart + identical foreign pair cannot be removed or overwritten by any new request/profile', async () => {
      const h = await createPilotHarness(store);
      await activate(h);
      failRelease = true;
      const removed = await h.commands.execute({
        requestId: 'remove-release-fails',
        action: 'REMOVE',
        profileId: P.profileId,
      });
      expect(removed.verified).toBe(false);
      expect(h.ssh.active).toBe(false);
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      const row = await db.mitigationAutomationRecord.findUniqueOrThrow({
        where: { id: baselineRecordId({ deviceId: P.deviceId, policyName: P.policy }) },
      });
      expect(row.status).toBe('REMOVING');
      expect(row.payload).toMatchObject({
        version: 2,
        state: 'REMOVING',
        baseline: { version: 1, policyName: P.policy },
      });
      expect(
        await new AutomationMitigationBaselineStore(store).load({
          deviceId: P.deviceId,
          policyName: P.policy,
        }),
      ).toBeNull();
      failRelease = false;
      await reconnect();
      await h.restart();
      const normal = h.ssh.config();
      const foreignPair = h.ssh.writes[0]!.filter(
        (c) => c !== 'system-view' && c !== 'commit',
      ).join('\n');
      h.ssh.config = () => [h.ssh.active ? foreignPair : '', normal].join('\n');
      h.ssh.active = true;
      const other = await h.repository.upsertProfile({
        deviceId: P.deviceId,
        policyName: P.policy,
        interfaceId: 'other-client-if',
        addressFamily: 'IPV4',
        detectedBandwidthBps: P.bandwidthBps,
        bandwidthSource: 'DESCRIPTION',
      });
      const count = h.ssh.writes.length;
      for (const profileId of [P.profileId, other.id])
        for (const action of ['REMOVE', 'ACTIVATE'] as const) {
          const result = await h.commands.execute({
            requestId: `new-${profileId}-${action}`,
            action,
            profileId,
          });
          expect(result.verified).toBe(false);
          expect(result.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
          expect(h.ssh.writes).toHaveLength(count);
        }
      await expect(h.lifecycle.manualMutation(P.deviceId, P.policy)).rejects.toThrow(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
      const held = (await h.scope())!;
      await expect(
        h.lifecycle.reconcileManualRelease({
          profileId: P.profileId,
          expectedOperationId: held.operationId,
          actor: 'operator-test',
          reason: 'read-only check',
        }),
      ).rejects.toThrow('RECONCILIATION_PHYSICAL_ABSENCE_NOT_PROVEN');
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      expect(h.ssh.writes).toHaveLength(count);
    });

    it('G-H: complete database outage after physical REMOVE remains quarantined; explicit absence reconciliation is atomic, durable and never adopts a foreign pair', async () => {
      const h = await createPilotHarness(store);
      await activate(h);
      h.ssh.afterWrite = async () => {
        databaseUnavailable = true;
      };
      const removed = await h.commands.execute({
        requestId: 'remove-db-outage',
        action: 'REMOVE',
        profileId: P.profileId,
      });
      expect(removed.verified).toBe(false);
      expect(h.ssh.active).toBe(false);
      databaseUnavailable = false;
      delete h.ssh.afterWrite;
      await reconnect();
      await h.restart();
      const held = (await h.scope())!;
      expect(held.phase).toBe('UNCERTAIN');
      const writes = h.ssh.writes.length;
      const retry = await h.commands.execute({
        requestId: 'after-postgres-recovery',
        action: 'REMOVE',
        profileId: P.profileId,
      });
      expect(retry.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
      expect(h.ssh.writes).toHaveLength(writes);
      const evidence = {
        profileId: P.profileId,
        expectedOperationId: held.operationId,
        actor: 'operator-test',
        reason: 'confirmed absent pair and unchanged permanent nodes',
      };
      failRelease = true;
      await expect(h.lifecycle.reconcileManualRelease(evidence)).rejects.toThrow(
        'injected RELEASED failure',
      );
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      expect(await db.mitigationAutomationRecord.count({ where: { kind: 'reconciliation' } })).toBe(
        0,
      );
      failRelease = false;
      const result = await h.lifecycle.reconcileManualRelease(evidence);
      expect(result.status).toBe('RECONCILED_RELEASED');
      expect(h.ssh.writes).toHaveLength(writes);
      await reconnect();
      await h.restart();
      expect((await h.scope())?.phase).toBe('COOLDOWN');
      const marker = await db.mitigationAutomationRecord.findUniqueOrThrow({
        where: { id: baselineRecordId({ deviceId: P.deviceId, policyName: P.policy }) },
      });
      expect(marker.status).toBe('RELEASED');
      expect(marker.payload).toMatchObject({
        version: 0,
        released: true,
        baseline: { version: 1 },
      });
      expect(
        await db.mitigationAutomationRecord.findUnique({ where: { id: result.reconciliationId } }),
      ).toMatchObject({ kind: 'reconciliation', status: 'RESOLVED_NO_WRITE' });
      expect(
        await new AutomationMitigationBaselineStore(store).load({
          deviceId: P.deviceId,
          policyName: P.policy,
        }),
      ).toBeNull();
      const normal = h.ssh.config(),
        foreignPair = h.ssh.writes[0]!.filter((c) => c !== 'system-view' && c !== 'commit').join(
          '\n',
        );
      h.ssh.config = () => [h.ssh.active ? foreignPair : '', normal].join('\n');
      h.ssh.active = true;
      const foreignRemoval = await h.commands.execute({
        requestId: 'after-explicit-release-foreign-remove',
        action: 'REMOVE',
        profileId: P.profileId,
      });
      expect(foreignRemoval.verified).toBe(false);
      expect(h.ssh.writes).toHaveLength(writes);
    });

    it('no removal-intent persistence means zero physical commands, including before any RELEASED transition', async () => {
      const h = await createPilotHarness(store);
      await activate(h);
      // Fail the next durable intent transaction, before the transport boundary.
      failIntent = true;
      const writes = h.ssh.writes.length;
      const result = await h.commands.execute({
        requestId: 'remove-before-intent-db-failure',
        action: 'REMOVE',
        profileId: P.profileId,
      });
      expect(result.verified).toBe(false);
      expect(h.ssh.writes).toHaveLength(writes);
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
    });
  },
);
