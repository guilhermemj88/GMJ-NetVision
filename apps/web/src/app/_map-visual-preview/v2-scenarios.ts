/**
 * MAP-VISUAL-V2 — cenários mock do laboratório (Fase B).
 *
 * Dados 100% DEMONSTRATIVOS: nada é lido da API, do banco ou dos equipamentos.
 * As taxas são derivadas de percentuais fixos sobre a capacidade, com idades de
 * amostra determinísticas — as capturas são reproduzíveis.
 */

import type { DeviceGlyphV2Type } from '@/components/network-device-glyphs-v2';
import type { NetworkDeviceIconType } from '@/lib/device-appearance';

export type MockNodeStatus = 'up' | 'warning' | 'down' | 'unknown';

export interface MockNode {
  id: string;
  name: string;
  ip: string;
  status: MockNodeStatus;
  legacyType: NetworkDeviceIconType;
  /** Glifo V2 explícito (PNI ainda não existe no tipo legado). */
  v2Glyph?: DeviceGlyphV2Type;
  x: number;
  y: number;
  alarms?: number;
  tag?: string;
}

export interface MockLinkEnd {
  bps: number | null;
  /** Idade da amostra em segundos; null = sem carimbo confiável. */
  sampleAgeSeconds: number | null;
  /** RX observado na outra ponta (percentual da capacidade), para consistência. */
  observedRxPercent: number | null;
}

export interface MockLagGroup {
  groupId: string;
  label: string;
  /** Capacidade agregada SÓ quando comprovada nos dados mock. */
  declaredCapacityBps: number | null;
}

export interface MockLink {
  id: string;
  label: string;
  a: string;
  b: string;
  capacityBps: number | null;
  status: 'up' | 'down' | 'unknown';
  aToB: MockLinkEnd;
  bToA: MockLinkEnd;
  inconsistent?: boolean;
  curvature?: number;
  lag?: MockLagGroup;
  logicalLinkId?: string;
  alarms?: number;
  tag?: string;
}

export interface MockScenario {
  id: 'simple' | 'dense' | 'real';
  title: string;
  description: string;
  nodes: MockNode[];
  links: MockLink[];
  /** Enlace sugerido para demonstrações (tooltip/simulações). */
  demoLinkId: string;
  demoLagGroupId: string | null;
}

const G = 1_000_000_000;

function end(
  percent: number | null,
  capacityBps: number,
  ageSeconds = 25,
  observedRxPercent: number | null = percent,
): MockLinkEnd {
  if (percent === null) return { bps: null, sampleAgeSeconds: null, observedRxPercent: null };
  return {
    bps: (capacityBps * percent) / 100,
    sampleAgeSeconds: ageSeconds,
    observedRxPercent,
  };
}

function link(
  id: string,
  label: string,
  a: string,
  b: string,
  capacityBps: number | null,
  aToBPercent: number | null,
  bToAPercent: number | null,
  extra: Partial<Omit<MockLink, 'id' | 'label' | 'a' | 'b' | 'capacityBps' | 'aToB' | 'bToA'>> = {},
  options: { ageSeconds?: number; observedRxPercent?: number | null } = {},
): MockLink {
  const capacity = capacityBps ?? 0;
  const observedRx =
    options.observedRxPercent === undefined ? aToBPercent : options.observedRxPercent;
  const base: MockLink = {
    id,
    label,
    a,
    b,
    capacityBps,
    status: 'up',
    aToB: end(aToBPercent, capacity, options.ageSeconds ?? 25, observedRx),
    bToA: end(bToAPercent, capacity, options.ageSeconds ?? 25),
  };
  return { ...base, ...extra };
}

/* ------------------------------------------------------------------ */
/* Cenário A — backbone simples (10 nós)                              */
/* ------------------------------------------------------------------ */

