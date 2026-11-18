import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VsiDiagnosticResult } from './vsi-diagnostic';
import { VSI_CLAUSE_CODES, composeVsiServiceDiagnosis, type VsiServiceComposeInput } from './vsi-service-compose';
import { VSI_EVIDENCE_AGE_LIMITS, VSI_FINDING_CLASS, vsiFindingKind, vsiFreshness } from './vsi-service-diagnosis';
import { adaptLegacyVsiDiagnostic } from './vsi-service-legacy';

const NOW = '2026-11-16T14:00:00.000Z';
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('idade da evidencia SSH', () => {
  it('ate 15 min e ATUAL; acima disso ate 24 h e ENVELHECIDA; acima de 24 h e ANTIGA', () => {
    expect(vsiFreshness(NOW, NOW)).toBe('CURRENT');
    expect(vsiFreshness(ago(15 * MIN), NOW)).toBe('CURRENT');
    expect(vsiFreshness(ago(15 * MIN + 1), NOW)).toBe('AGED');
    expect(vsiFreshness(ago(24 * HOUR), NOW)).toBe('AGED');
    expect(vsiFreshness(ago(24 * HOUR + 1), NOW)).toBe('STALE');
    expect(VSI_EVIDENCE_AGE_LIMITS).toEqual({ currentMs: 15 * MIN, agedMs: 24 * HOUR });
  });

  it('os limites sao configuraveis', () => {
    const limits = { currentMs: 5 * MIN, agedMs: HOUR };
    expect(vsiFreshness(ago(10 * MIN), NOW, limits)).toBe('AGED');
    expect(vsiFreshness(ago(2 * HOUR), NOW, limits)).toBe('STALE');
  });

  it('captura sem horario usa o inicio do dia: nunca parece mais nova do que se pode provar', () => {
    expect(vsiFreshness('2026-11-16T13:59:00.000Z', NOW, VSI_EVIDENCE_AGE_LIMITS, 'DAY')).toBe('AGED');
    expect(vsiFreshness('2026-11-14T23:00:00.000Z', NOW, VSI_EVIDENCE_AGE_LIMITS, 'DAY')).toBe('STALE');
  });

  it('sem instante nao ha idade', () => {
    expect(vsiFreshness(null, NOW)).toBeNull();
  });
});

describe('categoria do achado', () => {
  it('todo codigo emitido pelo motor VSI/MCP tem categoria', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/api/src/infrastructure/mpls/vsi-mcp/correlator.ts', import.meta.url)),
      'utf8',
    );
    const codes = [...new Set([...source.matchAll(/code: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]!))];
    expect(codes.length).toBeGreaterThan(40);
    expect(codes.filter((code) => !(code in VSI_FINDING_CLASS))).toEqual([]);
  });

  it('codigo sem categoria e erro, nao um padrao silencioso', () => {
    expect(() => vsiFindingKind('CODIGO_QUE_NAO_EXISTE', 'INFO')).toThrow(/sem categoria/);
  });

  it('achado operacional segue a severidade do motor: a tela nunca rebaixa uma falha', () => {
    expect(vsiFindingKind('VSI_DOWN', 'CRITICAL')).toBe('FAILURE');
    expect(vsiFindingKind('REDUNDANCY_PEER_MEMBER_DOWN', 'CRITICAL')).toBe('FAILURE');
    expect(vsiFindingKind('MTU_MISMATCH', 'WARNING')).toBe('RISK');
  });

  it('standby, obsoleto e coleta nao viram falha', () => {
    expect(vsiFindingKind('VSI_DOWN_STANDBY_EXPECTED', 'INFO')).toBe('STANDBY_EXPECTED');
    expect(vsiFindingKind('PERSISTED_PW_STALE', 'INFO')).toBe('STALE_DATA');
    expect(vsiFindingKind('COLLECTION_OUTPUT_INCOMPLETE', 'INFO')).toBe('COLLECTION');
    expect(vsiFindingKind('VLAN_OUTPUT_INCOMPLETE', 'INFO')).toBe('COLLECTION');
  });
});

const emptyInput = (): VsiServiceComposeInput => ({
  engine: 'VSI_MCP',
  engineVersion: 'test',
  runId: 'run-1',
  origin: 'ENGINE_RUN',
  vsiName: 'VSI-TESTE',
  operator: null,
  startedAt: NOW,
  completedAt: NOW,
  endpoints: [],
  links: [],
  findings: [],
  nextSteps: [],
  readings: [],
  evidence: [],
});

