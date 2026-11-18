import {
  VSI_EVIDENCE_AGE_LIMITS,
  vsiFindingKind,
  vsiFreshness,
  type VsiAxes,
  type VsiAxis,
  type VsiClause,
  type VsiConnectivity,
  type VsiResultOrigin,
  type VsiEndpointInput,
  type VsiEndpointEvidenceState,
  type VsiEndpointServiceState,
  type VsiEndpointView,
  type VsiEvidenceAgeLimits,
  type VsiEvidenceRef,
  type VsiFindingView,
  type VsiFreshness,
  type VsiNextStep,
  type VsiObserved,
  type VsiPwLinkView,
  type VsiReading,
  type VsiServiceDiagnosis,
  type VsiServiceEngine,
  type VsiServiceRunSummary,
  type VsiVerdictStatus,
} from './vsi-service-diagnosis';

/**
 * Composicao do diagnostico por servico: calcula idade das leituras, estado do servico por
 * ponta, os quatro eixos e o veredito. Funcoes puras; nenhuma frase livre e gerada aqui —
 * o resultado sao CLAUSULAS (codigo + parametros) que a tela traduz por dicionario.
 */

/** Todos os codigos de clausula que esta camada (e o adaptador do legado) pode emitir. */
export const VSI_CLAUSE_CODES = [
  'VERDICT_OK',
  'VERDICT_WARNING',
  'VERDICT_FAILED',
  'VERDICT_INCONCLUSIVE',
  'VERDICT_NO_CURRENT_READING',
  'FAILED_OTHER_PATH_ACTIVE',
  'REDUNDANCY_PROVEN',
  'REDUNDANCY_PATH_DOWN',
  'REDUNDANCY_ROLE_UNKNOWN',
  'REDUNDANCY_NO_ACTIVE_PATH',
  'REDUNDANCY_NOT_READ',
  'REDUNDANCY_ROLE_NOT_ASSIGNED',
  'REDUNDANCY_STALE',
  'REDUNDANCY_NOT_EVALUATED_BY_ENGINE',
  'SERVICE_PROVEN',
  'SERVICE_ISSUE',
  'SERVICE_NOT_CONFIRMED',
  'SERVICE_LAST_READING_STALE',
  'SERVICE_LEGACY_CHECKS',
  'MAC_PROVEN',
  'MAC_ISSUE',
  'MAC_INCONCLUSIVE',
  'MAC_NOT_READ',
  'MAC_STALE',
  'MAC_NOT_EVALUATED_BY_ENGINE',
  'EVIDENCE_COMPLETE',
  'EVIDENCE_PARTIAL',
  'EVIDENCE_STALE',
  'EVIDENCE_NONE',
  'LEGACY_SUMMARY',
  'LEGACY_RUN_NOT_COMPLETED',
] as const;
export type VsiClauseCode = (typeof VSI_CLAUSE_CODES)[number];

const clause = (code: VsiClauseCode, params: Record<string, string | number> = {}): VsiClause => ({ code, params });

export interface VsiServiceComposeInput {
  engine: VsiServiceEngine;
  engineVersion: string;
  runId: string;
  origin: VsiResultOrigin;
  vsiName: string;
  operator: { username: string; role: string } | null;
  startedAt: string;
  completedAt: string;
  connectivity?: VsiConnectivity;
  demonstration?: { label: string; provenance: string } | null;
  endpoints: VsiEndpointInput[];
  links: VsiPwLinkView[];
  /** `kind` e sempre calculado a partir de `code` + `severity`. */
  findings: Array<Omit<VsiFindingView, 'kind'>>;
  nextSteps: VsiNextStep[];
  readings: VsiReading[];
  evidence: VsiEvidenceRef[];
}

function stamp<T>(o: VsiObserved<T>, now: string, limits: VsiEvidenceAgeLimits): VsiObserved<T> {
  return {
    ...o,
    freshness: o.basis === 'LIVE_SSH' ? vsiFreshness(o.observedAt, now, limits, o.timePrecision ?? 'INSTANT') : null,
  };
}

