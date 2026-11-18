import type {
  VsiDiagnosticCategory,
  VsiDiagnosticCheck,
  VsiDiagnosticEndpoint,
  VsiDiagnosticEvidence,
  VsiDiagnosticResult,
} from './vsi-diagnostic';
import { assertReferences, deriveVsiAxes } from './vsi-service-compose';
import {
  VSI_EVIDENCE_AGE_LIMITS,
  vsiFindingKind,
  vsiFreshness,
  type VsiAxes,
  type VsiConnectivity,
  type VsiEndpointView,
  type VsiEngineCheck,
  type VsiEvidenceAgeLimits,
  type VsiEvidenceRef,
  type VsiFindingComponent,
  type VsiFindingView,
  type VsiNextStep,
  type VsiObserved,
  type VsiPwLinkView,
  type VsiReading,
  type VsiServiceDiagnosis,
  type VsiVerdictStatus,
} from './vsi-service-diagnosis';

/**
 * Adaptador do diagnostico LEGADO para o contrato por servico. Nao inventa nada:
 *  - o veredito e o `overallStatus`/`summary` do proprio motor legado;
 *  - so vira "estado lido" o que o legado devolve estruturado (`observedVsi`: VSI e PWs);
 *  - o que o legado so devolve como verificacao em texto (AC, Eth-Trunk, interface) segue como
 *    VERIFICACAO DO MOTOR (`engineChecks`), nunca como componente individualmente confirmado;
 *  - redundancia e MAC, que o legado nao avalia, ficam NAO AVALIADO;
 *  - ping/traceroute/RTT/perda sao preservados em `connectivity`, sem reinterpretacao;
 *  - todas as pontas remotas viram participantes (a tela antiga mostrava so a primeira).
 */

const COMPONENT: Record<VsiDiagnosticCategory, VsiFindingComponent> = {
  VSI: 'VSI',
  PW: 'PW',
  AC: 'AC',
  ETH_TRUNK: 'ETH_TRUNK',
  INTERFACE: 'INTERFACE',
  ERRORS: 'INTERFACE',
  UNDERLAY: 'UNDERLAY',
  LOOPBACK_REACHABILITY: 'UNDERLAY',
  ROUTE: 'UNDERLAY',
  L3: 'UNDERLAY',
};
const LAYER: Record<VsiDiagnosticCategory, VsiEngineCheck['layer']> = {
  VSI: 'vsi',
  PW: 'pw',
  AC: 'ac',
  ETH_TRUNK: 'lag',
  INTERFACE: 'interface',
  ERRORS: 'interface',
  UNDERLAY: 'underlay',
  LOOPBACK_REACHABILITY: 'underlay',
  ROUTE: 'underlay',
  L3: 'underlay',
};
const SERVICE_CATEGORIES: VsiDiagnosticCategory[] = ['VSI', 'PW', 'AC'];

const VERDICT: Record<VsiDiagnosticResult['overallStatus'], VsiVerdictStatus> = {
  OK: 'OK',
  WARNING: 'WARNING',
  FAILED: 'FAILED',
  INSUFFICIENT_DATA: 'INCONCLUSIVE',
};

const notRead = <T>(): VsiObserved<T> => ({
  value: null,
  basis: 'NOT_READ',
  readingId: null,
  evidenceId: null,
  observedAt: null,
  freshness: null,
});