describe('composicao', () => {
  it('referencia a evidencia inexistente e erro', () => {
    const input = emptyInput();
    input.findings.push({
      id: 'f1',
      code: 'VSI_DOWN',
      severity: 'CRITICAL',
      certainty: 'CONFIRMED',
      impactCertainty: 'CONFIRMED',
      origin: 'ENGINE',
      hostId: null,
      hostName: null,
      component: 'VSI',
      title: 't',
      explanation: 'e',
      caveat: null,
      evidenceIds: ['nao-existe'],
      nextStepIds: [],
    });
    expect(() => composeVsiServiceDiagnosis(input)).toThrow(/Referencia inexistente/);
  });

  it('sem nenhuma leitura o veredito e INCONCLUSIVO, nunca OK', () => {
    const d = composeVsiServiceDiagnosis(emptyInput());
    expect(d.verdict.status).toBe('INCONCLUSIVE');
    expect(d.axes.evidence.state).toBe('NOT_READ');
    for (const c of [...d.verdict.clauses, ...Object.values(d.axes).map((a) => a.clause)])
      expect(VSI_CLAUSE_CODES).toContain(c.code);
  });
});

const LEGACY: VsiDiagnosticResult = {
  diagnosticId: 'diag-1',
  hostId: 'h-a',
  vsiId: 'v1',
  vsiName: 'VSI-LEGADO',
  operator: { id: 'u1', username: 'admin', role: 'ADMIN' },
  state: 'COMPLETED',
  stage: 'DONE',
  startedAt: '2026-11-16T13:59:00.000Z',
  completedAt: NOW,
  overallStatus: 'FAILED',
  summary: 'PW down em PE-A.',
  local: { hostId: 'h-a', name: 'PE-A', vsiId: 'v1', vsiName: 'VSI-LEGADO', loopback: { address: '10.0.0.1', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] }, association: 'LOCAL',
    observedVsi: { vsiId: 1, status: 'UP', peers: [{ address: '10.0.0.2', vcId: 1, state: 'DOWN', inboundLabel: 100, outboundLabel: 200, tunnel: null }, { address: '10.0.0.3', vcId: 1, state: 'UP', inboundLabel: 101, outboundLabel: 201, tunnel: null }] } },
  remotes: [
    { hostId: 'h-b', name: 'PE-B', vsiId: null, vsiName: null, loopback: { address: '10.0.0.2', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] }, association: 'EXACT_INVENTORY_IP' },
    { hostId: 'h-c', name: 'PE-C', vsiId: null, vsiName: null, loopback: { address: '10.0.0.3', interfaceName: 'LoopBack0', routingContext: 'GLOBAL', evidence: [] }, association: 'EXACT_INVENTORY_IP' },
  ],
  checks: [
    { id: 'c-vsi', category: 'VSI', label: 'VSI up', status: 'OK', hostId: 'h-a', message: 'VSI up.', evidence: ['ev-1'], durationMs: 1, certainty: 'CONFIRMED', required: true },
    { id: 'c-pw', category: 'PW', label: 'PW para 10.0.0.2', status: 'FAILED', hostId: 'h-a', message: 'PW down.', evidence: ['ev-1', 'ev-sumiu'], durationMs: 1, certainty: 'CONFIRMED', required: true },
    { id: 'c-ac', category: 'AC', label: 'AC', status: 'INSUFFICIENT_DATA', hostId: 'h-a', message: 'AC não lido.', evidence: [], durationMs: 0, certainty: 'INCONCLUSIVE', required: false },
  ],
  evidence: [{ id: 'ev-1', hostId: 'h-a', source: 'LIVE_SSH', observedAt: null, collectedAt: '2026-11-16T13:59:30.000Z', command: 'display vsi name VSI-LEGADO verbose', output: 'VSI State : up' }],
  underlayClassification: 'DEGRADED_REACHABILITY',
  probes: [
    { sourceHostId: 'h-a', destinationHostId: 'h-b', source: '10.0.0.1', destination: '10.0.0.2', routingContext: 'GLOBAL', lossPercent: 20, rttMs: { min: 1, avg: 3, max: 9 }, hops: [{ ttl: 1, address: '10.9.9.1', timesMs: [1, 2, 2] }], status: 'WARNING', transmitted: 5, received: 4 },
    { sourceHostId: 'h-b', destinationHostId: 'h-a', source: '10.0.0.2', destination: '10.0.0.1', routingContext: 'GLOBAL', lossPercent: null, rttMs: null, hops: [], status: 'INSUFFICIENT_DATA', tracerouteNotExecutedReason: 'NOT_HOMOLOGATED' },
  ],
  warnings: ['Tracert não homologado.'],
  nextTests: ['Verificar o PW no PE-B.'],
};