const SIMPLE_NODES: MockNode[] = [
  { id: 'internet', name: 'INTERNET · AS28126', ip: '200.219.0.0/16', status: 'up', legacyType: 'CLOUD', x: 40, y: 150 },
  { id: 'pni-google', name: 'PNI-GOOGLE-01', ip: '142.250.0.1', status: 'up', legacyType: 'PEER', v2Glyph: 'PNI', x: 40, y: 380, tag: 'PNI (glifo novo)' },
  { id: 'edge', name: 'NE-8000-BORDA-01', ip: '10.255.0.1', status: 'up', legacyType: 'CORE_ROUTER', x: 340, y: 40, alarms: 1 },
  { id: 'ix', name: 'IX-SP-01', ip: '187.16.0.1', status: 'up', legacyType: 'IX', x: 340, y: 380 },
  { id: 'core', name: 'SW-CORE-01', ip: '10.255.1.1', status: 'up', legacyType: 'CORE_SWITCH', x: 660, y: 150 },
  { id: 'bng', name: 'BNG-BRAS-01', ip: '10.255.2.1', status: 'up', legacyType: 'BNG', x: 980, y: 40 },
  { id: 'agg', name: 'AGG-SUL-03', ip: '10.255.3.3', status: 'warning', legacyType: 'AGGREGATION', x: 980, y: 300, alarms: 2 },
  { id: 'olt', name: 'OLT-CENTRO-VILA-NOVA-01', ip: '10.255.9.11', status: 'warning', legacyType: 'OLT', x: 1300, y: 150, alarms: 1 },
  { id: 'dist', name: 'SW-DIST-02', ip: '10.255.4.2', status: 'down', legacyType: 'SWITCH', x: 980, y: 520 },
  { id: 'clientes', name: 'CLIENTES-SUL', ip: '100.64.0.0/12', status: 'up', legacyType: 'CUSTOMERS', x: 1300, y: 520 },
];

const SIMPLE_LINKS: MockLink[] = [
  link('a-internet-edge', 'Transit SP', 'internet', 'edge', 100 * G, 34, 28, { tag: 'normal' }),
  link('a-pni-edge', 'PNI Google', 'pni-google', 'edge', 10 * G, 55, 48, { curvature: 26, tag: 'atenção 55%' }),
  link('a-pni-ix', 'PNI → IX', 'pni-google', 'ix', 10 * G, null, null, { curvature: -18, tag: 'sem telemetria' }),
  link('a-edge-core', 'Borda → core', 'edge', 'core', 40 * G, 22, 19, { tag: 'enlace curto' }),
  link('a-ix-core', 'Peering IX', 'ix', 'core', 40 * G, 62, 41, { tag: 'atenção 62%' }),
  link('a-core-bng', 'Core → BNG', 'core', 'bng', 100 * G, 94, 71, { tag: 'crítico 94%' }),
  link('a-core-agg', 'Core → agregação', 'core', 'agg', 10 * G, 48, 52, { tag: 'equilibrado' }),
  link('a-agg-olt', 'Agregação → OLT', 'agg', 'olt', 10 * G, 30, 25, {}),
  link('a-agg-dist', 'Agregação → SW-DIST-02', 'agg', 'dist', 10 * G, null, null, { status: 'down', tag: 'DOWN' }),
  link('a-bng-clientes', 'BNG → assinantes', 'bng', 'clientes', 10 * G, 61, 14, {}),
  link('a-internet-ix', 'Transit IX (antigo)', 'internet', 'ix', 40 * G, 44, 39, { tag: 'stale', status: 'up' }, { ageSeconds: 600 }),
];

export const SCENARIO_SIMPLE: MockScenario = {
  id: 'simple',
  title: 'Cenário A · backbone simples',
  description:
    '10 equipamentos com enlace normal, 62%, 94%, DOWN, sem telemetria, stale, enlace curto, enlace equilibrado e alarme nos nós.',
  nodes: SIMPLE_NODES,
  links: SIMPLE_LINKS,
  demoLinkId: 'a-core-bng',
  demoLagGroupId: null,
};

/* ------------------------------------------------------------------ */
/* Cenário B — backbone denso (27 nós)                                */
/* ------------------------------------------------------------------ */

