import { describe, expect, it } from 'vitest';
import type {
  VsiDiagnosticCheck,
  VsiDiagnosticResult,
  VsiDiagnosticStatus,
} from '@gmj/shared';
import {
  buildHealthCards,
  buildSections,
  combineTones,
  durationLabel,
  headlineStatus,
  isRunning,
  sectionSummary,
  toneOf,
} from './health-model';

const LOCAL = 'host-local';
const REMOTE = 'host-remote';

function check(
  category: VsiDiagnosticCheck['category'],
  label: string,
  status: VsiDiagnosticStatus,
  hostId = LOCAL,
): VsiDiagnosticCheck {
  return {
    id: `${category}-${label}-${hostId}`,
    category,
    label,
    status,
    hostId,
    message: `mensagem ${label}`,
    evidence: [],
    durationMs: 5,
    certainty: status === 'INSUFFICIENT_DATA' ? 'INCONCLUSIVE' : 'CONFIRMED',
    required: true,
  };
}

function result(patch: Partial<VsiDiagnosticResult> = {}): VsiDiagnosticResult {
  return {
    diagnosticId: 'diag-1',
    hostId: LOCAL,
    vsiId: 'vsi-1',
    vsiName: 'SERVICE-A',
    operator: { id: 'u1', username: 'operator', role: 'OPERATOR' },
    state: 'COMPLETED',
    stage: 'Concluído',
    startedAt: '2026-10-26T10:00:00.000Z',
    completedAt: '2026-10-26T10:00:12.000Z',
    underlayClassification: 'UNDERLAY_REACHABLE',
    overallStatus: 'OK',
    summary: 'Circuito confirmado.',
    local: {
      hostId: LOCAL,
      name: 'PE-LOCAL',
      vsiId: '1',
      vsiName: 'SERVICE-A',
      loopback: { address: '10.0.0.1', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] },
      association: 'LOCAL',
      observedVsi: {
        vsiId: 1,
        status: 'UP',
        peers: [{ address: '10.0.0.2', vcId: 100, state: 'UP', inboundLabel: 40943, outboundLabel: 40944, tunnel: null }],
      },
    },
    remotes: [
      {
        hostId: REMOTE,
        name: 'PE-REMOTE',
        vsiId: '2',
        vsiName: 'SERVICE-B',
        loopback: { address: '10.0.0.2', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] },
        association: 'EXACT_INVENTORY_IP',
      },
    ],
    checks: [
      check('UNDERLAY', 'LoopBack atual', 'OK'),
      check('VSI', 'VSI atual', 'OK'),
      check('VSI', 'VSI remota', 'OK', REMOTE),
      check('PW', 'PW 10.0.0.2', 'OK'),
      check('PW', 'Reciprocidade e labels', 'OK'),
      check('AC', 'AC GE0/0/1', 'OK'),
      check('AC', 'AC GE0/0/2', 'OK', REMOTE),
      check('LOOPBACK_REACHABILITY', 'Ping atual', 'OK'),
    ],
    evidence: [
      {
        id: 'ev-1',
        hostId: LOCAL,
        source: 'LIVE_SSH',
        observedAt: '2026-10-26T10:00:03.000Z',
        collectedAt: '2026-10-26T10:00:03.000Z',
        command: 'display vsi name SERVICE-A verbose',
        output: 'linha 1\nlinha 2',
      },
    ],
    probes: [
      {
        sourceHostId: LOCAL,
        destinationHostId: REMOTE,
        source: '10.0.0.1',
        destination: '10.0.0.2',
        routingContext: 'GLOBAL',
        lossPercent: 0,
        rttMs: { min: 1, avg: 2, max: 3 },
        hops: [],
        status: 'OK',
        transmitted: 3,
        received: 3,
      },
    ],
    warnings: ['AAA = NOT_VERIFIED; privilégios da conta não foram verificados pelo diagnóstico.'],
    nextTests: [],
    ...patch,
  };
}

