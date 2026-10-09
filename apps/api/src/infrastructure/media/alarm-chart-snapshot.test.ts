import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNetworkAlarmTestSelection } from '@gmj/shared';
import {
  NETWORK_ALARM_EVENT_KEY,
  NETWORK_ALARM_TEST_EVENT,
  buildNetworkAlarmTestAlarm,
  buildNetworkAlarmWebhookPayload,
} from '../alarms/n8n-alarm-transport';
import {
  buildAlarmChartSpec,
  createAlarmChartSnapshot,
  isChartableAlarmType,
  opticalChartPeriod,
} from './alarm-chart-snapshot';
import { snapshotCacheKey, verifyMediaToken, verifySnapshotToken } from './snapshot-token';

const KEY = 'chave-de-teste-com-tamanho-suficiente';
const NOW = new Date('2026-10-08T18:00:00.000Z');

function payloadFor(
  type: 'INTERFACE_DOWN' | 'INTERFACE_CRC' | 'INTERFACE_DISCARDS' | 'INTERFACE_ERRORS' | 'OPTICAL_RX_DEGRADATION',
  event: 'OPENED' | 'ESCALATED' | 'RESOLVED' = 'OPENED',
  severity?: 'WARNING' | 'MAJOR' | 'CRITICAL',
) {
  const selection = resolveNetworkAlarmTestSelection({
    type,
    event,
    ...(severity ? { severity } : {}),
  });
  const alarm = buildNetworkAlarmTestAlarm(selection, NOW);
  return buildNetworkAlarmWebhookPayload(alarm, NETWORK_ALARM_EVENT_KEY[event], {
    test: true,
    eventKey: NETWORK_ALARM_TEST_EVENT,
  });
}

describe('spec do snapshot por tipo de alarme', () => {
  it('1) INTERFACE_DOWN nao tem serie: fica texto-only', () => {
    const payload = payloadFor('INTERFACE_DOWN');
    expect(isChartableAlarmType(payload.type)).toBe(false);
    expect(buildAlarmChartSpec(payload, 900, NOW.getTime())).toBeNull();
  });

  it('2) CRC gera serie de CRC com threshold, unidade e janela de 15m', () => {
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_CRC'), 900, NOW.getTime());
    expect(spec?.kind).toBe('METRIC');
    expect(spec?.period).toBe('15m');
    expect(spec?.metric?.series).toEqual([{ key: 'rxErrors', label: 'CRC RX', tone: 'crc' }]);
    expect(spec?.metric?.thresholdValue).toBe(10);
    expect(spec?.metric?.unit).toBe('errors/min');
  });

  it('3) DISCARDS usa os contadores de discards', () => {
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_DISCARDS'), 900, NOW.getTime());
    expect(spec?.metric?.series.map((item) => item.key)).toEqual(['rxDiscards', 'txDiscards']);
    expect(spec?.metric?.thresholdValue).toBe(20);
    expect(spec?.metric?.unit).toBe('discards/min');
  });

  it('4) ERRORS usa os contadores de erro', () => {
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_ERRORS'), 900, NOW.getTime());
    expect(spec?.metric?.series.map((item) => item.key)).toEqual(['rxErrors', 'txErrors']);
    expect(spec?.metric?.thresholdValue).toBe(10);
  });

  it('5) OPTICAL carrega lane e o bloco optical completo (WARN + ALARM)', () => {
    const spec = buildAlarmChartSpec(payloadFor('OPTICAL_RX_DEGRADATION'), 900, NOW.getTime());
    expect(spec?.kind).toBe('OPTICAL');
    expect(spec?.optical).toMatchObject({
      lane: 2,
      lowAlarmDbm: -21.48,
      highAlarmDbm: -2.5,
      lowWarningDbm: -18.9,
      highWarningDbm: -3.4,
    });
    // A fixture OPTICAL traz RAPID_DROP: a janela encurta para 1h.
    expect(spec?.period).toBe('1h');
  });

  it('sem RAPID_DROP a janela optica é de 24h', () => {
    const payload = { ...payloadFor('OPTICAL_RX_DEGRADATION'), triggerReasons: ['PROXIMITY'] };
    expect(buildAlarmChartSpec(payload, 900, NOW.getTime())?.period).toBe('24h');
  });

  it('RAPID_DROP encurta a janela optica para 1h', () => {
    expect(opticalChartPeriod(['PROXIMITY', 'RAPID_DROP'])).toBe('1h');
    expect(opticalChartPeriod(['PROXIMITY'])).toBe('24h');
    expect(opticalChartPeriod(null)).toBe('24h');
  });

  it('8) RESOLVED preserva o contexto e marca a recuperacao', () => {
    const payload = payloadFor('INTERFACE_CRC', 'RESOLVED');
    const spec = buildAlarmChartSpec(payload, 900, NOW.getTime());
    expect(payload.event).toBe('RESOLVED');
    expect(payload.resolvedAt).toBe(NOW.toISOString());
    expect(spec?.header.eventAt).toBe(NOW.toISOString());
    expect(spec?.header.resolvedAt).toBe(NOW.toISOString());
  });
});

