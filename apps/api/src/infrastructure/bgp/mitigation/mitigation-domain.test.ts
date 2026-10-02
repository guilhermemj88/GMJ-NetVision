import { describe, expect, it, vi } from 'vitest';
import {
  bpsToGbps,
  effectiveBandwidthBps,
  formatTrafficGbps,
  gbpsToBps,
  parseBandwidthBpsFromDescription,
} from './bandwidth-parser';
import {
  displayBriefTriggerPercent,
  mitigationConfigFromEnv,
  mitigationThresholdBps,
  recoveryThresholdBps,
} from './mitigation-config';
import {
  peersByPolicy,
  prefixStatus,
  safetyBlocks,
  selectTemporaryNode,
} from './mitigation-planner';
import { evaluateTraffic } from './mitigation-state-machine';
import { SimulationCommandExecutor } from './simulation-command-executor';
import {
  InMemoryNotificationPublisher,
  NoopNotificationPublisher,
  type MitigationNotification,
} from './notification-publisher';
import {
  buildMitigationWebhookPayload,
  createWebhookNotificationPublisher,
  type MitigationWebhookPayload,
} from './mitigation-webhook';

describe('bandwidth parser (fonte canônica em bps)', () => {
  it('extrai 40GB de HORIZONTE_IP_40GB como bps', () => {
    expect(parseBandwidthBpsFromDescription('HORIZONTE_IP_40GB')).toEqual({
      bps: 40_000_000_000n,
      source: 'DESCRIPTION',
    });
  });

  it('extrai 10GB de PLAY_CONNECT_10GB como bps', () => {
    expect(parseBandwidthBpsFromDescription('PLAY_CONNECT_10GB').bps).toBe(10_000_000_000n);
  });

  it('aceita variações: 40 Gbps, 40GB, 40G e 5g', () => {
    for (const description of ['CLIENTE 40 Gbps', 'CLIENTE 40GB', 'CLIENTE 40G', 'CLIENTE 5g']) {
      expect(parseBandwidthBpsFromDescription(description).bps).not.toBeNull();
    }
  });

  it('descrição sem banda vira UNKNOWN', () => {
    const parsed = parseBandwidthBpsFromDescription('ENLACE_SEM_BANDA');
    expect(parsed.bps).toBeNull();
    expect(parsed.source).toBe('UNKNOWN');
  });

  it('rejeita valores fora do intervalo operacional (0 e >100)', () => {
    expect(parseBandwidthBpsFromDescription('CLIENTE_0GB').bps).toBeNull();
    expect(parseBandwidthBpsFromDescription('CLIENTE_999GB').bps).toBeNull();
  });

  it('converte Gbps para bps e bps para Gbps (UI)', () => {
    expect(gbpsToBps(40)).toBe(40_000_000_000n);
    expect(bpsToGbps(40_000_000_000n)).toBe(40);
    expect(formatTrafficGbps(38_700_000_000n)).toBe('38.7 Gbps');
  });

  it('calcula a banda efetiva: override vence a detectada, e nunca é persistida', () => {
    expect(
      effectiveBandwidthBps({ detectedBandwidthBps: 40_000_000_000n, bandwidthOverrideBps: null }),
    ).toBe(40_000_000_000n);
    expect(
      effectiveBandwidthBps({ detectedBandwidthBps: 40_000_000_000n, bandwidthOverrideBps: 10_000_000_000n }),
    ).toBe(10_000_000_000n);
    expect(
      effectiveBandwidthBps({ detectedBandwidthBps: null, bandwidthOverrideBps: null }),
    ).toBeNull();
  });
});

describe('threshold calculation (bps)', () => {
  const config = mitigationConfigFromEnv({});

  it('40G / 300G trunk / 90% -> 12% no display interface brief', () => {
    expect(displayBriefTriggerPercent(config, 40_000_000_000n)).toBe(12);
  });

  it('40G / 90% -> 36_000_000_000 bps de limite', () => {
    expect(mitigationThresholdBps(config, 40_000_000_000n)).toBe(36_000_000_000n);
  });

  it('40G / 70% -> 28_000_000_000 bps de recovery', () => {
    expect(recoveryThresholdBps(config, 40_000_000_000n)).toBe(28_000_000_000n);
  });

  it('config é lida do ambiente e não é hardcoded', () => {
    const custom = mitigationConfigFromEnv({
      MITIGATION_TRUNK_CAPACITY_GB: '200',
      MITIGATION_TRIGGER_PERCENT: '80',
      MITIGATION_RECOVERY_PERCENT: '60',
      MITIGATION_CHECK_INTERVAL_SECONDS: '10',
      MITIGATION_TRIGGER_SAMPLES: '5',
      MITIGATION_RECOVERY_SAMPLES: '20',
      MITIGATION_PREFIX_LIMIT: '50',
      MITIGATION_RT: '123:456',
    });
    expect(custom.trunkCapacityBps).toBe(200_000_000_000n);
    expect(custom.triggerPercent).toBe(80);
    expect(custom.recoveryPercent).toBe(60);
    expect(custom.checkIntervalSeconds).toBe(10);
    expect(custom.triggerSamples).toBe(5);
    expect(custom.recoverySamples).toBe(20);
    expect(custom.prefixLimit).toBe(50);
    expect(custom.mitigationRt).toBe('123:456');
    expect(custom.mode).toBe('SIMULATION_ONLY');
  });

  it('config do motor não carrega detalhe de transporte (sem webhookUrl)', () => {
    expect(config).not.toHaveProperty('webhookUrl');
  });
});

