import type {
  VsiDiagnosticCategory,
  VsiDiagnosticCheck,
  VsiDiagnosticEndpoint,
  VsiDiagnosticEndpointAccess,
  VsiDiagnosticEvidence,
  VsiDiagnosticProbe,
  VsiDiagnosticResult,
  VsiDiagnosticStatus,
} from '@gmj/shared';

/** Tom visual. Nao altera o status tecnico: apenas o representa. */
export type Tone = 'ok' | 'attention' | 'error' | 'neutral';

const TONE_BY_STATUS: Record<VsiDiagnosticStatus, Tone> = {
  OK: 'ok',
  WARNING: 'attention',
  FAILED: 'error',
  INSUFFICIENT_DATA: 'neutral',
};

export function toneOf(status: VsiDiagnosticStatus | undefined): Tone {
  return status ? TONE_BY_STATUS[status] : 'neutral';
}

/**
 * Combina tons de varios checks. Um erro domina; na ausencia dele uma limitacao
 * domina o OK (nunca reportar saudavel um conjunto com evidencia faltando).
 */
export function combineTones(tones: Tone[]): Tone {
  if (tones.length === 0) return 'neutral';
  if (tones.includes('error')) return 'error';
  if (tones.includes('attention')) return 'attention';
  if (tones.includes('neutral')) return 'neutral';
  return 'ok';
}

export interface HealthCard {
  id: string;
  title: string;
  tone: Tone;
  detail: string;
}

export function isRunning(result: Pick<VsiDiagnosticResult, 'state'>): boolean {
  return result.state === 'QUEUED' || result.state === 'RUNNING';
}

/** Status de cabecalho: RUNNING vem do estado do job, nunca do veredito. */
export function headlineStatus(result: VsiDiagnosticResult): VsiDiagnosticStatus | 'RUNNING' {
  return isRunning(result) ? 'RUNNING' : result.overallStatus;
}

function checksOf(
  result: VsiDiagnosticResult,
  category: VsiDiagnosticCategory,
  hostId?: string | null,
): VsiDiagnosticCheck[] {
  return result.checks.filter(
    (check) => check.category === category && (!hostId || check.hostId === hostId),
  );
}

function worstOf(checks: VsiDiagnosticCheck[]): Pick<HealthCard, 'tone' | 'detail'> {
  if (checks.length === 0) return { tone: 'neutral', detail: 'não executado' };
  const failing = checks.find((check) => check.status === 'FAILED');
  const attentive = checks.find((check) => check.status === 'WARNING');
  const unknown = checks.find((check) => check.status === 'INSUFFICIENT_DATA');
  return {
    tone: combineTones(checks.map((check) => toneOf(check.status))),
    detail: (failing ?? attentive ?? unknown)?.message ?? 'verificado nesta execução',
  };
}

/** Manchete de um probe: respostas primeiro; perda fica como detalhe secundario. */
export function probeHeadline(probe: VsiDiagnosticProbe): string {
  const transmitted = probe.transmitted ?? 0;
  const received = probe.received ?? 0;
  return transmitted > 0 && received >= transmitted
    ? `Alcançável · ${received}/${transmitted} respostas`
    : `${received}/${transmitted} respostas`;
}

/** Por sentido, nunca somando os dois sentidos num total unico. */
function reachabilityHeadline(probes: VsiDiagnosticProbe[]): string {
  if (probes.length === 0) return 'não executado';
  const headlines = [...new Set(probes.map(probeHeadline))];
  if (headlines.length === 1)
    return probes.length > 1 ? `${headlines[0]} em cada sentido` : headlines[0]!;
  return probes.map(probeHeadline).join(' · ');
}

