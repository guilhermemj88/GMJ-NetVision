import {
  createLocalId,
  type ConnectionTestResult,
  type CreateHostInput,
  type HistoryPeriod,
  type HostRecord,
  type InterfaceStatus,
  type MetricPoint,
  type NetworkInterface,
  type SourceHealth,
  type SourceKind,
  type UpdateHostInput,
} from '@gmj/shared';
import type { CredentialVault } from '../../application/credential-vault';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { CredentialEncryptionUnavailableError } from './demo-map-repository';
import type {
  DeviceMetricSampleInput,
  HostRepository,
  InterfaceCounterSnapshot,
  InterfaceMetricSampleInput,
  SnmpCredentialSecret,
  SshCredentialSecret,
} from './host-repository';

function disabledHealth(): SourceHealth {
  return { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null };
}

function configuredHealth(): SourceHealth {
  return { state: 'CONFIGURED', lastSuccess: null, lastFailure: null, lastErrorSafe: null };
}

function safeNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

function statusFromDb(value: string): InterfaceStatus {
  return ['UP', 'DOWN', 'DISABLED', 'WARNING'].includes(value)
    ? (value as InterfaceStatus)
    : 'UNKNOWN';
}

function persistedHealthState(state: ConnectionTestResult['state']): 'DISABLED' | 'CONFIGURED' | 'CONNECTED' | 'FAILED' {
  if (state === 'DISABLED') return 'DISABLED';
  if (state === 'CONNECTED') return 'CONNECTED';
  return 'FAILED';
}

function historyStart(period: HistoryPeriod): Date {
  const milliseconds: Record<HistoryPeriod, number> = {
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
  };
  return new Date(Date.now() - milliseconds[period]);
}

type LatestMetricRow = {
  interfaceId: string;
  timestamp: Date;
  inOctets: bigint;
  outOctets: bigint;
  rxBps: number;
  txBps: number;
  inErrors: bigint;
  outErrors: bigint;
  inDiscards: bigint;
  outDiscards: bigint;
  operStatus: string;
};

