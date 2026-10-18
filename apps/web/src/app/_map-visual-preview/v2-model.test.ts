import { describe, expect, it } from 'vitest';
import {
  buildLinkV2Model,
  mockLinkHistory,
  toNetworkLinkMock,
  type LinkV2ModelOptions,
} from './v2-model';
import { SCENARIO_DENSE, SCENARIO_SIMPLE, scenarioById } from './v2-scenarios';

const NOW = 1_800_000_000_000;

function options(overrides: Partial<LinkV2ModelOptions> = {}): LinkV2ModelOptions {
  return {
    nowMs: NOW,
    showAllLabels: false,
    selectedEdgeId: null,
    selectedNodeId: null,
    simulation: null,
    expandedLagIds: [],
    ...overrides,
  };
}

describe('modelo do canvas V2 — cenários', () => {
  it('cenário simples resolve os casos obrigatórios', () => {
    const model = buildLinkV2Model(SCENARIO_SIMPLE, options());
    const byId = new Map(model.edges.map((edge) => [edge.id, edge]));

    expect(byId.get('a-internet-edge')?.visual.state).toBe('normal');
    expect(byId.get('a-core-bng')?.visual.state).toBe('critical');
    expect(byId.get('a-core-bng')?.visual.labelText).toBe('94G · 94%');
    expect(byId.get('a-agg-dist')?.visual.state).toBe('down');
    expect(byId.get('a-agg-dist')?.visual.labelText).toBe('DOWN');
    expect(byId.get('a-pni-ix')?.visual.state).toBe('no-data');
    expect(byId.get('a-internet-ix')?.visual.state).toBe('stale');
    expect(byId.get('a-core-agg')?.visual.direction).toBe('balanced');
    expect(byId.get('a-ix-core')?.visual.partial).toBe(false);
    expect(model.groups).toHaveLength(0);
  });

  it('cenário denso tem 27 nós e mantém 33 linhas com o LAG recolhido', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    expect(SCENARIO_DENSE.nodes).toHaveLength(27);
    expect(SCENARIO_DENSE.links).toHaveLength(34);
    expect(model.edges).toHaveLength(33);
    expect(model.groups).toHaveLength(1);
  });

  it('LAG declarado vira UMA linha com membros e falha visível', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const groupEdge = model.edges.find((edge) => edge.id === 'lag:lag-centro');
    expect(groupEdge).toBeDefined();
    expect(groupEdge?.labelText).toContain('2 membros');
    expect(groupEdge?.labelText).toContain('1 DOWN');
    // Membro DOWN não deixa o grupo fingir normalidade.
    expect(groupEdge?.visual.state).toBe('inconsistent');
    expect(groupEdge?.visual.reason).toBe('operational-unknown');
  });

  it('expandir o LAG preserva a identidade dos membros', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options({ expandedLagIds: ['lag-centro'] }));
    expect(model.edges).toHaveLength(34);
    const memberDown = model.edges.find((edge) => edge.id === 'd-lag-b');
    const memberUp = model.edges.find((edge) => edge.id === 'd-lag-a');
    expect(memberDown?.visual.state).toBe('down');
    expect(memberUp?.visual.state).toBe('attention');
    expect(memberUp?.lagGroupId).toBe('lag-centro');
    expect(model.edges.some((edge) => edge.id === 'lag:lag-centro')).toBe(false);
  });

  it('não agrupa circuitos independentes nem quatro paralelos', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const offsets = ['d-par-1', 'd-par-2', 'd-par-3', 'd-par-4'].map(
      (id) => model.edges.find((edge) => edge.id === id)?.autoOffset ?? 0,
    );
    expect([...offsets].sort((a, b) => a - b)).toEqual([-36, -12, 12, 36]);

    const transit = ['d-transit-a', 'd-transit-b'].map(
      (id) => model.edges.find((edge) => edge.id === id)?.autoOffset ?? 0,
    );
    expect(new Set(transit).size).toBe(2);
  });

  it('dois caminhos do MESMO enlace lógico compartilham o irmão paralelo', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const paths = model.edges.filter((edge) => edge.selectionId === 'll-bng-norte');
    const path1 = paths[0];
    const path2 = paths[1];
    // Encoding do mapa operacional: o primário usa o id do link, os extras `:path:n`.
    expect(paths.map((edge) => edge.id)).toEqual(['ll-bng-norte', 'll-bng-norte:path:1']);
    expect(path1?.logicalLinkId).toBe('ll-bng-norte');
    expect(path1?.autoOffset).toBe(path2?.autoOffset);
    expect(path1?.offset).not.toBe(path2?.offset);
  });
});

describe('modelo do canvas V2 — simulações', () => {
  it('simula DOWN no enlace escolhido sem afetar os outros', () => {
    const model = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ simulation: { linkId: 'a-core-bng', mode: 'down' } }),
    );
    const simulated = model.edges.find((edge) => edge.id === 'a-core-bng');
    const untouched = model.edges.find((edge) => edge.id === 'a-internet-edge');
    expect(simulated?.visual.state).toBe('down');
    expect(simulated?.simTag).toBe('DOWN simulado');
    expect(simulated?.networkLink.status).toBe('DOWN');
    expect(untouched?.visual.state).toBe('normal');
    expect(untouched?.simTag).toBeNull();
  });

  it('simula sem dados e stale com os rótulos certos', () => {
    const noData = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ simulation: { linkId: 'a-core-bng', mode: 'no-data' } }),
    ).edges.find((edge) => edge.id === 'a-core-bng');
    expect(noData?.visual.state).toBe('no-data');
    expect(noData?.visual.labelText).toBe('sem telemetria');

    const stale = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ simulation: { linkId: 'a-core-bng', mode: 'stale' } }),
    ).edges.find((edge) => edge.id === 'a-core-bng');
    expect(stale?.visual.state).toBe('stale');
    expect(stale?.visual.labelText).toContain('antigo');
  });

  it('simulação no grupo LAG aplica a todos os membros', () => {
    const model = buildLinkV2Model(
      SCENARIO_DENSE,
      options({ simulation: { linkId: 'lag:lag-centro', mode: 'no-data' } }),
    );
    const groupEdge = model.edges.find((edge) => edge.id === 'lag:lag-centro');
    expect(groupEdge?.visual.state).toBe('no-data');
    expect(groupEdge?.labelText).toContain('2 membros');
  });
});