const DENSE_NODES: MockNode[] = [
  { id: 'd-internet', name: 'INTERNET · AS28126', ip: '200.219.0.0/16', status: 'up', legacyType: 'CLOUD', x: 60, y: 30 },
  { id: 'd-ix', name: 'IX-SP-01', ip: '187.16.0.1', status: 'up', legacyType: 'IX', x: 380, y: 30 },
  { id: 'd-pni1', name: 'PNI-GOOGLE-01', ip: '142.250.0.1', status: 'up', legacyType: 'PEER', v2Glyph: 'PNI', x: 700, y: 30 },
  { id: 'd-pni2', name: 'PNI-META-01', ip: '157.240.0.1', status: 'up', legacyType: 'PEER', v2Glyph: 'PNI', x: 1020, y: 30, tag: 'PNI (glifo novo)' },
  { id: 'd-core-a', name: 'NE-8000-CORE-A', ip: '10.255.0.1', status: 'up', legacyType: 'CORE_ROUTER', x: 220, y: 170, alarms: 1 },
  { id: 'd-core-b', name: 'NE-8000-CORE-B', ip: '10.255.0.2', status: 'up', legacyType: 'CORE_ROUTER', x: 540, y: 170 },
  { id: 'd-csw1', name: 'SW-CORE-01', ip: '10.255.1.1', status: 'up', legacyType: 'CORE_SWITCH', x: 860, y: 170 },
  { id: 'd-csw2', name: 'SW-CORE-02', ip: '10.255.1.2', status: 'up', legacyType: 'CORE_SWITCH', x: 1180, y: 170 },
  { id: 'd-bng-n', name: 'BNG-NORTE-BRAS-01', ip: '10.255.2.1', status: 'up', legacyType: 'BNG', x: 60, y: 310 },
  { id: 'd-bng-s', name: 'BNG-SUL-BRAS-02', ip: '10.255.2.2', status: 'warning', legacyType: 'BNG', x: 380, y: 310 },
  { id: 'd-agg1', name: 'AGG-CENTRO-01', ip: '10.255.3.1', status: 'up', legacyType: 'AGGREGATION', x: 700, y: 310 },
  { id: 'd-agg2', name: 'AGG-NORTE-02', ip: '10.255.3.2', status: 'up', legacyType: 'AGGREGATION', x: 1020, y: 310 },
  { id: 'd-agg3', name: 'AGG-SUL-03', ip: '10.255.3.3', status: 'up', legacyType: 'AGGREGATION', x: 1340, y: 310 },
  { id: 'd-agg4', name: 'AGG-LESTE-04', ip: '10.255.3.4', status: 'up', legacyType: 'AGGREGATION', x: 1620, y: 310 },
  { id: 'd-sw1', name: 'SW-DIST-01', ip: '10.255.4.1', status: 'up', legacyType: 'SWITCH', x: 60, y: 450 },
  { id: 'd-sw2', name: 'SW-DIST-02', ip: '10.255.4.2', status: 'up', legacyType: 'SWITCH', x: 380, y: 450, alarms: 2 },
  { id: 'd-sw3', name: 'SW-DIST-03', ip: '10.255.4.3', status: 'up', legacyType: 'SWITCH', x: 700, y: 450 },
  { id: 'd-sw4', name: 'SW-DIST-04', ip: '10.255.4.4', status: 'up', legacyType: 'SWITCH', x: 1020, y: 450 },
  { id: 'd-sw5', name: 'SW-DIST-05', ip: '10.255.4.5', status: 'up', legacyType: 'SWITCH', x: 1340, y: 450 },
  { id: 'd-sw6', name: 'SW-DIST-06', ip: '10.255.4.6', status: 'down', legacyType: 'SWITCH', x: 1620, y: 450 },
  { id: 'd-olt1', name: 'OLT-CENTRO-VILA-NOVA-01', ip: '10.255.9.11', status: 'up', legacyType: 'OLT', x: 60, y: 590 },
  { id: 'd-olt2', name: 'OLT-NORTE-JARDIM-02', ip: '10.255.9.12', status: 'warning', legacyType: 'OLT', x: 380, y: 590 },
  { id: 'd-olt3', name: 'OLT-SUL-PARQUE-03', ip: '10.255.9.13', status: 'warning', legacyType: 'OLT', x: 700, y: 590, alarms: 3 },
  { id: 'd-dc', name: 'DATACENTER-A', ip: '10.255.20.1', status: 'up', legacyType: 'DATACENTER', x: 1020, y: 590 },
  { id: 'd-cl', name: 'CLUSTER-CACHE-01', ip: '10.255.21.1', status: 'up', legacyType: 'CLUSTER', x: 1340, y: 590 },
  { id: 'd-onu', name: 'ONU-PILOTO-01', ip: '10.255.30.1', status: 'unknown', legacyType: 'ONU', x: 1620, y: 590 },
  { id: 'd-clientes', name: 'CLIENTES-SUL', ip: '100.64.0.0/12', status: 'up', legacyType: 'CUSTOMERS', x: 940, y: 730 },
];

