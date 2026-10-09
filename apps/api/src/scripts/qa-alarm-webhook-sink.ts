import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  NETWORK_ALARM_EVENT_KEY,
  NETWORK_ALARM_TEST_EVENT,
  N8nAlarmTransport,
  buildNetworkAlarmTestAlarm,
  buildNetworkAlarmWebhookPayload,
  type NetworkAlarmWebhookPayload,
} from '../infrastructure/alarms/n8n-alarm-transport';
import { config } from '../config';
import {
  UNAVAILABLE_ALARM_CHART,
  buildAlarmChartSpec,
  createAlarmChartSnapshot,
  isChartableAlarmType,
} from '../infrastructure/media/alarm-chart-snapshot';
import {
  createFetchWebhookSender,
  type MediaChannelPort,
} from '../infrastructure/media/n8n-media-transport';
import {
  signMediaToken,
  signSnapshotToken,
  snapshotCacheKey,
} from '../infrastructure/media/snapshot-token';
import { prismaClient } from '../infrastructure/persistence/prisma-client';

/**
 * QA do grÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡fico anexado ao webhook NETWORK_ALARMS (fase "grÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡fico no webhook").
 *
 * Roda SOMENTE no preview. Captura o payload EXATO com um sink HTTP local
 * (127.0.0.1) no lugar do n8n: nenhum webhook externo, nenhum Telegram, nenhum
 * seed de MediaIntegration, nenhuma escrita em Alarm/OperationalOccurrence.
 *
 * Prova:
 *  1. texto continua chegando (obrigatÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³rio);
 *  2. `media.chart.available=true` + URL pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºblica assinada quando o renderer
 *     responde;
 *  3. a URL responde 200, image/png, 1200x720 e com pixels de sÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rie/eixo;
 *  4. token expirado, adulterado ou de outro recurso falha (404);
 *  5. renderer fora do ar mantÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©m o envio textual (payload sem `media`);
 *  6. LINK DOWN (sem sÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rie) segue texto-only e ainda chega no sink.
 *
 * Uso (somente preview):
 *   npx tsx src/scripts/qa-alarm-webhook-sink.ts
 */

const SINK_PORT = Number(process.env.QA_SINK_PORT ?? 9099);
const OUTPUT_DIR = process.env.QA_OUTPUT_DIR ?? '/opt/netvision-alarm-preview/qa-webhook-sink';
const SINK_TOKEN = 'qa-sink-token';

interface SinkCall {
  payload: NetworkAlarmWebhookPayload;
  token: string | null;
}

interface PngStats {
  width: number;
  height: number;
  inkRatio: number;
  colors: Record<string, number>;
  labelPixels: number;
}

const WATCHED_COLORS: Record<string, [number, number, number]> = {
  warn_crc: [0xe3, 0xa6, 0x4b],
  alarm: [0xe0, 0x5c, 0x5c],
  rx_teal: [0x43, 0xd6, 0xb5],
  tx_blue: [0x44, 0xa8, 0xe8],
  tx_red: [0xd1, 0x65, 0x65],
};
const LABEL_COLOR: [number, number, number] = [0x6f, 0x83, 0x92];

const CASES = [
  { name: 'crc-15m', type: 'INTERFACE_CRC', event: 'OPENED', period: '15m' },
  { name: 'errors-15m', type: 'INTERFACE_ERRORS', event: 'OPENED', period: '15m' },
  { name: 'discards-15m', type: 'INTERFACE_DISCARDS', event: 'OPENED', period: '15m' },
  { name: 'optical-24h', type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED', period: '24h', triggerReasons: ['PROXIMITY'] },
  {
    name: 'optical-rapiddrop-1h',
    type: 'OPTICAL_RX_DEGRADATION',
    event: 'OPENED',
    period: '1h',
    triggerReasons: ['PROXIMITY', 'RAPID_DROP'],
  },
  { name: 'resolved', type: 'INTERFACE_CRC', event: 'RESOLVED', period: '15m' },
  { name: 'link-down-texto-only', type: 'INTERFACE_DOWN', event: 'OPENED', period: null },
] as const;

function assertPreviewOnly(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('netvision_alarm_preview')) {
    throw new Error('QA do webhook so roda no preview (DATABASE_URL de preview obrigatoria)');
  }
  if (
    !config.SNAPSHOT_RENDERER_URL ||
    !config.SNAPSHOT_SIGNING_KEY ||
    !config.SNAPSHOT_WEB_INTERNAL_URL ||
    !config.SNAPSHOT_PUBLIC_API_URL
  ) {
    throw new Error('SNAPSHOT_* ausente: snapshot desligado neste ambiente');
  }
}

