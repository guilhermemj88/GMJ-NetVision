import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSnapshotRoutes } from './snapshot-routes';
import { SNAPSHOT_PERIODS, signMediaToken, signSnapshotToken } from './snapshot-token';

const KEY = 'chave-de-teste-com-tamanho-suficiente';
const NOW = Date.now();

async function buildApp(options: { signingKey?: string | null; cacheDir?: string } = {}) {
  const cacheDir = options.cacheDir ?? (await mkdtemp(join(tmpdir(), 'snap-routes-')));
  // O token assinado viaja no caminho: o default de 100 chars do Fastify
  // devolveria 414 em producao.
  const app = Fastify({ maxParamLength: 4096 });
  registerSnapshotRoutes(app, {
    getInterfaceHistory: async () => [
      {
        timestamp: '2026-10-08T17:50:00.000Z',
        rxBps: 1,
        txBps: 2,
        rxErrors: 18,
        txErrors: 0,
        rxDiscards: 0,
        txDiscards: 0,
      },
    ],
    getInterfaceOpticalHistory: async () => [
      { timestamp: '2026-10-08T17:50:00.000Z', lanes: [{ lane: 2, rxPowerDbm: -18.7, txPowerDbm: -2.1 }] },
    ],
    signingKey: options.signingKey === undefined ? KEY : options.signingKey,
    cacheDir,
    ttlSeconds: 900,
    now: () => new Date(NOW),
  });
  await app.ready();
  return { app, cacheDir };
}

function specFor(kind: 'METRIC' | 'OPTICAL', period: '15m' | '24h' = '15m') {
  return {
    kind,
    interfaceId: 'if-100ge',
    period,
    header: {
      device: 'CEM-CEN-6730-MPLS-01',
      interfaceName: '100GE0/0/1',
      alias: 'TESTE-WEBHOOK',
      type: kind === 'OPTICAL' ? 'OPTICAL_RX_DEGRADATION' : 'INTERFACE_CRC',
      severity: 'CRITICAL',
      message: 'Teste',
      eventAt: '2026-10-08T17:52:00.000Z',
      resolvedAt: null,
    },
    metric:
      kind === 'METRIC'
        ? { series: [{ key: 'rxErrors' as const, label: 'CRC RX', tone: 'crc' as const }], unit: 'errors/min', thresholdValue: 10, thresholdLabel: 'THRESHOLD CRC' }
        : null,
    optical:
      kind === 'OPTICAL'
        ? { lane: 2, lowAlarmDbm: -21.48, highAlarmDbm: -2.5, lowWarningDbm: -19.5, highWarningDbm: -3.5 }
        : null,
  };
}

describe('rotas de snapshot', () => {
  it('SNAPSHOT_PERIODS cobre a janela suportada', () => {
    expect(SNAPSHOT_PERIODS).toContain('15m');
    expect(SNAPSHOT_PERIODS).toContain('24h');
  });

  it('GET /api/public/snapshot/:token devolve spec publica + pontos', async () => {
    const { app } = await buildApp();
    const token = signSnapshotToken(specFor('METRIC'), KEY, 900, NOW);
    const response = await app.inject({ method: 'GET', url: `/api/public/snapshot/${token}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.spec.kind).toBe('METRIC');
    expect(body.spec.metric.thresholdValue).toBe(10);
    expect(body.points).toHaveLength(1);
    // Nada de chave interna na resposta publica.
    expect(JSON.stringify(body)).not.toContain(KEY);
    await app.close();
  });

  it('token ausente/adulterado/expirado => 404 sem vazar dados', async () => {
    const { app } = await buildApp();
    const token = signSnapshotToken(specFor('METRIC'), KEY, 900, NOW);
    const expired = signSnapshotToken(specFor('METRIC'), KEY, -10, NOW);
    for (const url of [
      '/api/public/snapshot/invalido',
      `/api/public/snapshot/${token}x`,
      `/api/public/snapshot/${expired}`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it('sem chave configurada o recurso responde 503 (desligado)', async () => {
    const { app } = await buildApp({ signingKey: null });
    const token = signSnapshotToken(specFor('METRIC'), KEY, 900, NOW);
    expect((await app.inject({ method: 'GET', url: `/api/public/snapshot/${token}` })).statusCode).toBe(
      503,
    );
    await app.close();
  });

  it('GET /media/snapshot/:token.png entrega o PNG em cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'snap-png-'));
    const { app } = await buildApp({ cacheDir });
    const mediaToken = signMediaToken('abc123def456', KEY, 900, NOW);
    await writeFile(join(cacheDir, 'abc123def456.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const response = await app.inject({ method: 'GET', url: `/media/snapshot/${mediaToken}.png` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload).toHaveLength(4);
    await app.close();
  });

  it('PNG inexistente ou token de outra chave => 404', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'snap-png2-'));
    const { app } = await buildApp({ cacheDir });
    const mediaToken = signMediaToken('naoexiste000000', KEY, 900, NOW);
    const otherKey = signMediaToken('naoexiste000000', 'outra-chave-de-teste-bem-longa', 900, NOW);
    expect((await app.inject({ method: 'GET', url: `/media/snapshot/${mediaToken}.png` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/media/snapshot/${otherKey}.png` })).statusCode).toBe(404);
    await app.close();
  });
});
