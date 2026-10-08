import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveNetworkAlarmTestSelection } from '@gmj/shared';
import { config } from '../config';
import {
  NETWORK_ALARM_EVENT_KEY,
  NETWORK_ALARM_TEST_EVENT,
  buildNetworkAlarmTestAlarm,
  buildNetworkAlarmWebhookPayload,
  type NetworkAlarmWebhookPayload,
} from '../infrastructure/alarms/n8n-alarm-transport';
import { buildAlarmChartSpec, createAlarmChartSnapshot } from '../infrastructure/media/alarm-chart-snapshot';
import { snapshotCacheKey } from '../infrastructure/media/snapshot-token';
import { prismaClient } from '../infrastructure/persistence/prisma-client';

/**
 * QA do snapshot do alarme (F9.5.2): gera os PNGs pelo MESMO caminho de
 * producao (spec assinado -> pagina interna -> renderer isolado -> cache ->
 * URL assinada). NAO cria Alarm, OperationalOccurrence, AlarmRule, suppression
 * nem roda SNMP; nao dispara webhook externo.
 *
 * Uso (somente preview):
 *   npx tsx src/scripts/qa-snapshot-charts.ts <interfaceId> <saida>
 *   npx tsx src/scripts/qa-snapshot-charts.ts --seed <interfaceId>
 */

