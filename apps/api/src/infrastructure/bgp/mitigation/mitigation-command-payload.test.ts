import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService } from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { buildMitigationWebhookPayload } from './mitigation-webhook';
import type {
  MitigationNotification,
  NotificationPublisher,
  NotificationPublishResult,
} from './notification-publisher';

const FIXED_NOW = new Date('2026-09-29T18:00:00.000Z');

/** Publisher de teste: guarda a notificacao canonica publicada pelo motor. */
class CapturePublisher implements NotificationPublisher {
  readonly published: MitigationNotification[] = [];
  constructor(private readonly result: NotificationPublishResult = { published: true, skipped: false }) {}
  async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
    this.published.push(notification);
    return this.result;
  }
}

function host(): HostRecord {
  return {
    id: 'device-1',
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    interfaces: [
      {
        id: 'if-3011',
        name: 'Eth-Trunk1.3011',
        alias: 'HORIZONTE_IP_40GB',
        description: '',
      },
      {
        id: 'if-3013',
        name: 'Eth-Trunk1.3013',
        alias: 'HORIZONTE_IP_02_40GB',
        description: '',
      },
    ],
  } as unknown as HostRecord;
}

/**
 * Cenario real da F1A: policy compartilhada por dois targets do mesmo cliente.
 * O profile principal e o segundo target entram na mesma policy IN.
 */
async function buildScenario(publisher?: NotificationPublisher) {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  executor.seedPolicy('PL-HORIZONTES_IPv4-IN', [11]);

  const primary = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: 'PL-HORIZONTES_IPv4-IN',
    interfaceId: 'if-3011',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
  });
  await repository.replaceProfilePeers(primary.id, [
    { peerAddress: '10.200.200.106', primary: true },
  ]);
  await repository.upsertRuntime(primary.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

  const shared = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: 'PL-HORIZONTES_IPv4-IN',
    interfaceId: 'if-3013',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
  });
  await repository.replaceProfilePeers(shared.id, [
    { peerAddress: '10.200.200.10', primary: true },
  ]);
  await repository.upsertRuntime(shared.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async () => host() },
    executor,
    ...(publisher ? { notifications: publisher } : {}),
    now: () => FIXED_NOW,
  });

  return { repository, executor, commands, profileId: primary.id, sharedProfileId: shared.id };
}

