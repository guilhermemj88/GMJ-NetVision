import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import type { MitigationNotification } from './notification-publisher';
import {
  buildGrowthMessage,
  buildMitigationWebhookPayload,
  type GrowthWebhookBlock,
} from './mitigation-webhook';

/** Servidor HTTP REAL local: o payload e transmitido, nao apenas montado. */
const received: unknown[] = [];
let server: Server;
let port = 0;

async function startWebhook(): Promise<void> {
  if (server) return;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
}

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(payload: unknown): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.status;
}

function notification(over: Partial<MitigationNotification> = {}): MitigationNotification {
  return {
    event: 'MITIGATION_TRIGGERED',
    simulation: true,
    customer: 'CLIENTE SIM 1',
    device: 'BHE-SIM-F1A',
    interfaceName: 'Eth-Trunk1.3001',
    peer: null,
    affectedPeers: [],
    policy: 'PL-SIM-1',
    node: 1,
    bogonNode: 1,
    mitigationNode: 2,
    rt: '268568:660',
    verified: null,
    detectedBandwidthBps: 1_050_000_000n,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 1_050_000_000n,
    trafficBps: 997_500_000n,
    thresholdBps: 997_500_000n,
    direction: 'tx',
    ...over,
  } as MitigationNotification;
}

function growthBlock(over: Partial<GrowthWebhookBlock> = {}): GrowthWebhookBlock {
  const growthClassification = over.growthClassification ?? 'BRUSCO';
  const block = {
    baselineAverage5mPct: 20,
    currentUtilizationPct: 95,
    deltaPercentagePoints: 75,
    delta30sPercentagePoints: 75,
    growthClassification,
    samples5m: 12,
    samples30s: 2,
    thresholdPct: 95,
    thresholdReachedAt: '2026-11-05T15:00:00.000Z',
    trafficDirection: 'tx' as const,
    mitigationStatus: 'SIMULACAO' as const,
    mitigationReason: 'THRESHOLD_REACHED',
    ...over,
  } as GrowthWebhookBlock;
  return { ...block, message: over.message ?? buildGrowthMessage({ customer: 'CLIENTE SIM 1', ...block }) };
}

describe('growth no payload do webhook (informativo)', () => {
  it('payload antigo continua identico e sem growth quando nao ha analise', () => {
    const payload = buildMitigationWebhookPayload(notification());
    expect(payload.growth).toBeNull();
    // Campos antigos intactos.
    expect(payload.event).toBe('MITIGATION_TRIGGERED');
    expect(payload.customer).toBe('CLIENTE SIM 1');
    expect(payload.thresholdMbps).toBe(997.5);
    expect(payload.simulation).toBe(true);
  });

  it.each([
    ['BRUSCO', 75, 75],
    ['MODERADO', 15, 15],
    ['GRADUAL_OU_ESTAVEL', 5, 5],
    ['INDETERMINADO', null, null],
  ] as const)('transmite %s por HTTP real com os campos informativos', async (cls, delta, delta30) => {
    await startWebhook();
    const payload = buildMitigationWebhookPayload(
      notification({
        growth: growthBlock({
          growthClassification: cls,
          baselineAverage5mPct: delta === null ? null : 20,
          deltaPercentagePoints: delta,
          delta30sPercentagePoints: delta30,
        }),
      }),
    );
    received.length = 0;
    expect(await post(payload)).toBe(200);
    const body = received[0] as Record<string, unknown>;
    const growth = body.growth as GrowthWebhookBlock;
    expect(growth.growthClassification).toBe(cls);
    expect(growth.delta30sPercentagePoints).toBe(delta30);
    expect(growth.thresholdPct).toBe(95);
    expect(typeof growth.message).toBe('string');
    // Compatibilidade: campos antigos continuam no mesmo payload.
    expect(body.eventId ?? null).toBeNull();
    expect(body.profileId ?? null).toBeNull();
    expect(body.customer).toBe('CLIENTE SIM 1');
  });

  it('nunca afirma mitigacao aplicada quando o evento e simulacao', async () => {
    await startWebhook();
    const payload = buildMitigationWebhookPayload(
      notification({ simulation: true, growth: growthBlock({ mitigationStatus: 'SIMULACAO' }) }),
    );
    received.length = 0;
    await post(payload);
    const growth = (received[0] as { growth: GrowthWebhookBlock }).growth;
    expect(growth.message).toContain('mitigação não executada');
    expect(growth.message).not.toContain('Mitigação aplicada');
    expect(growth.mitigationStatus).toBe('SIMULACAO');
  });

  it('mensagem humana segue o texto exigido', () => {
    const message = buildGrowthMessage({
      customer: 'CLIENTE SIM 1',
      currentUtilizationPct: 95,
      baselineAverage5mPct: 20,
      deltaPercentagePoints: 75,
      growthClassification: 'BRUSCO',
      mitigationStatus: 'NAO_APLICADA',
    });
    expect(message).toBe(
      'CLIENTE SIM 1 atingiu 95% da banda contratada. Média anterior de 5 minutos: 20%. ' +
        'Variação: +75 pontos percentuais. Crescimento: BRUSCO. ' +
        'Motivo: limiar de utilização atingido. Alerta confirmado — mitigação não executada.',
    );
  });

  it('payload e idempotente: mesma notificacao gera o mesmo JSON', async () => {
    await startWebhook();
    const input = notification({ growth: growthBlock() });
    const first = buildMitigationWebhookPayload(input);
    const second = buildMitigationWebhookPayload(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    received.length = 0;
    expect(await post(first)).toBe(200);
    expect(await post(second)).toBe(200);
    expect(received).toHaveLength(2);
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(received[1]));
  });
});
