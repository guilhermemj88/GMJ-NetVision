import type {
  MplsAdminStatus,
  MplsPwState,
  MplsPwStatus,
  MplsPwWorkingState,
  MplsStatus,
  MplsVsiOperationalStatus,
} from '@gmj/shared';
import type { SnmpClient, SnmpRequestOptions, SnmpVarBind } from '../../domain/ports';
import { decodeSnmpText } from '../snmp/snmp-text';
import {
  HUAWEI_VPLS_PW_COLUMNS,
  HUAWEI_VPLS_PW_ENTRY_OID,
  HUAWEI_VPLS_VSI_COLUMNS,
  HUAWEI_VPLS_VSI_ENTRY_OID,
} from './huawei-vpls-oids';
import {
  oidSuffix,
  parseHuaweiAdminStatus,
  parseHuaweiDateAndTime,
  parseHuaweiPwIndex,
  parseHuaweiPwState,
  parseHuaweiPwStatus,
  parseHuaweiPwType,
  parseHuaweiPwWorkingState,
  parseHuaweiSignalType,
  parseHuaweiVsiIndex,
  parseHuaweiVsiOperationalStatus,
  parseHuaweiVcType,
} from './huawei-vpls-parser';

type SnmpValue = SnmpVarBind['value'];

export interface CollectedMplsPw {
  key: string;
  vsiName: string;
  pwId: number;
  remoteIp: string;
  tunnelPolicy: string | null;
  pwType: string;
  inboundLabel: number | null;
  outboundLabel: number | null;
  status: MplsPwStatus;
  state: MplsPwState;
  workingState: MplsPwWorkingState;
  upStartTime: Date | null;
  upSumTime: bigint | null;
  statusObserved: boolean;
}

export interface CollectedMplsVsi {
  name: string;
  signalingType: string;
  rd: string | null;
  vsiId: number | null;
  status: MplsStatus;
  operationalStatus: MplsVsiOperationalStatus;
  adminStatus: MplsAdminStatus;
  mtu: number | null;
  vcType: string;
  tunnelPolicy: string | null;
  description: string | null;
  statusObserved: boolean;
  pws: CollectedMplsPw[];
}

export interface HuaweiVplsCollection {
  supported: boolean;
  collectedAt: Date;
  vsis: CollectedMplsVsi[];
}

interface VsiAccumulator extends Omit<CollectedMplsVsi, 'status' | 'pws'> {
  pws: CollectedMplsPw[];
}

function integer(value: SnmpValue): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function text(value: SnmpValue): string | null {
  const parsed = decodeSnmpText(value).trim();
  return parsed && !/^\d+(?:,\d+)+$/.test(parsed) ? parsed : null;
}

function aggregateStatus(vsi: VsiAccumulator): MplsStatus {
  if (vsi.adminStatus === 'DOWN' || vsi.operationalStatus === 'ADMIN_DOWN') return 'ADMIN_DOWN';
  if (!vsi.statusObserved || vsi.operationalStatus === 'UNKNOWN') return 'UNKNOWN';
  if (vsi.operationalStatus === 'DOWN') return 'DOWN';
  if (!vsi.pws.length || vsi.pws.some((pw) => !pw.statusObserved)) return 'UNKNOWN';
  if (vsi.pws.some((pw) => pw.status === 'DOWN' || pw.status === 'PLUG_OUT')) return 'DEGRADED';
  return vsi.pws.every((pw) => pw.status === 'UP') ? 'UP' : 'UNKNOWN';
}

function defaultVsi(name: string): VsiAccumulator {
  return {
    name,
    signalingType: 'UNKNOWN',
    rd: null,
    vsiId: null,
    operationalStatus: 'UNKNOWN',
    adminStatus: 'UNKNOWN',
    mtu: null,
    vcType: 'UNKNOWN',
    tunnelPolicy: null,
    description: null,
    statusObserved: false,
    pws: [],
  };
}

function defaultPw(index: NonNullable<ReturnType<typeof parseHuaweiPwIndex>>): CollectedMplsPw {
  return {
    ...index,
    tunnelPolicy: null,
    pwType: 'UNKNOWN',
    inboundLabel: null,
    outboundLabel: null,
    status: 'UNKNOWN',
    state: 'UNKNOWN',
    workingState: 'UNKNOWN',
    upStartTime: null,
    upSumTime: null,
    statusObserved: false,
  };
}

export class HuaweiVplsSnmpCollector {
  constructor(private readonly client: SnmpClient) {}

