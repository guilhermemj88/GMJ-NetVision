/**
 * PRODUTOR REAL de `MITIGATION_DETECTION_BLOCKED` — teste de integracao.
 *
 * Exercita a cadeia de producao de verdade:
 *   MitigationAutoEngine (decisao) -> trackDetection -> onBlockedActivation
 *   -> createDetectionAlertPublisher (payload + fieldsUnavailable)
 *   -> N8nMediaTransport (headers, ACK, semantica de delivered)
 *
 * Nenhum comando Huawei e emitido em nenhum cenario: o comando de escrita e
 * injetado como contador e precisa permanecer em zero.
 *
 * Dados: `__fixtures__/flash-3066-tx-real-samples.json` traz 24 amostras REAIS
 * de txBps da Eth-Trunk1.3066 coletadas por consulta read-only no PostgreSQL de
 * producao. Nenhuma telemetria de producao foi alterada.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from '../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { MitigationCommandService } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from '../infrastructure/bgp/mitigation/mitigation-executor';
import { buildMitigationWebhookPayload } from '../infrastructure/bgp/mitigation/mitigation-webhook';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
  type WebhookDeliverySender,
} from '../infrastructure/media/n8n-media-transport';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../worker/mitigation/mitigation-traffic-source';
import {
  buildDetectionAlertNotification,
  createDetectionAlertPublisher,
} from './mitigation-detection-alert';

const DEV = 'host-f1a';
const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const IF_ID = 'if-3066';
const IF_NAME = 'Eth-Trunk1.3066';
/** Banda declarada do perfil real (9537 Mbps) e gatilho de 90%. */
const BW = 9_537_000_000n;
const TRIGGER = (BW * 90n) / 100n;

