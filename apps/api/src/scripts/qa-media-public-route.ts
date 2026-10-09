import { config } from '../config';
import {
  NETWORK_ALARM_EVENT_KEY,
  buildNetworkAlarmTestAlarm,
  buildNetworkAlarmWebhookPayload,
} from '../infrastructure/alarms/n8n-alarm-transport';
import {
  buildAlarmChartSpec,
  createAlarmChartSnapshot,
} from '../infrastructure/media/alarm-chart-snapshot';
import { signMediaToken, snapshotCacheKey } from '../infrastructure/media/snapshot-token';

/**
 * QA do contrato do PNG pela camada PUBLICA (nginx): prova que o n8n baixa a
 * imagem por `/media/snapshot/<token>[.png]` sem conhecer porta interna,
 * renderer ou 127.0.0.1. Nao imprime token; apenas status/tipo/tamanho/dimensao.
 *
 * Uso:
 *   QA_NGINX_BASE=http://127.0.0.1 npx tsx src/scripts/qa-media-public-route.ts
 *   (QA_DIRECT_BASE opcional, default http://127.0.0.1:$PORT; QA_INTERFACE_ID opcional)
 */

interface Probe {
  status: number;
  type: string;
  bytes: number;
  buffer: Buffer;
}

async function probe(url: string): Promise<Probe> {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '-',
    bytes: buffer.length,
    buffer,
  };
}

function pngDims(buffer: Buffer): string {
  if (buffer.length < 24) return 'nao-png';
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

async function main(): Promise<void> {
  const signingKey = config.SNAPSHOT_SIGNING_KEY;
  if (!signingKey || !config.SNAPSHOT_RENDERER_URL) {
    throw new Error('SNAPSHOT_* ausente: snapshot desligado neste ambiente');
  }
  const publicBase = process.env.QA_NGINX_BASE;
  if (!publicBase) throw new Error('QA_NGINX_BASE obrigatorio (camada publica/nginx)');

  const direct = (process.env.QA_DIRECT_BASE ?? `http://127.0.0.1:${config.PORT}`).replace(/\/+$/, '');
  const bases: Array<[string, string]> = [
    ['interna  ', direct],
    ['publica ', publicBase.replace(/\/+$/, '')],
  ];

  const alarm = buildNetworkAlarmTestAlarm(
    { type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED', severity: 'MAJOR' },
    new Date(),
  );
  const payload = buildNetworkAlarmWebhookPayload(alarm, NETWORK_ALARM_EVENT_KEY.OPENED);
  const realPayload = {
    ...payload,
    interfaceId: process.env.QA_INTERFACE_ID ?? payload.interfaceId,
  };
  const snapshot = createAlarmChartSnapshot({
    rendererUrl: config.SNAPSHOT_RENDERER_URL,
    signingKey,
    webInternalUrl: config.SNAPSHOT_WEB_INTERNAL_URL,
    apiPublicUrl: config.SNAPSHOT_PUBLIC_API_URL,
    cacheDir: config.SNAPSHOT_CACHE_DIR,
    ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
    cacheKeepHours: config.SNAPSHOT_CACHE_KEEP_HOURS,
  });
  const media = await snapshot(realPayload);
  if (!media.available) throw new Error(`snapshot indisponivel: ${media.reason ?? 'sem motivo'}`);
  if (media.url) {
    if (/127\.0\.0\.1|localhost|:335[12]/.test(media.url)) {
      throw new Error('URL publica invalida: aponta para endereco interno ou para o renderer');
    }
    if (process.env.QA_REQUIRE_PORTLESS_PUBLIC === '1' && /:(3333|3340)\//.test(media.url)) {
      throw new Error('URL publica invalida: ainda usa a porta interna da API');
    }
  }
  console.log(`snapshot gerado (periodo ${media.period}); URL publica sem endereco interno`);

  const spec = buildAlarmChartSpec(realPayload, config.SNAPSHOT_TTL_SECONDS, Date.now());
  if (!spec) throw new Error('spec ausente');
  const cacheKey = snapshotCacheKey(spec);
  const token = signMediaToken(cacheKey, signingKey, 300, Date.now());
  const expired = signMediaToken(cacheKey, signingKey, -60, Date.now());
  const tampered = `${token.slice(0, -4)}zzzz`;

  let falhas = 0;
  const checar = (ok: boolean, rotulo: string): void => {
    if (!ok) falhas += 1;
    console.log(`  ${ok ? 'OK   ' : 'FALHA'} ${rotulo}`);
  };

  for (const [rotulo, base] of bases) {
    const semExt = await probe(`${base}/media/snapshot/${token}`);
    const comExt = await probe(`${base}/media/snapshot/${token}.png`);
    console.log(
      `  ${rotulo} sem_ext=${semExt.status} ${semExt.type} ${semExt.bytes}b ${pngDims(semExt.buffer)} | com_ext=${comExt.status} ${comExt.type} ${comExt.bytes}b`,
    );
    checar(semExt.status === 200 && semExt.type.startsWith('image/png'), `${rotulo}: /media/snapshot/<token> = 200 image/png`);
    checar(comExt.status === 200 && comExt.type.startsWith('image/png'), `${rotulo}: /media/snapshot/<token>.png = 200 image/png`);
    checar(pngDims(semExt.buffer) === '1200x720', `${rotulo}: PNG 1200x720`);
    const exp = await probe(`${base}/media/snapshot/${expired}.png`);
    const tam = await probe(`${base}/media/snapshot/${tampered}.png`);
    checar(exp.status === 404, `${rotulo}: token expirado = 404`);
    checar(tam.status === 404, `${rotulo}: token adulterado = 404`);
  }

  console.log(
    falhas === 0 ? 'RESULTADO: OK (contrato publico do PNG)' : `RESULTADO: ${falhas} FALHA(S)`,
  );
  if (falhas > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`FALHA: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