function startSink(): { server: Server; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        calls.push({
          payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as NetworkAlarmWebhookPayload,
          token: (request.headers['x-netvision-token'] as string | undefined) ?? null,
        });
      } catch {
        calls.push({ payload: {} as NetworkAlarmWebhookPayload, token: null });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return { server, calls };
}

function closeTo(value: number, target: number, tolerance = 12): boolean {
  return Math.abs(value - target) <= tolerance;
}

/** Decodifica o PNG do Chromium (8 bits, RGB/RGBA) sem dependencia externa. */
function analyzePng(png: Buffer): PngStats {
  if (png.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('PNG invalido (assinatura)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`PNG fora do formato esperado (depth=${bitDepth} color=${colorType})`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const target = pixels.subarray(row * stride, (row + 1) * stride);
    const previous = row === 0 ? null : pixels.subarray((row - 1) * stride, row * stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (target[index - channels] ?? 0) : 0;
      const up = previous ? (previous[index] ?? 0) : 0;
      const upLeft = previous && index >= channels ? (previous[index - channels] ?? 0) : 0;
      const value = line[index] ?? 0;
      let result = value;
      if (filter === 1) result = value + left;
      else if (filter === 2) result = value + up;
      else if (filter === 3) result = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        const smallest = Math.min(...distances);
        result = value + (smallest === distances[0] ? left : smallest === distances[1] ? up : upLeft);
      }
      target[index] = result & 0xff;
    }
  }

  const colors: Record<string, number> = {};
  for (const name of Object.keys(WATCHED_COLORS)) colors[name] = 0;
  let ink = 0;
  let labelPixels = 0;
  const total = width * height;
  for (let index = 0; index < total; index += 1) {
    const base = index * channels;
    const r = pixels[base] ?? 0;
    const g = pixels[base + 1] ?? 0;
    const b = pixels[base + 2] ?? 0;
    if (r + g + b > 150) ink += 1;
    if (closeTo(r, LABEL_COLOR[0], 26) && closeTo(g, LABEL_COLOR[1], 26) && closeTo(b, LABEL_COLOR[2], 26)) {
      labelPixels += 1;
    }
    for (const [name, [tr, tg, tb]] of Object.entries(WATCHED_COLORS)) {
      if (closeTo(r, tr) && closeTo(g, tg) && closeTo(b, tb)) {
        colors[name] = (colors[name] ?? 0) + 1;
        break;
      }
    }
  }
  return { width, height, inkRatio: ink / total, colors, labelPixels };
}

