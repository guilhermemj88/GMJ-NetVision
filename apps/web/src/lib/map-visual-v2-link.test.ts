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

describe('Fase H — SINGLE_ENDED: TX e RX da MESMA interface', () => {
  const G = 1_000_000_000;

  /** Enlace de trânsito com a interface monitorada na ponta A (ex.: CPTZ). */
  const monitoredAtA = (overrides: Partial<NetworkLink> = {}) =>
    link({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: 'if-a',
      targetInterfaceId: null,
      directions: {
        // A→B sai pela ponta A (TX) e B→A entra na ponta A (RX observado).
        A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: 3 * G, deltaPercent: null, consistency: 'UNKNOWN' },
      },
      ...overrides,
    });

  /** Endpoints invertidos: a ponta monitorada é a B (ex.: TUDDO IP). */
  const monitoredAtB = (overrides: Partial<NetworkLink> = {}) =>
    link({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: null,
      targetInterfaceId: 'if-b',
      directions: {
        A_TO_B: { bps: 4 * G, utilization: 4, txBps: null, observedRxBps: 4 * G, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 5 * G, utilization: 5, txBps: 5 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
      },
      ...overrides,
    });

  it('1) interface monitorada na ponta A: A→B = TX(A) e B→A = RX(A)', () => {
    const input = linkV2InputFromLink(monitoredAtA(), context());
    expect(input.aToB.bps).toBe(2 * G);
    expect(input.bToA.bps).toBe(3 * G);
    const visual = resolveRealLinkV2(monitoredAtA(), context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.bToA.hasSample).toBe(true);
    // Os dois sentidos avaliados: não é mais "parcial".
    expect(visual.partial).toBe(false);
    expect(visual.state).toBe('normal');
  });

  it('2) interface monitorada na ponta B (endpoints invertidos): A→B = RX(B), B→A = TX(B)', () => {
    const input = linkV2InputFromLink(monitoredAtB(), context());
    expect(input.aToB.bps).toBe(4 * G);
    expect(input.bToA.bps).toBe(5 * G);
    const visual = resolveRealLinkV2(monitoredAtB(), context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.bToA.hasSample).toBe(true);
    expect(visual.partial).toBe(false);
  });

  it('3) só TX válido: a direção do TX aparece e a outra continua desconhecida', () => {
    const onlyTx = monitoredAtA({
      directions: {
        A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
      },
    });
    const visual = resolveRealLinkV2(onlyTx, context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.bToA.hasSample).toBe(false);
    expect(visual.partial).toBe(true);
  });

  it('4) só RX válido: vale o espelho do caso anterior', () => {
    const onlyRx = monitoredAtA({
      directions: {
        A_TO_B: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: 3 * G, deltaPercent: null, consistency: 'UNKNOWN' },
      },
    });
    const visual = resolveRealLinkV2(onlyRx, context());
    expect(visual.aToB.hasSample).toBe(false);
    expect(visual.bToA.hasSample).toBe(true);
  });

  it('5) TX = 0 é medição válida (não é ausência de dados)', () => {
    const zeroTx = monitoredAtA({
      directions: {
        A_TO_B: { bps: 0, utilization: 0, txBps: 0, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: 3 * G, deltaPercent: null, consistency: 'UNKNOWN' },
      },
    });
    const visual = resolveRealLinkV2(zeroTx, context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.aToB.bps).toBe(0);
    expect(visual.aToB.utilizationPercent).toBe(0);
    expect(visual.state).not.toBe('no-data');
  });

  it('6) RX = 0 é medição válida', () => {
    const zeroRx = monitoredAtA({
      directions: {
        A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: 0, deltaPercent: null, consistency: 'UNKNOWN' },
      },
    });
    const visual = resolveRealLinkV2(zeroRx, context());
    expect(visual.bToA.hasSample).toBe(true);
    expect(visual.bToA.bps).toBe(0);
  });

  it('7) sem TX e sem RX: "sem dados", nada inventado', () => {
    const empty = monitoredAtA({
      directions: {
        A_TO_B: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
      },
    });
    const visual = resolveRealLinkV2(empty, context());
    expect(visual.aToB.hasSample).toBe(false);
    expect(visual.bToA.hasSample).toBe(false);
    expect(visual.state).toBe('no-data');
  });

  it('8) enlace sem NENHUMA interface associada continua sem dados', () => {
    const noInterface = link({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: null,
      targetInterfaceId: null,
    });
    const visual = resolveRealLinkV2(noInterface, context());
    expect(visual.aToB.hasSample).toBe(false);
    expect(visual.bToA.hasSample).toBe(false);
    expect(visual.state).toBe('no-data');
  });

  it('9) métricas antigas preservam o estado stale', () => {
    const visual = resolveRealLinkV2(monitoredAtA(), context(STALE));
    expect(visual.state).toBe('stale');
    expect(visual.stale).toBe(true);
  });

  it('10) DOWN continua DOWN mesmo com TX e RX na amostra', () => {
    const visual = resolveRealLinkV2(monitoredAtA({ status: 'DOWN' }), context());
    expect(visual.state).toBe('down');
    expect(visual.labelText).toBe('DOWN');
  });

  it('11) capacidade desconhecida: mostra a taxa, nunca um percentual inventado', () => {
    const visual = resolveRealLinkV2(monitoredAtA({ capacityBps: 0 }), context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.aToB.bps).toBe(2 * G);
    expect(visual.aToB.utilizationPercent).toBeNull();
    expect(visual.utilizationPercent).toBeNull();
  });

  it('12) interface remota não monitorada não é exigida', () => {
    const visual = resolveRealLinkV2(monitoredAtA(), context());
    // A ponta sem interface (operadora externa) não impede os dois sentidos.
    expect(visual.aToB.hasSample && visual.bToA.hasSample).toBe(true);
    expect(visual.reason).not.toBe('no-data');
  });

  it('13) DOUBLE_ENDED não regride: dois sentidos, sem parcial', () => {
    const visual = resolveRealLinkV2(link(), context());
    expect(visual.aToB.hasSample).toBe(true);
    expect(visual.bToA.hasSample).toBe(true);
    expect(visual.partial).toBe(false);
    expect(visual.state).toBe('normal');
  });

  it('14) valores não são somados nem duplicados entre as direções', () => {
    const visual = resolveRealLinkV2(monitoredAtA(), context());
    expect(visual.aToB.bps).toBe(2 * G);
    expect(visual.bToA.bps).toBe(3 * G);
    expect(visual.aToB.bps).not.toBe(visual.bToA.bps);
    expect(visual.dominantBps).toBe(3 * G);
  });

  it('15) percentuais seguem a capacidade do enlace, sentido a sentido', () => {
    const visual = resolveRealLinkV2(monitoredAtA({ capacityBps: 100 * G }), context());
    expect(visual.aToB.utilizationPercent).toBeCloseTo(2, 6);
    expect(visual.bToA.utilizationPercent).toBeCloseTo(3, 6);
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