describe('adaptador do legado', () => {
  const d = adaptLegacyVsiDiagnostic(LEGACY);

  it('identifica o motor e preserva execucao, operador e veredito do proprio legado', () => {
    expect(d.engine).toBe('LEGACY');
    expect(d.runId).toBe('diag-1');
    expect(d.origin).toBe('LEGACY_JOB');
    expect(d.verdict.status).toBe('FAILED');
    expect(d.verdict.clauses[0]).toEqual({ code: 'LEGACY_SUMMARY', params: { text: 'PW down em PE-A.' } });
    for (const c of [...d.verdict.clauses, ...Object.values(d.axes).map((a) => a.clause)])
      expect(VSI_CLAUSE_CODES).toContain(c.code);
  });

  it('nao inventa redundancia, AC nem MAC: ficam nao avaliados', () => {
    expect(d.axes.redundancy.state).toBe('NOT_APPLICABLE');
    expect(d.axes.mac.state).toBe('NOT_APPLICABLE');
    for (const e of d.endpoints) {
      expect(e.accessRole).toBeNull();
      expect(e.acs).toEqual([]);
      expect(e.eTrunks).toEqual([]);
      expect(e.mac.basis).toBe('NOT_READ');
    }
  });

  it('todas as pontas remotas viram participantes, lidas ou nao', () => {
    expect(d.endpoints.map((e) => e.hostName)).toEqual(['PE-A', 'PE-B', 'PE-C']);
    expect(d.endpoints[1]!.collection).toBe('NOT_READ');
    expect(d.endpoints[1]!.vsi.value).toBeNull();
  });

  it('check FAILED vira FALHA critica; dado insuficiente vira INCONCLUSIVO; limitacao nao vira falha', () => {
    const byId = Object.fromEntries(d.findings.map((f) => [f.id, f]));
    expect(byId['c-pw']).toMatchObject({ kind: 'FAILURE', severity: 'CRITICAL', evidenceIds: ['ev-1'] });
    expect(byId['c-ac']!.kind).toBe('INCONCLUSIVE');
    expect(byId['c-vsi']!.kind).toBe('INFO');
    expect(byId['legacy-limitation-0']!.kind).toBe('INFO');
    expect(d.axes.service.state).toBe('ISSUE');
  });

  it('leitura SSH do legado e desta execucao e a saida bruta vem inteira', () => {
    expect(d.readings).toEqual([expect.objectContaining({ kind: 'SSH_SESSION', inThisRun: true, hostName: 'PE-A' })]);
    expect(d.evidence[0]!.output).toBe('VSI State : up');
    expect(d.endpoints[0]!.vsi).toMatchObject({ basis: 'LIVE_SSH', evidenceId: 'ev-1', freshness: 'CURRENT' });
  });

  it('ping, perda, RTT, saltos e motivo do traceroute nao executado sao preservados sem reinterpretacao', () => {
    expect(d.connectivity.evaluated).toBe(true);
    expect(d.connectivity.underlayClassification).toBe('DEGRADED_REACHABILITY');
    expect(d.connectivity.probes).toEqual([
      { sourceHostId: 'h-a', sourceHostName: 'PE-A', destinationHostId: 'h-b', destinationHostName: 'PE-B', source: '10.0.0.1', destination: '10.0.0.2', routingContext: 'GLOBAL', status: 'WARNING', transmitted: 5, received: 4, lossPercent: 20, rttMs: { min: 1, avg: 3, max: 9 }, hops: [{ ttl: 1, address: '10.9.9.1', timesMs: [1, 2, 2] }], tracerouteNotExecutedReason: null },
      { sourceHostId: 'h-b', sourceHostName: 'PE-B', destinationHostId: 'h-a', destinationHostName: 'PE-A', source: '10.0.0.2', destination: '10.0.0.1', routingContext: 'GLOBAL', status: 'INSUFFICIENT_DATA', transmitted: null, received: null, lossPercent: null, rttMs: null, hops: [], tracerouteNotExecutedReason: 'NOT_HOMOLOGATED' },
    ]);
  });

  it('aprovacao do legado nao e "componente confirmado": AC fica como verificacao em texto', () => {
    const ok = adaptLegacyVsiDiagnostic({
      ...LEGACY,
      overallStatus: 'OK',
      checks: LEGACY.checks.map((c) => ({ ...c, status: 'OK' as const })),
      remotes: [],
    });
    expect(ok.endpoints[0]!.serviceState).toBe('ENGINE_APPROVED');
    expect(ok.axes.service).toEqual({ state: 'ENGINE_APPROVED', clause: { code: 'SERVICE_LEGACY_CHECKS', params: { ok: 3, total: 3, read: 1, endpoints: 1 } } });
    expect(ok.endpoints[0]!.acs).toEqual([]);
    expect(ok.endpoints[0]!.engineChecks!.find((c) => c.layer === 'ac')).toMatchObject({ label: 'AC', status: 'OK', message: 'AC não lido.' });
    // um PE sem verificacao aprovada impede o eixo de ficar aprovado
    expect(d.axes.service.state).toBe('ISSUE');
    const partial = adaptLegacyVsiDiagnostic({ ...LEGACY, overallStatus: 'OK', checks: [LEGACY.checks[0]!] });
    expect(partial.axes.service.state).toBe('NOT_CONFIRMED');
  });

  it('execucao nao concluida nao recebe veredito do resumo', () => {
    const running = adaptLegacyVsiDiagnostic({ ...LEGACY, state: 'TIMED_OUT' });
    expect(running.verdict).toEqual({ status: 'INCONCLUSIVE', clauses: [{ code: 'LEGACY_RUN_NOT_COMPLETED', params: { state: 'TIMED_OUT' } }] });
  });
});
