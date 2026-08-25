import type {
  MplsAdminStatus,
  MplsPwState,
  MplsPwStatus,
  MplsPwWorkingState,
  MplsVsiOperationalStatus,
} from '@gmj/shared';

export interface DecodedAsciiIndex {
  value: string;
  consumed: number;
}

export interface HuaweiPwIndex {
  vsiName: string;
  pwId: number;
  remoteIp: string;
  key: string;
}

export function oidSuffix(oid: string, baseOid: string): number[] | null {
  const normalized = oid.replace(/^\./, '');
  const base = baseOid.replace(/^\./, '');
  if (!normalized.startsWith(`${base}.`)) return null;
  const parts = normalized
    .slice(base.length + 1)
    .split('.')
    .map(Number);
  return parts.length > 0 && parts.every(Number.isInteger) ? parts : null;
}

export function decodeLengthPrefixedAsciiIndex(
  values: readonly number[],
): DecodedAsciiIndex | null {
  const length = values[0];
  if (!Number.isInteger(length) || length! <= 0 || values.length < length! + 1) return null;
  const bytes = values.slice(1, length! + 1);
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0x20 || byte > 0x7e)) return null;
  const value = String.fromCharCode(...bytes);
  return value ? { value, consumed: length! + 1 } : null;
}

export function parseHuaweiVsiIndex(values: readonly number[]): string | null {
  const decoded = decodeLengthPrefixedAsciiIndex(values);
  return decoded && decoded.consumed === values.length ? decoded.value : null;
}

export function parseHuaweiPwIndex(values: readonly number[]): HuaweiPwIndex | null {
  const decoded = decodeLengthPrefixedAsciiIndex(values);
  if (!decoded || values.length !== decoded.consumed + 5) return null;
  const pwId = values[decoded.consumed];
  const octets = values.slice(decoded.consumed + 1);
  if (!Number.isInteger(pwId) || pwId! < 0 || pwId! > 0xffffffff) return null;
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  const remoteIp = octets.join('.');
  return {
    vsiName: decoded.value,
    pwId: pwId!,
    remoteIp,
    key: `${decoded.value}|${pwId}|${remoteIp}`,
  };
}

export function parseHuaweiVsiOperationalStatus(value: unknown): MplsVsiOperationalStatus {
  return value === 1 ? 'UP' : value === 2 ? 'DOWN' : value === 3 ? 'ADMIN_DOWN' : 'UNKNOWN';
}

export function parseHuaweiAdminStatus(value: unknown): MplsAdminStatus {
  return value === 1 ? 'UP' : value === 2 ? 'DOWN' : 'UNKNOWN';
}

export function parseHuaweiPwStatus(value: unknown): MplsPwStatus {
  return value === 1
    ? 'DOWN'
    : value === 2
      ? 'UP'
      : value === 3
        ? 'PLUG_OUT'
        : value === 4
          ? 'BACKUP'
          : 'UNKNOWN';
}

export function parseHuaweiPwState(value: unknown): MplsPwState {
  return value === 1 ? 'DOWN' : value === 2 ? 'UP' : 'UNKNOWN';
}

export function parseHuaweiPwWorkingState(value: unknown): MplsPwWorkingState {
  return value === 1 ? 'MASTER' : value === 2 ? 'BACKUP' : 'UNKNOWN';
}

export function parseHuaweiSignalType(value: unknown): string {
  const values: Record<number, string> = {
    1: 'LDP',
    2: 'BGP',
    3: 'BGP_AD',
    4: 'BGP_MH',
    5: 'LDP_BGP_MIXED',
    6: 'LDP_BGP_AD_MIXED',
    255: 'UNKNOWN',
  };
  return typeof value === 'number' ? (values[value] ?? 'UNKNOWN') : 'UNKNOWN';
}

export function parseHuaweiPwType(value: unknown): string {
  return value === 1 ? 'NORMAL' : value === 2 ? 'OTHER' : 'UNKNOWN';
}

export function parseHuaweiVcType(value: unknown): string {
  const values: Record<number, string> = {
    1: 'FRAME_RELAY_DLCI_MARTINI',
    2: 'ATM_AAL5_SDU_VCC',
    3: 'ATM_TRANSPARENT_CELL',
    4: 'VLAN',
    5: 'ETHERNET',
    6: 'HDLC',
    7: 'PPP',
    8: 'CEM',
    9: 'ATM_N_TO_ONE_VCC',
    10: 'ATM_N_TO_ONE_VPC',
    11: 'IP_LAYER2_TRANSPORT',
    12: 'ATM_ONE_TO_ONE_VCC',
    13: 'ATM_ONE_TO_ONE_VPC',
    14: 'ATM_AAL5_PDU_VCC',
    15: 'FRAME_RELAY_PORT',
    16: 'CEP',
    17: 'SA_E1_OVER_PACKET',
    18: 'SA_T1_OVER_PACKET',
    19: 'SA_E3_OVER_PACKET',
    20: 'SA_T3_OVER_PACKET',
    21: 'CESOPSN_BASIC',
    22: 'TDMOIP_BASIC',
    23: 'CESOPSN_TDM_WITH_CAS',
    24: 'TDMOIP_TDM_WITH_CAS',
    25: 'FRAME_RELAY_DLCI',
    64: 'IP_INTERWORKING',
    255: 'UNKNOWN',
  };
  return typeof value === 'number' ? (values[value] ?? 'UNKNOWN') : 'UNKNOWN';
}

export function parseHuaweiDateAndTime(value: unknown): Date | null {
  if (!(value instanceof Uint8Array) || (value.length !== 8 && value.length !== 11)) return null;
  const year = value[0]! * 256 + value[1]!;
  const month = value[2]!;
  const day = value[3]!;
  const hour = value[4]!;
  const minute = value[5]!;
  const second = value[6]!;
  const decisecond = value[7]!;
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    decisecond > 9
  )
    return null;
  let milliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    Math.min(second, 59),
    decisecond * 100,
  );
  if (value.length === 11) {
    const direction = String.fromCharCode(value[8]!);
    const offsetHours = value[9]!;
    const offsetMinutes = value[10]!;
    if (!['+', '-'].includes(direction) || offsetHours > 13 || offsetMinutes > 59) return null;
    const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
    milliseconds += direction === '+' ? -offset : offset;
  }
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