describe('payload NETWORK_ALARMS com snapshot', () => {
  it('6/9/10/11/12) OPENED de teste mantem test, eventKey, purpose e canal de alarmes', () => {
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_CRC'), 900, NOW.getTime());
    expect(spec).not.toBeNull();
    const payload = payloadFor('INTERFACE_CRC');
    expect(payload.test).toBe(true);
    expect(payload.eventKey).toBe('NETWORK_ALARM_TEST');
    expect(payload.purpose).toBe('NETWORK_ALARMS');
    expect(JSON.stringify(payload)).not.toContain('BGP_MITIGATION');
  });

  it('7) ESCALATED carrega previousSeverity junto do gráfico', () => {
    const payload = payloadFor('INTERFACE_ERRORS', 'ESCALATED', 'MAJOR');
    expect(payload.event).toBe('ESCALATED');
    expect(payload.previousSeverity).toBe('WARNING');
    expect(buildAlarmChartSpec(payload, 900, NOW.getTime())?.kind).toBe('METRIC');
  });

  it('17) payload real de producao permanece inalterado quando nao há chart', async () => {
    const alarm = buildNetworkAlarmTestAlarm(
      resolveNetworkAlarmTestSelection({ type: 'INTERFACE_DOWN', event: 'OPENED' }),
      NOW,
    );
    const withoutChart = buildNetworkAlarmWebhookPayload(alarm, NETWORK_ALARM_EVENT_KEY.OPENED);
    expect(withoutChart).not.toHaveProperty('media');
    const disabled = createAlarmChartSnapshot({ cacheDir: await mkdtemp(join(tmpdir(), 'snap-')) });
    await expect(disabled(withoutChart)).resolves.toMatchObject({
      available: false,
      url: null,
      period: null,
    });
  });
});

describe('orquestracao do PNG (renderer injetado)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'netvision-snap-'));
  });

  const deps = () => ({
    cacheDir,
    signingKey: KEY,
    webInternalUrl: 'http://127.0.0.1:3005',
    apiPublicUrl: 'http://127.0.0.1:3340',
    ttlSeconds: 900,
    now: () => NOW,
  });

  it('renderiza uma vez, grava no cache e devolve URL assinada curta', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const render = vi.fn(async (_url: string, _timeoutMs: number) => png);
    const snapshot = createAlarmChartSnapshot({ ...deps(), render });
    const payload = payloadFor('INTERFACE_CRC');

    const media = await snapshot(payload);
    expect(media.available).toBe(true);
    expect(media.url).toMatch(/^http:\/\/127\.0\.0\.1:3340\/media\/snapshot\/.+\.png$/);
    expect(media.period).toBe('15m');
    expect(media.expiresAt).toBe(new Date(NOW.getTime() + 900_000).toISOString());
    // Nunca base64/bytes no payload: só a URL.
    expect(JSON.stringify(media)).not.toContain(png.toString('base64'));

    const cached = await snapshot.read(snapshotCacheKey(buildAlarmChartSpec(payload, 900, NOW.getTime())!));
    expect(cached?.equals(png)).toBe(true);

    await snapshot(payload);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:3005\/snapshot\//);
  });

  it('falha do renderer vira available=false sem lancar (fallback texto-only)', async () => {
    const render = vi.fn(async () => {
      throw new Error('renderer fora do ar');
    });
    const snapshot = createAlarmChartSnapshot({ ...deps(), render });
    await expect(snapshot(payloadFor('INTERFACE_ERRORS'))).resolves.toMatchObject({
      available: false,
      url: null,
    });
  });

  it('PNG vazio tambem e recusado', async () => {
    const snapshot = createAlarmChartSnapshot({ ...deps(), render: async () => Buffer.alloc(0) });
    await expect(snapshot(payloadFor('INTERFACE_DISCARDS'))).resolves.toMatchObject({
      available: false,
    });
  });

  it('a URL assinada do PNG expira e e rejeitada depois do TTL', async () => {
    const snapshot = createAlarmChartSnapshot({ ...deps(), render: async () => Buffer.from([1]) });
    const media = await snapshot(payloadFor('INTERFACE_CRC'));
    const token = media.url!.split('/').pop()!.replace('.png', '');
    expect(verifyMediaToken(token, KEY, NOW.getTime() + 1_000)).not.toBeNull();
    expect(verifyMediaToken(token, KEY, NOW.getTime() + 901_000)).toBeNull();
  });

  it('o token da pagina é assinado e verificavel (HMAC, expiração, escopo)', async () => {
    const spec = buildAlarmChartSpec(payloadFor('OPTICAL_RX_DEGRADATION'), 900, NOW.getTime())!;
    const render = vi.fn(async (_url: string, _timeoutMs: number) => Buffer.from([1, 2, 3]));
    const snapshot = createAlarmChartSnapshot({ ...deps(), render });
    await snapshot(payloadFor('OPTICAL_RX_DEGRADATION'));
    const pageUrl = render.mock.calls[0]![0];
    const pageToken = pageUrl.split('/snapshot/')[1]!;
    const verified = verifySnapshotToken(pageToken, KEY, NOW.getTime());
    expect(verified?.interfaceId).toBe(spec.interfaceId);
    expect(verified?.kind).toBe('OPTICAL');
    expect(verifySnapshotToken(pageToken, KEY, NOW.getTime() + 901_000)).toBeNull();
    expect(verifySnapshotToken(`${pageToken}x`, KEY, NOW.getTime())).toBeNull();
  });

  it('cache em disco existe e tem o mesmo sha do render', async () => {
    const png = Buffer.from('PNGDATA');
    const snapshot = createAlarmChartSnapshot({ ...deps(), render: async () => png });
    await snapshot(payloadFor('INTERFACE_CRC'));
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_CRC'), 900, NOW.getTime())!;
    const file = await readFile(join(cacheDir, `${snapshotCacheKey(spec)}.png`));
    expect(file.equals(png)).toBe(true);
  });

  it('caminho PADRAO (sem render injetado) fala HTTP com o renderer', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn(async () => new Response(png, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.SNAPSHOT_RENDER_TOKEN = 'token-de-teste';
    try {
      const snapshot = createAlarmChartSnapshot({ ...deps(), rendererUrl: 'http://127.0.0.1:3351' });
      const media = await snapshot(payloadFor('INTERFACE_CRC'));
      expect(media.available).toBe(true);
      const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(calledUrl).toBe('http://127.0.0.1:3351/render');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-netvision-render-token']).toBe('token-de-teste');
      const body = JSON.parse(String(init.body)) as { url: string; width: number; height: number };
      expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:3005\/snapshot\//);
      expect(body.width).toBe(1200);
      expect(body.height).toBe(720);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SNAPSHOT_RENDER_TOKEN;
    }
  });

  it('renderer indisponivel no caminho padrao nao lanca (fallback texto-only)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ocupado', { status: 503 })),
    );
    try {
      const snapshot = createAlarmChartSnapshot({ ...deps(), rendererUrl: 'http://127.0.0.1:3351' });
      await expect(snapshot(payloadFor('INTERFACE_CRC'))).resolves.toMatchObject({
        available: false,
        url: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reaproveita PNG em cache mesmo com o renderer fora do ar', async () => {    const png = Buffer.from('CACHED');
    const spec = buildAlarmChartSpec(payloadFor('INTERFACE_CRC'), 900, NOW.getTime())!;
    await writeFile(join(cacheDir, `${snapshotCacheKey(spec)}.png`), png);
    const snapshot = createAlarmChartSnapshot({
      ...deps(),
      render: async () => {
        throw new Error('sem renderer');
      },
    });
    await expect(snapshot(payloadFor('INTERFACE_CRC'))).resolves.toMatchObject({ available: true });
  });
});

