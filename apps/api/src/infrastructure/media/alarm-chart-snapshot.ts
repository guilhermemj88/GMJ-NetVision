import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryPeriod } from '@gmj/shared';
import type { NetworkAlarmWebhookPayload } from '../alarms/n8n-alarm-transport';
import {
  SNAPSHOT_TOKEN_TTL_SECONDS,
  mediaSnapshotPath,
  signMediaToken,
  signSnapshotToken,
  snapshotCacheKey,
  snapshotPagePath,
  type SnapshotSeriesSpec,
  type SnapshotSpec,
} from './snapshot-token';

/**
 * Bloco `media.chart` do payload NETWORK_ALARMS. NUNCA carrega bytes: apenas a
 * URL assinada e curta que o n8n baixa. Quando o snapshot falha, `available`
 * fica `false` e o alarme segue com a mensagem textual (imagem nunca atrasa
 * nem perde alarme).
 */
export interface AlarmChartMedia {
  available: boolean;
  url: string | null;
  mimeType: string;
  period: HistoryPeriod | null;
  generatedAt: string | null;
  expiresAt: string | null;
  /** Preenchido apenas quando `available: false`, para diagnostico seguro. */
  reason?: string;
}

export const UNAVAILABLE_ALARM_CHART: AlarmChartMedia = {
  available: false,
  url: null,
  mimeType: 'image/png',
  period: null,
  generatedAt: null,
  expiresAt: null,
};

export const SNAPSHOT_VIEWPORT = { width: 1200, height: 720 } as const;
const DEFAULT_RENDER_TIMEOUT_MS = 12_000;
/**
 * Limpeza do cache de PNGs: roda no maximo a cada 30 min, apaga em lote
 * limitado e SOMENTE arquivos `*.png` do diretorio de cache (nunca recursivo,
 * nunca rm -rf). O token assinado expira em minutos; a retencao existe so para
 * o cache nao crescer sem limite.
 */
const CACHE_PRUNE_INTERVAL_MS = 30 * 60_000;
const CACHE_PRUNE_MAX_DELETIONS = 200;
export const DEFAULT_SNAPSHOT_CACHE_KEEP_HOURS = 24;

const CRC_SERIES: SnapshotSeriesSpec[] = [{ key: 'rxErrors', label: 'CRC RX', tone: 'crc' }];
const ERRORS_SERIES: SnapshotSeriesSpec[] = [
  { key: 'rxErrors', label: 'Erros RX', tone: 'rx' },
  { key: 'txErrors', label: 'Erros TX', tone: 'tx' },
];
const DISCARD_SERIES: SnapshotSeriesSpec[] = [
  { key: 'rxDiscards', label: 'Discards RX', tone: 'rx' },
  { key: 'txDiscards', label: 'Discards TX', tone: 'tx' },
];

/** Tipos que possuem serie historica real para desenhar (os demais ficam texto-only). */
export function isChartableAlarmType(type: string): boolean {
  return (
    type === 'INTERFACE_CRC' ||
    type === 'INTERFACE_ERRORS' ||
    type === 'INTERFACE_DISCARDS' ||
    type === 'OPTICAL_RX_DEGRADATION'
  );
}

/** RAPID_DROP encurta a janela optica (1h) para o PNG mostrar a queda. */
export function opticalChartPeriod(reasons: ReadonlyArray<string> | null): HistoryPeriod {
  return reasons?.includes('RAPID_DROP') ? '1h' : '24h';
}

/**
 * Especificacao PURA do snapshot a partir do payload canonico dos alarmes.
 * Devolve `null` quando o tipo nao tem serie (ex.: INTERFACE_DOWN), o que
 * mantem o payload real inalterado nesses casos.
 */
