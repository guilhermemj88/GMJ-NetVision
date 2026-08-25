import {
  EMPTY_MPLS_SUMMARY,
  type MplsHostOverview,
  type MplsPw,
  type MplsStateEvent,
  type MplsSummary,
  type MplsVsi,
} from '@gmj/shared';
import { PrismaClient } from '../../generated/prisma/index.js';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';
import { HUAWEI_VPLS_PW_COLUMNS, HUAWEI_VPLS_VSI_COLUMNS } from './huawei-vpls-oids';
import type { MplsRepository } from './mpls-repository';
import { isRealMplsStateChange } from './mpls-state-events';

const remoteHostSelect = { id: true, name: true, hostname: true } as const;
const pwInclude = { remoteHost: { select: remoteHostSelect } } as const;

type PwRow = Awaited<ReturnType<PrismaClient['mplsPw']['findMany']>>[number] & {
  remoteHost?: { id: string; name: string; hostname: string } | null;
};

function toPw(row: PwRow): MplsPw {
  return {
    id: row.id,
    hostId: row.hostId,
    mplsVsiId: row.mplsVsiId,
    vsiName: row.vsiName,
    pwId: row.pwId,
    remoteIp: row.remoteIp,
    remoteHostId: row.remoteHostId,
    remoteHost: row.remoteHost ?? null,
    tunnelPolicy: row.tunnelPolicy,
    pwType: row.pwType,
    inboundLabel: row.inboundLabel,
    outboundLabel: row.outboundLabel,
    status: row.status,
    state: row.state,
    workingState: row.workingState,
    upStartTime: row.upStartTime?.toISOString() ?? null,
    upSumTime: row.upSumTime == null ? null : Number(row.upSumTime),
    source: row.source,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type VsiRow = Awaited<ReturnType<PrismaClient['mplsVsi']['findMany']>>[number] & { pws?: PwRow[] };

function toVsi(row: VsiRow): MplsVsi {
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    signalingType: row.signalingType,
    rd: row.rd,
    vsiId: row.vsiId,
    status: row.status,
    operationalStatus: row.operationalStatus,
    adminStatus: row.adminStatus,
    mtu: row.mtu,
    vcType: row.vcType,
    tunnelPolicy: row.tunnelPolicy,
    description: row.description,
    vlanId: row.vlanId,
    localInterfaceId: row.localInterfaceId,
    source: row.source,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    pws: (row.pws ?? []).map(toPw),
  };
}

function summary(vsis: MplsVsi[]): MplsSummary {
  const pws = vsis.flatMap((vsi) => vsi.pws);
  return {
    vsiTotal: vsis.length,
    vsiUp: vsis.filter((vsi) => vsi.status === 'UP').length,
    vsiDown: vsis.filter((vsi) => vsi.status === 'DOWN').length,
    vsiDegraded: vsis.filter((vsi) => vsi.status === 'DEGRADED').length,
    vsiAdminDown: vsis.filter((vsi) => vsi.status === 'ADMIN_DOWN').length,
    vsiUnknown: vsis.filter((vsi) => vsi.status === 'UNKNOWN').length,
    pwTotal: pws.length,
    pwUp: pws.filter((pw) => pw.status === 'UP').length,
    pwDown: pws.filter((pw) => pw.status === 'DOWN' || pw.status === 'PLUG_OUT').length,
  };
}

function pwKey(vsiName: string, pwId: number, remoteIp: string): string {
  return `${vsiName}|${pwId}|${remoteIp}`;
}

export class PrismaMplsRepository implements MplsRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async saveCollection(hostId: string, collection: HuaweiVplsCollection): Promise<void> {
    const now = collection.collectedAt;
    if (!collection.supported) {
      await this.prisma.mplsDeviceState.upsert({
        where: { hostId },
        create: { hostId, supported: false, lastPollingAt: now, lastSuccessAt: now },
        update: { supported: false, lastPollingAt: now, lastSuccessAt: now, lastErrorSafe: null },
      });
      return;
    }

    const existingVsis = await this.prisma.mplsVsi.findMany({
      where: { hostId },
      include: { pws: true },
    });
    const collectedVsiColumns = new Set(collection.collectedColumns.vsi);
    const collectedPwColumns = new Set(collection.collectedColumns.pw);
    const remoteIps = [
      ...new Set(collection.vsis.flatMap((vsi) => vsi.pws.map((pw) => pw.remoteIp))),
    ];
    const hosts = remoteIps.length
      ? await this.prisma.device.findMany({
          where: { OR: [{ ip: { in: remoteIps } }, { managementIp: { in: remoteIps } }] },
          select: { id: true, ip: true, managementIp: true },
        })
      : [];
    const remoteHostIds = new Map<string, string>();
    for (const host of hosts) if (remoteIps.includes(host.ip)) remoteHostIds.set(host.ip, host.id);
    for (const host of hosts)
      if (!remoteHostIds.has(host.managementIp)) remoteHostIds.set(host.managementIp, host.id);

    const existingVsiByName = new Map(existingVsis.map((vsi) => [vsi.name, vsi]));
    const existingPwByKey = new Map(
      existingVsis.flatMap((vsi) =>
        vsi.pws.map((pw) => [pwKey(pw.vsiName, pw.pwId, pw.remoteIp), pw] as const),
      ),
    );
    const operations = [];
    const events: Array<{
      hostId: string;
      entityType: 'VSI' | 'PW';
      entityId: string;
      vsiName: string;
      pwId: number | null;
      remoteIp: string | null;
      previousStatus: string;
      currentStatus: string;
      occurredAt: Date;
    }> = [];

    for (const vsi of collection.vsis) {
      const existing = existingVsiByName.get(vsi.name);
      const collectedPwKeys = new Set(vsi.pws.map((pw) => pw.key));
      const allKnownPwsPresent =
        !existing ||
        existing.pws.every((pw) => collectedPwKeys.has(pwKey(pw.vsiName, pw.pwId, pw.remoteIp)));
      const mayUpdateStatus = vsi.statusObserved && allKnownPwsPresent && vsi.status !== 'UNKNOWN';
      if (
        existing &&
        isRealMplsStateChange(existing.status, vsi.status, {
          observed: vsi.statusObserved,
          complete: allKnownPwsPresent,
        })
      ) {
        events.push({
          hostId,
          entityType: 'VSI',
          entityId: existing.id,
          vsiName: vsi.name,
          pwId: null,
          remoteIp: null,
          previousStatus: existing.status,
          currentStatus: vsi.status,
          occurredAt: now,
        });
      }
      operations.push(
        this.prisma.mplsVsi.upsert({
          where: { hostId_name: { hostId, name: vsi.name } },
          create: {
            hostId,
            name: vsi.name,
            signalingType: vsi.signalingType,
            rd: vsi.rd,
            vsiId: vsi.vsiId,
            status: vsi.status,
            operationalStatus: vsi.operationalStatus,
            adminStatus: vsi.adminStatus,
            mtu: vsi.mtu,
            vcType: vsi.vcType,
            tunnelPolicy: vsi.tunnelPolicy,
            description: vsi.description,
            source: 'SNMP',
            lastSeenAt: now,
          },
          update: {
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.signalingType)
              ? { signalingType: vsi.signalingType }
              : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.rd) ? { rd: vsi.rd } : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.vsiId) ? { vsiId: vsi.vsiId } : {}),
            ...(mayUpdateStatus
              ? { status: vsi.status, operationalStatus: vsi.operationalStatus }
              : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.adminStatus)
              ? { adminStatus: vsi.adminStatus }
              : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.mtu) ? { mtu: vsi.mtu } : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.vcType)
              ? { vcType: vsi.vcType }
              : {}),
            ...(collectedVsiColumns.has(HUAWEI_VPLS_VSI_COLUMNS.tunnelPolicy)
              ? { tunnelPolicy: vsi.tunnelPolicy }
              : {}),
            source: 'SNMP',
            lastSeenAt: now,
          },
        }),
      );

      for (const pw of vsi.pws) {
        const existingPw = existingPwByKey.get(pw.key);
        const mayUpdatePwStatus = pw.statusObserved && pw.status !== 'UNKNOWN';
        if (
          existingPw &&
          isRealMplsStateChange(existingPw.status, pw.status, {
            observed: pw.statusObserved,
            complete: true,
          })
        ) {
          events.push({
            hostId,
            entityType: 'PW',
            entityId: existingPw.id,
            vsiName: vsi.name,
            pwId: pw.pwId,
            remoteIp: pw.remoteIp,
            previousStatus: existingPw.status,
            currentStatus: pw.status,
            occurredAt: now,
          });
        }
        operations.push(
          this.prisma.mplsPw.upsert({
            where: {
              hostId_vsiName_pwId_remoteIp: {
                hostId,
                vsiName: vsi.name,
                pwId: pw.pwId,
                remoteIp: pw.remoteIp,
              },
            },
            create: {
              vsiName: vsi.name,
              pwId: pw.pwId,
              remoteIp: pw.remoteIp,
              host: { connect: { id: hostId } },
              vsi: { connect: { hostId_name: { hostId, name: vsi.name } } },
              ...(remoteHostIds.has(pw.remoteIp)
                ? { remoteHost: { connect: { id: remoteHostIds.get(pw.remoteIp)! } } }
                : {}),
              tunnelPolicy: pw.tunnelPolicy,
              pwType: pw.pwType,
              inboundLabel: pw.inboundLabel,
              outboundLabel: pw.outboundLabel,
              status: pw.status,
              state: pw.state,
              workingState: pw.workingState,
              upStartTime: pw.upStartTime,
              upSumTime: pw.upSumTime,
              source: 'SNMP',
              lastSeenAt: now,
            },
            update: {
              remoteHostId: remoteHostIds.get(pw.remoteIp) ?? null,
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.tunnelPolicy)
                ? { tunnelPolicy: pw.tunnelPolicy }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.pwType)
                ? { pwType: pw.pwType }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.inboundLabel)
                ? { inboundLabel: pw.inboundLabel }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.outboundLabel)
                ? { outboundLabel: pw.outboundLabel }
                : {}),
              ...(mayUpdatePwStatus ? { status: pw.status } : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.state) ? { state: pw.state } : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.workingState)
                ? { workingState: pw.workingState }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.upStartTime)
                ? { upStartTime: pw.upStartTime }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.upSumTime)
                ? { upSumTime: pw.upSumTime }
                : {}),
              source: 'SNMP',
              lastSeenAt: now,
            },
          }),
        );
      }
    }
    if (events.length) operations.push(this.prisma.mplsStateEvent.createMany({ data: events }));
    operations.push(
      this.prisma.mplsDeviceState.upsert({
        where: { hostId },
        create: { hostId, supported: true, lastPollingAt: now, lastSuccessAt: now },
        update: { supported: true, lastPollingAt: now, lastSuccessAt: now, lastErrorSafe: null },
      }),
    );
    await this.prisma.$transaction(operations);
  }

  async saveFailure(hostId: string, occurredAt: Date, safeMessage: string): Promise<void> {
    await this.prisma.mplsDeviceState.upsert({
      where: { hostId },
      create: {
        hostId,
        supported: false,
        lastPollingAt: occurredAt,
        lastFailureAt: occurredAt,
        lastErrorSafe: safeMessage.slice(0, 500),
      },
      update: {
        lastPollingAt: occurredAt,
        lastFailureAt: occurredAt,
        lastErrorSafe: safeMessage.slice(0, 500),
      },
    });
  }

  async getHostOverview(hostId: string): Promise<MplsHostOverview> {
    const state = await this.prisma.mplsDeviceState.findUnique({ where: { hostId } });
    if (!state || !state.supported) {
      return {
        supported: false,
        source: 'SNMP',
        lastPollingAt: state?.lastPollingAt?.toISOString() ?? null,
        lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
        lastErrorSafe: state?.lastErrorSafe ?? null,
        summary: { ...EMPTY_MPLS_SUMMARY },
        vsis: [],
      };
    }
    const vsis = await this.listVsis(hostId);
    return {
      supported: true,
      source: state.source,
      lastPollingAt: state.lastPollingAt?.toISOString() ?? null,
      lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
      lastErrorSafe: state.lastErrorSafe,
      summary: summary(vsis),
      vsis,
    };
  }

  async listVsis(hostId: string): Promise<MplsVsi[]> {
    const rows = await this.prisma.mplsVsi.findMany({
      where: { hostId },
      include: { pws: { include: pwInclude, orderBy: [{ remoteIp: 'asc' }, { pwId: 'asc' }] } },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => toVsi(row as unknown as VsiRow));
  }

  async listPws(hostId: string, vsiId: string): Promise<MplsPw[] | null> {
    const vsi = await this.prisma.mplsVsi.findFirst({
      where: { id: vsiId, hostId },
      select: { id: true },
    });
    if (!vsi) return null;
    const rows = await this.prisma.mplsPw.findMany({
      where: { hostId, mplsVsiId: vsiId },
      include: pwInclude,
      orderBy: [{ remoteIp: 'asc' }, { pwId: 'asc' }],
    });
    return rows.map((row) => toPw(row as unknown as PwRow));
  }

  async listEvents(hostId: string, limit: number): Promise<MplsStateEvent[]> {
    const rows = await this.prisma.mplsStateEvent.findMany({
      where: { hostId },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      hostId: row.hostId,
      entityType: row.entityType,
      entityId: row.entityId,
      vsiName: row.vsiName,
      pwId: row.pwId,
      remoteIp: row.remoteIp,
      previousStatus: row.previousStatus,
      currentStatus: row.currentStatus,
      occurredAt: row.occurredAt.toISOString(),
    }));
  }
}
