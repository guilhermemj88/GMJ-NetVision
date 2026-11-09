import { describe, expect, it } from 'vitest';
import {
  PhysicalBgpSimulator,
  REAL_BGP_CONFIG,
  REAL_EXTCOMMUNITY_FILTER,
  REAL_ROUTE_POLICY_CONFIG,
  SIM_CUSTOMER_PEER,
  SIM_ELIGIBLE,
  SIM_MITIGATION_PEER,
} from '../../../testing/physical-bgp-simulator';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import {
  captureBeforeEvidence,
  DEFAULT_PHYSICAL_TIMING,
  discoverMitigationPeer,
  isMitigationEvidenceCommand,
  parseExtcommunityFilters,
  parsePeerVerbose,
  parseRoutingTableEntry,
  verifyMitigationPhysical,
  type PhysicalBeforeEvidence,
} from './mitigation-physical-verification';
import { testMitigationContract } from './mitigation-test-support';
import { validateReadOnlyCommand } from '../../../worker/mitigation/read-only-command-guard';

const CONTRACT = {
  ...testMitigationContract(A.policy, A.targetPrefixList, 1100),
  prefixListEntries: [A.prefixDefinition],
};
const FAST = { maxAttempts: 4, intervalMs: 1_000, budgetMs: 28_000 };

function harness() {
  let mitigated = false;
  const sim = new PhysicalBgpSimulator(() => mitigated);
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sim,
    activate: () => {
      mitigated = true;
    },
    sleeps,
    verify: (before: PhysicalBeforeEvidence | null) =>
      verifyMitigationPhysical({
        read: (commands) => sim.read(commands),
        contract: CONTRACT,
        customerPeers: [SIM_CUSTOMER_PEER],
        before,
        timing: FAST,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        clock: () => clock,
      }),
    before: () => captureBeforeEvidence((commands) => sim.read(commands), [SIM_CUSTOMER_PEER]),
  };
}

describe('parsers sobre a captura REAL sanitizada do equipamento', () => {
  it('peer verbose: Established e 3 rotas recebidas', () => {
    const sim = new PhysicalBgpSimulator(() => false);
    return sim.read([`display bgp peer ${SIM_CUSTOMER_PEER} verbose`]).then(([read]) => {
      expect(parsePeerVerbose(read!.output)).toEqual({
        state: 'Established',
        receivedTotal: 3,
        upCount: 11,
      });
    });
  });

  it('routing-table: tres caminhos (direto LP 1100, CIRION 800, Seaborn 50) com RT 140 e 330', async () => {
    const sim = new PhysicalBgpSimulator(() => false);
    const [read] = await sim.read(['display bgp routing-table 167.250.126.0 24']);
    const paths = parseRoutingTableEntry(read!.output)!;
    expect(paths).toHaveLength(3);
    expect(paths.map((path) => [path.from, path.localPreference, path.best, path.select])).toEqual([
      ['10.200.201.2', 1100, true, true],
      ['200.194.223.85', 800, false, false],
      ['198.18.1.152', 50, false, false],
    ]);
    expect(paths[0]!.extCommunities).toEqual(['268568:140', '268568:330']);
  });

  it('extcommunity-filter: MITIGACAO permite a RT 268568:660', () => {
    const filters = parseExtcommunityFilters(REAL_EXTCOMMUNITY_FILTER);
    expect(filters.get('MITIGACAO')).toEqual([{ action: 'permit', rt: '268568:660' }]);
    expect(filters.get('140')).toEqual([{ action: 'permit', rt: '268568:140' }]);
  });
});