function stampEndpoint(e: VsiEndpointInput, now: string, limits: VsiEvidenceAgeLimits): VsiEndpointInput {
  return {
    ...e,
    vsi: stamp(e.vsi, now, limits),
    mac: stamp(e.mac, now, limits),
    acs: e.acs.map((a) => ({ ...a, state: stamp(a.state, now, limits) })),
    pws: e.pws.map((p) => ({ ...p, state: stamp(p.state, now, limits) })),
    ethTrunks: e.ethTrunks.map((t) => ({ ...t, operStatus: stamp(t.operStatus, now, limits) })),
    eTrunks: e.eTrunks.map((t) => ({ ...t, state: stamp(t.state, now, limits) })),
  };
}

const isLive = (o: VsiObserved<unknown>): boolean => o.basis === 'LIVE_SSH' && o.value !== null;

function redundancyObserved(e: VsiEndpointInput): Array<VsiObserved<unknown>> {
  return [...e.eTrunks.map((t) => t.state), ...e.ethTrunks.map((t) => t.operStatus)];
}
function allObserved(e: VsiEndpointInput): Array<VsiObserved<unknown>> {
  return [e.vsi, e.mac, ...e.acs.map((a) => a.state), ...e.pws.map((p) => p.state), ...redundancyObserved(e)];
}

export function summarizeVsiServiceRun(d: VsiServiceDiagnosis, storedIn: VsiServiceRunSummary['storedIn']): VsiServiceRunSummary {
  return {
    runId: d.runId,
    vsiName: d.vsiName,
    origin: d.origin,
    label: d.demonstration?.label ?? null,
    engine: d.engine,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    verdict: d.verdict.status,
    endpoints: d.endpoints.map((e) => ({ hostId: e.hostId, hostName: e.hostName, collection: e.collection, accessRole: e.accessRole })),
    storedIn,
  };
}

/**
 * Suficiencia da EVIDENCIA numa ponta (terceiro eixo, separado de coleta e de estado do servico):
 * NONE = nada lido ao vivo; INSUFFICIENT = algo lido, mas a coleta nao fechou, a VSI nao foi lida, o papel
 * ficou indeterminado ou ha leitura pendente; SUFFICIENT = a ponta esta classificada sem nova leitura.
 */
export function vsiEndpointEvidenceState(e: VsiEndpointInput): VsiEndpointEvidenceState {
  if (!allObserved(e).some(isLive)) return 'NONE';
  if (e.collection !== 'READ' || !isLive(e.vsi) || e.accessRole === 'ROLE_UNKNOWN' || e.missingEvidence.length > 0) return 'INSUFFICIENT';
  return 'SUFFICIENT';
}

/** Estado do SERVICO numa ponta. Papel do acesso so entra para reconhecer o down esperado do Backup. */
export function vsiEndpointServiceState(e: VsiEndpointInput): VsiEndpointServiceState {
  if (!isLive(e.vsi) || !e.vsi.value) return 'NOT_CONFIRMED';
  if (e.vsi.freshness === 'STALE') return 'STALE';
  if (e.vsi.value.state === 'DOWN') return e.accessRole === 'STANDBY_EXPECTED' ? 'EXPECTED_DOWN' : 'ISSUE';
  const liveAcs = e.acs.filter((a) => isLive(a.state));
  if (liveAcs.some((a) => a.state.value === 'DOWN' && a.role !== 'STANDBY_EXPECTED')) return 'ISSUE';
  const livePws = e.pws.filter((p) => isLive(p.state) && !p.stale);
  if (livePws.length > 0 && livePws.every((p) => p.state.value === 'DOWN')) return 'ISSUE';
  if (liveAcs.length === 0 || livePws.length === 0) return 'NOT_CONFIRMED';
  return 'PROVEN_OK';
}

const names = (list: Array<{ hostName: string }>): string => list.map((e) => e.hostName).join(', ');
const worstIsStale = (list: Array<VsiObserved<unknown>>): boolean => {
  const live = list.filter(isLive);
  return live.length > 0 && live.every((o) => o.freshness === 'STALE');
};
const dateOf = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

function newestLive(endpoints: VsiEndpointInput[]): string | null {
  let best: string | null = null;
  for (const e of endpoints)
    for (const o of allObserved(e))
      if (isLive(o) && o.observedAt && (best === null || o.observedAt > best)) best = o.observedAt;
  return best;
}