describe('payload OUTBOUND da mitigacao (lane 1: NetVision -> n8n)', () => {
  it('ACTIVATE publica MITIGATION_VERIFIED com o payload completo do alvo', async () => {
    const publisher = new CapturePublisher();
    const scenario = await buildScenario(publisher);

    const result = await scenario.commands.execute({
      requestId: 'req-verified-1',
      action: 'ACTIVATE',
      profileId: scenario.profileId,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    // interface legivel no resultado, id interno preservado
    expect(result.interface).toBe('Eth-Trunk1.3011');
    expect(result.interfaceId).toBe('if-3011');
    expect(result.notification).toEqual({ published: true, skipped: false });

    expect(publisher.published).toHaveLength(1);
    const notification = publisher.published[0]!;
    expect(notification.event).toBe('MITIGATION_VERIFIED');
    expect(notification).toMatchObject({
      eventId: 'req-verified-1',
      profileId: scenario.profileId,
      simulation: true,
      customer: 'HORIZONTE_IP',
      device: 'BHE-VTA-F1A-BGP-01',
      interfaceName: 'Eth-Trunk1.3011',
      addressFamily: 'IPV4',
      peer: '10.200.200.106',
      affectedPeers: ['10.200.200.106'],
      policy: 'PL-HORIZONTES_IPv4-IN',
      node: 2,
      bogonNode: 1,
      mitigationNode: 2,
      rt: '268568:660',
      verified: true,
      sharedPolicy: true,
      effectiveBandwidthBps: 40_000_000_000n,
    });
    expect(notification.sharedPolicyTargets).toEqual([
      {
        interfaceName: 'Eth-Trunk1.3013',
        peerAddress: '10.200.200.10',
        customer: 'HORIZONTE_IP_02',
        addressFamily: 'IPV4',
      },
    ]);

    // Payload de transporte: todos os campos que o n8n usa para montar a mensagem.
    const payload = buildMitigationWebhookPayload(notification);
    expect(payload).toMatchObject({
      event: 'MITIGATION_VERIFIED',
      eventId: 'req-verified-1',
      profileId: scenario.profileId,
      simulation: true,
      customer: 'HORIZONTE_IP',
      device: 'BHE-VTA-F1A-BGP-01',
      interface: 'Eth-Trunk1.3011',
      addressFamily: 'IPV4',
      peer: '10.200.200.106',
      affectedPeers: ['10.200.200.106'],
      bandwidthGbps: 40,
      policy: 'PL-HORIZONTES_IPv4-IN',
      node: 2,
      bogonNode: 1,
      mitigationNode: 2,
      rt: '268568:660',
      verified: true,
      sharedPolicy: true,
      occurredAt: FIXED_NOW.toISOString(),
    });
    expect(payload.sharedPolicyTargets).toHaveLength(1);
    for (const campo of [
      'event',
      'eventId',
      'profileId',
      'customer',
      'device',
      'interface',
      'addressFamily',
      'peer',
      'policy',
      'rt',
      'occurredAt',
    ] as const) {
      expect(payload[campo]).not.toBeNull();
    }
    expect(payload.node).not.toBeNull();
    expect(payload.simulation).toBe(true);
  });

  it('SIMULATE_ACTIVATE publica MITIGATION_SIMULATION_TRIGGERED sem executar nada', async () => {
    const publisher = new CapturePublisher();
    const scenario = await buildScenario(publisher);

    const result = await scenario.commands.execute({
      requestId: 'req-sim-1',
      action: 'SIMULATE_ACTIVATE',
      profileId: scenario.profileId,
    });

    expect(result.status).toBe('WOULD_ACTIVATE');
    expect(result.interface).toBe('Eth-Trunk1.3011');
    expect(publisher.published[0]?.event).toBe('MITIGATION_SIMULATION_TRIGGERED');
    expect(publisher.published[0]?.verified).toBeNull();
    expect(buildMitigationWebhookPayload(publisher.published[0]!).verified).toBeNull();
    expect(buildMitigationWebhookPayload(publisher.published[0]!).interface).toBe('Eth-Trunk1.3011');
    // Simulacao nao escreve nada: o executor nem foi chamado.
    expect(scenario.executor.calls).toEqual([]);
  });

  it('shared policy e AVISO: a mitigacao segue normalmente', async () => {
    const publisher = new CapturePublisher();
    const scenario = await buildScenario(publisher);

    const result = await scenario.commands.execute({
      requestId: 'req-shared-1',
      action: 'ACTIVATE',
      profileId: scenario.profileId,
    });

    expect(result.ok).toBe(true);
    expect(result.sharedPolicy).toBe(true);
    expect(result.sharedPolicyTargets).toHaveLength(1);
    expect(result.safeError).toBeUndefined();
    expect(publisher.published[0]?.sharedPolicy).toBe(true);
  });

  it('notification.skipped quando nenhuma midia esta configurada', async () => {
    const publisher = new CapturePublisher({ published: false, skipped: true });
    const scenario = await buildScenario(publisher);

    const result = await scenario.commands.execute({
      requestId: 'req-skip-1',
      action: 'ACTIVATE',
      profileId: scenario.profileId,
    });

    expect(result.ok).toBe(true);
    expect(result.notification).toEqual({ published: false, skipped: true });
  });

  it('sem publisher o motor continua e reporta NAO CONFIGURADA', async () => {
    const scenario = await buildScenario();
    const result = await scenario.commands.execute({
      requestId: 'req-no-publisher',
      action: 'ACTIVATE',
      profileId: scenario.profileId,
    });
    expect(result.ok).toBe(true);
    expect(result.notification).toEqual({ published: false, skipped: true });
  });

  it('nenhuma escrita real: o executor e o mock e so ele recebe os comandos', async () => {
    const scenario = await buildScenario();
    await scenario.commands.execute({
      requestId: 'req-mock-1',
      action: 'ACTIVATE',
      profileId: scenario.profileId,
    });

    // Os comandos "de escrita" existem apenas no espelho em memoria do mock.
    expect(scenario.executor).toBeInstanceOf(MockMitigationExecutor);
    expect(scenario.executor.calls).toContain('route-policy PL-HORIZONTES_IPv4-IN deny node 1');
    expect(scenario.executor.calls).toContain(' if-match ip-prefix BOGONS');
    expect(scenario.executor.calls).toContain('route-policy PL-HORIZONTES_IPv4-IN permit node 2');
    expect(scenario.executor.calls).toContain(' if-match ip-prefix PREFIX8to24');
    // E o read-back e sempre feito apos a acao.
    expect(scenario.executor.calls).toContain('display route-policy PL-HORIZONTES_IPv4-IN');
  });

  it('profile inexistente nao toca em nenhum executor', async () => {
    const scenario = await buildScenario();
    const result = await scenario.commands.execute({
      requestId: 'req-missing',
      action: 'ACTIVATE',
      profileId: 'profile-inexistente',
    });
    expect(result.status).toBe('PROFILE_NOT_FOUND');
    expect(result.interface).toBeNull();
    expect(result.interfaceId).toBeNull();
    expect(scenario.executor.calls).toEqual([]);
  });
});