export function buildHealthCards(result: VsiDiagnosticResult): HealthCard[] {
  const local = result.local;
  const remote = result.remotes[0] ?? null;
  const localId = local.hostId;
  const remoteId = remote?.hostId ?? null;

  const loopbackTone = (present: boolean): Tone => (present ? 'ok' : 'neutral');

  const vsiLocal = worstOf(checksOf(result, 'VSI', localId));
  const vsiRemote = remote ? worstOf(checksOf(result, 'VSI', remoteId)) : null;
  const pw = worstOf(checksOf(result, 'PW'));
  const acLocal = worstOf(checksOf(result, 'AC', localId));
  const acRemote = remote ? worstOf(checksOf(result, 'AC', remoteId)) : null;

  const probes = result.probes ?? [];
  const reachabilityTone = probes.length
    ? combineTones(probes.map((probe) => toneOf(probe.status)))
    : 'neutral';
  const reachabilityDetail = reachabilityHeadline(probes);

  const labelsCheck = result.checks.find((check) => /label/i.test(check.label));

  return [
    {
      id: 'loopback-local',
      title: 'Loopback local',
      tone: loopbackTone(Boolean(local.loopback)),
      detail: local.loopback?.address ?? 'não confirmado',
    },
    {
      id: 'loopback-remote',
      title: 'Loopback remoto',
      tone: loopbackTone(Boolean(remote?.loopback)),
      detail: remote?.loopback?.address ?? (remote ? 'não confirmado' : 'sem PE remoto'),
    },
    { id: 'vsi-local', title: 'VSI local', tone: vsiLocal.tone, detail: vsiLocal.detail },
    {
      id: 'vsi-remote',
      title: 'VSI remota',
      tone: vsiRemote?.tone ?? 'neutral',
      detail: vsiRemote?.detail ?? 'sem PE remoto',
    },
    { id: 'pw', title: 'PW', tone: pw.tone, detail: pw.detail },
    { id: 'ac-local', title: 'AC local', tone: acLocal.tone, detail: acLocal.detail },
    {
      id: 'ac-remote',
      title: 'AC remoto',
      tone: acRemote?.tone ?? 'neutral',
      detail: acRemote?.detail ?? 'sem PE remoto',
    },
    {
      id: 'reachability',
      title: 'Reachability',
      tone: reachabilityTone,
      detail: reachabilityDetail,
    },
    {
      id: 'labels',
      title: 'Labels match',
      tone: labelsCheck ? toneOf(labelsCheck.status) : 'neutral',
      detail: labelsCheck?.message ?? 'não avaliado nesta execução',
    },
  ];
}

export interface CheckSection {
  id: string;
  title: string;
  tone: Tone;
  count: number;
  checks: VsiDiagnosticCheck[];
}

export function buildSections(result: VsiDiagnosticResult): CheckSection[] {
  const plan: Array<{ id: string; title: string; categories: VsiDiagnosticCategory[] }> = [
    { id: 'underlay', title: 'Underlay', categories: ['UNDERLAY', 'ROUTE', 'L3'] },
    { id: 'vsi', title: 'VSI', categories: ['VSI'] },
    { id: 'pw', title: 'PW', categories: ['PW', 'ETH_TRUNK'] },
    { id: 'ac', title: 'AC', categories: ['AC', 'INTERFACE'] },
    { id: 'reachability', title: 'Reachability', categories: ['LOOPBACK_REACHABILITY', 'ERRORS'] },
  ];
  return plan.map(({ id, title, categories }) => {
    const checks = result.checks.filter((check) => categories.includes(check.category));
    return {
      id,
      title,
      checks,
      count: checks.length,
      tone: combineTones(checks.map((check) => toneOf(check.status))),
    };
  });
}

export function sectionSummary(section: CheckSection): string {
  if (section.count === 0) return 'não avaliado';
  const failed = section.checks.filter((check) => check.status === 'FAILED').length;
  const warning = section.checks.filter((check) => check.status === 'WARNING').length;
  const unknown = section.checks.filter((check) => check.status === 'INSUFFICIENT_DATA').length;
  const ok = section.count - failed - warning - unknown;
  const parts = [`${section.count} ${section.count === 1 ? 'verificação' : 'verificações'}`];
  if (failed) parts.push(`${failed} falha${failed > 1 ? 's' : ''}`);
  if (warning) parts.push(`${warning} atenção`);
  if (unknown) parts.push(`${unknown} sem evidência`);
  if (ok) parts.push(`${ok} ok`);
  return parts.join(' · ');
}