export function deriveVsiAxes(
  engine: VsiServiceEngine,
  endpoints: VsiEndpointView[],
  findings: VsiFindingView[],
  readings: VsiReading[],
): VsiAxes {
  const total = endpoints.length;
  const failureOn = (components: string[]): boolean =>
    findings.some((f) => f.kind === 'FAILURE' && components.includes(f.component));

  // --- redundancia do acesso ---
  let redundancy: VsiAxis;
  const scoped = endpoints.filter((e) => e.accessRole !== null);
  const down = scoped.filter((e) => e.accessRole === 'DOWN_UNEXPECTED');
  const unknown = scoped.filter((e) => e.accessRole === 'ROLE_UNKNOWN');
  const active = scoped.filter((e) => e.accessRole === 'ACTIVE');
  const standby = scoped.filter((e) => e.accessRole === 'STANDBY_EXPECTED');
  // E-Trunk/LACP lidos, mas sem papel: o motor so atribui ACTIVE/STANDBY quando tambem leu a VSI.
  const readNoRole = endpoints.filter((e) => e.accessRole === null && redundancyObserved(e).some(isLive));
  if (scoped.length === 0)
    redundancy =
      engine === 'LEGACY'
        ? { state: 'NOT_APPLICABLE', clause: clause('REDUNDANCY_NOT_EVALUATED_BY_ENGINE') }
        : readNoRole.length > 0
          ? { state: 'NOT_CONFIRMED', clause: clause('REDUNDANCY_ROLE_NOT_ASSIGNED', { hosts: names(readNoRole) }) }
          : { state: 'NOT_READ', clause: clause('REDUNDANCY_NOT_READ') };
  else if (down.length > 0 || failureOn(['ETH_TRUNK', 'E_TRUNK']))
    redundancy = { state: 'ISSUE', clause: clause('REDUNDANCY_PATH_DOWN', { hosts: names(down) || names(scoped) }) };
  else if (unknown.length > 0)
    // Papel desconhecido porque a VSI nao foi lida (o motor nao correlaciona) x desconhecido com a VSI lida.
    redundancy = unknown.every((e) => !isLive(e.vsi) && redundancyObserved(e).some(isLive))
      ? { state: 'NOT_CONFIRMED', clause: clause('REDUNDANCY_ROLE_NOT_ASSIGNED', { hosts: names(unknown) }) }
      : { state: 'NOT_CONFIRMED', clause: clause('REDUNDANCY_ROLE_UNKNOWN', { hosts: names(unknown) }) };
  else if (active.length === 0)
    redundancy = { state: 'NOT_CONFIRMED', clause: clause('REDUNDANCY_NO_ACTIVE_PATH', { hosts: names(standby) }) };
  else if (worstIsStale(scoped.flatMap(redundancyObserved)))
    redundancy = { state: 'STALE', clause: clause('REDUNDANCY_STALE') };
  else {
    const eTrunkId = scoped.flatMap((e) => e.eTrunks)[0]?.id;
    redundancy = {
      state: 'PROVEN_OK',
      clause: clause('REDUNDANCY_PROVEN', {
        mechanism: eTrunkId === undefined ? 'LACP' : `E-Trunk ${eTrunkId}`,
        active: names(active),
        standby: names(standby) || '—',
      }),
    };
  }

  // --- servico ---
  let service: VsiAxis;
  const read = endpoints.filter((e) => isLive(e.vsi)).length;
  const issue = endpoints.filter((e) => e.serviceState === 'ISSUE');
  const staleOnly = endpoints.filter((e) => e.serviceState === 'STALE');
  const fresh = endpoints.filter((e) => isLive(e.vsi) && e.vsi.freshness !== 'STALE');
  if (issue.length > 0 || failureOn(['VSI', 'AC', 'PW']))
    service = { state: 'ISSUE', clause: clause('SERVICE_ISSUE', { hosts: names(issue) || '—' }) };
  else if (fresh.length === 0 && staleOnly.length > 0) {
    const last = staleOnly.map((e) => e.vsi.observedAt ?? '').sort().at(-1) ?? '';
    const states = new Set(staleOnly.map((e) => e.vsi.value?.state));
    service = {
      state: 'STALE',
      clause: clause('SERVICE_LAST_READING_STALE', {
        date: dateOf(last),
        state: states.size === 1 ? [...states][0] ?? 'MIXED' : 'MIXED',
        read: staleOnly.length,
        total,
      }),
    };
  } else if (endpoints.some((e) => e.serviceState === 'NOT_CONFIRMED' || e.serviceState === 'STALE'))
    service = { state: 'NOT_CONFIRMED', clause: clause('SERVICE_NOT_CONFIRMED', { read, total }) };
  else if (endpoints.some((e) => e.serviceState === 'PROVEN_OK'))
    service = { state: 'PROVEN_OK', clause: clause('SERVICE_PROVEN', { read, total }) };
  else service = { state: 'NOT_CONFIRMED', clause: clause('SERVICE_NOT_CONFIRMED', { read, total }) };

  // --- aprendizado MAC ---
  let mac: VsiAxis;
  const macRead = endpoints.filter((e) => isLive(e.mac));
  const macFindings = findings.filter((f) => f.component === 'MAC');
  if (engine === 'LEGACY') mac = { state: 'NOT_APPLICABLE', clause: clause('MAC_NOT_EVALUATED_BY_ENGINE') };
  else if (macRead.length === 0) mac = { state: 'NOT_READ', clause: clause('MAC_NOT_READ', { total }) };
  else if (macFindings.some((f) => f.kind === 'FAILURE' || f.kind === 'RISK'))
    mac = { state: 'ISSUE', clause: clause('MAC_ISSUE', { count: macFindings.length }) };
  else if (macFindings.some((f) => f.kind === 'INCONCLUSIVE')) {
    const unresolved = macRead.reduce((n, e) => n + (e.mac.value?.viaUnresolved ?? 0), 0);
    mac = { state: 'NOT_CONFIRMED', clause: clause('MAC_INCONCLUSIVE', { unresolved, read: macRead.length, total }) };
  } else if (worstIsStale(macRead.map((e) => e.mac))) mac = { state: 'STALE', clause: clause('MAC_STALE') };
  else
    mac = {
      state: macRead.length === total ? 'PROVEN_OK' : 'NOT_CONFIRMED',
      clause: clause('MAC_PROVEN', {
        viaAc: macRead.reduce((n, e) => n + (e.mac.value?.viaAc ?? 0), 0),
        viaPw: macRead.reduce((n, e) => n + (e.mac.value?.viaPw ?? 0), 0),
        // entradas cuja origem (AC ou PW) nao foi comprovada: aparecem a parte, nunca somadas a AC ou PW
        unresolved: macRead.reduce((n, e) => n + (e.mac.value?.viaUnresolved ?? 0), 0),
        read: macRead.length,
        total,
      }),
    };

  // --- evidencia ---
  let evidence: VsiAxis;
  const live = endpoints.flatMap(allObserved).filter(isLive);
  const thisRun = new Set(readings.filter((r) => r.inThisRun && r.kind === 'SSH_SESSION').map((r) => r.id));
  if (live.length === 0) evidence = { state: 'NOT_READ', clause: clause('EVIDENCE_NONE', { total }) };
  else if (live.every((o) => o.freshness === 'STALE'))
    evidence = { state: 'STALE', clause: clause('EVIDENCE_STALE', { read, total, date: dateOf(newestLive(endpoints)) }) };
  else if (
    read === total &&
    endpoints.every((e) => e.collection === 'READ' && e.vsi.readingId !== null && thisRun.has(e.vsi.readingId))
  )
    evidence = { state: 'PROVEN_OK', clause: clause('EVIDENCE_COMPLETE', { read, total }) };
  else evidence = { state: 'NOT_CONFIRMED', clause: clause('EVIDENCE_PARTIAL', { read, total }) };

  return { redundancy, service, mac, evidence };
}