describe('modelo do canvas V2 — rótulos', () => {
  it('esconde saudáveis abaixo de 50% e mantém DOWN/crítico/atenção', () => {
    const model = buildLinkV2Model(SCENARIO_SIMPLE, options());
    expect(model.placements.has('a-internet-edge')).toBe(false);
    expect(model.placements.has('a-edge-core')).toBe(false);
    expect(model.placements.has('a-core-bng')).toBe(true);
    expect(model.placements.has('a-agg-dist')).toBe(true);
    expect(model.placements.has('a-internet-ix')).toBe(true);
    expect(model.placements.has('a-pni-ix')).toBe(true);
    expect(model.placements.has('a-pni-edge')).toBe(true);
  });

  it('"mostrar todos" posiciona todos os rótulos do cenário denso', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options({ showAllLabels: true }));
    expect(model.placements.size).toBe(model.edges.length);
  });

  it('seleção força o rótulo mesmo em enlace saudável', () => {
    const model = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ selectedEdgeId: 'a-internet-edge' }),
    );
    expect(model.placements.has('a-internet-edge')).toBe(true);
    const selected = model.placements.get('a-internet-edge');
    expect(selected?.mode).not.toBe('hidden');
  });

  it('nó selecionado libera rótulos dos enlaces conectados', () => {
    const model = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ selectedNodeId: 'internet' }),
    );
    expect(model.placements.has('a-internet-edge')).toBe(true);
    expect(model.placements.has('a-internet-ix')).toBe(true);
    expect(model.placements.has('a-agg-olt')).toBe(false);
  });

  it('é determinístico entre duas construções', () => {
    const first = buildLinkV2Model(SCENARIO_DENSE, options());
    const second = buildLinkV2Model(SCENARIO_DENSE, options());
    expect([...second.placements.entries()]).toEqual([...first.placements.entries()]);
    expect(second.edges.map((edge) => edge.visual.state)).toEqual(
      first.edges.map((edge) => edge.visual.state),
    );
    expect(Number.isFinite(first.buildMs)).toBe(true);
  });
});

describe('contrato V1 reutilizado', () => {
  it('monta NetworkLink com direções, consistência e status', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const transit = model.edges.find((edge) => edge.id === 'd-transit-a');
    expect(transit).toBeDefined();
    const link = transit?.networkLink;
    expect(link?.status).toBe('UP');
    expect(link?.directions.A_TO_B.bps).toBeCloseTo(94_000_000_000, 0);
    expect(link?.directions.A_TO_B.utilization).toBeCloseTo(94, 5);
    // RX observado em 62% contra 94% enviados → divergente.
    expect(link?.directions.A_TO_B.consistency).toBe('DIVERGENT');
    expect(link?.directions.A_TO_B.deltaPercent).toBeCloseTo(34, 0);
    // B→A sem divergência declarada no mock.
    expect(link?.directions.B_TO_A.consistency).toBe('CONSISTENT');
    expect(link?.visualPaths[0]?.curvature).toBe(0);
    expect(link?.animationEnabled).toBe(false);

    const curved = model.edges.find((edge) => edge.id === 'd-pni1-core-a');
    expect(curved?.networkLink.visualPaths[0]?.curvature).toBe(26);
  });

  it('DOWN simulado também rebaixa o status do objeto V1', () => {
    const model = buildLinkV2Model(
      SCENARIO_SIMPLE,
      options({ simulation: { linkId: 'a-agg-dist', mode: 'down' } }),
    );
    const edge = model.edges.find((item) => item.id === 'a-agg-dist');
    expect(toNetworkLinkMock(SCENARIO_SIMPLE.links[8]!, edge!.visual).status).toBe('DOWN');
    expect(edge?.networkLink.status).toBe('DOWN');
  });
});

describe('histórico demonstrativo', () => {
  it('é determinístico e termina perto da utilização atual', () => {
    const first = mockLinkHistory('a-core-bng', 94, 48);
    const second = mockLinkHistory('a-core-bng', 94, 48);
    expect(second).toEqual(first);
    expect(first).toHaveLength(48);
    expect(Math.abs((first[first.length - 1] ?? 0) - 94)).toBeLessThan(20);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...first)).toBeLessThanOrEqual(120);
    expect(mockLinkHistory('outro-enlace', 94, 48)).not.toEqual(first);
  });
});

describe('cenários declarados', () => {
  it('mantém os ids de demonstração consistentes', () => {
    expect(SCENARIO_SIMPLE.demoLinkId).toBe('a-core-bng');
    expect(SCENARIO_DENSE.demoLagGroupId).toBe('lag-centro');
    expect(scenarioById('dense')).toBe(SCENARIO_DENSE);
    expect(scenarioById('simple')).toBe(SCENARIO_SIMPLE);
    expect(SCENARIO_DENSE.links.some((link) => link.id === SCENARIO_DENSE.demoLinkId)).toBe(true);
  });
});