export function adaptLegacyVsiDiagnostic(
  result: VsiDiagnosticResult,
  limits: VsiEvidenceAgeLimits = VSI_EVIDENCE_AGE_LIMITS,
): VsiServiceDiagnosis {
  const completedAt = result.completedAt ?? result.startedAt;
  const legacyEndpoints: VsiDiagnosticEndpoint[] = [result.local, ...result.remotes];
  const nameOf = (hostId: string): string => legacyEndpoints.find((e) => e.hostId === hostId)?.name ?? hostId;

  // leituras: uma sessao SSH e/ou um ciclo de inventario por host, conforme a origem das evidencias
  const readings: VsiReading[] = [];
  const readingId = (ev: VsiDiagnosticEvidence): string => {
    const live = ev.source === 'LIVE_SSH';
    const id = `${live ? 'ssh' : 'inv'}-${ev.hostId}`;
    if (!readings.some((r) => r.id === id))
      readings.push({
        id,
        kind: live ? 'SSH_SESSION' : 'SNMP_CYCLE',
        hostId: ev.hostId,
        hostName: nameOf(ev.hostId),
        startedAt: live ? ev.collectedAt : (ev.observedAt ?? ev.collectedAt),
        inThisRun: live,
        outcome: 'OK',
        scope: live ? 'comandos somente leitura desta execução' : 'inventário e métricas já gravados',
      });
    return id;
  };
  const evidence: VsiEvidenceRef[] = result.evidence.map((ev) => ({
    id: ev.id,
    readingId: readingId(ev),
    hostId: ev.hostId,
    hostName: nameOf(ev.hostId),
    source: ev.source,
    command: ev.command,
    collectedAt: ev.collectedAt,
    observedAt: ev.observedAt,
    complete: ev.complete ?? true,
    bytes: ev.output.length,
    sha256: ev.sha256 ?? null,
    output: ev.output,
    note: ev.errorCode ? `Código de erro da coleta: ${ev.errorCode}` : null,
  }));
  for (const r of readings)
    if (evidence.some((e) => e.readingId === r.id && !e.complete)) r.outcome = 'PARTIAL';
  const evidenceIds = new Set(evidence.map((e) => e.id));
  const known = (ids: string[]): string[] => ids.filter((id) => evidenceIds.has(id));

  const liveEvidenceFor = (hostId: string, category: VsiDiagnosticCategory): VsiEvidenceRef | null => {
    const ids = result.checks.filter((c) => c.hostId === hostId && c.category === category).flatMap((c) => c.evidence);
    return evidence.find((e) => ids.includes(e.id) && e.source === 'LIVE_SSH') ?? null;
  };

  const endpoints: VsiEndpointView[] = legacyEndpoints.map((ep, index) => {
    const live = evidence.some((e) => e.hostId === ep.hostId && e.source === 'LIVE_SSH');
    // `observedVsi` e sempre fruto do `display vsi` DESTA execucao (vsi-diagnostic-service): e leitura direta.
    const vsiEv =
      evidence.find((e) => e.hostId === ep.hostId && e.source === 'LIVE_SSH' && (e.command ?? '').startsWith('display vsi name')) ??
      liveEvidenceFor(ep.hostId, 'VSI');
    const pwEv = liveEvidenceFor(ep.hostId, 'PW') ?? vsiEv;
    const observed = <T>(value: T | null, ev: VsiEvidenceRef | null): VsiObserved<T> =>
      value === null
        ? notRead<T>()
        : {
            value,
            basis: 'LIVE_SSH',
            readingId: ev?.readingId ?? null,
            evidenceId: ev?.id ?? null,
            observedAt: ev?.collectedAt ?? completedAt,
            freshness: vsiFreshness(ev?.collectedAt ?? completedAt, completedAt, limits),
          };
    const facts = ep.observedVsi;
    const vsi = observed(
      facts?.status ? { state: facts.status, signaling: null, encapsulation: null, mtu: null, rd: null } : null,
      vsiEv,
    );
    const pws = (facts?.peers ?? []).map((p) => ({
      peerAddress: p.address,
      peerHostId: legacyEndpoints.find((o) => o.loopback?.address === p.address)?.hostId ?? null,
      state: observed(p.state, pwEv),
      localLabel: p.inboundLabel,
      remoteLabel: p.outboundLabel,
      tunnel: p.tunnel,
      stale: false,
      detail: p.vcId === null ? null : `VC-ID ${p.vcId}`,
    }));
    const hostChecks = result.checks.filter((c) => c.hostId === ep.hostId);
    const serviceChecks = hostChecks.filter((c) => SERVICE_CATEGORIES.includes(c.category));
    // O legado nao devolve AC estruturado: aprovacao das verificacoes NAO e "cada componente lido".
    const serviceState: VsiEndpointView['serviceState'] = serviceChecks.some((c) => c.status === 'FAILED')
      ? 'ISSUE'
      : serviceChecks.length > 0 && serviceChecks.every((c) => c.status === 'OK')
        ? 'ENGINE_APPROVED'
        : 'NOT_CONFIRMED';
    return {
      hostId: ep.hostId,
      hostName: ep.name,
      platform: null,
      loopback: ep.loopback?.address ?? null,
      discoveredBy: index === 0 ? 'REQUESTED' : 'PW_PEER',
      collection: live || facts ? 'READ' : 'NOT_READ',
      accessRole: null,
      serviceState,
      vsi,
      acs: [],
      pws,
      ethTrunks: [],
      eTrunks: [],
      mac: notRead(),
      missingEvidence: [
        'papel de redundância (E-Trunk/LACP): o motor legado não avalia',
        'estado estruturado de cada AC: o motor legado só devolve a verificação em texto',
        'tabela MAC da VSI: o motor legado não coleta',
      ],
      engineChecks: hostChecks.map((c) => ({
        id: c.id,
        layer: LAYER[c.category],
        label: c.label,
        status: c.status,
        message: c.message,
        certainty: c.certainty,
        evidenceIds: known(c.evidence),
      })),
    };
  });

  const findings: VsiFindingView[] = result.checks.map((c: VsiDiagnosticCheck) => {
    const severity = c.status === 'FAILED' ? 'CRITICAL' : c.status === 'WARNING' ? 'WARNING' : 'INFO';
    const code = c.status === 'INSUFFICIENT_DATA' ? 'LEGACY_CHECK_INSUFFICIENT_DATA' : 'LEGACY_CHECK';
    return {
      id: c.id,
      code,
      kind: vsiFindingKind(code, severity),
      severity,
      certainty: c.certainty,
      impactCertainty: c.certainty,
      origin: 'ENGINE',
      hostId: c.hostId,
      hostName: nameOf(c.hostId),
      component: COMPONENT[c.category],
      title: c.label,
      explanation: c.message,
      caveat: null,
      evidenceIds: known(c.evidence),
      nextStepIds: [],
    };
  });
  result.warnings.forEach((text, i) =>
    findings.push({
      id: `legacy-limitation-${i}`,
      code: 'LEGACY_LIMITATION',
      kind: vsiFindingKind('LEGACY_LIMITATION', 'INFO'),
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'INCONCLUSIVE',
      origin: 'ENGINE',
      hostId: null,
      hostName: null,
      component: 'COLLECTION',
      title: 'Limitação declarada pelo motor legado',
      explanation: text,
      caveat: 'Limitação de escopo não indica falha do circuito.',
      evidenceIds: [],
      nextStepIds: [],
    }),
  );

  const nextSteps: VsiNextStep[] = result.nextTests.map((text, i) => ({
    id: `legacy-next-${i}`,
    hostId: null,
    hostName: null,
    title: text,
    command: null,
    homologated: null,
    reason: 'Sugerido pelo motor legado.',
    reasonFindingIds: [],
    evidenceIds: [],
  }));

  const links: VsiPwLinkView[] = endpoints[0]!.pws.map((pw) => {
    const remote = endpoints.find((e) => e.hostId !== null && e.hostId === pw.peerHostId) ?? null;
    const back = remote?.pws.find((p) => p.peerAddress === endpoints[0]!.loopback) ?? null;
    const a = pw.state.value;
    const b = back?.state.value ?? null;
    return {
      aHostId: endpoints[0]!.hostId,
      bHostId: remote?.hostId ?? null,
      bAddress: pw.peerAddress,
      state: a === null ? 'NOT_CONFIRMED' : a === 'UP' && b === 'UP' ? 'UP_BOTH' : a === 'DOWN' && b !== 'UP' ? 'DOWN' : 'UP_ONE_SIDE',
      labelsMatch:
        back && pw.localLabel !== null && pw.remoteLabel !== null && back.localLabel !== null && back.remoteLabel !== null
          ? pw.localLabel === back.remoteLabel && pw.remoteLabel === back.localLabel
          : null,
      findingIds: [],
    };
  });

  const connectivity: VsiConnectivity = {
    evaluated: true,
    underlayClassification: result.underlayClassification ?? null,
    probes: (result.probes ?? []).map((p) => ({
      sourceHostId: p.sourceHostId,
      sourceHostName: nameOf(p.sourceHostId),
      destinationHostId: p.destinationHostId,
      destinationHostName: nameOf(p.destinationHostId),
      source: p.source,
      destination: p.destination,
      routingContext: p.routingContext,
      status: p.status,
      transmitted: p.transmitted ?? null,
      received: p.received ?? null,
      lossPercent: p.lossPercent,
      rttMs: p.rttMs,
      hops: p.hops,
      tracerouteNotExecutedReason: p.tracerouteNotExecutedReason ?? null,
    })),
  };

  assertReferences(findings, nextSteps, evidence, readings, endpoints);
  const derived = deriveVsiAxes('LEGACY', endpoints, findings, readings);
  const read = endpoints.filter((e) => e.collection === 'READ').length;
  const serviceChecks = result.checks.filter((c) => SERVICE_CATEGORIES.includes(c.category));
  const approved = serviceChecks.filter((c) => c.status === 'OK').length;
  const axes: VsiAxes = {
    ...derived,
    // Falha continua falha. Sem falha, o eixo diz o que o legado realmente entrega: verificacoes aprovadas.
    service:
      derived.service.state === 'ISSUE'
        ? derived.service
        : {
            state:
              endpoints.length > 0 && endpoints.every((e) => e.serviceState === 'ENGINE_APPROVED')
                ? 'ENGINE_APPROVED'
                : 'NOT_CONFIRMED',
            clause: { code: 'SERVICE_LEGACY_CHECKS', params: { ok: approved, total: serviceChecks.length, read, endpoints: endpoints.length } },
          },
    // No legado toda leitura direta e da propria execucao: a cobertura e so quantos PEs foram lidos.
    evidence:
      read === 0
        ? { state: 'NOT_READ', clause: { code: 'EVIDENCE_NONE', params: { total: endpoints.length } } }
        : {
            state: read === endpoints.length ? 'PROVEN_OK' : 'NOT_CONFIRMED',
            clause: { code: read === endpoints.length ? 'EVIDENCE_COMPLETE' : 'EVIDENCE_PARTIAL', params: { read, total: endpoints.length } },
          },
  };
  const completed = result.state === 'COMPLETED';
  return {
    schemaVersion: 1,
    engine: 'LEGACY',
    engineVersion: 'legado',
    runId: result.diagnosticId,
    origin: 'LEGACY_JOB',
    vsiName: result.vsiName,
    operator: { username: result.operator.username, role: result.operator.role },
    startedAt: result.startedAt,
    completedAt,
    connectivity,
    demonstration: null,
    verdict: completed
      ? {
          status: VERDICT[result.overallStatus],
          clauses: [{ code: 'LEGACY_SUMMARY', params: { text: result.summary } }, axes.redundancy.clause, axes.mac.clause],
        }
      : { status: 'INCONCLUSIVE', clauses: [{ code: 'LEGACY_RUN_NOT_COMPLETED', params: { state: result.state } }] },
    axes,
    endpoints,
    links,
    findings,
    nextSteps,
    readings,
    evidence,
  };
}