export class PrismaHostRepository implements HostRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly vault: CredentialVault | null,
  ) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async listHosts(): Promise<HostRecord[]> {
    const devices = await this.prisma.device.findMany({
      include: {
        interfaces: { orderBy: { ifIndex: 'asc' } },
        metricSamples: { orderBy: { timestamp: 'desc' }, take: 1, select: { sysName: true } },
        mapNodes: { select: { mapId: true } },
        sourceHealth: true,
      },
      orderBy: { hostname: 'asc' },
    });
    const latest = await this.loadLatestMetrics(devices.flatMap((device) => device.interfaces.map((item) => item.id)));
    return devices.map((device) => this.toHostRecord({
      ...device,
      interfaces: device.interfaces.map((item) => ({
        ...item,
        metricSamples: latest.has(item.id) ? [latest.get(item.id)!] : [],
      })),
    }));
  }

  async getHost(hostId: string): Promise<HostRecord | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: hostId },
      include: {
        interfaces: { orderBy: { ifIndex: 'asc' } },
        metricSamples: { orderBy: { timestamp: 'desc' }, take: 1, select: { sysName: true } },
        mapNodes: { select: { mapId: true } },
        sourceHealth: true,
      },
    });
    if (!device) return null;
    const latest = await this.loadLatestMetrics(device.interfaces.map((item) => item.id));
    return this.toHostRecord({
      ...device,
      interfaces: device.interfaces.map((item) => ({
        ...item,
        metricSamples: latest.has(item.id) ? [latest.get(item.id)!] : [],
      })),
    });
  }

  async createHost(input: CreateHostInput, interfaces: NetworkInterface[] = []): Promise<HostRecord> {
    this.assertCredentialEncryption(input);
    const duplicate = await this.prisma.device.findFirst({
      where: {
        OR: [
          { hostname: { equals: input.hostname, mode: 'insensitive' } },
          ...(input.managementIp ? [{ managementIp: input.managementIp }] : []),
        ],
      },
      select: { id: true },
    });
    if (duplicate) return (await this.getHost(duplicate.id))!;

    const id = createLocalId('host');
    await this.prisma.$transaction(async (tx) => {
      const snmpCredentialId = await this.createSnmpCredential(tx, id, input.hostname, input.snmp);
      const sshCredentialId = await this.createSshCredential(tx, id, input.hostname, input.ssh);
      await tx.device.create({
        data: {
          id,
          name: input.displayName,
          displayName: input.displayName,
          hostname: input.hostname,
          ip: input.managementIp,
          managementIp: input.managementIp,
          vendor: input.vendor || null,
          model: input.model || null,
          description: input.description,
          notes: input.notes,
          origin: input.origin,
          status: 'UNKNOWN',
          deviceType: input.deviceType,
          site: input.site || null,
          source: input.zabbix.enabled ? 'ZABBIX' : 'MANUAL',
          discoveryMethod: input.snmp.enabled ? 'SNMP' : input.ssh.enabled ? 'SSH' : 'MANUAL',
          useZabbix: input.zabbix.enabled,
          zabbixHostId: input.zabbix.enabled ? input.zabbix.hostId : null,
          zabbixHostName: input.zabbix.enabled ? input.zabbix.hostName : null,
          zabbixInterfaceId: input.zabbix.enabled ? input.zabbix.primaryInterfaceId : null,
          zabbixIp: input.zabbix.enabled ? input.zabbix.ip : null,
          sshEnabled: input.ssh.enabled,
          sshHost: input.ssh.enabled ? input.ssh.host || input.managementIp : null,
          sshPort: input.ssh.port,
          sshUsername: input.ssh.enabled ? input.ssh.username : null,
          sshAuthentication: input.ssh.enabled ? 'PASSWORD' : null,
          snmpEnabled: input.snmp.enabled,
          snmpVersion: input.snmp.enabled ? input.snmp.version : null,
          snmpHost: input.snmp.enabled ? input.snmp.host || input.managementIp : null,
          snmpPort: input.snmp.port,
          snmpUsername: input.snmp.enabled ? input.snmp.username : null,
          snmpSecurityLevel: input.snmp.enabled ? input.snmp.securityLevel : null,
          snmpAuthProtocol: input.snmp.enabled ? input.snmp.authProtocol : null,
          snmpPrivacyProtocol: input.snmp.enabled ? input.snmp.privacyProtocol : null,
          snmpCredentialId,
          sshCredentialId,
          sourceHealth: {
            create: [
              { source: 'ZABBIX', state: input.zabbix.enabled ? 'CONFIGURED' : 'DISABLED' },
              { source: 'SSH', state: input.ssh.enabled ? 'CONFIGURED' : 'DISABLED' },
              { source: 'SNMP', state: input.snmp.enabled ? 'CONFIGURED' : 'DISABLED' },
            ],
          },
          ...(interfaces.length
            ? { interfaces: { create: interfaces.map((item) => this.interfaceCreateData(item)) } }
            : {}),
        },
      });
    });
    return (await this.getHost(id))!;
  }

  async updateHost(hostId: string, input: UpdateHostInput): Promise<HostRecord | null> {
    const existing = await this.prisma.device.findUnique({ where: { id: hostId } });
    if (!existing) return null;
    this.assertCredentialEncryption(input);

    await this.prisma.$transaction(async (tx) => {
      let snmpCredentialId = existing.snmpCredentialId;
      let sshCredentialId = existing.sshCredentialId;

      if (input.snmp) {
        if (input.snmp.clearCredential && snmpCredentialId) {
          await tx.device.update({ where: { id: hostId }, data: { snmpCredentialId: null } });
          await tx.snmpCredential.delete({ where: { id: snmpCredentialId } });
          snmpCredentialId = null;
        }
        if (input.snmp.community || input.snmp.authPassword || input.snmp.privacyPassword) {
          const encryptedPayload = this.encryptSnmp(input.snmp);
          if (snmpCredentialId) {
            await tx.snmpCredential.update({
              where: { id: snmpCredentialId },
              data: { version: input.snmp.version, port: input.snmp.port, encryptedPayload },
            });
          } else {
            const created = await tx.snmpCredential.create({
              data: {
                name: `${existing.hostname} SNMP`,
                version: input.snmp.version,
                port: input.snmp.port,
                encryptedPayload,
              },
            });
            snmpCredentialId = created.id;
          }
        }
      }

      if (input.ssh) {
        if (input.ssh.clearCredential && sshCredentialId) {
          await tx.device.update({ where: { id: hostId }, data: { sshCredentialId: null } });
          await tx.sshCredential.delete({ where: { id: sshCredentialId } });
          sshCredentialId = null;
        }
        if (input.ssh.password) {
          const encryptedPayload = this.encryptSsh(input.ssh.password);
          if (sshCredentialId) {
            await tx.sshCredential.update({
              where: { id: sshCredentialId },
              data: { port: input.ssh.port, username: input.ssh.username, encryptedPayload },
            });
          } else {
            const created = await tx.sshCredential.create({
              data: {
                name: `${existing.hostname} SSH`,
                port: input.ssh.port,
                username: input.ssh.username,
                encryptedPayload,
              },
            });
            sshCredentialId = created.id;
          }
        }
      }

      const snmpEnabled = input.snmp?.enabled ?? existing.snmpEnabled;
      const sshEnabled = input.ssh?.enabled ?? existing.sshEnabled;
      await tx.device.update({
        where: { id: hostId },
        data: {
          ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName, name: input.displayName } : {}),
          ...(input.managementIp !== undefined ? { managementIp: input.managementIp, ip: input.managementIp } : {}),
          ...(input.vendor !== undefined ? { vendor: input.vendor || null } : {}),
          ...(input.model !== undefined ? { model: input.model || null } : {}),
          ...(input.deviceType !== undefined ? { deviceType: input.deviceType } : {}),
          ...(input.site !== undefined ? { site: input.site || null } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
          ...(input.zabbix
            ? {
                useZabbix: input.zabbix.enabled,
                zabbixHostId: input.zabbix.enabled ? input.zabbix.hostId : null,
                zabbixHostName: input.zabbix.enabled ? input.zabbix.hostName : null,
                zabbixInterfaceId: input.zabbix.enabled ? input.zabbix.primaryInterfaceId : null,
                zabbixIp: input.zabbix.enabled ? input.zabbix.ip : null,
              }
            : {}),
          ...(input.ssh
            ? {
                sshEnabled: input.ssh.enabled,
                sshHost: input.ssh.enabled ? input.ssh.host || existing.managementIp : null,
                sshPort: input.ssh.port,
                sshUsername: input.ssh.enabled ? input.ssh.username : null,
                sshAuthentication: input.ssh.enabled ? 'PASSWORD' : null,
                sshCredentialId,
              }
            : {}),
          ...(input.snmp
            ? {
                snmpEnabled: input.snmp.enabled,
                snmpVersion: input.snmp.enabled ? input.snmp.version : null,
                snmpHost: input.snmp.enabled ? input.snmp.host || existing.managementIp : null,
                snmpPort: input.snmp.port,
                snmpUsername: input.snmp.enabled ? input.snmp.username : null,
                snmpSecurityLevel: input.snmp.enabled ? input.snmp.securityLevel : null,
                snmpAuthProtocol: input.snmp.enabled ? input.snmp.authProtocol : null,
                snmpPrivacyProtocol: input.snmp.enabled ? input.snmp.privacyProtocol : null,
                snmpCredentialId,
              }
            : {}),
          discoveryMethod: snmpEnabled ? 'SNMP' : sshEnabled ? 'SSH' : 'MANUAL',
        },
      });

      if (input.zabbix) await this.upsertSourceState(tx, hostId, 'ZABBIX', input.zabbix.enabled);
      if (input.ssh) await this.upsertSourceState(tx, hostId, 'SSH', input.ssh.enabled);
      if (input.snmp) await this.upsertSourceState(tx, hostId, 'SNMP', input.snmp.enabled);
    });
    return this.getHost(hostId);
  }

  async deleteHost(hostId: string): Promise<boolean> {
    const existing = await this.prisma.device.findUnique({
      where: { id: hostId },
      select: { id: true, snmpCredentialId: true, sshCredentialId: true },
    });
    if (!existing) return false;
    await this.prisma.$transaction(async (tx) => {
      await tx.device.delete({ where: { id: hostId } });
      if (existing.snmpCredentialId) await tx.snmpCredential.deleteMany({ where: { id: existing.snmpCredentialId } });
      if (existing.sshCredentialId) await tx.sshCredential.deleteMany({ where: { id: existing.sshCredentialId } });
    });
    return true;
  }

  async updateSourceHealth(hostId: string, result: ConnectionTestResult): Promise<void> {
    const state = persistedHealthState(result.state);
    const now = new Date(result.checkedAt);
    await this.prisma.deviceSourceHealth.upsert({
      where: { deviceId_source: { deviceId: hostId, source: result.source } },
      create: {
        deviceId: hostId,
        source: result.source,
        state,
        lastSuccess: state === 'CONNECTED' ? now : null,
        lastFailure: state === 'FAILED' ? now : null,
        lastErrorSafe: state === 'FAILED' ? result.message : null,
      },
      update: {
        state,
        ...(state === 'CONNECTED' ? { lastSuccess: now, lastFailure: null, lastErrorSafe: null } : {}),
        ...(state === 'FAILED' ? { lastFailure: now, lastErrorSafe: result.message } : {}),
        ...(state === 'DISABLED' ? { lastFailure: null, lastErrorSafe: null } : {}),
      },
    });
  }

  async getDecryptedSnmpCredentials(hostId: string): Promise<SnmpCredentialSecret | null> {
    if (!this.vault) return null;
    const device = await this.prisma.device.findUnique({
      where: { id: hostId },
      select: { snmpCredential: { select: { encryptedPayload: true } } },
    });
    if (!device?.snmpCredential) return null;
    try {
      const decrypted = this.vault.decrypt(Buffer.from(device.snmpCredential.encryptedPayload));
      return {
        ...(typeof decrypted.community === 'string' ? { community: decrypted.community } : {}),
        ...(typeof decrypted.authPassword === 'string' ? { authPassword: decrypted.authPassword } : {}),
        ...(typeof decrypted.privacyPassword === 'string' ? { privacyPassword: decrypted.privacyPassword } : {}),
      };
    } catch {
      return null;
    }
  }

  async getDecryptedSshCredentials(hostId: string): Promise<SshCredentialSecret | null> {
    if (!this.vault) return null;
    const device = await this.prisma.device.findUnique({
      where: { id: hostId },
      select: { sshCredential: { select: { encryptedPayload: true } } },
    });
    if (!device?.sshCredential) return null;
    try {
      const decrypted = this.vault.decrypt(Buffer.from(device.sshCredential.encryptedPayload));
      return typeof decrypted.password === 'string' ? { password: decrypted.password } : null;
    } catch {
      return null;
    }
  }

  async replaceInterfaces(hostId: string, interfaces: NetworkInterface[]): Promise<NetworkInterface[]> {
    await this.prisma.$transaction(async (tx) => {
      for (const item of interfaces) {
        await tx.interface.upsert({
          where: { deviceId_ifIndex: { deviceId: hostId, ifIndex: item.ifIndex } },
          create: { deviceId: hostId, ...this.interfaceCreateData(item) },
          update: this.interfaceUpdateData(item),
        });
      }
      await tx.device.update({ where: { id: hostId }, data: { lastDiscoveryAt: new Date() } });
    });
    return (await this.getHost(hostId))?.interfaces ?? [];
  }

  async getLatestCounterSnapshots(hostId: string): Promise<Map<number, InterfaceCounterSnapshot>> {
    const rows = await this.prisma.$queryRaw<Array<LatestMetricRow & { ifIndex: number }>>(Prisma.sql`
      SELECT
        i."ifIndex" AS "ifIndex",
        s."interfaceId" AS "interfaceId",
        s."timestamp" AS "timestamp",
        s."inOctets" AS "inOctets",
        s."outOctets" AS "outOctets",
        s."rxBps" AS "rxBps",
        s."txBps" AS "txBps",
        s."inErrors" AS "inErrors",
        s."outErrors" AS "outErrors",
        s."inDiscards" AS "inDiscards",
        s."outDiscards" AS "outDiscards",
        s."operStatus"::text AS "operStatus"
      FROM "Interface" i
      JOIN LATERAL (
        SELECT
          m."interfaceId",
          m."timestamp",
          m."inOctets",
          m."outOctets",
          m."rxBps",
          m."txBps",
          m."inErrors",
          m."outErrors",
          m."inDiscards",
          m."outDiscards",
          m."operStatus"
        FROM "InterfaceMetricSample" m
        WHERE m."interfaceId" = i."id"
        ORDER BY m."timestamp" DESC
        LIMIT 1
      ) s ON TRUE
      WHERE i."deviceId" = ${hostId}
    `);
    return new Map(rows.map((row) => [row.ifIndex, {
      interfaceId: row.interfaceId,
      ifIndex: row.ifIndex,
      timestamp: row.timestamp,
      inOctets: row.inOctets,
      outOctets: row.outOctets,
      inErrors: row.inErrors,
      outErrors: row.outErrors,
      inDiscards: row.inDiscards,
      outDiscards: row.outDiscards,
    }]));
  }

  async saveSnmpPoll(hostId: string, deviceSample: DeviceMetricSampleInput, samples: InterfaceMetricSampleInput[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.device.update({
        where: { id: hostId },
        data: {
          lastPollingAt: deviceSample.timestamp,
          ...(deviceSample.uptimeSeconds !== undefined ? { uptimeSeconds: deviceSample.uptimeSeconds } : {}),
          status: 'UP',
        },
      });
      await tx.deviceMetricSample.create({
        data: {
          deviceId: hostId,
          timestamp: deviceSample.timestamp,
          ...(deviceSample.uptimeSeconds !== undefined ? { uptimeSeconds: deviceSample.uptimeSeconds } : {}),
          ...(deviceSample.sysName !== undefined ? { sysName: deviceSample.sysName } : {}),
          ...(deviceSample.sysDescr !== undefined ? { sysDescr: deviceSample.sysDescr } : {}),
          ...(deviceSample.sysObjectId !== undefined ? { sysObjectId: deviceSample.sysObjectId } : {}),
        },
      });
      if (samples.length) {
        await tx.interfaceMetricSample.createMany({
          data: samples.map((sample) => ({
            interfaceId: sample.interfaceId,
            timestamp: sample.timestamp,
            inOctets: sample.inOctets,
            outOctets: sample.outOctets,
            rxBps: sample.rxBps,
            txBps: sample.txBps,
            inErrors: sample.inErrors,
            outErrors: sample.outErrors,
            inDiscards: sample.inDiscards,
            outDiscards: sample.outDiscards,
            operStatus: sample.operStatus,
          })),
        });
      }
    });
  }

  async getInterfaceHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]> {
    const rows = await this.prisma.interfaceMetricSample.findMany({
      where: { interfaceId, timestamp: { gte: historyStart(period) } },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map((row) => ({
      timestamp: row.timestamp.toISOString(),
      rxBps: row.rxBps,
      txBps: row.txBps,
      rxErrors: safeNumber(row.inErrors),
      txErrors: safeNumber(row.outErrors),
      rxDiscards: safeNumber(row.inDiscards),
      txDiscards: safeNumber(row.outDiscards),
    }));
  }

  async getInterfaceMetrics(interfaceId: string): Promise<Record<string, number | string> | null> {
    const row = await this.prisma.interfaceMetricSample.findFirst({
      where: { interfaceId },
      orderBy: { timestamp: 'desc' },
      include: { interface: { select: { speedBps: true } } },
    });
    if (!row) return null;
    const speedBps = safeNumber(row.interface.speedBps);
    return {
      timestamp: row.timestamp.toISOString(),
      rxBps: row.rxBps,
      txBps: row.txBps,
      rxUtilization: speedBps > 0 ? (row.rxBps / speedBps) * 100 : 0,
      txUtilization: speedBps > 0 ? (row.txBps / speedBps) * 100 : 0,
      rxErrors: safeNumber(row.inErrors),
      txErrors: safeNumber(row.outErrors),
      rxDiscards: safeNumber(row.inDiscards),
      txDiscards: safeNumber(row.outDiscards),
      operStatus: row.operStatus,
    };
  }

  private async loadLatestMetrics(interfaceIds: string[]): Promise<Map<string, LatestMetricRow>> {
    if (!interfaceIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<LatestMetricRow[]>(Prisma.sql`
      SELECT
        i."id" AS "interfaceId",
        s."timestamp" AS "timestamp",
        s."inOctets" AS "inOctets",
        s."outOctets" AS "outOctets",
        s."rxBps" AS "rxBps",
        s."txBps" AS "txBps",
        s."inErrors" AS "inErrors",
        s."outErrors" AS "outErrors",
        s."inDiscards" AS "inDiscards",
        s."outDiscards" AS "outDiscards",
        s."operStatus"::text AS "operStatus"
      FROM "Interface" i
      JOIN LATERAL (
        SELECT
          m."timestamp",
          m."inOctets",
          m."outOctets",
          m."rxBps",
          m."txBps",
          m."inErrors",
          m."outErrors",
          m."inDiscards",
          m."outDiscards",
          m."operStatus"
        FROM "InterfaceMetricSample" m
        WHERE m."interfaceId" = i."id"
        ORDER BY m."timestamp" DESC
        LIMIT 1
      ) s ON TRUE
      WHERE i."id" IN (${Prisma.join(interfaceIds)})
    `);
    return new Map(rows.map((row) => [row.interfaceId, row]));
  }

  private toHostRecord(device: {
    id: string; name: string; displayName: string; hostname: string; ip: string; managementIp: string;
    vendor: string | null; model: string | null; description: string; notes: string; origin: string; status: string;
    deviceType: string; site: string | null; source: string; discoveryMethod: string; useZabbix: boolean;
    zabbixHostId: string | null; zabbixHostName: string | null; zabbixInterfaceId: string | null; zabbixIp: string | null;
    sshEnabled: boolean; sshHost: string | null; sshPort: number; sshUsername: string | null; sshAuthentication: string | null;
    snmpEnabled: boolean; snmpVersion: string | null; snmpHost: string | null; snmpPort: number; snmpUsername: string | null;
    snmpSecurityLevel: string | null; snmpAuthProtocol: string | null; snmpPrivacyProtocol: string | null;
    lastPollingAt: Date | null; lastDiscoveryAt: Date | null; uptimeSeconds: bigint | null; cpuPercent: number | null;
    memoryPercent: number | null; snmpCredentialId: string | null; sshCredentialId: string | null; createdAt: Date; updatedAt: Date;
    mapNodes: Array<{ mapId: string }>;
    sourceHealth: Array<{ source: string; state: string; lastSuccess: Date | null; lastFailure: Date | null; lastErrorSafe: string | null }>;
    metricSamples: Array<{ sysName: string | null }>;
    interfaces: Array<{
      id: string; deviceId: string; name: string; alias: string | null; description: string | null; ifIndex: number;
      mac: string | null; mtu: number | null; speedBps: bigint | null; adminStatus: string; operStatus: string;
      rxPowerDbm: number | null; txPowerDbm: number | null; opticalSource: string | null; opticalUpdatedAt: Date | null;
      rxItemId: string | null; txItemId: string | null; statusItemId: string | null; inErrorsItemId: string | null;
      outErrorsItemId: string | null; inDiscardsItemId: string | null; outDiscardsItemId: string | null; dataSources: unknown;
      metricSamples: Array<{ rxBps: number; txBps: number; inErrors: bigint; outErrors: bigint; inDiscards: bigint; outDiscards: bigint }>;
    }>;
  }): HostRecord {
    const health = new Map(device.sourceHealth.map((item) => [item.source, item]));
    const sourceHealth = Object.fromEntries(
      (['ZABBIX', 'SSH', 'SNMP'] as SourceKind[]).map((source) => {
        const row = health.get(source);
        return [source, row
          ? {
              state: row.state,
              lastSuccess: row.lastSuccess?.toISOString() ?? null,
              lastFailure: row.lastFailure?.toISOString() ?? null,
              lastErrorSafe: row.lastErrorSafe,
            }
          : source === 'ZABBIX'
            ? device.useZabbix ? configuredHealth() : disabledHealth()
            : source === 'SSH'
              ? device.sshEnabled ? configuredHealth() : disabledHealth()
              : device.snmpEnabled ? configuredHealth() : disabledHealth()];
      }),
    ) as HostRecord['sourceHealth'];

    const interfaces: NetworkInterface[] = device.interfaces.map((item) => {
      const sample = item.metricSamples[0];
      const speedBps = safeNumber(item.speedBps);
      const rxBps = sample?.rxBps ?? 0;
      const txBps = sample?.txBps ?? 0;
      return {
        id: item.id,
        deviceId: item.deviceId,
        name: item.name,
        alias: item.alias ?? '',
        description: item.description ?? '',
        ifIndex: item.ifIndex,
        mac: item.mac ?? '',
        mtu: item.mtu ?? 0,
        speedBps,
        adminStatus: item.adminStatus === 'UP' ? 'UP' : 'DOWN',
        operStatus: statusFromDb(item.operStatus),
        rxBps,
        txBps,
        rxUtilization: speedBps > 0 ? (rxBps / speedBps) * 100 : 0,
        txUtilization: speedBps > 0 ? (txBps / speedBps) * 100 : 0,
        rxErrors: safeNumber(sample?.inErrors),
        txErrors: safeNumber(sample?.outErrors),
        rxDiscards: safeNumber(sample?.inDiscards),
        txDiscards: safeNumber(sample?.outDiscards),
        rxPowerDbm: item.rxPowerDbm,
        txPowerDbm: item.txPowerDbm,
        opticalSource: item.opticalSource === 'SNMP' || item.opticalSource === 'SSH' ? item.opticalSource : null,
        opticalUpdatedAt: item.opticalUpdatedAt?.toISOString() ?? null,
        rxItemId: item.rxItemId,
        txItemId: item.txItemId,
        statusItemId: item.statusItemId,
        inErrorsItemId: item.inErrorsItemId,
        outErrorsItemId: item.outErrorsItemId,
        inDiscardsItemId: item.inDiscardsItemId,
        outDiscardsItemId: item.outDiscardsItemId,
        dataSources: Array.isArray(item.dataSources)
          ? (item.dataSources as Array<'ZABBIX' | 'SNMP' | 'SSH' | 'DEMO'>)
          : ['SNMP'],
      };
    });

    const mapIds = device.mapNodes.map((node) => node.mapId);
    return {
      id: device.id,
      name: device.name,
      displayName: device.displayName,
      hostname: device.hostname,
      ip: device.ip,
      managementIp: device.managementIp,
      vendor: device.vendor ?? '',
      model: device.model ?? '',
      status: device.status as HostRecord['status'],
      deviceType: device.deviceType as HostRecord['deviceType'],
      site: device.site ?? '',
      source: device.source as HostRecord['source'],
      discoveryMethod: device.discoveryMethod as HostRecord['discoveryMethod'],
      uptimeSeconds: safeNumber(device.uptimeSeconds),
      ...(device.cpuPercent === null ? {} : { cpuPercent: device.cpuPercent }),
      ...(device.memoryPercent === null ? {} : { memoryPercent: device.memoryPercent }),
      updatedAt: device.updatedAt.toISOString(),
      interfaces,
      description: device.description,
      notes: device.notes,
      origin: device.origin as HostRecord['origin'],
      useZabbix: device.useZabbix,
      zabbix: device.useZabbix ? {
        hostId: device.zabbixHostId ?? '', hostName: device.zabbixHostName ?? '', primaryInterfaceId: device.zabbixInterfaceId ?? '', ip: device.zabbixIp ?? device.managementIp,
      } : null,
      sshEnabled: device.sshEnabled,
      ssh: device.sshEnabled ? {
        host: device.sshHost ?? device.managementIp,
        port: device.sshPort,
        username: device.sshUsername ?? '',
        credentialConfigured: Boolean(device.sshCredentialId),
        authenticationType: device.sshAuthentication === 'PRIVATE_KEY' ? 'PRIVATE_KEY' : 'PASSWORD',
      } : null,
      snmpEnabled: device.snmpEnabled,
      snmp: device.snmpEnabled ? {
        version: (device.snmpVersion ?? 'SNMP_V2C') as NonNullable<HostRecord['snmp']>['version'],
        host: device.snmpHost ?? device.managementIp,
        port: device.snmpPort,
        username: device.snmpUsername ?? '',
        securityLevel: (device.snmpSecurityLevel ?? 'NO_AUTH_NO_PRIV') as NonNullable<HostRecord['snmp']>['securityLevel'],
        authProtocol: device.snmpAuthProtocol as NonNullable<HostRecord['snmp']>['authProtocol'],
        privacyProtocol: device.snmpPrivacyProtocol as NonNullable<HostRecord['snmp']>['privacyProtocol'],
        credentialConfigured: Boolean(device.snmpCredentialId),
      } : null,
      sourceHealth,
      lastPollingAt: device.lastPollingAt?.toISOString() ?? null,
      lastDiscoveryAt: device.lastDiscoveryAt?.toISOString() ?? null,
      detectedHostname: device.metricSamples[0]?.sysName ?? null,
      mapIds,
      mapCount: mapIds.length,
      createdAt: device.createdAt.toISOString(),
    };
  }

  private interfaceCreateData(item: NetworkInterface) {
    return {
      name: item.name,
      alias: item.alias || null,
      description: item.description || null,
      ifIndex: item.ifIndex,
      mac: item.mac || null,
      mtu: item.mtu || null,
      speedBps: BigInt(Math.max(0, Math.trunc(item.speedBps))),
      adminStatus: item.adminStatus,
      operStatus: item.operStatus,
      rxPowerDbm: item.rxPowerDbm ?? null,
      txPowerDbm: item.txPowerDbm ?? null,
      opticalSource: item.opticalSource ?? null,
      opticalUpdatedAt: item.opticalUpdatedAt ? new Date(item.opticalUpdatedAt) : null,
      rxItemId: item.rxItemId ?? null,
      txItemId: item.txItemId ?? null,
      statusItemId: item.statusItemId ?? null,
      inErrorsItemId: item.inErrorsItemId ?? null,
      outErrorsItemId: item.outErrorsItemId ?? null,
      inDiscardsItemId: item.inDiscardsItemId ?? null,
      outDiscardsItemId: item.outDiscardsItemId ?? null,
      dataSources: item.dataSources ?? ['SNMP'],
    };
  }

  private interfaceUpdateData(item: NetworkInterface) {
    return this.interfaceCreateData(item);
  }

  private assertCredentialEncryption(input: CreateHostInput | UpdateHostInput): void {
    if (!this.vault) {
      const ssh = input.ssh;
      const snmp = input.snmp;
      if (ssh?.password || snmp?.community || snmp?.authPassword || snmp?.privacyPassword) {
        throw new CredentialEncryptionUnavailableError();
      }
    }
  }

  private encryptSnmp(input: NonNullable<CreateHostInput['snmp']>): Buffer<ArrayBuffer> {
    if (!this.vault) throw new CredentialEncryptionUnavailableError();
    return this.vault.encrypt({
      version: input.version,
      ...(input.community ? { community: input.community } : {}),
      ...(input.authPassword ? { authPassword: input.authPassword } : {}),
      ...(input.privacyPassword ? { privacyPassword: input.privacyPassword } : {}),
    });
  }

  private encryptSsh(password: string): Buffer<ArrayBuffer> {
    if (!this.vault) throw new CredentialEncryptionUnavailableError();
    return this.vault.encrypt({ type: 'PASSWORD', password });
  }

  private async createSnmpCredential(
    tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    _hostId: string,
    hostname: string,
    input: CreateHostInput['snmp'],
  ): Promise<string | null> {
    if (!input.enabled || (!input.community && !input.authPassword && !input.privacyPassword)) return null;
    const credential = await tx.snmpCredential.create({
      data: {
        name: `${hostname} SNMP`,
        version: input.version,
        port: input.port,
        encryptedPayload: this.encryptSnmp(input),
      },
    });
    return credential.id;
  }

  private async createSshCredential(
    tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    _hostId: string,
    hostname: string,
    input: CreateHostInput['ssh'],
  ): Promise<string | null> {
    if (!input.enabled || !input.password) return null;
    const credential = await tx.sshCredential.create({
      data: {
        name: `${hostname} SSH`,
        port: input.port,
        username: input.username,
        encryptedPayload: this.encryptSsh(input.password),
      },
    });
    return credential.id;
  }

  private async upsertSourceState(
    tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    hostId: string,
    source: SourceKind,
    enabled: boolean,
  ): Promise<void> {
    await tx.deviceSourceHealth.upsert({
      where: { deviceId_source: { deviceId: hostId, source } },
      create: { deviceId: hostId, source, state: enabled ? 'CONFIGURED' : 'DISABLED' },
      update: { state: enabled ? 'CONFIGURED' : 'DISABLED', lastErrorSafe: null },
    });
  }
}

export function createPrismaHostRepository(vault: CredentialVault | null): PrismaHostRepository {
  return new PrismaHostRepository(new PrismaClient(), vault);
}
