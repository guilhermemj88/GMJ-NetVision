import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../../generated/prisma/index.js';
import { CredentialVault } from '../../application/credential-vault';
import { loopbackSnmpAgent } from '../../testing/loopback-snmp-agent';
import { fastObserverServer } from './fast-observer-server';
import type { FastTrafficPoller } from './fast-traffic-poller';
const observerBundle = fileURLToPath(
  new URL('../../../dist/mitigation-fast-observer-main.cjs', import.meta.url),
);

describe('observer cannot execute mitigation', () => {
  it('built artifact contains no engine, command service or SSH transport', () => {
    const bundle = readFileSync(observerBundle, 'utf8');
    for (const name of [
      'MitigationAutoEngine',
      'MitigationCommandService',
      'HuaweiMitigationExecutor',
      'require("ssh2")',
    ])
      expect(bundle).not.toContain(name);
  });
  it('rejects ENFORCE before opening database or SNMP connections', async () => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [observerBundle], {
        env: { ...process.env, MITIGATION_FAST_POLL_MODE: 'ENFORCE' },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
    expect(code).toBe(1);
  });
  it('HTTP exposes GET diagnostics only, bound by caller to loopback', async () => {
    const server = fastObserverServer(
      {
        status: () => ({
          running: true,
          monitoredDevices: 1,
          lastError: null,
          entries: [{ lastCollectedAt: new Date().toISOString() }],
        }),
      } as FastTrafficPoller,
      'test',
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        executionAvailable: false,
        observationOnly: true,
      });
      expect((await fetch(`http://127.0.0.1:${port}/mitigate`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe.skipIf(!process.env.FAST_TEST_DATABASE_URL)(
  'observer isolated startup / stop / restart rollback',
  () => {
    it('read-only source, separate database, real UDP, stop and resume without altering profile', async () => {
      const url = process.env.FAST_TEST_DATABASE_URL!;
      if (
        new URL(url).hostname !== '127.0.0.1' ||
        new URL(url).port !== '55439' ||
        new URL(url).pathname !== '/netvision_ddos_fast_test'
      )
        throw new Error('Isolated database required');
      const storageUrl = new URL(url);
      storageUrl.pathname = '/netvision_ddos_observe_test';
      const readOnlyUrl = new URL(url);
      readOnlyUrl.searchParams.set('options', '-c default_transaction_read_only=on');
      const source = new PrismaClient({ datasources: { db: { url } } });
      const storage = new PrismaClient({ datasources: { db: { url: storageUrl.toString() } } });
      const vaultKey = randomBytes(32).toString('base64');
      const vault = new CredentialVault(vaultKey);
      const agent = await loopbackSnmpAgent({
        value: (oid) => ({
          type: oid.endsWith('.1.200') ? 4 : 0x46,
          value: oid === '1.3.6.1.2.1.31.1.1.1.1.200' ? 'Eth-Trunk1.3043' : 100000n,
        }),
      });
      const reservation = createServer();
      await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((r) => reservation.close(() => r()));
      const id = 'observer-integration-only';
      let child: ReturnType<typeof spawn> | null = null;
      const launch = () => {
        child = spawn(process.execPath, [observerBundle], {
          env: {
            ...process.env,
            DATABASE_URL: storageUrl.toString(),
            MITIGATION_FAST_SOURCE_DATABASE_URL: readOnlyUrl.toString(),
            CREDENTIAL_ENCRYPTION_KEY: vaultKey,
            MITIGATION_FAST_POLL_MODE: 'OBSERVE',
            MITIGATION_FAST_PROFILE_IDS: id,
            MITIGATION_FAST_ALLOWED_DEVICE_IDS: id,
            MITIGATION_FAST_OBSERVER_PORT: String(port),
            MITIGATION_FAST_NORMAL_SECONDS: '10',
          },
          stdio: 'ignore',
        });
        return child;
      };
      const waitUntil = async (test: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) {
          if (await test()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('Observer condition timed out');
      };
      const stop = async () => {
        if (!child) return;
        const processRef = child;
        const exited = processRef.exitCode !== null || processRef.signalCode !== null
          ? Promise.resolve()
          : new Promise((r) => processRef.once('exit', r));
        processRef.kill('SIGTERM');
        await exited;
        child = null;
      };
      try {
        await storage.mitigationTrafficObservation.deleteMany({ where: { interfaceId: id } });
        await source.snmpCredential.create({
          data: {
            id,
            name: id,
            version: 'SNMP_V2C',
            encryptedPayload: vault.encrypt({ community: 'synthetic-only' }),
          },
        });
        await source.device.create({
          data: {
            id,
            name: id,
            displayName: id,
            hostname: id,
            ip: '127.0.0.1',
            managementIp: '127.0.0.1',
            source: 'SNMP',
            deviceType: 'ROUTER',
            snmpEnabled: true,
            snmpVersion: 'SNMP_V2C',
            snmpHost: '127.0.0.1',
            snmpPort: agent.port,
            snmpCredentialId: id,
          },
        });
        await source.interface.create({
          data: {
            id,
            deviceId: id,
            ifIndex: 200,
            name: 'Eth-Trunk1.3043',
            speedBps: 300_000_000_000n,
            adminStatus: 'UP',
          },
        });
        await source.bgpMitigationProfile.create({
          data: {
            id,
            deviceId: id,
            interfaceId: id,
            policyName: 'SYNTHETIC-ONLY',
            mode: 'AUTO',
            detectedBandwidthBps: 10_000_000_000n,
            autoTrafficDirection: 'TX',
          },
        });
        launch();
        await waitUntil(
          async () =>
            (await storage.mitigationTrafficObservation.count({ where: { interfaceId: id } })) ===
            1,
        );
        await stop();
        const requests = agent.requests();
        await new Promise((r) => setTimeout(r, 250));
        expect(agent.requests()).toBe(requests);
        launch();
        await waitUntil(
          async () =>
            (await storage.mitigationTrafficObservation.count({ where: { interfaceId: id } })) ===
            2,
        );
        await stop();
        const profile = await source.bgpMitigationProfile.findUnique({ where: { id } });
        expect(profile?.triggerSamples).toBe(3);
        expect(profile?.mode).toBe('AUTO');
        expect(await source.bgpMitigationEvent.count({ where: { profileId: id } })).toBe(0);
      } finally {
        await stop();
        await agent.close();
        await storage.mitigationTrafficObservation.deleteMany({ where: { interfaceId: id } });
        await source.device.deleteMany({ where: { id } });
        await source.snmpCredential.deleteMany({ where: { id } });
        await Promise.all([source.$disconnect(), storage.$disconnect()]);
      }
    }, 20000);
  },
);
