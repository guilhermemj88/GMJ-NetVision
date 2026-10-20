/** Dedicated observation service. Deliberately does NOT import routes, engine, SSH or command service. */
import { PrismaClient } from './generated/prisma/index.js';
import { CredentialVault } from './application/credential-vault';
import { FastTrafficPoller, fastPollerConfig } from './infrastructure/snmp/fast-traffic-poller';
import { FastSnmpReader, type FastSnmpHostPort } from './infrastructure/snmp/fast-snmp-reader';
import { SnmpClientImpl } from './infrastructure/snmp/snmp-client-impl';
import { PrismaObserverTrafficStore } from './infrastructure/snmp/prisma-observer-traffic-store';
import {
  fastRetentionConfig,
  PrismaFastObservationPurge,
  purgeFastObservations,
} from './infrastructure/snmp/fast-observation-retention';
import { listFastTrafficTargets } from './infrastructure/snmp/fast-traffic-targets';
import { fastObserverServer } from './infrastructure/snmp/fast-observer-server';
import type { MitigationProfileRecord } from './infrastructure/bgp/mitigation/mitigation-repository';

async function main(): Promise<void> {
  if (process.env.MITIGATION_FAST_POLL_MODE !== 'OBSERVE')
    throw new Error('Observer requires OBSERVE; execution modes are forbidden');
  const config = fastPollerConfig();
  const sourceUrl = process.env.MITIGATION_FAST_SOURCE_DATABASE_URL;
  const storageUrl = process.env.DATABASE_URL;
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (
    !sourceUrl ||
    !storageUrl ||
    !key ||
    new URL(sourceUrl).pathname === new URL(storageUrl).pathname
  ) {
    throw new Error(
      'Separate read-only source and observation databases, and vault key, are required',
    );
  }
  const port = Number(process.env.MITIGATION_FAST_OBSERVER_PORT ?? 3355);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid observer port');
  const allowed = (process.env.MITIGATION_FAST_ALLOWED_DEVICE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) throw new Error('Explicit observer device allowlist required');
  const directions = Object.fromEntries(
    (process.env.MITIGATION_AUTO_TRAFFIC_DIRECTIONS ?? '')
      .split(',')
      .map((s) => s.split(':'))
      .filter((p) => p.length === 2 && ['rx', 'tx'].includes(p[1]!)),
  );
  const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const storage = new PrismaClient({ datasources: { db: { url: storageUrl } } });
  const readOnly = await source.$queryRaw<
    Array<{ transaction_read_only: string }>
  >`SHOW transaction_read_only`;
  if (readOnly[0]?.transaction_read_only !== 'on')
    throw new Error('Operational source must enforce read-only transactions');
  const vault = new CredentialVault(key);
  const hosts: FastSnmpHostPort = {
    getHost: async (id) => {
      if (!allowed.includes(id)) return null;
      const d = await source.device.findUnique({
        where: { id },
        select: {
          id: true,
          snmpEnabled: true,
          snmpVersion: true,
          snmpHost: true,
          snmpPort: true,
          interfaces: { select: { id: true, name: true, ifIndex: true, speedBps: true } },
        },
      });
      return d
        ? {
            id: d.id,
            snmpEnabled: d.snmpEnabled,
            snmp: d.snmpHost
              ? { version: d.snmpVersion ?? '', host: d.snmpHost, port: d.snmpPort }
              : null,
            interfaces: d.interfaces,
          }
        : null;
    },
    getDecryptedSnmpCredentials: async (id) => {
      if (!allowed.includes(id)) return null;
      const d = await source.device.findUnique({
        where: { id },
        select: { snmpCredential: { select: { encryptedPayload: true } } },
      });
      if (!d?.snmpCredential) return null;
      const secret = vault.decrypt(d.snmpCredential.encryptedPayload);
      return typeof secret.community === 'string' ? { community: secret.community } : null;
    },
  };
  const store = new PrismaObserverTrafficStore(storage);
  const poller = new FastTrafficPoller({
    config,
    store,
    reader: new FastSnmpReader(hosts, new SnmpClientImpl(config.timeoutMs, config.retries)),
    listTargets: () =>
      listFastTrafficTargets({
        profileIds: config.profileIds,
        allowedDeviceIds: allowed,
        hosts,
        listProfiles: async () =>
          (await source.bgpMitigationProfile.findMany({
            where: { id: { in: config.profileIds } },
          })) as MitigationProfileRecord[],
        direction: (p) =>
          p.autoTrafficDirection === 'TX'
            ? 'tx'
            : p.autoTrafficDirection === 'RX'
              ? 'rx'
              : directions[p.id] === 'tx'
                ? 'tx'
                : directions[p.id] === 'rx'
                  ? 'rx'
                  : null,
      }),
    logger: (message, meta) =>
      process.stdout.write(
        JSON.stringify({ at: new Date().toISOString(), message, ...meta }) + '\n',
      ),
  });
  const server = fastObserverServer(poller, process.env.MITIGATION_FAST_RELEASE ?? 'unidentified');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  // Retenção configurável, em lotes, SOMENTE no banco de observação. Auditoria e
  // histórico de mitigação vivem no banco operacional (read-only para este processo).
  const retentionConfig = fastRetentionConfig();
  const purge = new PrismaFastObservationPurge(storage);
  const runRetention = async () => {
    try {
      const result = await purgeFastObservations(purge, retentionConfig);
      process.stdout.write(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'observer retention',
          retentionDays: retentionConfig.retentionDays,
          cutoff: result.cutoff.toISOString(),
          deleted: result.deleted,
          batches: result.batches,
          backlogRemaining: result.backlogRemaining,
        }) + '\n',
      );
    } catch {
      process.stderr.write('observer retention failed\n');
    }
  };
  const retention = setInterval(() => void runRetention(), retentionConfig.intervalMs);
  retention.unref();
  void runRetention();
  poller.start();
  const summary = setInterval(
    () =>
      process.stdout.write(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'observer summary',
          ...poller.status(),
        }) + '\n',
      ),
    60000,
  );
  summary.unref();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(retention);
    clearInterval(summary);
    await poller.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([source.$disconnect(), storage.$disconnect()]);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}
main().catch(() => {
  process.stderr.write(
    'Fast observer failed to start; inspect configuration, read-only source and schema\n',
  );
  process.exit(1);
});