export function deriveVsiVerdict(
  axes: VsiAxes,
  endpoints: VsiEndpointView[],
  findings: VsiFindingView[],
  readings: VsiReading[],
  now: string,
): { status: VsiVerdictStatus; clauses: VsiClause[] } {
  const axisClauses = [axes.redundancy.clause, axes.service.clause, axes.mac.clause];
  const failures = findings.filter((f) => f.kind === 'FAILURE' && f.certainty === 'CONFIRMED');
  if (failures.length > 0) {
    const failing = new Set(failures.map((f) => f.hostId));
    const others = endpoints.filter(
      (e) => !failing.has(e.hostId) && e.accessRole === 'ACTIVE' && e.serviceState === 'PROVEN_OK',
    );
    return {
      status: 'FAILED',
      clauses: [
        clause('VERDICT_FAILED', { count: failures.length }),
        ...(others.length > 0 ? [clause('FAILED_OTHER_PATH_ACTIVE', { hosts: names(others) })] : []),
        ...axisClauses,
      ],
    };
  }
  const ranNow = readings.some((r) => r.inThisRun && r.kind === 'SSH_SESSION');
  const newest = newestLive(endpoints);
  const allStale = (() => {
    const live = endpoints.flatMap(allObserved).filter(isLive);
    return live.length > 0 && live.every((o) => o.freshness === ('STALE' satisfies VsiFreshness));
  })();
  if (!ranNow && allStale && newest) {
    const ageDays = Math.round((Date.parse(now) - Date.parse(newest)) / 86_400_000);
    return { status: 'NO_CURRENT_READING', clauses: [clause('VERDICT_NO_CURRENT_READING', { ageDays }), ...axisClauses] };
  }
  if (axes.service.state !== 'PROVEN_OK' || endpoints.some((e) => e.collection !== 'READ'))
    return { status: 'INCONCLUSIVE', clauses: [clause('VERDICT_INCONCLUSIVE'), ...axisClauses] };
  const risks = findings.filter((f) => f.kind === 'RISK');
  if (risks.length > 0) return { status: 'WARNING', clauses: [clause('VERDICT_WARNING', { count: risks.length }), ...axisClauses] };
  const proven = (a: VsiAxis): boolean => a.state === 'PROVEN_OK';
  if (proven(axes.service) && proven(axes.mac) && proven(axes.evidence) && (proven(axes.redundancy) || axes.redundancy.state === 'NOT_READ'))
    return { status: 'OK', clauses: [clause('VERDICT_OK'), ...axisClauses] };
  return { status: 'INCONCLUSIVE', clauses: [clause('VERDICT_INCONCLUSIVE'), ...axisClauses] };
}