describe('descoberta do peer de mitigacao pela configuracao (nunca fixo)', () => {
  it('config real: unico peer = COMPUTIZE 198.19.4.145 via PL-COMPUTIZE-IPv4-OUT', () => {
    const discovery = discoverMitigationPeer({
      bgpConfiguration: REAL_BGP_CONFIG,
      routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
      extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER,
    });
    expect(discovery.peer).toBe(SIM_MITIGATION_PEER);
    expect(discovery.candidates).toEqual([SIM_MITIGATION_PEER]);
  });

  it('exports SEABORN/SEMPRE (deny node 5 pelo filtro) nao contam como peer de mitigacao', () => {
    const discovery = discoverMitigationPeer({
      bgpConfiguration: REAL_BGP_CONFIG,
      routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
      extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER,
    });
    expect(discovery.candidates).not.toContain('198.18.1.152');
    expect(discovery.candidates).not.toContain('198.18.36.26');
  });

  it('dois peers exportando por policy que permite a RT => ambiguo (peer null)', () => {
    const doubled = REAL_BGP_CONFIG.replace(
      /(\s+peer 198\.19\.4\.145 route-policy PL-COMPUTIZE-IPv4-OUT export)/,
      '$1\n  peer 198.19.4.146 route-policy PL-COMPUTIZE-IPv4-OUT export',
    );
    const discovery = discoverMitigationPeer({
      bgpConfiguration: doubled,
      routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
      extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER,
    });
    expect(discovery.peer).toBeNull();
    expect(discovery.candidates).toHaveLength(2);
    expect(discovery.detail).toMatch(/ambigua/);
  });

  it('leitura incompleta ou filtro sem a RT => nao descobre', () => {
    expect(
      discoverMitigationPeer({
        bgpConfiguration: REAL_BGP_CONFIG,
        routePolicyConfiguration: null,
        extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER,
      }).peer,
    ).toBeNull();
    expect(
      discoverMitigationPeer({
        bgpConfiguration: REAL_BGP_CONFIG,
        routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
        extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER.replace('268568:660', '268568:661'),
      }).peer,
    ).toBeNull();
  });
});