describe('health-model — apresentacao sem alterar contrato', () => {
  it('mapeia status tecnico para tom visual', () => {
    expect(toneOf('OK')).toBe('ok');
    expect(toneOf('WARNING')).toBe('attention');
    expect(toneOf('FAILED')).toBe('error');
    expect(toneOf('INSUFFICIENT_DATA')).toBe('neutral');
    expect(toneOf(undefined)).toBe('neutral');
  });

  it('um erro domina, depois atencao, depois falta de evidencia', () => {
    expect(combineTones(['ok', 'error', 'attention'])).toBe('error');
    expect(combineTones(['ok', 'attention'])).toBe('attention');
    expect(combineTones(['ok', 'neutral'])).toBe('neutral');
    expect(combineTones(['ok', 'ok'])).toBe('ok');
    expect(combineTones([])).toBe('neutral');
  });

  it('RUNNING vem do estado do job, nunca do veredito', () => {
    expect(headlineStatus(result({ state: 'RUNNING' }))).toBe('RUNNING');
    expect(headlineStatus(result({ state: 'QUEUED' }))).toBe('RUNNING');
    expect(headlineStatus(result())).toBe('OK');
    expect(isRunning(result({ state: 'COMPLETED' }))).toBe(false);
  });

  it('produz os 9 cards de saude esperados', () => {
    const cards = buildHealthCards(result());
    expect(cards.map((card) => card.id)).toEqual([
      'loopback-local',
      'loopback-remote',
      'vsi-local',
      'vsi-remote',
      'pw',
      'ac-local',
      'ac-remote',
      'reachability',
      'labels',
    ]);
    expect(cards.every((card) => card.tone === 'ok')).toBe(true);
    expect(cards.find((c) => c.id === 'reachability')?.detail).toBe('Alcançável · 3/3 respostas');
  });

  it('propaga falhas para o card correspondente', () => {
    const cards = buildHealthCards(
      result({
        overallStatus: 'FAILED',
        checks: [check('PW', 'PW 10.0.0.2', 'FAILED'), check('AC', 'AC GE0/0/1', 'WARNING')],
      }),
    );
    expect(cards.find((c) => c.id === 'pw')?.tone).toBe('error');
    expect(cards.find((c) => c.id === 'ac-local')?.tone).toBe('attention');
    expect(cards.find((c) => c.id === 'ac-remote')?.tone).toBe('neutral');
  });

  it('sem PE remoto os cards remotos ficam neutros, nao como erro', () => {
    const cards = buildHealthCards(result({ remotes: [], probes: [] }));
    expect(cards.find((c) => c.id === 'vsi-remote')?.tone).toBe('neutral');
    expect(cards.find((c) => c.id === 'loopback-remote')?.detail).toBe('sem PE remoto');
    expect(cards.find((c) => c.id === 'reachability')?.detail).toBe('não executado');
  });

  it('agrupa checks em secoes e resume', () => {
    const sections = buildSections(result());
    expect(sections.map((section) => section.id)).toEqual([
      'underlay',
      'vsi',
      'pw',
      'ac',
      'reachability',
    ]);
    expect(sections.find((s) => s.id === 'ac')?.count).toBe(2);
    expect(sectionSummary(sections.find((s) => s.id === 'ac')!)).toBe('2 verificações · 2 ok');
  });

  it('mostra duracao e estado de conclusao', () => {
    expect(durationLabel(result())).toBe('12 s');
    expect(durationLabel(result({ completedAt: null, state: 'RUNNING' }))).toBe('em andamento');
    expect(durationLabel(result({ completedAt: null, state: 'CANCELLED' }))).toBe('não concluído');
  });
});