/** Achados que a propria composicao acrescenta: participante sem leitura do servico e caminho em falha sem achado do motor. */
function aggregatorFindings(endpoints: VsiEndpointInput[], given: Array<Omit<VsiFindingView, 'kind'>>): Array<Omit<VsiFindingView, 'kind'>> {
  const out: Array<Omit<VsiFindingView, 'kind'>> = [];
  for (const e of endpoints) {
    const key = e.hostId ?? e.hostName;
    // Se o motor ja disse que a saida da VSI faltou neste PE, nao repetir o mesmo fato com outro codigo.
    const alreadySaid = given.some((f) => (f.code === 'ENDPOINT_SERVICE_NOT_READ' || f.code === 'VSI_EVIDENCE_MISSING') && f.hostName === e.hostName);
    if (!isLive(e.vsi) && !alreadySaid) {
      const inventory = e.vsi.inventoryHint;
      out.push({
        id: `agg-not-read-${key}`,
        code: 'ENDPOINT_SERVICE_NOT_READ',
        severity: 'INFO',
        certainty: 'CONFIRMED',
        impactCertainty: 'INCONCLUSIVE',
        origin: 'AGGREGATOR',
        hostId: e.hostId,
        hostName: e.hostName,
        component: 'VSI',
        title: `VSI, AC e PW não foram lidos diretamente em ${e.hostName}`,
        explanation: inventory
          ? `Só existe o registro do inventário (VSI ${inventory.value.state.toLowerCase()}), que não é leitura do equipamento e não comprova o estado atual.`
          : 'Não há leitura do equipamento nem registro de inventário para esta ponta.',
        caveat:
          e.accessRole === 'ACTIVE'
            ? 'O acesso ativo (Master/LACP) não comprova que a VSI está operacional.'
            : e.accessRole === 'STANDBY_EXPECTED'
              ? 'O standby do acesso está comprovado; o estado da VSI nesta ponta, não.'
              : null,
        evidenceIds: [e.vsi.evidenceId, inventory?.evidenceId ?? null].filter((v): v is string => v !== null),
        nextStepIds: [],
      });
    }
    if (
      e.accessRole === 'DOWN_UNEXPECTED' &&
      !given.some((f) => f.hostName === e.hostName && f.severity === 'CRITICAL')
    )
      out.push({
        id: `agg-path-down-${key}`,
        code: 'PATH_DOWN_UNEXPECTED',
        severity: 'CRITICAL',
        certainty: 'CONFIRMED',
        impactCertainty: 'PROBABLE',
        origin: 'AGGREGATOR',
        hostId: e.hostId,
        hostName: e.hostName,
        component: e.eTrunks.length > 0 ? 'E_TRUNK' : 'ETH_TRUNK',
        title: `Caminho de acesso em falha inesperada em ${e.hostName}`,
        explanation: 'O caminho está fora de operação sem evidência de que seja o lado reserva da redundância.',
        caveat: 'A existência de outro caminho ativo não reduz a severidade desta falha.',
        evidenceIds: redundancyObserved(e).map((o) => o.evidenceId).filter((v): v is string => v !== null),
        nextStepIds: [],
      });
  }
  return out;
}