export function durationLabel(result: VsiDiagnosticResult): string {
  if (!result.completedAt) return isRunning(result) ? 'em andamento' : 'não concluído';
  const ms = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'não disponível';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatUtc(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function evidenceSummary(evidence: VsiDiagnosticEvidence): string {
  const firstLine = evidence.output.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/** Campos do contrato de evidencia; qualquer campo extra nunca chega ao navegador. */
const EVIDENCE_FIELDS = [
  'id',
  'diagnosticId',
  'hostId',
  'source',
  'observedAt',
  'collectedAt',
  'command',
  'durationMs',
  'complete',
  'errorCode',
  'sha256',
  'output',
] as const;

export function evidenceJson(evidence: VsiDiagnosticEvidence): string {
  const picked: Record<string, unknown> = {};
  for (const field of EVIDENCE_FIELDS)
    if (evidence[field] !== undefined) picked[field] = evidence[field];
  return JSON.stringify(picked, null, 2);
}

/** Labels in/out do peer observado no proprio PE (cada PE com os seus). */
export function endpointLabels(endpoint: VsiDiagnosticEndpoint | null): string {
  const peer = endpoint?.observedVsi?.peers[0];
  if (!peer) return '—';
  return `${peer.inboundLabel ?? '—'} / ${peer.outboundLabel ?? '—'}`;
}

export interface ExecutionContextView {
  /** RBAC do NetVision: quem iniciou a execucao. */
  netvision: string;
  /** Conta de servico SSH usada nos equipamentos. */
  deviceAccess: string;
  /** Autorizacao observada dos comandos desta execucao, por PE. */
  commandAuthorization: string;
  /** Nivel AAA da conta: nunca consultado; apenas contexto. */
  privilegeLevel: string;
}

function authorizationOf(endpoint: VsiDiagnosticEndpointAccess): string {
  const counted = `${endpoint.acceptedCommands}/${endpoint.executedCommands}`;
  if (endpoint.commandAuthorization === 'CONFIRMED_FOR_EXECUTED_COMMANDS')
    return `${endpoint.name}: confirmada para os ${endpoint.executedCommands} comandos executados (${counted}).`;
  if (endpoint.commandAuthorization === 'NOT_EXECUTED')
    return `${endpoint.name}: nenhum comando executado nesta execução.`;
  return endpoint.acceptedCommands < endpoint.executedCommands
    ? `${endpoint.name}: não confirmada (${counted} comandos com evidência válida).`
    : `${endpoint.name}: não confirmada; nem todos os comandos necessários foram executados (${counted} com evidência válida).`;
}

/**
 * Fonte de verdade: `executionContext` do backend. A UI nao infere autorizacao
 * a partir de approvals, evidencias ou contagem de comandos.
 */
export function buildExecutionContext(result: VsiDiagnosticResult): ExecutionContextView {
  const netvision = `${result.operator.username} (${result.operator.role})`;
  const context = result.executionContext;
  if (!context)
    return {
      netvision,
      deviceAccess: 'não informado pelo servidor',
      commandAuthorization: 'não informada pelo servidor',
      privilegeLevel: 'Não verificado explicitamente.',
    };
  const endpoints = context.endpoints;
  const sessions = endpoints.filter((endpoint) => endpoint.executedCommands > 0);
  const usernames = [...new Set(sessions.map((endpoint) => endpoint.sshUsername).filter(Boolean))];
  const confirmed =
    endpoints.length > 0 &&
    endpoints.every(
      (endpoint) => endpoint.commandAuthorization === 'CONFIRMED_FOR_EXECUTED_COMMANDS',
    );
  const pes = endpoints.length === 2 ? 'nos dois PEs' : 'no PE';
  return {
    netvision,
    deviceAccess:
      sessions.length === 0
        ? 'Nenhuma sessão SSH aberta nesta execução.'
        : usernames.length === 1
          ? `Conta de serviço ${usernames[0]}.`
          : sessions
              .map((endpoint) => `${endpoint.name}: ${endpoint.sshUsername ?? 'N/D'}`)
              .join(' · '),
    commandAuthorization: `${
      confirmed
        ? `Confirmada para os comandos executados nesta execução ${pes}.`
        : endpoints.map(authorizationOf).join(' ')
    } Vale somente para os comandos executados nesta execução.`,
    privilegeLevel: confirmed
      ? 'Não verificado explicitamente. Isso não afeta o resultado desta execução.'
      : 'Não verificado explicitamente.',
  };
}