describe('verificacao fisica pos-escrita', () => {
  it('PASS: best/select pelo peer, LP 1100, RT 660 sem 140, anunciado a COMPUTIZE, peer Established com 3 rotas', async () => {
    const h = harness();
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('PASS');
    expect(result.mitigationPeer).toBe(SIM_MITIGATION_PEER);
    expect(result.eligiblePrefixes).toEqual(SIM_ELIGIBLE);
    expect(result.checks.every((check) => check.outcome === 'PASS')).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('propagacao tardia: observa nas tentativas seguintes (intervalo curto, dentro do limite)', async () => {
    const h = harness();
    h.sim.propagationDelayAttempts = 2;
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('PASS');
    expect(result.attempts).toBe(3);
    expect(h.sleeps).toEqual([1_000, 1_000]);
  });

  it('propagacao que nao ocorre dentro das tentativas => FAIL (nunca sucesso) e para no limite', async () => {
    const h = harness();
    h.sim.propagationDelayAttempts = 99;
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('FAIL');
    expect(result.attempts).toBe(FAST.maxAttempts);
    expect(result.elapsedMs).toBeLessThanOrEqual(30_000);
  });

  it.each([
    ['wrong-lp', /localpref 100 \(esperado 1100\)/],
    ['rt140', /RT 268568:140 ainda presente/],
    ['not-best', /nao e best\/select/],
    ['peer-down', /deixou de estar Established/],
    ['flap', /flap do peer 10\.200\.201\.2: BGP Peer Up count 11 antes x 12 depois/],
    ['count-changed', /rotas recebidas de 10\.200\.201\.2: 3 antes x 2 depois/],
  ] as const)('FAIL quando %s', async (mode, expected) => {
    const h = harness();
    h.sim.mode = mode;
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('FAIL');
    expect(result.summary).toMatch(expected);
  });

  it('prefixos fora da lista: inalterados passam; alterados ou com RT 660 falham', async () => {
    const ok = harness();
    ok.sim.outside = ['198.51.100.0/24'];
    const okBefore = await ok.before();
    ok.activate();
    expect((await ok.verify(okBefore)).outcome).toBe('PASS');

    for (const mode of ['outside-changed', 'outside-rt660'] as const) {
      const bad = harness();
      bad.sim.outside = ['198.51.100.0/24'];
      bad.sim.mode = mode;
      const badBefore = await bad.before();
      bad.activate();
      const result = await bad.verify(badBefore);
      expect(result.outcome, mode).toBe('FAIL');
    }
  });

  it.each(['unreadable', 'garbled-routing'] as const)(
    'INCONCLUSIVE com leitura %s (nunca sucesso)',
    async (mode) => {
      const h = harness();
      h.sim.mode = mode;
      const before = await h.before();
      h.activate();
      const result = await h.verify(before);
      expect(result.outcome).toBe('INCONCLUSIVE');
    },
  );

  it.each(['ambiguous-peer', 'no-mitigation-peer'] as const)(
    'INCONCLUSIVE quando a descoberta do peer de mitigacao e %s',
    async (mode) => {
      const h = harness();
      h.sim.mode = mode;
      const before = await h.before();
      h.activate();
      const result = await h.verify(before);
      expect(result.outcome).toBe('INCONCLUSIVE');
      expect(result.mitigationPeer).toBeNull();
    },
  );

  it('INCONCLUSIVE sem evidencia PRE-escrita ou sem prefixo elegivel recebido', async () => {
    const h = harness();
    h.activate();
    expect((await h.verify(null)).outcome).toBe('INCONCLUSIVE');
    const empty = harness();
    const before = await empty.before();
    before.peers[0]!.received = before.peers[0]!.received!.replace(/ \*>[^\n]*\n/g, '').replace(
      /Total Number of Routes: \d+/,
      'Total Number of Routes: 0',
    );
    empty.activate();
    const result = await empty.verify(before);
    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('o tempo total respeita o orcamento de ~30 s mesmo com intervalo grande', async () => {
    let clock = 0;
    const sim = new PhysicalBgpSimulator(() => true);
    sim.propagationDelayAttempts = 99;
    const before = await captureBeforeEvidence((c) => sim.read(c), [SIM_CUSTOMER_PEER]);
    const result = await verifyMitigationPhysical({
      read: (commands) => sim.read(commands),
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      timing: { maxAttempts: 50, intervalMs: 10_000, budgetMs: 28_000 },
      sleep: async (ms) => {
        clock += ms;
      },
      clock: () => clock,
    });
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBeLessThanOrEqual(28_000);
    expect(result.outcome).toBe('FAIL');
  });
});

describe('allowlist de leitura da verificacao fisica (somente estes display)', () => {
  it('aceita exatamente os displays de evidencia', () => {
    for (const command of [
      'display bgp peer 10.200.201.2 verbose',
      'display bgp routing-table peer 10.200.201.2 received-routes',
      'display bgp routing-table peer 198.19.4.145 advertised-routes',
      'display bgp routing-table 167.250.126.0 23',
      'display ip extcommunity-filter',
      'display current-configuration configuration bgp',
      'display current-configuration configuration route-policy',
    ]) {
      expect(isMitigationEvidenceCommand(command), command).toBe(true);
      expect(validateReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it('rejeita variantes, escrita e injecao', () => {
    for (const command of [
      'display bgp routing-table',
      'display bgp routing-table 167.250.126.0 33',
      'display bgp routing-table 999.1.1.1 24',
      'display bgp peer 10.200.201.2 verbose; system-view',
      'display bgp peer verbose',
      'display ip routing-table 10.0.0.1',
      'display current-configuration | include ip-prefix',
      'system-view',
      'commit',
      'undo route-policy X node 2',
      'display bgp routing-table peer 10.200.201.2 received',
    ]) {
      expect(isMitigationEvidenceCommand(command), command).toBe(false);
    }
  });
});

describe('M1: orcamento de 90 s, "ainda nao anunciado" e INCONCLUSIVE, nunca FAIL', () => {
  it('padrao: 90 s no total, tentativas a cada 5 s (maior que o MRAI de eBGP de 30 s)', () => {
    expect(DEFAULT_PHYSICAL_TIMING).toEqual({
      maxAttempts: 18,
      intervalMs: 5_000,
      budgetMs: 90_000,
    });
    expect(DEFAULT_PHYSICAL_TIMING.budgetMs).toBeGreaterThan(30_000);
  });

  it('not-advertised: continua tentando dentro do orcamento e, ao esgotar, e INCONCLUSIVE', async () => {
    const h = harness();
    h.sim.mode = 'not-advertised';
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.attempts).toBe(FAST.maxAttempts);
    expect(result.summary).toMatch(/ainda nao anunciados a 198\.19\.4\.145/);
    expect(result.checks.some((check) => check.outcome === 'FAIL')).toBe(false);
  });

  it('anuncio aparece tarde (apos varias tentativas) e passa', async () => {
    const h = harness();
    h.sim.propagationDelayAttempts = 3;
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('PASS');
    expect(result.attempts).toBe(4);
  });

  it('o orcamento e respeitado ANTES de cada leitura, inclusive quando a leitura demora', async () => {
    let clock = 0;
    const sim = new PhysicalBgpSimulator(() => true);
    sim.propagationDelayAttempts = 99;
    const before = await captureBeforeEvidence((c) => sim.read(c), [SIM_CUSTOMER_PEER]);
    let reads = 0;
    const result = await verifyMitigationPhysical({
      read: async (commands) => {
        if (commands.some((c) => c.startsWith('display bgp routing-table'))) {
          reads += 1;
          clock += 40_000; // cada leitura consome 40 s do relogio
        }
        return sim.read(commands);
      },
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      timing: { maxAttempts: 50, intervalMs: 5_000, budgetMs: 90_000 },
      sleep: async (ms) => {
        clock += ms;
      },
      clock: () => clock,
    });
    // t=0 leitura(40) +5 sleep=45 leitura(85) -> 85+5>=90: para. Nenhuma leitura apos o orcamento.
    expect(reads).toBe(2);
    expect(result.attempts).toBe(2);
    expect(clock).toBeLessThanOrEqual(90_000);
  });
});

describe('M2: flap do peer (Peer Up count)', () => {
  it('mesmo Established e mesma contagem, mas Up count maior => FAIL', async () => {
    const h = harness();
    h.sim.mode = 'flap';
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('FAIL');
    expect(result.checks.find((c) => c.id === 'peer:10.200.201.2')?.detail).toMatch(/flap/);
  });
});

describe('M3: causalidade do anuncio ao peer de mitigacao', () => {
  it('ja anunciado ANTES da escrita (sessao MITIGACAO paralela) => INCONCLUSIVE, nunca PASS', async () => {
    const h = harness();
    h.sim.mode = 'already-advertised';
    const before = await h.before();
    h.activate();
    const result = await h.verify(before);
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.checks.find((c) => c.id === 'advertised')?.detail).toMatch(
      /ja anunciado a 198\.19\.4\.145 ANTES da escrita/,
    );
    // O efeito no proprio peer esta provado (best/select, LP, 660): so a causalidade nao.
    expect(
      result.checks.filter((c) => c.id.startsWith('route:')).every((c) => c.outcome === 'PASS'),
    ).toBe(true);
  });

  it('sem o anuncio PRE (leitura indisponivel) => INCONCLUSIVE', async () => {
    const h = harness();
    const before = await h.before();
    before.advertisedBefore = null;
    h.activate();
    expect((await h.verify(before)).outcome).toBe('INCONCLUSIVE');
  });

  it('peer de mitigacao diferente entre pre e pos => INCONCLUSIVE', async () => {
    const h = harness();
    const before = await h.before();
    before.mitigationPeer = '198.19.4.99';
    h.activate();
    expect((await h.verify(before)).outcome).toBe('INCONCLUSIVE');
  });
});
