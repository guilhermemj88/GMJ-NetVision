import {
  EMPTY_MPLS_SUMMARY,
  summarizeMpls,
  type MplsAc,
  type MplsHostOverview,
  type MplsL2vcCircuit,
  type MplsPw,
  type MplsStateEvent,
  type MplsVsi,
} from '@gmj/shared';
import { PrismaClient } from '../../generated/prisma/index.js';
import { prismaClient } from '../persistence/prisma-client.js';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';
import {
  HUAWEI_VPLS_AC_COLUMNS,
  HUAWEI_VPLS_PW_COLUMNS,
  HUAWEI_VPLS_VSI_COLUMNS,
} from './huawei-vpls-oids';
import type { MplsRepository } from './mpls-repository';
import { isRealMplsStateChange } from './mpls-state-events';
import { interfaceNameKeys } from '../topology/interface-correlation';

const remoteHostSelect = { id: true, name: true, hostname: true } as const;
const pwInclude = { remoteHost: { select: remoteHostSelect } } as const;
const acInclude = {
  interface: { select: { id: true, name: true, alias: true, ifIndex: true } },
} as const;

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

type AcRow = Awaited<ReturnType<PrismaClient['mplsAc']['findMany']>>[number] & {
  interface?: { id: string; name: string; alias: string; ifIndex: number } | null;
};

function toAc(row: AcRow): MplsAc {
  return {
    id: row.id,
    hostId: row.hostId,
    mplsVsiId: row.mplsVsiId,
    vsiName: row.vsiName,
    ifIndex: row.ifIndex,
    interfaceId: row.interfaceId,
    interface: row.interface ?? null,
    status: row.status,
    upStartTimeRaw: row.upStartTimeRaw,
    upSumTimeRaw: row.upSumTimeRaw == null ? null : Number(row.upSumTimeRaw),
    source: row.source,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type VsiRow = Awaited<ReturnType<PrismaClient['mplsVsi']['findMany']>>[number] & {
  acs?: AcRow[];
  pws?: PwRow[];
};

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
    memberDiscovery: row.memberDiscovery,
    vlanId: row.vlanId,
    localInterfaceId: row.localInterfaceId,
    source: row.source,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acs: (row.acs ?? []).map(toAc),
    pws: (row.pws ?? []).map(toPw),
  };
}

export function vlanIdFromMplsInterfaceName(name: string): number | null {
  const match = name.match(/^Vlanif(\d+)$/i);
  if (!match) return null;
  const vlanId = Number(match[1]);
  return Number.isInteger(vlanId) && vlanId >= 1 && vlanId <= 4094 ? vlanId : null;
}

export function correlateMplsAcInterface<T extends { id: string; ifIndex: number; name: string }>(
  ifIndex: number,
  interfacesByIfIndex: ReadonlyMap<number, T>,
): { interface: T; vlanId: number | null } | null {
  const networkInterface = interfacesByIfIndex.get(ifIndex);
  return networkInterface
    ? { interface: networkInterface, vlanId: vlanIdFromMplsInterfaceName(networkInterface.name) }
    : null;
}

function pwKey(vsiName: string, pwId: number, remoteIp: string): string {
  return `${vsiName}|${pwId}|${remoteIp}`;
}

export class PrismaMplsRepository implements MplsRepository {
  constructor(private readonly prisma: PrismaClient = prismaClient) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * Liga cada circuito L2VC ao inventario de interfaces do host pelo nome do AC
   * (o VRP imprime `Vlanif100`, o inventario guarda `Vlanif100`/`GigabitEthernet`).
   * Sem correspondencia o circuito continua valido, apenas sem correlacao.
   */
  private async correlateL2vcCircuits(
    hostId: string,
    circuits: MplsL2vcCircuit[] | undefined,
  ): Promise<MplsL2vcCircuit[] | undefined> {
    if (!circuits?.length) return circuits;
    const interfaces = await this.prisma.interface.findMany({
      where: { deviceId: hostId },
      select: { id: true, ifIndex: true, name: true, alias: true },
    });
    const byKey = new Map<string, (typeof interfaces)[number]>();
    for (const item of interfaces) {
      for (const key of interfaceNameKeys(item.name)) {
        if (!byKey.has(key)) byKey.set(key, item);
      }
    }
    return circuits.map((circuit) => {
      const match = interfaceNameKeys(circuit.name)
        .map((key) => byKey.get(key))
        .find((item) => item !== undefined);
      return match
        ? { ...circuit, ifIndex: match.ifIndex, interfaceId: match.id, interfaceAlias: match.alias }
        : circuit;
    });
  }