describe('state machine (trigger + recovery hysteresis)', () => {
  const hysteresis = { triggerSamples: 3, recoverySamples: 12 };

  it('3 amostras consecutivas acima -> WOULD_MITIGATE', () => {
    expect(
      evaluateTraffic({
        currentlyMitigated: false,
        consecutiveOverThreshold: 3,
        consecutiveBelowRecovery: 0,
        hysteresis,
      }),
    ).toEqual({ state: 'MITIGATING', result: 'WOULD_MITIGATE' });
  });

  it('1 ou 2 amostras acima -> TRIGGER_PENDING (sem mitigar)', () => {
    for (const consecutiveOverThreshold of [1, 2]) {
      const decision = evaluateTraffic({
        currentlyMitigated: false,
        consecutiveOverThreshold,
        consecutiveBelowRecovery: 0,
        hysteresis,
      });
      expect(decision.state).toBe('TRIGGER_PENDING');
      expect(decision.result).toBe('NO_ACTION');
    }
  });

  it('12 amostras abaixo do recovery -> WOULD_RECOVER', () => {
    expect(
      evaluateTraffic({
        currentlyMitigated: true,
        consecutiveOverThreshold: 0,
        consecutiveBelowRecovery: 12,
        hysteresis,
      }),
    ).toEqual({ state: 'RECOVERING', result: 'WOULD_RECOVER' });
  });

  it('11 amostras abaixo do recovery -> RECOVERY_PENDING', () => {
    const decision = evaluateTraffic({
      currentlyMitigated: true,
      consecutiveOverThreshold: 0,
      consecutiveBelowRecovery: 11,
      hysteresis,
    });
    expect(decision.state).toBe('RECOVERY_PENDING');
    expect(decision.result).toBe('NO_ACTION');
  });

  it('mitigado com tráfego ainda alto permanece MITIGATED', () => {
    expect(
      evaluateTraffic({
        currentlyMitigated: true,
        consecutiveOverThreshold: 5,
        consecutiveBelowRecovery: 0,
        hysteresis,
      }).state,
    ).toBe('MITIGATED');
  });
});