  async collect(host: string, options: SnmpRequestOptions): Promise<HuaweiVplsCollection> {
    const collectedAt = new Date();
    const [vsiRows, pwRows] = await Promise.all([
      this.client.walk(host, HUAWEI_VPLS_VSI_ENTRY_OID, options),
      this.client.walk(host, HUAWEI_VPLS_PW_ENTRY_OID, options),
    ]);
    const vsis = this.collectVsis(vsiRows);
    if (!vsis.size) return { supported: false, collectedAt, vsis: [] };

    const pws = this.collectPws(pwRows);
    for (const pw of pws.values()) {
      const vsi = vsis.get(pw.vsiName);
      if (vsi) vsi.pws.push(pw);
    }
    return {
      supported: true,
      collectedAt,
      vsis: [...vsis.values()]
        .map((vsi) => ({ ...vsi, status: aggregateStatus(vsi) }))
        .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR')),
    };
  }

  private collectVsis(rows: SnmpVarBind[]): Map<string, VsiAccumulator> {
    const result = new Map<string, VsiAccumulator>();
    for (const row of rows) {
      const suffix = oidSuffix(row.oid, HUAWEI_VPLS_VSI_ENTRY_OID);
      if (!suffix || suffix.length < 2) continue;
      const [column, ...index] = suffix;
      const name = parseHuaweiVsiIndex(index);
      if (!name || !Object.values(HUAWEI_VPLS_VSI_COLUMNS).includes(column as never)) continue;
      const vsi = result.get(name) ?? defaultVsi(name);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.signalingType)
        vsi.signalingType = parseHuaweiSignalType(integer(row.value));
      if (column === HUAWEI_VPLS_VSI_COLUMNS.rd) vsi.rd = text(row.value);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.vsiId) vsi.vsiId = integer(row.value);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.vcType)
        vsi.vcType = parseHuaweiVcType(integer(row.value));
      if (column === HUAWEI_VPLS_VSI_COLUMNS.operationalStatus) {
        vsi.operationalStatus = parseHuaweiVsiOperationalStatus(integer(row.value));
        vsi.statusObserved = true;
      }
      if (column === HUAWEI_VPLS_VSI_COLUMNS.mtu) vsi.mtu = integer(row.value);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.tunnelPolicy) vsi.tunnelPolicy = text(row.value);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.description) vsi.description = text(row.value);
      if (column === HUAWEI_VPLS_VSI_COLUMNS.adminStatus)
        vsi.adminStatus = parseHuaweiAdminStatus(integer(row.value));
      result.set(name, vsi);
    }
    return result;
  }

  private collectPws(rows: SnmpVarBind[]): Map<string, CollectedMplsPw> {
    const result = new Map<string, CollectedMplsPw>();
    for (const row of rows) {
      const suffix = oidSuffix(row.oid, HUAWEI_VPLS_PW_ENTRY_OID);
      if (!suffix || suffix.length < 7) continue;
      const [column, ...index] = suffix;
      const parsedIndex = parseHuaweiPwIndex(index);
      if (!parsedIndex || !Object.values(HUAWEI_VPLS_PW_COLUMNS).includes(column as never))
        continue;
      const pw = result.get(parsedIndex.key) ?? defaultPw(parsedIndex);
      if (column === HUAWEI_VPLS_PW_COLUMNS.tunnelPolicy) pw.tunnelPolicy = text(row.value);
      if (column === HUAWEI_VPLS_PW_COLUMNS.pwType)
        pw.pwType = parseHuaweiPwType(integer(row.value));
      if (column === HUAWEI_VPLS_PW_COLUMNS.inboundLabel) pw.inboundLabel = integer(row.value);
      if (column === HUAWEI_VPLS_PW_COLUMNS.outboundLabel) pw.outboundLabel = integer(row.value);
      if (column === HUAWEI_VPLS_PW_COLUMNS.status) {
        pw.status = parseHuaweiPwStatus(integer(row.value));
        pw.statusObserved = true;
      }
      if (column === HUAWEI_VPLS_PW_COLUMNS.upStartTime)
        pw.upStartTime = parseHuaweiDateAndTime(row.value);
      if (column === HUAWEI_VPLS_PW_COLUMNS.upSumTime) {
        const duration = integer(row.value);
        pw.upSumTime = duration === null ? null : BigInt(duration);
      }
      if (column === HUAWEI_VPLS_PW_COLUMNS.state)
        pw.state = parseHuaweiPwState(integer(row.value));
      if (column === HUAWEI_VPLS_PW_COLUMNS.workingState)
        pw.workingState = parseHuaweiPwWorkingState(integer(row.value));
      result.set(parsedIndex.key, pw);
    }
    return result;
  }
}

export { aggregateStatus as aggregateMplsVsiStatus };