  async saveCollection(hostId: string, collection: HuaweiVplsCollection): Promise<void> {
    const now = collection.collectedAt;
    const discoveryState = collection.discoveryState ?? (collection.supported ? 'FOUND_UP' : 'INCOMPLETE');
    // Circuitos L2VC sao JSON: a correlacao com o inventario e feita aqui, uma
    // vez por coleta, antes de gravar as evidencias.
    const l2vcCircuits = await this.correlateL2vcCircuits(hostId, collection.l2vcCircuits);
    const discoveryMetadata = {
      discoveryState,
      sources: collection.sources ?? [],
      // Ausente = fonte nao consultada nesta rodada; preserva a evidencia anterior.
      ...(collection.ldpPeers === undefined
        ? {}
        : { ldpPeers: collection.ldpPeers as unknown as object }),
      ...(l2vcCircuits === undefined
        ? {}
        : { l2vcCircuits: l2vcCircuits as unknown as object }),
      ...(collection.conflicts === undefined
        ? {}
        : { conflicts: collection.conflicts as unknown as object }),
    };

    // Coleta inconclusiva SEM VSI lida NAO apaga o que ja era conhecido: o
    // estado e a mensagem mudam, mas as VSIs persistidas continuam visiveis.
    if (
      (discoveryState === 'INCOMPLETE' || discoveryState === 'UNKNOWN') &&
      collection.vsis.length === 0
    ) {
      await this.prisma.mplsDeviceState.upsert({
        where: { hostId },
        create: {
          hostId,
          supported: false,
          vsiSupported: false,
          acSupported: false,
          pwSupported: false,
          lastPollingAt: now,
          lastFailureAt: now,
          lastErrorSafe: collection.errors.length
            ? `Coleta MPLS incompleta: ${collection.errors.join('; ')}`.slice(0, 500)
            : 'Coleta MPLS incompleta: nenhuma fonte concluiu a leitura.',
          ...discoveryMetadata,
        },
        update: {
          lastPollingAt: now,
          lastFailureAt: now,
          lastErrorSafe: collection.errors.length
            ? `Coleta MPLS incompleta: ${collection.errors.join('; ')}`.slice(0, 500)
            : 'Coleta MPLS incompleta: nenhuma fonte concluiu a leitura.',
          ...discoveryMetadata,
        },
      });
      return;
    }

    if (!collection.supported) {
      await this.prisma.mplsDeviceState.upsert({
        where: { hostId },
        create: {
          hostId,
          supported: false,
          vsiSupported: false,
          acSupported: false,
          pwSupported: false,
          lastPollingAt: now,
          lastSuccessAt: now,
          ...discoveryMetadata,
        },
        update: {
          supported: false,
          vsiSupported: false,
          acSupported: false,
          pwSupported: false,
          lastPollingAt: now,
          lastSuccessAt: now,
          lastErrorSafe: null,
          ...discoveryMetadata,
        },
      });
      return;
    }

    const [existingState, existingVsis] = await Promise.all([
      this.prisma.mplsDeviceState.findUnique({ where: { hostId } }),
      this.prisma.mplsVsi.findMany({
        where: { hostId },
        include: { pws: true },
      }),
    ]);
    const collectedVsiColumns = new Set(collection.collectedColumns.vsi);
    const collectedAcColumns = new Set(collection.collectedColumns.ac);
    const collectedPwColumns = new Set(collection.collectedColumns.pw);
    const acIfIndexes = [
      ...new Set(
        collection.vsis.flatMap((vsi) =>
          vsi.acs.map((ac) => ac.ifIndex).filter((ifIndex): ifIndex is number => ifIndex !== null),
        ),
      ),
    ];
    const acInterfaceNames = [
      ...new Set(
        collection.vsis.flatMap((vsi) =>
          vsi.acs
            .map((ac) => ac.interfaceName ?? null)
            .filter((name): name is string => Boolean(name)),
        ),
      ),
    ];
    const interfaces = acIfIndexes.length
      ? await this.prisma.interface.findMany({
          where: { deviceId: hostId, ifIndex: { in: acIfIndexes } },
          select: { id: true, ifIndex: true, name: true, alias: true },
        })
      : [];
    const interfaceByIfIndex = new Map(interfaces.map((item) => [item.ifIndex, item]));
    // A leitura SSH entrega o nome da porta AC, nao o ifIndex: o inventario do
    // proprio host e a unica fonte confiavel para correlacionar.
    const interfaceByName = new Map<string, (typeof interfaces)[number]>();
    if (acInterfaceNames.length) {
      const deviceInterfaces = await this.prisma.interface.findMany({
        where: { deviceId: hostId },
        select: { id: true, ifIndex: true, name: true, alias: true },
      });
      for (const item of deviceInterfaces) {
        for (const key of interfaceNameKeys(item.name)) {
          if (!interfaceByName.has(key)) interfaceByName.set(key, item);
        }
      }
    }
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
      // Entidade vinda do SSH tem todos os campos lidos na CLI; entidade SNMP
      // continua restrita as colunas que o walk realmente devolveu.
      const vsiSource = vsi.source ?? 'SNMP';
      const observedVsi = (column: number): boolean =>
        vsiSource === 'SSH' || collectedVsiColumns.has(column);
      const collectedPwKeys = new Set(vsi.pws.map((pw) => pw.key));
      const allKnownPwsPresent =
        collection.capabilities.pw === false ||
        !existing ||
        existing.pws.every((pw) => collectedPwKeys.has(pwKey(pw.vsiName, pw.pwId, pw.remoteIp)));
      const mayUpdateStatus =
        vsi.statusObserved && vsi.statusComplete && allKnownPwsPresent && vsi.status !== 'UNKNOWN';
      const correlatedAcs = vsi.acs
        .map((ac) => (ac.ifIndex === null ? undefined : interfaceByIfIndex.get(ac.ifIndex)))
        .filter((item) => item !== undefined)
        .sort((left, right) => left.ifIndex - right.ifIndex);
      const primaryInterface = correlatedAcs[0];
      const correlatedVlanId = primaryInterface
        ? vlanIdFromMplsInterfaceName(primaryInterface.name)
        : null;
      if (
        existing &&
        isRealMplsStateChange(existing.status, vsi.status, {
          observed: vsi.statusObserved,
          complete:
            vsi.statusComplete &&
            allKnownPwsPresent &&
            !(
              collection.capabilities.pw === false &&
              existingState?.pwSupported === true &&
              existing.pws.length > 0
            ),
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
            memberDiscovery: vsi.peerDiscovery ?? null,
            localInterfaceId: primaryInterface?.id ?? null,
            vlanId: correlatedVlanId,
            source: vsiSource,
            lastSeenAt: now,
          },
          update: {
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.signalingType)
              ? { signalingType: vsi.signalingType }
              : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.rd) ? { rd: vsi.rd } : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.vsiId) ? { vsiId: vsi.vsiId } : {}),
            ...(mayUpdateStatus ? { status: vsi.status } : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.operationalStatus)
              ? { operationalStatus: vsi.operationalStatus }
              : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.adminStatus)
              ? { adminStatus: vsi.adminStatus }
              : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.mtu) ? { mtu: vsi.mtu } : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.vcType) ? { vcType: vsi.vcType } : {}),
            ...(observedVsi(HUAWEI_VPLS_VSI_COLUMNS.tunnelPolicy)
              ? { tunnelPolicy: vsi.tunnelPolicy }
              : {}),
            ...(vsi.peerDiscovery ? { memberDiscovery: vsi.peerDiscovery } : {}),
            ...(collection.capabilities.ac === true && primaryInterface
              ? { localInterfaceId: primaryInterface.id, vlanId: correlatedVlanId }
              : {}),
            source: vsiSource,
            lastSeenAt: now,
          },
        }),
      );

      for (const ac of vsi.acs) {
        const byName = ac.interfaceName
          ? interfaceNameKeys(ac.interfaceName)
              .map((key) => interfaceByName.get(key))
              .find((item) => item !== undefined)
          : undefined;
        const resolvedIfIndex = ac.ifIndex ?? byName?.ifIndex ?? null;
        // Sem ifIndex nao existe chave estavel para o AC: registra apenas o que
        // da para correlacionar com o inventario, sem inventar identificador.
        if (resolvedIfIndex === null) continue;
        const correlatedInterface =
          byName ?? correlateMplsAcInterface(resolvedIfIndex, interfaceByIfIndex)?.interface;
        const acSource = ac.source ?? vsiSource;
        const observedAc = (column: number): boolean =>
          acSource === 'SSH' || collectedAcColumns.has(column);
        operations.push(
          this.prisma.mplsAc.upsert({
            where: {
              hostId_vsiName_ifIndex: {
                hostId,
                vsiName: vsi.name,
                ifIndex: resolvedIfIndex,
              },
            },
            create: {
              vsiName: vsi.name,
              ifIndex: resolvedIfIndex,
              ...(correlatedInterface
                ? { interface: { connect: { id: correlatedInterface.id } } }
                : {}),
              status: ac.status,
              upStartTimeRaw: ac.upStartTimeRaw,
              upSumTimeRaw: ac.upSumTimeRaw,
              source: acSource,
              lastSeenAt: now,
              host: { connect: { id: hostId } },
              vsi: { connect: { hostId_name: { hostId, name: vsi.name } } },
            },
            update: {
              interfaceId: correlatedInterface?.id ?? null,
              ...(observedAc(HUAWEI_VPLS_AC_COLUMNS.status) ? { status: ac.status } : {}),
              // Tempos de UP so existem no SNMP: o CLI nao os devolve.
              ...(collectedAcColumns.has(HUAWEI_VPLS_AC_COLUMNS.upStartTime)
                ? { upStartTimeRaw: ac.upStartTimeRaw }
                : {}),
              ...(collectedAcColumns.has(HUAWEI_VPLS_AC_COLUMNS.upSumTime)
                ? { upSumTimeRaw: ac.upSumTimeRaw }
                : {}),
              source: acSource,
              lastSeenAt: now,
            },
          }),
        );
      }

      for (const pw of vsi.pws) {
        const existingPw = existingPwByKey.get(pw.key);
        const pwSource = pw.source ?? vsiSource;
        const observedPw = (column: number): boolean =>
          pwSource === 'SSH' || collectedPwColumns.has(column);
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
              source: pwSource,
              lastSeenAt: now,
            },
            update: {
              remoteHostId: remoteHostIds.get(pw.remoteIp) ?? null,
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.tunnelPolicy)
                ? { tunnelPolicy: pw.tunnelPolicy }
                : {}),
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.pwType) ? { pwType: pw.pwType } : {}),
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.inboundLabel)
                ? { inboundLabel: pw.inboundLabel }
                : {}),
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.outboundLabel)
                ? { outboundLabel: pw.outboundLabel }
                : {}),
              ...(mayUpdatePwStatus ? { status: pw.status } : {}),
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.state) ? { state: pw.state } : {}),
              ...(observedPw(HUAWEI_VPLS_PW_COLUMNS.workingState)
                ? { workingState: pw.workingState }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.upStartTime)
                ? { upStartTime: pw.upStartTime }
                : {}),
              ...(collectedPwColumns.has(HUAWEI_VPLS_PW_COLUMNS.upSumTime)
                ? { upSumTime: pw.upSumTime }
                : {}),
              source: pwSource,
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
        create: {
          hostId,
          supported: true,
          vsiSupported: true,
          acSupported: collection.capabilities.ac ?? false,
          pwSupported: collection.capabilities.pw ?? false,
          lastPollingAt: now,
          lastSuccessAt: now,
          ...discoveryMetadata,
        },
        update: {
          supported: true,
          vsiSupported: true,
          ...(collection.capabilities.ac === null
            ? {}
            : { acSupported: collection.capabilities.ac }),
          ...(collection.capabilities.pw === null
            ? {}
            : { pwSupported: collection.capabilities.pw }),
          lastPollingAt: now,
          lastSuccessAt: now,
          lastErrorSafe:
            discoveryState === 'INCOMPLETE'
              ? 'Coleta MPLS incompleta: status das VSIs não confirmado por nenhuma fonte.'
              : null,
          ...discoveryMetadata,
        },
      }),
    );
    await this.prisma.$transaction(operations);
  }

  /**
   * Rodada sem evidencia nova (CLI no intervalo de cadencia): so o carimbo do
   * polling avanca, sem tocar em estado, fontes ou mensagem de erro.
   */
  async touchPolling(hostId: string, occurredAt: Date): Promise<void> {
    await this.prisma.mplsDeviceState.updateMany({
      where: { hostId },
      data: { lastPollingAt: occurredAt },
    });
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
    const discoveryState = state?.discoveryState ?? 'UNKNOWN';
    const shared = {
      discoveryState,
      sources: (state?.sources ?? []) as MplsHostOverview['sources'],
      ldpPeers: (state?.ldpPeers ?? []) as unknown as MplsHostOverview['ldpPeers'],
      l2vcCircuits: (state?.l2vcCircuits ?? []) as unknown as MplsHostOverview['l2vcCircuits'],
      conflicts: (state?.conflicts ?? []) as unknown as MplsHostOverview['conflicts'],
    };
    if (!state || !state.vsiSupported) {
      return {
        supported: false,
        ...shared,
        capabilities: {
          vsi: state?.vsiSupported ?? false,
          ac: state?.acSupported ?? false,
          pw: state?.pwSupported ?? false,
        },
        source: state?.source ?? 'SNMP',
        lastPollingAt: state?.lastPollingAt?.toISOString() ?? null,
        lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
        lastErrorSafe: state?.lastErrorSafe ?? null,
        summary: { ...EMPTY_MPLS_SUMMARY },
        vsis: [],
      };
    }
    const vsis = await this.listVsis(hostId);
    return {
      // `supported` da API significa "existe algo para exibir"; o resultado da
      // descoberta (inclusive NOT_FOUND/INCOMPLETE) vai em `discoveryState`.
      supported: vsis.length > 0 || shared.l2vcCircuits.length > 0,
      ...shared,
      capabilities: {
        vsi: state.vsiSupported,
        ac: state.acSupported,
        pw: state.pwSupported,
      },
      source: state.source,
      lastPollingAt: state.lastPollingAt?.toISOString() ?? null,
      lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
      lastErrorSafe: state.lastErrorSafe,
      summary: summarizeMpls(vsis),
      vsis,
    };
  }

  async listVsis(hostId: string): Promise<MplsVsi[]> {
    const rows = await this.prisma.mplsVsi.findMany({
      where: { hostId },
      include: {
        acs: { include: acInclude, orderBy: { ifIndex: 'asc' } },
        pws: { include: pwInclude, orderBy: [{ remoteIp: 'asc' }, { pwId: 'asc' }] },
      },
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