/** Mesma forma publica que o transporte envia em `media.chart`. */
function sanitize(value: unknown): string {
  return JSON.stringify(value, null, 1)
    .replace(/\/media\/snapshot\/[^/"]+/g, '/media/snapshot/<SIGNED_TOKEN>')
    .replace(/\/api\/public\/snapshot\/[^/"]+/g, '/api/public/snapshot/<SIGNED_TOKEN>');
}

async function main(): Promise<void> {
  assertPreviewOnly();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const iface = await prismaClient.interface.findFirst({
    where: { name: '100GE0/1/48', device: { name: { contains: 'F1A' } } },
    include: { device: { select: { id: true, name: true } } },
  });
  if (!iface) throw new Error('interface 100GE0/1/48 do F1A nao encontrada no preview');
  /** Fonte READ-ONLY do historico (mesma forma que o backend resolve). */
  const chartSource = {
    interfaceId: iface.id,
    deviceName: iface.device.name,
    interfaceName: iface.name,
    alias: iface.alias ?? '',
    lanes: Array.isArray(iface.opticalLanes)
      ? (iface.opticalLanes as Array<{ lane?: unknown }>)
          .map((lane) => Number(lane?.lane))
          .filter((lane) => Number.isFinite(lane))
      : [],
  };
  const real = {
    interfaceId: iface.id,
    deviceId: iface.device.id,
    deviceName: iface.device.name,
    interfaceName: iface.name,
    alias: iface.alias ?? '',
  };
  console.log(
    `F1A de QA: ${real.deviceName} / ${real.interfaceName} (${real.interfaceId}) lanes=[${chartSource.lanes.join(',')}]`,
  );

  const historyInterfaceId = process.env.QA_HISTORY_INTERFACE_ID ?? real.interfaceId;
  const { server, calls } = startSink();
  await new Promise<void>((resolve) => server.listen(SINK_PORT, '127.0.0.1', resolve));
  const sinkUrl = `http://127.0.0.1:${SINK_PORT}/sink`;
  const media: MediaChannelPort = {
    resolveOutbound: async () => ({
      integrationId: 'qa-sink',
      source: 'MEMORY' as const,
      resolvedPurpose: 'NETWORK_ALARMS' as const,
      url: sinkUrl,
      token: SINK_TOKEN,
      enabled: true,
    }),
    recordOutboundAttempt: async () => undefined,
    recordOutboundDelivery: async () => undefined,
  };
  const sender = createFetchWebhookSender();
  const buildSnapshot = (rendererUrl: string | undefined) =>
    createAlarmChartSnapshot({
      rendererUrl,
      signingKey: config.SNAPSHOT_SIGNING_KEY,
      webInternalUrl: config.SNAPSHOT_WEB_INTERNAL_URL,
      apiPublicUrl: config.SNAPSHOT_PUBLIC_API_URL,
      cacheDir: config.SNAPSHOT_CACHE_DIR,
      ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
      cacheKeepHours: config.SNAPSHOT_CACHE_KEEP_HOURS,
    });
  const realSnapshot = buildSnapshot(config.SNAPSHOT_RENDERER_URL);
  // Renderer fora do ar: cache PROPRIO (sem hit do cache real) para provar o fallback.
  const brokenSnapshot = createAlarmChartSnapshot({
    rendererUrl: 'http://127.0.0.1:1',
    signingKey: config.SNAPSHOT_SIGNING_KEY,
    webInternalUrl: config.SNAPSHOT_WEB_INTERNAL_URL,
    apiPublicUrl: config.SNAPSHOT_PUBLIC_API_URL,
    cacheDir: join(OUTPUT_DIR, 'cache-renderer-off'),
    ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
  });

  /**
   * A fixture do TESTAR ALARME usa uma interface sintetica; para o PNG sair com
   * dados REAIS trocamos apenas a identidade usada no historico. O payload
   * entregue ao sink continua sendo o do transporte canonico (sem patch).
   */
  const withRealHistory = (
    payload: NetworkAlarmWebhookPayload,
    triggerReasons?: readonly string[],
  ): NetworkAlarmWebhookPayload => ({
    ...payload,
    interfaceId: historyInterfaceId,
    deviceName: real.deviceName,
    interfaceName: real.interfaceName,
    interfaceLabel: real.alias,
    ...(triggerReasons ? { triggerReasons: [...triggerReasons] } : {}),
  });

  const lines: string[] = ['caso|evento|periodo|http|bytes|png|tinta%|cores|texto'];
  let failures = 0;

  console.log('\n== 1) payload canonico + sink local (sem webhook externo) ==');
  for (const testCase of CASES) {
    const before = calls.length;
    const snapshot = (payload: NetworkAlarmWebhookPayload) =>
      realSnapshot(
        withRealHistory(
          payload,
          'triggerReasons' in testCase ? testCase.triggerReasons : undefined,
        ),
      );
    const transport = new N8nAlarmTransport({
      media,
      send: sender,
      chartSnapshot: snapshot,
    });
    const outcome = await transport.publishAlarmTest({
      type: testCase.type,
      event: testCase.event,
      includeChart: true,
    });
    const call = calls[before];
    if (!call) {
      failures += 1;
      console.log(`  ${testCase.name}: FALHA (nada chegou no sink)`);
      continue;
    }
    const delivered = call.payload;
    const chart = delivered.media?.chart;
    const chartable = isChartableAlarmType(testCase.type);
    let http = 'n/a';
    let bytes = 0;
    let png = 'n/a';
    let ink = 'n/a';
    let colors = '';
    if (chart?.available && chart.url) {
      const response = await fetch(chart.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.length;
      http = `${response.status} ${response.headers.get('content-type') ?? '-'}`;
      const stats = analyzePng(buffer);
      png = `${stats.width}x${stats.height}`;
      ink = (stats.inkRatio * 100).toFixed(1);
      colors = Object.entries(stats.colors)
        .filter(([, count]) => count > 60)
        .map(([name, count]) => `${name}:${count}`)
        .join(' ');
      const okPublic = !/127\.0\.0\.1|localhost|:3351|:3352/.test(chart.url);
      const okPeriod = chart.period === testCase.period;
      const hasThresholdInk = Object.values(stats.colors).some((count) => count > 60);
      const okPng =
        response.status === 200 &&
        (response.headers.get('content-type') ?? '') === 'image/png' &&
        stats.width === 1200 &&
        stats.height === 720 &&
        stats.inkRatio > 0.005 &&
        stats.labelPixels > 100 &&
        (testCase.type !== 'OPTICAL_RX_DEGRADATION' || hasThresholdInk);
      if (!okPublic || !okPeriod || !okPng) failures += 1;
      const verdict = okPublic && okPeriod && okPng ? 'OK' : 'FALHA';
      console.log(
        `  ${testCase.name.padEnd(22)} ${verdict.padEnd(5)} period=${chart.period} http=${http} bytes=${bytes} png=${png} tinta=${ink}% labels=${stats.labelPixels}px cores[${colors}] urlPublica=${okPublic ? 'sim' : 'NAO'} tokens=${call.token === SINK_TOKEN ? 'ok' : 'NAO'} texto=${delivered.message ? 'ok' : 'NAO'}`,
      );
    } else {
      const textOnly = !chartable && delivered.media === undefined;
      if (!textOnly) failures += 1;
      console.log(
        `  ${testCase.name.padEnd(22)} ${delivered.event.padEnd(9)} period=n/a http=n/a bytes=0 png=n/a texto=${delivered.message ? 'ok' : 'NAO'} media=${delivered.media === undefined ? 'ausente (texto-only)' : 'PRESENTE (inesperado)'}`,
      );
    }
    await writeFile(join(OUTPUT_DIR, `payload-${testCase.name}.json`), `${sanitize(delivered)}\n`);
    lines.push(
      `${testCase.name}|${delivered.event}|${chart?.period ?? '-'}|${http}|${bytes}|${png}|${ink}|${colors}|${delivered.message ? 'ok' : 'nao'}`,
    );
    void outcome;
  }

  console.log('\n== 2) F1A: TESTAR ALARME com interface REAL como fonte do grafico ==');
  // F9.5.2: o texto continua sendo a fixture; a interface real entra SO como
  // `chartSource` (fonte read-only do historico).
  const f1aTransport = new N8nAlarmTransport({
    media,
    send: sender,
    chartSnapshot: realSnapshot,
  });
  const f1aOutcome = await f1aTransport.publishAlarmTest({
    type: 'OPTICAL_RX_DEGRADATION',
    event: 'OPENED',
    severity: 'CRITICAL',
    includeChart: true,
    chartSource,
  });
  const f1aCall = calls[calls.length - 1];
  const f1aDelivered = f1aCall?.payload;
  const fixtureKept =
    f1aDelivered?.test === true &&
    f1aDelivered?.device.name === 'NETVISION-TEST' &&
    f1aDelivered?.interface.id === 'test-interface' &&
    f1aDelivered?.interface.name === '100GE0/0/2';
  const f1aUrl = f1aDelivered?.media?.chart.url ?? null;
  let f1aLine = 'F1A: sem imagem (fallback texto-only)';
  if (f1aUrl) {
    const response = await fetch(f1aUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const stats = analyzePng(buffer);
    const spec = buildAlarmChartSpec(f1aDelivered!, config.SNAPSHOT_TTL_SECONDS, Date.now(), {
      source: chartSource,
      test: true,
    });
    const pageToken = spec ? snapshotCacheKey(spec) : null;
    let laneCheck = 'n/a';
    if (pageToken) {
      const cache = await readFile(join(config.SNAPSHOT_CACHE_DIR, `${pageToken}.png`)).catch(() => null);
      laneCheck = cache ? `${cache.length}b` : 'sem cache';
    }
    const colors = Object.entries(stats.colors)
      .filter(([, count]) => count > 60)
      .map(([name, count]) => `${name}:${count}`)
      .join(' ');
    f1aLine = `F1A: http=${response.status} ${response.headers.get('content-type')} bytes=${buffer.length} png=${stats.width}x${stats.height} tinta=${(stats.inkRatio * 100).toFixed(1)}% cores[${colors}] periodo=${f1aDelivered?.media?.chart.period} lane=${spec?.optical?.lane} hist=${spec?.interfaceId === chartSource.interfaceId ? 'f1a-real' : 'FIXTURE'} cache=${laneCheck} fixture=${fixtureKept ? 'ok' : 'MISTUROU'}`;
    await writeFile(join(OUTPUT_DIR, 'payload-f1a-real.json'), `${sanitize(f1aDelivered)}\n`);
    await writeFile(join(OUTPUT_DIR, 'f1a-optical-1h.png'), buffer);
    // A janela vem do fixture (RAPID_DROP -> 1h). O coletor do preview esta
    // desligado, entao a serie pode estar vazia: a prova das LANES e feita na
    // janela de 24h logo abaixo.
    const ok = response.status === 200 && stats.width === 1200 && stats.height === 720
      && stats.inkRatio > 0.005
      && spec?.interfaceId === chartSource.interfaceId && fixtureKept;
    if (!ok) failures += 1;
  } else {
    failures += 1;
  }
  console.log(`  ${f1aLine}`);
  console.log(
    `  payload: test=${f1aDelivered?.test} device=${f1aDelivered?.device.name} interface=${f1aDelivered?.interface.name} chartSourceNoPayload=${JSON.stringify(f1aDelivered ?? {}).includes(chartSource.interfaceId) ? 'VAZOU' : 'nao'} evento=${f1aOutcome.event}`,
  );

  console.log('\n== 2c) F1A na janela de 24h: LANES reais no PNG (sem o agregado) ==');
  const base24h = buildNetworkAlarmWebhookPayload(
    buildNetworkAlarmTestAlarm(
      { type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED', severity: 'CRITICAL' },
      new Date(),
    ),
    NETWORK_ALARM_EVENT_KEY.OPENED,
    { test: true, eventKey: NETWORK_ALARM_TEST_EVENT },
  );
  // Mesma fixture, apenas sem o RAPID_DROP: a janela vira 24h (onde o preview
  // tem historico optico real do F1A).
  const payload24h: NetworkAlarmWebhookPayload = {
    ...base24h,
    triggerReasons: ['PROXIMITY'],
    optical: base24h.optical
      ? { ...base24h.optical, triggerReasons: ['PROXIMITY'], dropDb: null, dropWindowMinutes: null }
      : null,
  };
  const spec24h = buildAlarmChartSpec(payload24h, config.SNAPSHOT_TTL_SECONDS, Date.now(), {
    source: chartSource,
    test: true,
  });
  const media24h = await realSnapshot(payload24h, { source: chartSource, test: true });
  if (spec24h && media24h.available && media24h.url) {
    const response = await fetch(media24h.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const stats = analyzePng(buffer);
    const colors24 = Object.entries(stats.colors)
      .filter(([, count]) => count > 60)
      .map(([name, count]) => `${name}:${count}`)
      .join(' ');
    const lanesDrawn = (stats.colors.rx_teal ?? 0) > 60;
    const ok = response.status === 200 && stats.width === 1200 && stats.height === 720
      && lanesDrawn && spec24h.period === '24h' && spec24h.interfaceId === chartSource.interfaceId;
    if (!ok) failures += 1;
    console.log(
      `  F1A-24h: ${ok ? 'OK' : 'FALHA'} http=${response.status} png=${stats.width}x${stats.height} periodo=${spec24h.period} lanesDesenhadas=${lanesDrawn ? 'sim' : 'NAO'} lane=${spec24h.optical?.lane} cores[${colors24}]`,
    );
    await writeFile(join(OUTPUT_DIR, 'f1a-optical-24h.png'), buffer);
  } else {
    failures += 1;
    console.log(`  F1A-24h: FALHA (media unavailable: ${media24h.reason ?? '-'})`);
  }

  console.log('\n== 2b) TESTAR ALARME sem interface de referencia: texto-only ==');
  // A obrigatoriedade da interface e validada no SERVICO (testes C/F da suite):
  // aqui provamos que, sem serie historica, o payload segue texto-only.
  const semFonte = new N8nAlarmTransport({
    media,
    send: sender,
    chartSnapshot: async () => ({
      ...UNAVAILABLE_ALARM_CHART,
      reason: 'sem interface de referencia',
    }),
  });
  const beforeSemFonte = calls.length;
  await semFonte.publishAlarmTest({
    type: 'OPTICAL_RX_DEGRADATION',
    event: 'OPENED',
    includeChart: true,
  });
  const semFonteCall = calls[beforeSemFonte];
  const semFonteOk =
    semFonteCall !== undefined && semFonteCall.payload.media === undefined && semFonteCall.payload.test === true;
  if (!semFonteOk) failures += 1;
  console.log(
    `  sem-fonte: chegou=${semFonteCall ? 'sim' : 'NAO'} media=${semFonteCall?.payload.media === undefined ? 'ausente (texto-only)' : 'PRESENTE (inesperado)'} test=${semFonteCall?.payload.test}`,
  );

  console.log('\n== 3) token: expirado, adulterado e outro recurso ==');
  const publicBase = (config.SNAPSHOT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  const signingKey = config.SNAPSHOT_SIGNING_KEY as string;
  const signed = f1aCall?.payload.media?.chart.url ?? null;
  if (signed) {
    const withMediaToken = (token: string) => signed.replace(/\/media\/snapshot\/[^/]+$/, `/media/snapshot/${token}.png`);
    const expiredToken = signMediaToken('aaaaaaaaaaaaaaaa', signingKey, -60, Date.now());
    const expiredResponse = await fetch(withMediaToken(expiredToken));
    const freshToken = signMediaToken('aaaaaaaaaaaaaaaa', signingKey, 60, Date.now());
    const tamperedResponse = await fetch(withMediaToken(`${freshToken.slice(0, -4)}zzzz`));
    const otherResourceToken = signMediaToken('deadbeefdeadbeef', signingKey, 60, Date.now());
    const otherResource = await fetch(withMediaToken(otherResourceToken));
    const genericApi = await fetch(`${publicBase}/api/interfaces/${real.interfaceId}/history?period=15m`);
    console.log(
      `  expirado=${expiredResponse.status} (esperado 404)  adulterado=${tamperedResponse.status} (404)  outro-recurso=${otherResource.status} (404)  api-sem-login=${genericApi.status} (401)`,
    );
    if (expiredResponse.status !== 404) failures += 1;
    if (tamperedResponse.status !== 404) failures += 1;
    if (otherResource.status !== 404) failures += 1;
    if (genericApi.status !== 401) failures += 1;
  } else {
    console.log('  sem URL assinada para testar tokens');
    failures += 1;
  }

  console.log('\n== 3b) dados do F1A na pagina assinada (lanes reais, sem o agregado) ==');
  const f1aSpec = spec24h;
  if (f1aSpec) {
    const pageToken = signSnapshotToken(f1aSpec, signingKey, 120, Date.now());
    const pageResponse = await fetch(`${publicBase}/api/public/snapshot/${pageToken}`);
    const pageData = (await pageResponse.json()) as {
      points?: Array<{
        rxAvg?: number | null;
        lanes?: Array<{ lane: number; rxAvg: number | null }>;
      }>;
    };
    const points = pageData.points ?? [];
    const laneValues = points
      .flatMap((point) => point.lanes ?? [])
      .map((lane) => lane.rxAvg)
      .filter((value): value is number => typeof value === 'number');
    const moduleValues = points
      .map((point) => point.rxAvg)
      .filter((value): value is number => typeof value === 'number');
    const laned = laneValues.length
      ? `${laneValues.length} leituras, ${Math.min(...laneValues).toFixed(2)}..${Math.max(...laneValues).toFixed(2)} dBm`
      : 'sem lanes';
    const aggregate = moduleValues.length
      ? `${Math.min(...moduleValues).toFixed(2)}..${Math.max(...moduleValues).toFixed(2)} dBm (agregado do modulo, NAO vai como lane)`
      : 'n/a';
    console.log(`  page=${pageResponse.status} pontos=${points.length} lanes=${laned} escalar=${aggregate}`);
    await writeFile(join(OUTPUT_DIR, 'f1a-page-data.json'), `${sanitize({ spec: f1aSpec, points })}\n`);
    const saneLanes = laneValues.length > 0 && Math.max(...laneValues) < 3 && Math.min(...laneValues) > -25;
    const aggregateSeparated = moduleValues.length > 0 && Math.max(...moduleValues) > 4;
    if (pageResponse.status !== 200 || !saneLanes || !aggregateSeparated) failures += 1;
    const tamperedPage = await fetch(`${publicBase}/api/public/snapshot/${pageToken.slice(0, -3)}xyz`);
    console.log(`  page_adulterada=${tamperedPage.status} (esperado 404)`);
    if (tamperedPage.status !== 404) failures += 1;
  } else {
    console.log('  sem spec para o F1A');
    failures += 1;
  }

  console.log('\n== 4) renderer fora do ar: texto continua ==');
  const downBefore = calls.length;
  const downTransport = new N8nAlarmTransport({
    media,
    send: sender,
    chartSnapshot: (payload, options) => brokenSnapshot(withRealHistory(payload), options),
  });
  await downTransport.publishAlarmTest({
    type: 'INTERFACE_CRC',
    event: 'OPENED',
    includeChart: true,
    chartSource,
  });
  const downCall = calls[downBefore];
  const brokenPayload = buildNetworkAlarmWebhookPayload(
    buildNetworkAlarmTestAlarm({ type: 'INTERFACE_CRC', event: 'OPENED' }, new Date()),
    NETWORK_ALARM_EVENT_KEY.OPENED,
    { test: true, eventKey: NETWORK_ALARM_TEST_EVENT },
  );
  const mediaBroken = await brokenSnapshot(brokenPayload, { source: chartSource, test: true });
  console.log(
    `  sink_recebeu=${downCall ? 'sim' : 'NAO'} media_no_payload=${downCall?.payload.media === undefined ? 'ausente' : 'PRESENTE'} available=${mediaBroken.available} reason=${mediaBroken.available ? '-' : mediaBroken.reason ?? 'falha ao renderizar'}`,
  );
  if (!downCall || downCall.payload.media !== undefined || mediaBroken.available) failures += 1;
  await writeFile(
    join(OUTPUT_DIR, 'payload-renderer-off.json'),
    `${sanitize(downCall?.payload ?? {})}\n`,
  );

  await writeFile(join(OUTPUT_DIR, 'medicoes.csv'), `${lines.join('\n')}\n`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prismaClient.$disconnect();
  console.log(`\nRESULTADO: ${failures === 0 ? 'TODOS OS CASOS OK' : `${failures} FALHA(S)`}`);
  console.log(`saida: ${OUTPUT_DIR}`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch(async (error: unknown) => {
  console.error(`FALHA: ${error instanceof Error ? error.message : String(error)}`);
  await prismaClient.$disconnect().catch(() => undefined);
  process.exit(1);
});