const DENSE_LINKS: MockLink[] = [
  // Upstream / peering
  link('d-internet-core-a', 'Transit A', 'd-internet', 'd-core-a', 100 * G, 34, 28, {}),
  link('d-internet-core-b', 'Transit B', 'd-internet', 'd-core-b', 100 * G, 55, 52, { tag: 'equilibrado 5x%' }),
  link('d-ix-core-a', 'Peering IX → core A', 'd-ix', 'd-core-a', 100 * G, 88, 84, { tag: 'crítico' }),
  link('d-ix-core-b', 'Peering IX → core B', 'd-ix', 'd-core-b', 40 * G, 62, 58, {}),
  link('d-pni1-core-a', 'PNI Google', 'd-pni1', 'd-core-a', 10 * G, 72, 70, { curvature: 26 }),
  link('d-pni2-core-b', 'PNI Meta', 'd-pni2', 'd-core-b', 10 * G, 45, 49, { curvature: -26 }),
  // Dois circuitos independentes entre os mesmos nós (não agrupar!)
  link('d-transit-a', 'Transit-SP (100G)', 'd-core-a', 'd-core-b', 100 * G, 94, 12, { tag: 'crítico 94% · métrica divergente' }, { observedRxPercent: 62 }),
  link('d-transit-b', 'Circuito secundário', 'd-core-a', 'd-core-b', 40 * G, 12, 9, { tag: 'independente' }),
  link('d-core-a-csw1', 'Core A → SW-CORE-01', 'd-core-a', 'd-csw1', 40 * G, 62, 60, {}),
  // Quatro links paralelos entre os core switches (sem LAG comprovado)
  link('d-par-1', 'Paralelo 1', 'd-csw1', 'd-csw2', 10 * G, 62, 60, {}),
  link('d-par-2', 'Paralelo 2', 'd-csw1', 'd-csw2', 10 * G, 45, 44, {}),
  link('d-par-3', 'Paralelo 3', 'd-csw1', 'd-csw2', 10 * G, 88, 86, { tag: 'crítico' }),
  link('d-par-4', 'Paralelo 4', 'd-csw1', 'd-csw2', 10 * G, 30, 28, {}),
  // LAG demonstrativo 2×10G com um membro DOWN
  link('d-lag-a', 'LAG-CENTRO membro 1', 'd-agg1', 'd-csw1', 10 * G, 55, 52, {
    lag: { groupId: 'lag-centro', label: 'LAG-CENTRO 2×10G', declaredCapacityBps: 20 * G },
  }),
  link('d-lag-b', 'LAG-CENTRO membro 2', 'd-agg1', 'd-csw1', 10 * G, null, null, {
    status: 'down',
    lag: { groupId: 'lag-centro', label: 'LAG-CENTRO 2×10G', declaredCapacityBps: 20 * G },
    tag: 'membro DOWN',
  }),
  // Dois caminhos visuais do MESMO enlace lógico
  link('d-bngn-path1', 'Core 02 → BNG Norte (path 1)', 'd-csw2', 'd-bng-n', 40 * G, 66, 62, {
    logicalLinkId: 'll-bng-norte',
    curvature: -22,
  }),
  link('d-bngn-path2', 'Core 02 → BNG Norte (path 2)', 'd-csw2', 'd-bng-n', 40 * G, 66, 62, {
    logicalLinkId: 'll-bng-norte',
    curvature: 22,
  }),
  link('d-csw1-bng-s', 'SW-CORE-01 → BNG Sul', 'd-csw1', 'd-bng-s', 40 * G, 30, 28, {}),
  link('d-csw1-dc', 'SW-CORE-01 → datacenter', 'd-csw1', 'd-dc', 10 * G, 12, 11, {}),
  link('d-csw2-cl', 'SW-CORE-02 → cluster', 'd-csw2', 'd-cl', 10 * G, 35, 33, {}),
  link('d-dc-csw2', 'Datacenter → SW-CORE-02', 'd-dc', 'd-csw2', 10 * G, 120, 8, {
    tag: 'amostra inconsistente (120%)',
  }),
  // Agregação → distribuição
  link('d-agg1-sw1', 'AGG-CENTRO-01 → SW-DIST-01', 'd-agg1', 'd-sw1', 10 * G, 62, 58, {}),
  link('d-agg2-sw2', 'AGG-NORTE-02 → SW-DIST-02', 'd-agg2', 'd-sw2', 10 * G, 88, 84, { tag: 'crítico' }),
  link('d-agg3-sw3', 'AGG-SUL-03 → SW-DIST-03', 'd-agg3', 'd-sw3', 10 * G, null, null, { tag: 'sem telemetria' }),
  link('d-agg4-sw4', 'AGG-LESTE-04 → SW-DIST-04', 'd-agg4', 'd-sw4', 10 * G, 40, 38, {}),
  link('d-bng-n-sw5', 'BNG Norte → SW-DIST-05', 'd-bng-n', 'd-sw5', 10 * G, 55, 50, {}),
  link('d-bng-s-sw6', 'BNG Sul → SW-DIST-06', 'd-bng-s', 'd-sw6', 10 * G, null, null, { status: 'down', tag: 'DOWN (SW-06 fora)' }),
  // Acessos
  link('d-olt1-sw1', 'OLT Centro → SW-DIST-01', 'd-olt1', 'd-sw1', 10 * G, 30, 28, { tag: 'enlace curto' }),
  link('d-olt2-sw2', 'OLT Norte → SW-DIST-02', 'd-olt2', 'd-sw2', 10 * G, 78, 74, {}),
  link('d-olt3-sw3', 'OLT Sul → SW-DIST-03', 'd-olt3', 'd-sw3', 10 * G, 55, 50, { tag: 'stale' }, { ageSeconds: 600 }),
  link('d-sw5-clientes', 'SW-DIST-05 → assinantes', 'd-sw5', 'd-clientes', 10 * G, 88, 84, { tag: 'crítico' }),
  // Tráfego sem capacidade declarada: utilização não pode ser calculada.
  {
    id: 'd-sw6-onu',
    label: 'SW-DIST-06 → ONU piloto',
    a: 'd-sw6',
    b: 'd-onu',
    capacityBps: null,
    status: 'up',
    aToB: { bps: 300_000_000, sampleAgeSeconds: 25, observedRxPercent: null },
    bToA: { bps: 120_000_000, sampleAgeSeconds: 25, observedRxPercent: null },
    tag: 'capacidade desconhecida',
  },
  link('d-sw2-clientes', 'SW-DIST-02 → assinantes', 'd-sw2', 'd-clientes', 40 * G, 94, 90, { tag: 'crítico' }),
  link('d-sw4-clientes', 'SW-DIST-04 → assinantes', 'd-sw4', 'd-clientes', 10 * G, 12, 10, {}),
];

export const SCENARIO_DENSE: MockScenario = {
  id: 'dense',
  title: 'Cenário B · backbone denso',
  description:
    '27 equipamentos e 34 enlaces: links paralelos, LAG 2×10G com membro DOWN, dois caminhos do mesmo enlace lógico, capacidades 1G/10G/40G/100G, nomes longos, alarmes e zoom.',
  nodes: DENSE_NODES,
  links: DENSE_LINKS,
  demoLinkId: 'd-transit-a',
  demoLagGroupId: 'lag-centro',
};

export const MOCK_SCENARIOS: readonly MockScenario[] = [SCENARIO_SIMPLE, SCENARIO_DENSE];

/** Cenários A/B — o cenário C (geometria real) vive em v2-scenario-catalog. */
export function scenarioById(id: 'simple' | 'dense'): MockScenario {
  return id === 'dense' ? SCENARIO_DENSE : SCENARIO_SIMPLE;
}