describe('temporary node selection', () => {
  it('sem nodes existentes usa 1', () => {
    expect(selectTemporaryNode({ normalNodes: [], occupiedNodes: [] }).node).toBe(1);
  });

  it('com primeiro node normal 11 usa 1', () => {
    const selection = selectTemporaryNode({ normalNodes: [11, 12], occupiedNodes: [11, 12] });
    expect(selection.node).toBe(1);
    expect(selection.firstNormalNode).toBe(11);
    expect(selection.nodesBeforeFirstNormal).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('node 1 ocupado usa 2', () => {
    expect(selectTemporaryNode({ normalNodes: [11], occupiedNodes: [1, 11] }).node).toBe(2);
  });

  it('nodes 1..9 ocupados -> bloqueado, sem sobrescrever', () => {
    const selection = selectTemporaryNode({
      normalNodes: [11],
      occupiedNodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11],
    });
    expect(selection.node).toBeNull();
    expect(selection.blocked).toBe(true);
    expect(selection.reason).toBe('NO_SAFE_TEMPORARY_NODE');
  });
});

describe('prefix limit and shared policy', () => {
  it('12/100 é SAFE; 120/100 é EXCEEDED; null é UNKNOWN', () => {
    expect(prefixStatus(12, 100)).toBe('SAFE');
    expect(prefixStatus(120, 100)).toBe('EXCEEDED');
    expect(prefixStatus(null, 100)).toBe('UNKNOWN');
  });

  it('policy compartilhada identifica todos os peers', () => {
    const byPolicy = peersByPolicy([
      { policyName: 'PL-HORIZONTES_IPv4-IN', peerAddress: '10.200.200.10' },
      { policyName: 'PL-HORIZONTES_IPv4-IN', peerAddress: '10.200.200.106' },
      { policyName: 'PL-OUTRA-IN', peerAddress: '10.0.0.1' },
    ]);
    expect(byPolicy.get('PL-HORIZONTES_IPv4-IN')).toEqual(['10.200.200.10', '10.200.200.106']);
  });

  it('bloqueia por banda, excesso de prefixos e ambiguidade de interface', () => {
    const base = {
      bandwidthBps: 40_000_000_000n as bigint | null,
      prefixCount: 12 as number | null,
      prefixLimit: 100,
      interfaceCorrelation: 'MATCHED' as const,
      policyExists: true,
      peerExists: true,
    };
    expect(safetyBlocks(base).blocked).toBe(false);
    expect(safetyBlocks({ ...base, bandwidthBps: null }).reason).toBe('BANDWIDTH_UNKNOWN');
    expect(safetyBlocks({ ...base, prefixCount: 120 }).reason).toBe('PREFIX_LIMIT_EXCEEDED');
    // prefixCount nulo => UNKNOWN INFORMATIVO: nao bloqueia a mitigacao.
    expect(safetyBlocks({ ...base, prefixCount: null }).blocked).toBe(false);
    expect(safetyBlocks({ ...base, prefixCount: null }).reason).toBeNull();
    expect(safetyBlocks({ ...base, interfaceCorrelation: 'AMBIGUOUS' }).reason).toBe(
      'INTERFACE_AMBIGUOUS',
    );
    expect(safetyBlocks({ ...base, policyExists: false }).reason).toBe('POLICY_NOT_FOUND');
    expect(safetyBlocks({ ...base, peerExists: false }).reason).toBe('PEER_NOT_FOUND');
  });
});

describe('simulation command executor (nunca escreve)', () => {
  const executor = new SimulationCommandExecutor();

  it('gera os comandos de mitigação corretos', () => {
    const preview = executor.buildMitigation(
      'PL-HORIZONTES_IPv4-IN',
      { bogonNode: 1, mitigationNode: 2 },
      '268568:660',
      { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
    );
    expect(preview.commands).toEqual([
      'system-view',
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'commit',
    ]);
    expect(preview.safe).toBe(true);
  });

  it('gera os comandos de recovery corretos', () => {
    expect(
      executor.buildRecovery('PL-HORIZONTES_IPv4-IN', { bogonNode: 1, mitigationNode: 2 }).commands,
    ).toEqual([
      'system-view',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 1',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 2',
      'commit',
    ]);
  });

  it('não possui método de execução SSH nem cliente', () => {
    expect('execute' in executor).toBe(false);
    expect('executeConfig' in executor).toBe(false);
    expect(Object.getOwnPropertyNames(executor).every((name) => name !== 'client')).toBe(true);
  });
});

const baseNotification: MitigationNotification = {
  event: 'MITIGATION_STARTED',
  simulation: true,
  customer: 'HORIZONTES',
  device: 'BHE-VTA-F1A-BGP-01',
  interfaceName: 'Eth-Trunk1.3011',
  peer: '10.200.200.106',
  affectedPeers: ['10.200.200.10', '10.200.200.106'],
  detectedBandwidthBps: 40_000_000_000n,
  bandwidthOverrideBps: null,
  effectiveBandwidthBps: 40_000_000_000n,
  trafficBps: 38_700_000_000n,
  thresholdBps: 36_000_000_000n,
  policy: 'PL-HORIZONTES_IPv4-IN',
  node: 1,
  rt: '268568:660',
  verified: null,
};

describe('notification publisher (domínio genérico, sem acoplamento a webhook)', () => {
  it('domínio publica no publisher e não conhece transporte', async () => {
    const publisher = new InMemoryNotificationPublisher();
    const result = await publisher.publish(baseNotification);

    expect(result).toEqual({ published: true, skipped: false });
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.effectiveBandwidthBps).toBe(40_000_000_000n);
  });

  it('publisher no-op apenas marca como pulado', async () => {
    const result = await new NoopNotificationPublisher().publish(baseNotification);
    expect(result).toEqual({ published: false, skipped: true });
  });
});

describe('webhook é só um adaptador de transporte (NotificationPublisher)', () => {
  it('converte a notificação canônica (bps) no payload de exibição em Gbps', () => {
    const payload = buildMitigationWebhookPayload(baseNotification);
    expect(payload.simulation).toBe(true);
    expect(payload.bandwidthGbps).toBe(40);
    expect(payload.trafficGbps).toBe(38.7);
    expect(payload.thresholdGbps).toBe(36);
    expect(payload.affectedPeers).toEqual(['10.200.200.10', '10.200.200.106']);
  });

  it('falha no transporte não afeta o motor (erro engolido)', async () => {
    const send = vi.fn(async (_url: string, _payload: MitigationWebhookPayload) => {
      throw new Error('rede fora');
    });
    const publisher = createWebhookNotificationPublisher({ url: 'http://n8n/webhook', send });

    expect(await publisher.publish(baseNotification)).toEqual({ published: false, skipped: false });
    expect(send).toHaveBeenCalledOnce();
  });

  it('sem URL configurada simplesmente pula o envio', async () => {
    const send = vi.fn(async () => undefined);
    const publisher = createWebhookNotificationPublisher({ url: null, send });

    expect(await publisher.publish(baseNotification)).toEqual({ published: false, skipped: true });
    expect(send).not.toHaveBeenCalled();
  });
});
