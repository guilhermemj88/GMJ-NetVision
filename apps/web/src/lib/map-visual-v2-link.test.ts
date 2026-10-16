import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import {
  LINK_V2_COLLECTION_STALE_AFTER_MS,
  linkV2CompactLabel,
  linkV2InputFromLink,
  linkV2LabelPriority,
  resolveRealLinkV2,
} from './map-visual-v2-link';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const FRESH = new Date(NOW - 30_000).toISOString();
const STALE = new Date(NOW - LINK_V2_COLLECTION_STALE_AFTER_MS - 60_000).toISOString();

const baseLink = cloneDemoMaps()[0]!.links[0]!;
const G = 1_000_000_000;

function link(overrides: Partial<NetworkLink> = {}): NetworkLink {
  const merged: NetworkLink = {
    ...structuredClone(baseLink),
    capacityBps: 100 * G,
    status: 'UP',
    trafficMode: 'BIDIRECTIONAL',
    sourceInterfaceId: 'if-a',
    targetInterfaceId: 'if-b',
    directions: {
      A_TO_B: { bps: 30 * G, utilization: 30, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      B_TO_A: { bps: 40 * G, utilization: 40, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
    },
    ...overrides,
  };
  return merged;
}

function context(collectionStamp: string | null = FRESH) {
  return { nowMs: NOW, collectionStamp };
}

describe('adaptador do enlace real para o V2', () => {
  it('usa as taxas e a capacidade reais', () => {
    const input = linkV2InputFromLink(link(), context());
    expect(input.operational).toBe('up');
    expect(input.capacityBps).toBe(100 * G);
    expect(input.aToB.bps).toBe(30 * G);
    expect(input.bToA.bps).toBe(40 * G);
    expect(input.aToB.sampledAtMs).toBe(Date.parse(FRESH));
  });

  it('classifica pelos mesmos limites do lib puro (50/80)', () => {
    expect(resolveRealLinkV2(link(), context()).state).toBe('normal');
    const attention = link({
      directions: {
        A_TO_B: { bps: 60 * G, utilization: 60, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        B_TO_A: { bps: 10 * G, utilization: 10, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      },
    });
    expect(resolveRealLinkV2(attention, context()).state).toBe('attention');
    const critical = link({
      directions: {
        A_TO_B: { bps: 85 * G, utilization: 85, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        B_TO_A: { bps: 20 * G, utilization: 20, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      },
    });
    expect(resolveRealLinkV2(critical, context()).state).toBe('critical');
  });

  it('DOWN confirmado nunca vira normal', () => {
    const visual = resolveRealLinkV2(link({ status: 'DOWN' }), context());
    expect(visual.state).toBe('down');
    expect(visual.labelText).toBe('DOWN');
  });

  it('sem carimbo de coleta não há amostra: "sem dados" em vez de saudável', () => {
    const visual = resolveRealLinkV2(link(), context(null));
    expect(visual.state).toBe('no-data');
    expect(visual.aToB.hasSample).toBe(false);
  });

  it('carimbo velho vira stale (mesma regra do FreshnessTag)', () => {
    const visual = resolveRealLinkV2(link(), context(STALE));
    expect(visual.state).toBe('stale');
  });

  it('capacidade ausente não vira utilização: estado sem dados', () => {
    const visual = resolveRealLinkV2(link({ capacityBps: 0 }), context());
    expect(visual.utilizationPercent).toBeNull();
    expect(visual.state).toBe('no-data');
  });

  it('enlace de ponta única só tem amostra no lado monitorado', () => {
    const single = link({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: 'if-a',
      targetInterfaceId: null,
    });
    const visual = resolveRealLinkV2(single, context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.bToA.hasSample).toBe(false);
    expect(visual.partial).toBe(true);
  });

  it('inconsistência declarada pela origem é respeitada', () => {
    const divergent = link({
      directions: {
        A_TO_B: { bps: 30 * G, utilization: 30, txBps: null, observedRxBps: null, deltaPercent: 40, consistency: 'DIVERGENT' },
        B_TO_A: { bps: 30 * G, utilization: 30, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      },
    });
    const input = linkV2InputFromLink(divergent, context());
    expect(input.inconsistent).toBe(true);
    expect(resolveRealLinkV2(divergent, context()).state).toBe('inconsistent');
  });

  it('status desconhecido não é apresentado como normal', () => {
    const visual = resolveRealLinkV2(link({ status: 'UNKNOWN' }), context());
    expect(visual.state).not.toBe('normal');
    expect(visual.reason).toBe('operational-unknown');
  });
});

describe('rótulo do enlace real', () => {
  it('versão compacta cabe na pílula', () => {
    const visual = resolveRealLinkV2(link(), context());
    expect(linkV2CompactLabel(visual)).toBe('40%');
    expect(linkV2CompactLabel(resolveRealLinkV2(link({ status: 'DOWN' }), context()))).toBe('DOWN');
    expect(linkV2CompactLabel(resolveRealLinkV2(link(), context(null)))).toBe('sem dados');
    expect(linkV2CompactLabel(resolveRealLinkV2(link(), context(STALE)))).toBe('desatualizado');
  });

  it('prioridade respeita seleção, alarme e severidade', () => {
    const healthy = resolveRealLinkV2(link(), context());
    expect(linkV2LabelPriority({ visual: healthy, selected: false })).toBe(0);
    expect(linkV2LabelPriority({ visual: healthy, selected: true })).toBe(3);
    expect(linkV2LabelPriority({ visual: healthy, selected: false, alarmCount: 1 })).toBe(2);
    const down = resolveRealLinkV2(link({ status: 'DOWN' }), context());
    expect(linkV2LabelPriority({ visual: down, selected: false })).toBe(2);
    const attention = resolveRealLinkV2(
      link({
        directions: {
          A_TO_B: { bps: 60 * G, utilization: 60, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 10 * G, utilization: 10, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      }),
      context(),
    );
    expect(linkV2LabelPriority({ visual: attention, selected: false })).toBe(1);
  });
});