export function buildAlarmChartSpec(
  payload: NetworkAlarmWebhookPayload,
  ttlSeconds: number = SNAPSHOT_TOKEN_TTL_SECONDS,
  now: number = Date.now(),
): SnapshotSpec | null {
  if (!isChartableAlarmType(payload.type)) return null;
  const header = {
    device: payload.deviceName,
    interfaceName: payload.interfaceName,
    alias: payload.interfaceLabel,
    type: payload.type,
    severity: payload.severity,
    message: payload.message,
    eventAt: payload.occurredAt,
    resolvedAt: payload.event === 'RESOLVED' ? (payload.resolvedAt ?? payload.occurredAt) : null,
  };
  if (payload.type === 'OPTICAL_RX_DEGRADATION') {
    const optical = payload.optical;
    const spec = signSpec(
      {
        kind: 'OPTICAL' as const,
        interfaceId: payload.interfaceId,
        period: opticalChartPeriod(payload.triggerReasons),
        header,
        metric: null,
        optical: {
          lane: optical?.lane ?? payload.lane ?? null,
          lowAlarmDbm: optical?.lowAlarmDbm ?? null,
          highAlarmDbm: optical?.highAlarmDbm ?? null,
          lowWarningDbm: optical?.lowWarningDbm ?? null,
          highWarningDbm: optical?.highWarningDbm ?? null,
        },
      },
      ttlSeconds,
      now,
    );
    return spec;
  }
  const series =
    payload.type === 'INTERFACE_CRC'
      ? CRC_SERIES
      : payload.type === 'INTERFACE_DISCARDS'
        ? DISCARD_SERIES
        : ERRORS_SERIES;
  return signSpec(
    {
      kind: 'METRIC' as const,
      interfaceId: payload.interfaceId,
      period: '15m' as HistoryPeriod,
      header,
      metric: {
        series,
        unit: payload.unit ?? (payload.type === 'INTERFACE_DISCARDS' ? 'discards/min' : 'errors/min'),
        thresholdValue: payload.thresholdValue,
        thresholdLabel: payload.type === 'INTERFACE_CRC' ? 'THRESHOLD CRC' : 'THRESHOLD',
      },
      optical: null,
    },
    ttlSeconds,
    now,
  );
}