describe('execution context, reachability por sentido e evidencia (integracao 318d169)', () => {
  it('buildExecutionContext usa somente o executionContext do backend', async () => {
    const { buildExecutionContext } = await import('./health-model');
    const { vsi1809Result, access, VSI_1809_IDS } = await import('./vsi-1809.fixture');
    expect(buildExecutionContext(vsi1809Result)).toMatchObject({
      summary: 'admin (ADMIN) · comandos autorizados nos 2 PEs',
      netvision: 'admin (ADMIN)',
      deviceAccess: 'Conta de serviço guilherme3.',
      commandAuthorization:
        'Confirmada para os comandos executados nesta execução nos dois PEs. Vale somente para os comandos executados nesta execução.',
      privilegeLevel: 'Não verificado explicitamente. Isso não afeta o resultado desta execução.',
      endpoints: [
        {
          role: 'PE local',
          name: 'IIE-VSR-6730-MPLS-01',
          sshUsername: 'guilherme3',
          authorization: 'Confirmada para os comandos executados nesta execução',
          commands: '7 comandos enviados · 7 com evidência válida',
        },
        {
          role: 'PE remoto',
          name: 'RNS-FLOR-6730-MPLS-01',
          sshUsername: 'guilherme3',
          authorization: 'Confirmada para os comandos executados nesta execução',
          commands: '7 comandos enviados · 7 com evidência válida',
        },
      ],
    });
    const partial = buildExecutionContext({
      ...vsi1809Result,
      executionContext: {
        endpoints: [
          access(VSI_1809_IDS.LOCAL, 'IIE', { sshUsername: 'svc-a' }),
          access(VSI_1809_IDS.REMOTE, 'RNS', {
            sshUsername: 'svc-b',
            commandAuthorization: 'NOT_CONFIRMED',
            acceptedCommands: 4,
            executedCommands: 5,
          }),
        ],
      },
    });
    expect(partial.deviceAccess).toBe('IIE: svc-a · RNS: svc-b');
    expect(partial.commandAuthorization).toContain(
      'IIE: confirmada para os 7 comandos executados (7/7).',
    );
    expect(partial.commandAuthorization).toContain(
      'RNS: não confirmada (4/5 comandos com evidência válida).',
    );
    expect(partial.privilegeLevel).toBe('Não verificado explicitamente.');
  });

  it('reachability nunca soma os dois sentidos num total unico', async () => {
    const { vsi1809Result } = await import('./vsi-1809.fixture');
    const card = (r: VsiDiagnosticResult) =>
      buildHealthCards(r).find((c) => c.id === 'reachability')!;
    expect(card(vsi1809Result).detail).toBe('Alcançável · 3/3 respostas em cada sentido');
    const [a, b] = vsi1809Result.probes;
    expect(
      card({
        ...vsi1809Result,
        probes: [a!, { ...b!, received: 0, lossPercent: 100, status: 'FAILED' }],
      }).detail,
    ).toBe('Alcançável · 3/3 respostas · 0/3 respostas');
  });

  it('endpointLabels mostra os labels in/out do proprio PE', async () => {
    const { endpointLabels } = await import('./health-model');
    const { vsi1809Result } = await import('./vsi-1809.fixture');
    expect(endpointLabels(vsi1809Result.local)).toBe('38464 / 37134');
    expect(endpointLabels(vsi1809Result.remotes[0]!)).toBe('37134 / 38464');
    expect(endpointLabels(null)).toBe('—');
  });

  it('evidenceJson so serializa os campos do contrato', async () => {
    const { evidenceJson } = await import('./health-model');
    const { vsi1809Result } = await import('./vsi-1809.fixture');
    const json = evidenceJson({
      ...vsi1809Result.evidence[0]!,
      password: 'x',
      token: 'y',
    } as unknown as (typeof vsi1809Result.evidence)[0]);
    expect(Object.keys(JSON.parse(json))).toEqual([
      'id',
      'diagnosticId',
      'hostId',
      'source',
      'observedAt',
      'collectedAt',
      'command',
      'durationMs',
      'complete',
      'output',
    ]);
  });
});

function withoutUnderlay(r: VsiDiagnosticResult): VsiDiagnosticResult {
  const copy = { ...r };
  delete copy.underlayClassification;
  return copy;
}