const QA_CASES = [
  { name: 'crc-15m', type: 'INTERFACE_CRC', event: 'OPENED', rapidDrop: null },
  { name: 'discards-15m', type: 'INTERFACE_DISCARDS', event: 'OPENED', rapidDrop: null },
  { name: 'errors-15m', type: 'INTERFACE_ERRORS', event: 'OPENED', rapidDrop: null },
  { name: 'optical-24h', type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED', rapidDrop: false },
  { name: 'optical-rapiddrop-1h', type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED', rapidDrop: true },
  { name: 'resolved', type: 'INTERFACE_CRC', event: 'RESOLVED', rapidDrop: null },
] as const;

function assertPreviewOnly(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('netvision_alarm_preview')) {
    throw new Error('QA de snapshot so roda no preview (DATABASE_URL de preview obrigatoria)');
  }
  if (!config.SNAPSHOT_RENDERER_URL || !config.SNAPSHOT_SIGNING_KEY) {
    throw new Error('SNAPSHOT_* ausente: renderer desligado');
  }
}

/** Amostras sinteticas de QA (somente preview) para o PNG ter curva real. */
async function seedMetricSamples(interfaceId: string): Promise<void> {
  const windowStart = new Date(Date.now() - 20 * 60_000);
  await prismaClient.interfaceMetricSample.deleteMany({
    where: { interfaceId, timestamp: { gte: windowStart } },
  });
  await prismaClient.interfaceOpticalSample.deleteMany({
    where: { interfaceId, timestamp: { gte: new Date(Date.now() - 90 * 60_000) } },
  });
  const now = Date.now();
  /**
   * O agregador de histórico comprime os deltas do bucket (~1/6 do delta
   * amostral), então os picos abaixo chegam ao gráfico perto/cima dos
   * thresholds (CRC/erros 10, discards 20) — que é o ponto do QA visual.
   */
  const crc = [0, 0, 10, 22, 54, 96, 132, 126, 102, 72, 36, 18, 6, 0, 0, 0, 0, 0];
  const disc = [0, 0, 18, 42, 105, 150, 150, 120, 72, 36, 18, 6, 0, 0, 0, 0, 0, 0];
  const outDisc = [0, 0, 6, 18, 36, 48, 30, 12, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let inErrors = 120;
  let inDiscards = 340;
  let outDiscards = 90;
  const rows = crc.map((crcValue, index) => {
    const timestamp = new Date(now - (crc.length - index) * 30_000);
    inErrors += crcValue;
    inDiscards += disc[index] ?? 0;
    outDiscards += outDisc[index] ?? 0;
    const seconds = (index + 1) * 30;
    return {
      interfaceId,
      timestamp,
      inOctets: BigInt(Math.round((2_350_000_000 / 8) * seconds)),
      outOctets: BigInt(Math.round((850_000_000 / 8) * seconds)),
      rxBps: 2_350_000_000 + (index % 5) * 12_000_000,
      txBps: 850_000_000 + (index % 3) * 9_000_000,
      inErrors: BigInt(inErrors),
      outErrors: BigInt(0),
      inDiscards: BigInt(inDiscards),
      outDiscards: BigInt(outDiscards),
      inErrorsDelta: BigInt(crcValue),
      outErrorsDelta: BigInt(0),
      inDiscardsDelta: BigInt(disc[index] ?? 0),
      outDiscardsDelta: BigInt(outDisc[index] ?? 0),
      fcsErrors: BigInt(inErrors),
      fcsErrorsDelta: BigInt(crcValue),
      operStatus: 'UP' as const,
    };
  });
  await prismaClient.interfaceMetricSample.createMany({ data: rows });
  console.log(`  seed: ${rows.length} amostras de metrica (preview)`);

  // Histórico óptico recente (a janela de 1h do RAPID_DROP precisa de dados).
  const opticalRows = Array.from({ length: 61 }, (_, offset) => {
    const progress = offset / 60;
    const rx1 = -17.6 - progress * 3.1;
    const rx2 = -19.3 - progress * 1.7;
    return {
      interfaceId,
      timestamp: new Date(now - (60 - offset) * 60_000),
      rxPowerDbm: rx1,
      txPowerDbm: -3.1,
      opticalLanes: [
        { lane: 1, rxPowerDbm: Number(rx1.toFixed(2)), txPowerDbm: -3.2 },
        { lane: 2, rxPowerDbm: Number(rx2.toFixed(2)), txPowerDbm: -2.9 },
      ],
    };
  });
  await prismaClient.interfaceOpticalSample.createMany({ data: opticalRows });
  console.log(`  seed: ${opticalRows.length} amostras opticas (preview)`);
}

function payloadFor(
  testCase: (typeof QA_CASES)[number],
  real: { interfaceId: string; deviceName: string; interfaceName: string; alias: string },
  now: Date,
): NetworkAlarmWebhookPayload {
  const selection = resolveNetworkAlarmTestSelection({
    type: testCase.type,
    event: testCase.event,
  });
  const alarm = buildNetworkAlarmTestAlarm(selection, now);
  const base = buildNetworkAlarmWebhookPayload(alarm, NETWORK_ALARM_EVENT_KEY[testCase.event], {
    test: true,
    eventKey: NETWORK_ALARM_TEST_EVENT,
  });
  const triggerReasons =
    testCase.rapidDrop === null
      ? base.triggerReasons
      : testCase.rapidDrop
        ? ['PROXIMITY', 'RAPID_DROP']
        : ['PROXIMITY'];
  return {
    ...base,
    interfaceId: real.interfaceId,
    deviceName: real.deviceName,
    interfaceName: real.interfaceName,
    interfaceLabel: real.alias,
    triggerReasons,
  };
}

async function main(): Promise<void> {
  assertPreviewOnly();
  const args = process.argv.slice(2);
  const seedOnly = args[0] === '--seed';
  const interfaceId = seedOnly ? args[1] : args[0];
  if (!interfaceId) throw new Error('informe o interfaceId (interface real, so como fonte de historico)');

  if (seedOnly) {
    await seedMetricSamples(interfaceId);
    await prismaClient.$disconnect();
    return;
  }

  const outputDir = args[1] ?? '/opt/netvision-alarm-preview/qa-snapshots';
  const iface = await prismaClient.interface.findUnique({
    where: { id: interfaceId },
    include: { device: { select: { name: true } } },
  });
  if (!iface) throw new Error('interface nao encontrada');
  const real = {
    interfaceId,
    deviceName: iface.device.name,
    interfaceName: iface.name,
    alias: iface.alias ?? '',
  };
  const snapshot = createAlarmChartSnapshot({
    rendererUrl: config.SNAPSHOT_RENDERER_URL,
    signingKey: config.SNAPSHOT_SIGNING_KEY,
    webInternalUrl: config.SNAPSHOT_WEB_INTERNAL_URL,
    apiPublicUrl: config.SNAPSHOT_PUBLIC_API_URL,
    cacheDir: config.SNAPSHOT_CACHE_DIR,
    ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
  });
  await mkdir(outputDir, { recursive: true });
  console.log(
    `interface ${real.deviceName} / ${real.interfaceName} (${real.alias}) -> ${outputDir}`,
  );
  const lines: string[] = ['caso|periodo|bytes|ms|http_url'];
  for (const testCase of QA_CASES) {
    const now = new Date();
    const payload = payloadFor(testCase, real, now);
    const t0 = Date.now();
    const media = await snapshot(payload);
    const elapsed = Date.now() - t0;
    let bytes = 0;
    let http = 'n/a';
    if (media.available && media.url) {
      const spec = buildAlarmChartSpec(payload, config.SNAPSHOT_TTL_SECONDS, now.getTime());
      if (spec) {
        const png = await snapshot.read(snapshotCacheKey(spec));
        if (png) {
          await writeFile(join(outputDir, `${testCase.name}.png`), png);
          bytes = png.length;
        }
      }
      const response = await fetch(media.url);
      http = `${response.status} ${response.headers.get('content-type')} ${(await response.arrayBuffer()).byteLength}b`;
    }
    console.log(
      `  ${testCase.name.padEnd(22)} period=${String(media.period)} bytes=${bytes} ms=${elapsed} url=${media.available ? 'ok' : media.reason}`,
    );
    lines.push(`${testCase.name}|${media.period}|${bytes}|${elapsed}|${http}`);
  }
  await writeFile(join(outputDir, 'medicoes.csv'), `${lines.join('\n')}\n`);
  await prismaClient.$disconnect();
  console.log('  medicoes.csv gravado');
}

void main().catch(async (error: unknown) => {
  console.error(`FALHA: ${error instanceof Error ? error.message : String(error)}`);
  await prismaClient.$disconnect().catch(() => undefined);
  process.exit(1);
});