function signSpec(
  spec: Omit<SnapshotSpec, 'v' | 'exp'>,
  ttlSeconds: number,
  now: number,
): SnapshotSpec {
  return {
    v: 1,
    ...spec,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
}

export type SnapshotRenderer = (pageUrl: string, timeoutMs: number) => Promise<Buffer>;

export interface AlarmChartSnapshotDeps {
  rendererUrl?: string | undefined;
  signingKey?: string | undefined;
  webInternalUrl?: string | undefined;
  apiPublicUrl?: string | undefined;
  cacheDir: string;
  ttlSeconds?: number;
  /** Retencao dos PNGs em cache (horas). Default: 24. */
  cacheKeepHours?: number;
  timeoutMs?: number;
  now?: () => Date;
  /** Injetavel nos testes; por padrao fala HTTP com o renderer isolado. */
  render?: SnapshotRenderer;
}

export interface AlarmChartSnapshot {
  (payload: NetworkAlarmWebhookPayload): Promise<AlarmChartMedia>;
  /** Reaproveita PNG ja renderizado (cache TTL) para o QA e para o n8n. */
  read(cacheKey: string): Promise<Buffer | null>;
}

function defaultRender(rendererUrl: string, token: string | undefined): SnapshotRenderer {
  return async (pageUrl: string, timeoutMs: number): Promise<Buffer> => {
    const response = await fetch(`${rendererUrl.replace(/\/+$/, '')}/render`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-netvision-render-token': token } : {}),
      },
      body: JSON.stringify({ url: pageUrl, ...SNAPSHOT_VIEWPORT, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 1_000),
    });
    if (!response.ok) {
      throw new Error(`Snapshot renderer respondeu ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  };
}

/**
 * Orquestra o PNG do evento: spec assinado -> pagina interna -> renderer
 * isolado -> cache em disco -> URL assinada. Qualquer falha (renderer fora do
 * ar, timeout, PNG vazio) devolve `available: false` sem lancar excecao.
 */
export function createAlarmChartSnapshot(deps: AlarmChartSnapshotDeps): AlarmChartSnapshot {
  const ttlSeconds = deps.ttlSeconds ?? SNAPSHOT_TOKEN_TTL_SECONDS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const render =
    deps.render ??
    (deps.rendererUrl
      ? defaultRender(deps.rendererUrl, process.env.SNAPSHOT_RENDER_TOKEN)
      : null);

  const configured = Boolean(
    render && deps.signingKey && deps.webInternalUrl && deps.apiPublicUrl,
  );

  const filePath = (cacheKey: string) => join(deps.cacheDir, `${cacheKey}.png`);
  const keepMs = (deps.cacheKeepHours ?? DEFAULT_SNAPSHOT_CACHE_KEEP_HOURS) * 3_600_000;
  let lastPruneMs = 0;

  /**
   * Limpeza LIMITADA ao diretorio de cache: remove apenas `*.png` mais antigos
   * que a janela de retencao. Best-effort: qualquer falha (diretorio ausente,
   * permissao) nao afeta o snapshot nem o alarme.
   */
  async function pruneCache(): Promise<void> {
    const current = now().getTime();
    if (current - lastPruneMs < CACHE_PRUNE_INTERVAL_MS) return;
    lastPruneMs = current;
    try {
      const entries = await readdir(deps.cacheDir, { withFileTypes: true });
      let deleted = 0;
      for (const entry of entries) {
        if (deleted >= CACHE_PRUNE_MAX_DELETIONS) break;
        if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
        const path = join(deps.cacheDir, entry.name);
        const info = await stat(path).catch(() => null);
        if (!info || current - info.mtimeMs <= keepMs) continue;
        await unlink(path).catch(() => undefined);
        deleted += 1;
      }
    } catch {
      // Cache ausente/ilegivel: o snapshot segue normalmente.
    }
  }

  async function readCached(cacheKey: string): Promise<Buffer | null> {
    try {
      const info = await stat(filePath(cacheKey));
      if (now().getTime() - info.mtimeMs > ttlSeconds * 1000) return null;
      return await readFile(filePath(cacheKey));
    } catch {
      return null;
    }
  }

  const snapshot = async (payload: NetworkAlarmWebhookPayload): Promise<AlarmChartMedia> => {
    const unavailable = (reason: string): AlarmChartMedia => ({
      ...UNAVAILABLE_ALARM_CHART,
      reason,
    });
    if (!configured) return unavailable('snapshot desabilitado');
    const spec = buildAlarmChartSpec(payload, ttlSeconds, now().getTime());
    if (!spec) return unavailable('tipo sem serie historica');
    const signingKey = deps.signingKey as string;
    const pageToken = signSnapshotToken(spec, signingKey, ttlSeconds, now().getTime());
    const cacheKey = snapshotCacheKey(spec);
    const generatedAt = now();
    try {
      let png = await readCached(cacheKey);
      if (!png) {
        const pageUrl = new URL(snapshotPagePath(pageToken), deps.webInternalUrl).toString();
        png = await (render as SnapshotRenderer)(pageUrl, timeoutMs);
        if (png.length === 0) return unavailable('PNG vazio');
        await mkdir(deps.cacheDir, { recursive: true });
        await writeFile(filePath(cacheKey), png);
      }
      const mediaToken = signMediaToken(cacheKey, signingKey, ttlSeconds, generatedAt.getTime());
      await pruneCache();
      return {
        available: true,
        url: new URL(mediaSnapshotPath(mediaToken), deps.apiPublicUrl).toString(),
        mimeType: 'image/png',
        period: spec.period,
        generatedAt: generatedAt.toISOString(),
        expiresAt: new Date(generatedAt.getTime() + ttlSeconds * 1000).toISOString(),
      };
    } catch (error) {
      if (process.env.SNAPSHOT_DEBUG === 'true') {
        console.error(
          `snapshot: falha ao renderizar (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)})`,
        );
      }
      return unavailable('falha ao renderizar');
    }
  };

  return Object.assign(snapshot, { read: readCached });
}