const realSamples = JSON.parse(
  readFileSync(
    new URL(
      '../infrastructure/bgp/mitigation/__fixtures__/flash-3066-tx-real-samples.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { samples: { at: string; bps: number }[]; provenance: { origin: string } };

const host = (id: string) =>
  ({
    id,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    interfaces: [{ id: IF_ID, name: IF_NAME, ifIndex: 287, speedBps: BW }],
  }) as unknown as HostRecord;

const targetState = (over: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState => ({
  profileId: 'p-flash-3066',
  deviceId: DEV,
  policyName: POLICY,
  interfaceId: IF_ID,
  customer: 'FLASH TELECOM',
  mode: 'AUTO',
  addressFamily: 'IPV4',
  direction: 'tx',
  directionSource: 'INTERFACE',
  snapshotAvailable: true,
  readiness: 'READY',
  prefixStatus: 'SAFE',
  blockedReason: null,
  mitigationExcluded: false,
  runtimeState: 'NORMAL',
  effectiveBandwidthBps: BW,
  bogonNode: 1,
  mitigationNode: 2,
  sharedPolicy: true,
  peerAddresses: ['10.200.201.22', '10.200.201.23'],
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  ...over,
});

interface SentWebhook {
  url: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Cenario completo: motor real + command service real + publisher real +
 * transporte real. `ack` decide o que o n8n responde.
 */
async function scenario(options: {
  series: { bps: bigint; at: Date }[];
  ack?: unknown;
  httpStatus?: number;
  timeout?: boolean;
  label?: string;
}) {
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: DEV,
    policyName: POLICY,
    interfaceId: IF_ID,
    addressFamily: 'IPV4',
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
    mode: 'AUTO',
  });

  // Escrita Huawei: contador. Precisa terminar em zero em TODOS os cenarios.
  let huaweiWrites = 0;
  const executor = new MockMitigationExecutor();
  const realActivate = executor.activate.bind(executor);
  executor.activate = async (input) => {
    huaweiWrites += 1;
    return realActivate(input);
  };

  const commands = new MitigationCommandService({
    // Homologacao: execucao automatica DESLIGADA.
    autoExecutionEnabled: () => false,
    repository,
    hosts: { getHost: async (id) => host(id) },
    executor,
  });

  // SENDER REAL com `fetch` falso: exercita a mesma regra de status/corpo que
  // roda em producao (`createFetchWebhookSender` lanca fora de 2xx).
  const sent: SentWebhook[] = [];
  const realSender: WebhookDeliverySender = createFetchWebhookSender({
    timeoutMs: 200,
    fetchImpl: (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      sent.push({
        url,
        payload: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const status = options.httpStatus ?? 200;
      if (options.timeout === true) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return new Response(JSON.stringify(options.ack ?? { ok: true, routed: true, delivered: true }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as never,
  });
  const send: WebhookDeliverySender = realSender;
  const deliveries: { ok: boolean }[] = [];
  const transport = new N8nMediaTransport({
    media: {
      resolveOutbound: async () => ({
        integrationId: 'int-mitigation',
        enabled: true,
        url: 'https://n8n.example/webhook/netvision-mitigation',
        token: 'token-de-teste',
      }),
      recordOutboundAttempt: async () => undefined,
      recordOutboundDelivery: async (input: { ok: boolean }) => {
        deliveries.push({ ok: input.ok });
      },
    } as never,
    send,
  });

  const notifications: MitigationNotification[] = [];
  const publisher = createDetectionAlertPublisher({
    hosts: { getHost: async (id) => host(id) },
    transport: {
      publish: async (notification) => {
        notifications.push(notification);
        return transport.publish(notification);
      },
    },
  });

  let clock = options.series[0]!.at.getTime();
  let executed = 0;
  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
    evaluationScope: 'OPERATIONAL',
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEV] },
    executionControl: { enabled: false, allowedProfileIds: [], legacyExemptProfileIds: [] },
    requireRuntimeRead: false,
    targets: { list: async () => [targetState({ profileId: profile.id })] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: (id) => repository.getRuntime(id),
      save: async (id, patch) => {
        await repository.upsertRuntime(id, patch);
      },
    },
    commands: {
      execute: async (input) => {
        executed += 1;
        return commands.execute(input);
      },
    },
    onBlockedActivation: publisher,
    logger: () => undefined,
    now: () => new Date(clock),
  });

  for (const sample of options.series) {
    clock = sample.at.getTime();
    traffic.push(profile.id, sample.bps, `s-${sample.at.getTime()}`, sample.at);
    await engine.tick();
  }
  await engine.settleDetectionAlerts();

  return {
    sent,
    notifications,
    deliveries,
    decisions: engine.activeDetectionEpisodes(),
    writes: () => ({ huaweiWrites, executed }),
  };
}

describe('produtor real: dados REAIS coletados (controle negativo)', () => {
  it('trafego real da .3066 (tx 391-673 Mbps) NAO dispara alerta', async () => {
    expect(realSamples.samples.length).toBeGreaterThanOrEqual(20);
    const max = Math.max(...realSamples.samples.map((s) => s.bps));
    // Sanidade: o mundo real esta bem abaixo do gatilho de 90% (8,58 Gbps).
    expect(BigInt(max)).toBeLessThan(TRIGGER);

    const series = realSamples.samples.map((sample) => ({
      bps: BigInt(sample.bps),
      at: new Date(`${sample.at}Z`),
    }));
    const result = await scenario({ series });
    expect(result.notifications).toHaveLength(0);
    expect(result.sent).toHaveLength(0);
    expect(result.writes()).toEqual({ huaweiWrites: 0, executed: 0 });
  });
});

describe('produtor real: gatilho cruzado (caminho positivo)', () => {
  /** Serie acima do gatilho, derivada da banda real do perfil. */
  const burst = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      bps: (BW * 95n) / 100n,
      at: new Date(Date.UTC(2026, 9, 28, 20, 0, index * 10)),
    }));

  it('emite MITIGATION_DETECTION_BLOCKED com o payload completo do NOC', async () => {
    const result = await scenario({ series: burst(4) });
    expect(result.notifications).toHaveLength(1);
    const notification = result.notifications[0]!;
    expect(notification.event).toBe('MITIGATION_DETECTION_BLOCKED');
    expect(notification.simulation).toBe(true);
    expect(notification.verified).toBe(false);
    expect(notification.blockedReason).toBe('AUTO_EXECUTION_DISABLED');
    expect(notification.policy).toBe(POLICY);
    expect(notification.interfaceName).toBe(IF_NAME);
    expect(notification.device).toBe('BHE-VTA-F1A-BGP-01');
    expect(notification.addressFamily).toBe('IPV4');
    expect(notification.direction).toBe('tx');
    expect(notification.directionSource).toBe('INTERFACE');
    expect(notification.affectedPeers).toEqual(['10.200.201.22', '10.200.201.23']);
    expect(notification.sharedPolicy).toBe(true);
    expect(notification.episodeId).toBeTruthy();
    expect(notification.fieldsUnavailable).toEqual([]);

    // Payload do webhook: nada de id interno, nada de "0 Gbps".
    const payload = buildMitigationWebhookPayload(notification);
    expect(payload.event).toBe('MITIGATION_DETECTION_BLOCKED');
    expect(payload.device).toBe('BHE-VTA-F1A-BGP-01');
    expect(payload.interface).toBe(IF_NAME);
    expect(payload.policy).toBe(POLICY);
    expect(payload.trafficGbps).toBe(9.06);
    expect(payload.thresholdGbps).toBe(8.58);
    expect(payload.episodeId).toBeTruthy();
    expect(payload.blockedReason).toBe('AUTO_EXECUTION_DISABLED');
    // Contrato do workflow: so MITIGATION_VERIFIED pode virar "mitigacao aplicada".
    const realActivated =
      payload.event === 'MITIGATION_VERIFIED' &&
      payload.simulation === false &&
      payload.verified === true;
    expect(realActivated).toBe(false);
  });

  it('envia ao webhook com o header de autenticacao e um unico POST por episodio', async () => {
    const result = await scenario({ series: burst(6) });
    expect(result.sent).toHaveLength(1);
    const request = result.sent[0]!;
    expect(request.url).toContain('netvision-mitigation');
    expect(request.headers['X-NetVision-Token']).toBe('token-de-teste');
    expect(request.payload['event']).toBe('MITIGATION_DETECTION_BLOCKED');
  });

  it('ACK com delivered:true confirma; a API registra entrega OK', async () => {
    const result = await scenario({ series: burst(4), ack: { routed: true, delivered: true } });
    expect(result.deliveries.at(-1)).toEqual({ ok: true });
  });

  it('HTTP 200 SEM delivered:true NAO confirma (gera nova tentativa)', async () => {
    const result = await scenario({ series: burst(4), ack: { routed: false, delivered: false } });
    expect(result.sent).toHaveLength(1);
    expect(result.deliveries.at(-1)).toEqual({ ok: false });
  });

  it('HTTP 500 tambem nao confirma', async () => {
    const result = await scenario({ series: burst(4), httpStatus: 500, ack: null });
    expect(result.deliveries.at(-1)).toEqual({ ok: false });
  });

  it('timeout nao confirma (e o evento continua no episodio para retry)', async () => {
    const result = await scenario({ series: burst(4), timeout: true, ack: null });
    expect(result.deliveries.at(-1)).toEqual({ ok: false });
  });

  it('nenhuma escrita Huawei e nenhum comando emitido com a execucao desligada', async () => {
    const result = await scenario({ series: burst(10) });
    expect(result.writes()).toEqual({ huaweiWrites: 0, executed: 0 });
    expect(result.decisions).toHaveLength(1); // um episodio, nao dez
  });
});

describe('payload: campos ausentes sao declarados, nunca inventados', () => {
  it('sem nome de device/interface e sem policy, tudo entra em fieldsUnavailable', () => {
    const notification = buildDetectionAlertNotification({
      decision: {
        at: '2026-10-28T20:00:00.000Z',
        profileId: 'p1',
        deviceId: 'host-x',
        customer: null,
        trafficBps: '9000000000',
        thresholdBps: null,
        recoveryThresholdBps: null,
        requiredSamples: 3,
        samplesOver: 3,
        samplesBelow: 0,
        runtimeState: 'NORMAL',
        sharedPolicy: false,
        requestId: null,
        commandStatus: null,
        verified: false,
        notification: null,
        detail: null,
        outcome: 'WOULD_ACTIVATE',
        reason: 'AUTO_EXECUTION_DISABLED',
        episodeId: 'p1:1',
        policyName: null,
        interfaceId: null,
        peerAddress: null,
        peerAddresses: [],
        direction: null,
        directionSource: null,
        addressFamily: 'IPV4',
      },
      deviceName: null,
      interfaceName: null,
    });
    expect(notification.device).toBeNull();
    expect(notification.interfaceName).toBeNull();
    expect(notification.policy).toBeNull();
    expect(notification.fieldsUnavailable).toEqual(
      expect.arrayContaining(['device', 'interface', 'policy', 'customer', 'peer', 'direction', 'threshold']),
    );
    // Nunca inventa valor: traffic existe, threshold nao.
    expect(notification.trafficBps).toBe(9_000_000_000n);
    expect(notification.thresholdBps).toBeNull();
  });
});