describe('polish 02: rotulos transitorios, contagem por PE e wording ao operador', () => {
  it('resumo do contexto nunca usa contagem global de comandos', async () => {
    const { buildExecutionContext } = await import('./health-model');
    const { vsi1809Result, access, VSI_1809_IDS } = await import('./vsi-1809.fixture');
    const summaries = [
      buildExecutionContext(vsi1809Result).summary,
      buildExecutionContext({
        ...vsi1809Result,
        executionContext: {
          endpoints: [
            access(VSI_1809_IDS.LOCAL, 'IIE'),
            access(VSI_1809_IDS.REMOTE, 'RNS', {
              commandAuthorization: 'NOT_CONFIRMED',
              acceptedCommands: 4,
              executedCommands: 5,
            }),
          ],
        },
      }).summary,
      buildExecutionContext({
        ...vsi1809Result,
        executionContext: {
          endpoints: [
            access(VSI_1809_IDS.LOCAL, 'IIE', {
              sshUsername: null,
              commandAuthorization: 'NOT_EXECUTED',
              acceptedCommands: 0,
              executedCommands: 0,
            }),
          ],
        },
      }).summary,
    ];
    expect(summaries).toEqual([
      'admin (ADMIN) · comandos autorizados nos 2 PEs',
      'admin (ADMIN) · autorização não confirmada em todos os PEs',
      'admin (ADMIN) · nenhum comando executado',
    ]);
    for (const summary of summaries) expect(summary).not.toMatch(/\d+ comandos?\b/);
  });

  it('RUNNING usa rotulos transitorios para PE remoto e underlay', async () => {
    const { remotePeerLabel, underlayLabel } = await import('./health-model');
    const { vsi1809Result } = await import('./vsi-1809.fixture');
    const running = withoutUnderlay({ ...vsi1809Result, state: 'RUNNING', remotes: [] });
    expect(remotePeerLabel(running)).toBe('PE remoto aguardando identificação');
    expect(underlayLabel(running)).toBe('em análise');
    expect(underlayLabel({ ...running, underlayClassification: 'UNDERLAY_REACHABLE' })).toBe(
      'em análise',
    );
    const finished: VsiDiagnosticResult = { ...running, state: 'COMPLETED' };
    expect(remotePeerLabel(finished)).toBe('PE remoto não identificado');
    expect(underlayLabel(finished)).toBe('não classificado');
    expect(remotePeerLabel(vsi1809Result)).toBe('RNS-FLOR-6730-MPLS-01');
    expect(underlayLabel(vsi1809Result)).toBe('UNDERLAY_REACHABLE');
  });

  it('card Labels match usa resumo curto, sem a frase truncada do backend', async () => {
    const { vsi1809Result } = await import('./vsi-1809.fixture');
    const labels = (r: VsiDiagnosticResult) => buildHealthCards(r).find((c) => c.id === 'labels')!;
    expect(labels(vsi1809Result).detail).toBe('Peers recíprocos · labels MATCH');
    expect(labels(vsi1809Result).detail).not.toContain('na execução atual');
    const unproven = vsi1809Result.checks.map((c) =>
      c.id === 'recip' ? { ...c, status: 'INSUFFICIENT_DATA' as const } : c,
    );
    expect(labels({ ...vsi1809Result, checks: unproven }).detail).toBe(
      'Peers/labels não comprovados',
    );
  });

  it('traceroute amigavel e pendencia de desenvolvimento fora das recomendacoes', async () => {
    const { limitationText, operationalNextTests } = await import('./health-model');
    expect(limitationText('Traceroute real desabilitado: NOT_HOMOLOGATED.')).toBe(
      'Traceroute: ainda não homologado para execução ativa.',
    );
    expect(
      limitationText('F1A, cliente final, porta física, CRC, LLDP e LSP detalhado não avaliados.'),
    ).toBe('F1A, cliente final, porta física, CRC, LLDP e LSP detalhado não avaliados.');
    const operational =
      'Verificar o circuito de acesso e a ponta do cliente na interface indicada, sem alterar a configuração.';
    expect(
      operationalNextTests([
        'Homologar o fluxo nativo completo pela API/WEB em release isolada, mediante nova autorização para testes ativos.',
        operational,
      ]),
    ).toEqual([operational]);
  });
});