export function composeVsiServiceDiagnosis(
  input: VsiServiceComposeInput,
  limits: VsiEvidenceAgeLimits = VSI_EVIDENCE_AGE_LIMITS,
): VsiServiceDiagnosis {
  const now = input.completedAt;
  const stamped = input.endpoints.map((e) => stampEndpoint(e, now, limits));
  const endpoints: VsiEndpointView[] = stamped.map((e) => ({ ...e, serviceState: vsiEndpointServiceState(e) }));
  const findings: VsiFindingView[] = [...input.findings, ...aggregatorFindings(stamped, input.findings)].map((f) => ({
    ...f,
    kind: vsiFindingKind(f.code, f.severity),
  }));
  assertReferences(findings, input.nextSteps, input.evidence, input.readings, endpoints);
  const axes = deriveVsiAxes(input.engine, endpoints, findings, input.readings);
  const verdict = deriveVsiVerdict(axes, endpoints, findings, input.readings, now);
  return {
    schemaVersion: 1,
    engine: input.engine,
    engineVersion: input.engineVersion,
    runId: input.runId,
    origin: input.origin,
    connectivity: input.connectivity ?? { evaluated: false, underlayClassification: null, probes: [] },
    vsiName: input.vsiName,
    operator: input.operator,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    demonstration: input.demonstration ?? null,
    verdict,
    axes,
    endpoints,
    links: input.links,
    findings,
    nextSteps: input.nextSteps,
    readings: input.readings,
    evidence: input.evidence,
  };
}

/** Rastreabilidade: toda referencia a evidencia, leitura ou passo precisa existir. */
export function assertReferences(
  findings: VsiFindingView[],
  nextSteps: VsiNextStep[],
  evidence: VsiEvidenceRef[],
  readings: VsiReading[],
  endpoints: VsiEndpointInput[],
): void {
  const ev = new Set(evidence.map((e) => e.id));
  const rd = new Set(readings.map((r) => r.id));
  const st = new Set(nextSteps.map((s) => s.id));
  const fd = new Set(findings.map((f) => f.id));
  const need = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`Referencia inexistente no diagnostico VSI: ${what}`);
  };
  for (const f of findings) {
    f.evidenceIds.forEach((id) => need(ev.has(id), `evidencia ${id} (achado ${f.id})`));
    f.nextStepIds.forEach((id) => need(st.has(id), `passo ${id} (achado ${f.id})`));
  }
  for (const s of nextSteps) {
    s.evidenceIds.forEach((id) => need(ev.has(id), `evidencia ${id} (passo ${s.id})`));
    s.reasonFindingIds.forEach((id) => need(fd.has(id), `achado ${id} (passo ${s.id})`));
  }
  for (const e of evidence) if (e.readingId !== null) need(rd.has(e.readingId), `leitura ${e.readingId} (evidencia ${e.id})`);
  for (const e of endpoints)
    for (const o of allObserved(e)) {
      if (o.evidenceId !== null) need(ev.has(o.evidenceId), `evidencia ${o.evidenceId} (${e.hostName})`);
      if (o.readingId !== null) need(rd.has(o.readingId), `leitura ${o.readingId} (${e.hostName})`);
      if (o.inventoryHint?.evidenceId) need(ev.has(o.inventoryHint.evidenceId), `evidencia ${o.inventoryHint.evidenceId} (${e.hostName})`);
    }
}