describe('limpeza do cache de snapshots', () => {
  it('apaga PNGs vencidos, preserva recentes e nunca toca outros arquivos', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-cache-'));
    const oldPng = join(dir, 'aaaaaaaa-vencido.png');
    const freshPng = join(dir, 'bbbbbbbb-recente.png');
    const otherFile = join(dir, 'cccccccc-manter.txt');
    await writeFile(oldPng, Buffer.from('png-antigo'));
    await writeFile(freshPng, Buffer.from('png-recente'));
    await writeFile(otherFile, Buffer.from('nao-e-png'));
    const longAgo = new Date(Date.now() - 40 * 3_600_000);
    await utimes(oldPng, longAgo, longAgo);
    await utimes(otherFile, longAgo, longAgo);

    const snapshot = createAlarmChartSnapshot({
      render: async () => Buffer.from('png-novo'),
      signingKey: KEY,
      webInternalUrl: 'http://127.0.0.1:3005',
      apiPublicUrl: 'http://127.0.0.1:3340',
      cacheDir: dir,
      ttlSeconds: 900,
      cacheKeepHours: 24,
      now: () => new Date(),
    });
    const media = await snapshot(payloadFor('INTERFACE_CRC'));
    expect(media.available).toBe(true);

    await expect(stat(oldPng)).rejects.toThrow();
    await expect(stat(freshPng)).resolves.toBeDefined();
    await expect(readFile(otherFile, 'utf8')).resolves.toBe('nao-e-png');
  });

  it('cache sem diretorio nao gera erro no caminho de escrita', async () => {
    const snapshot = createAlarmChartSnapshot({
      render: async () => Buffer.from('png'),
      signingKey: KEY,
      webInternalUrl: 'http://127.0.0.1:3005',
      apiPublicUrl: 'http://127.0.0.1:3340',
      cacheDir: join(tmpdir(), 'snapshot-cache-inexistente-prune-qa'),
      ttlSeconds: 900,
      now: () => new Date(),
    });
    await expect(snapshot(payloadFor('INTERFACE_CRC'))).resolves.toMatchObject({ available: true });
  });
});
