import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { HistoryPeriod } from '@gmj/shared';

/**
 * Token assinado (HMAC) da pagina de snapshot. Escopo minimo: UM tipo de
 * grafico, UMA interface, UM periodo e uma janela curta de validade. Nao e uma
 * credencial reutilizavel: expira sozinho e nao abre nenhuma outra rota (nem a
 * API autenticada, nem escrita, nem SNMP).
 */
export const SNAPSHOT_TOKEN_VERSION = 1 as const;
export const SNAPSHOT_TOKEN_TTL_SECONDS = 900;

export const SNAPSHOT_PERIODS: HistoryPeriod[] = ['15m', '1h', '6h', '24h', '7d'];

export type SnapshotChartKind = 'METRIC' | 'OPTICAL';

/** Serie do grafico de contadores: chave em `MetricPoint` + rotulo de tela. */
export interface SnapshotSeriesSpec {
  key: 'rxErrors' | 'txErrors' | 'rxDiscards' | 'txDiscards';
  label: string;
  tone: 'crc' | 'rx' | 'tx';
}

export interface SnapshotMetricSpec {
  series: SnapshotSeriesSpec[];
  unit: string;
  thresholdValue: number | null;
  thresholdLabel: string;
}

/** Limites opticos que o GRÁFICO desenha (mesmos numeros que o motor usou). */
export interface SnapshotOpticalSpec {
  lane: number | null;
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  lowWarningDbm: number | null;
  highWarningDbm: number | null;
}

export interface SnapshotHeaderSpec {
  device: string;
  interfaceName: string;
  alias: string;
  type: string;
  severity: string;
  message: string | null;
  eventAt: string;
  resolvedAt: string | null;
  /** TESTAR ALARME: o PNG nao veio de um alarme real. */
  test?: boolean;
  /** Origem REAL do historico quando o PNG e de teste. */
  sourceDeviceName?: string | null;
  sourceInterfaceName?: string | null;
}

export interface SnapshotSpec {
  v: typeof SNAPSHOT_TOKEN_VERSION;
  kind: SnapshotChartKind;
  interfaceId: string;
  period: HistoryPeriod;
  header: SnapshotHeaderSpec;
  metric: SnapshotMetricSpec | null;
  optical: SnapshotOpticalSpec | null;
  exp: number;
}

const seriesSchema = z.object({
  key: z.enum(['rxErrors', 'txErrors', 'rxDiscards', 'txDiscards']),
  label: z.string(),
  tone: z.enum(['crc', 'rx', 'tx']),
});

const specSchema = z.object({
  v: z.literal(SNAPSHOT_TOKEN_VERSION),
  kind: z.enum(['METRIC', 'OPTICAL']),
  interfaceId: z.string().min(1),
  period: z.enum(['15m', '1h', '6h', '24h', '7d']),
  header: z.object({
    device: z.string(),
    interfaceName: z.string(),
    alias: z.string(),
    type: z.string(),
    severity: z.string(),
    message: z.string().nullable(),
    eventAt: z.string(),
    resolvedAt: z.string().nullable(),
    test: z.boolean().optional(),
    sourceDeviceName: z.string().nullable().optional(),
    sourceInterfaceName: z.string().nullable().optional(),
  }),
  metric: z
    .object({
      series: z.array(seriesSchema),
      unit: z.string(),
      thresholdValue: z.number().nullable(),
      thresholdLabel: z.string(),
    })
    .nullable(),
  optical: z
    .object({
      lane: z.number().nullable(),
      lowAlarmDbm: z.number().nullable(),
      highAlarmDbm: z.number().nullable(),
      lowWarningDbm: z.number().nullable(),
      highWarningDbm: z.number().nullable(),
    })
    .nullable(),
  exp: z.number(),
});

const mediaSchema = z.object({
  v: z.literal(SNAPSHOT_TOKEN_VERSION),
  key: z.string().min(1),
  exp: z.number(),
});

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function signature(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(schemaPayload: string, key: string): string {
  return `${base64UrlEncode(schemaPayload)}.${signature(schemaPayload, key)}`;
}

function verify<T>(token: string, key: string, parse: (value: unknown) => T | null, now: number): T | null {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const payload = base64UrlDecode(encoded);
  if (!payload) return null;
  if (!safeEqual(provided, signature(payload, key))) return null;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = parse(json);
  if (!parsed) return null;
  const exp = (json as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= now) return null;
  return parsed;
}

/** Assina a especificacao do snapshot (pagina interna usada pelo renderer). */
export function signSnapshotToken(
  spec: Omit<SnapshotSpec, 'v' | 'exp'>,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const payload: SnapshotSpec = {
    v: SNAPSHOT_TOKEN_VERSION,
    ...spec,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  return sign(JSON.stringify(payload), key);
}

export function verifySnapshotToken(
  token: string,
  key: string,
  now: number = Date.now(),
): SnapshotSpec | null {
  return verify(token, key, (value) => {
    const parsed = specSchema.safeParse(value);
    return parsed.success ? (parsed.data as SnapshotSpec) : null;
  }, now);
}

/** URL assinada do PNG (curta, so leitura, sem base de dados). */
export function signMediaToken(
  cacheKey: string,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  return sign(
    JSON.stringify({
      v: SNAPSHOT_TOKEN_VERSION,
      key: cacheKey,
      exp: Math.floor(now / 1000) + ttlSeconds,
    }),
    key,
  );
}

export function verifyMediaToken(
  token: string,
  key: string,
  now: number = Date.now(),
): { cacheKey: string } | null {
  return verify(token, key, (value) => {
    const parsed = mediaSchema.safeParse(value);
    return parsed.success ? { cacheKey: parsed.data.key } : null;
  }, now);
}

/** Chave estavel do cache: mesmo spec => mesmo PNG. */
export function snapshotCacheKey(spec: Pick<SnapshotSpec, 'kind' | 'interfaceId' | 'period' | 'header'> & {
  metric: SnapshotMetricSpec | null;
  optical: SnapshotOpticalSpec | null;
}): string {
  const canonical = JSON.stringify({
    kind: spec.kind,
    interfaceId: spec.interfaceId,
    period: spec.period,
    eventAt: spec.header.eventAt,
    resolvedAt: spec.header.resolvedAt,
    type: spec.header.type,
    severity: spec.header.severity,
    metric: spec.metric,
    optical: spec.optical,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function snapshotPagePath(token: string): string {
  return `/snapshot/${token}`;
}

export function mediaSnapshotPath(token: string): string {
  return `/media/snapshot/${token}.png`;
}
