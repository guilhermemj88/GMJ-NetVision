import { vsiEndpointEvidenceState } from '@gmj/shared';
import type {
  VsiAxisState,
  VsiClause,
  VsiClauseCode,
  VsiEndpointView,
  VsiEngineCheck,
  VsiFindingKind,
  VsiFindingView,
  VsiNextStep,
  VsiObserved,
  VsiPathRole,
  VsiServiceDiagnosis,
  VsiTimePrecision,
  VsiUpDown,
  VsiVerdictStatus,
} from '@gmj/shared';

/**
 * Modelo de exibicao do Diagnostico VSI/VPLS por servico. So traduz o contrato em rotulos:
 * nenhuma conclusao e criada aqui. Estado nunca depende so de cor — todo tom tem icone e palavra.
 */

export type Tone = 'ok' | 'active' | 'warn' | 'crit' | 'unk' | 'standby' | 'stale' | 'collect';

/* ------------------------------ tempo ------------------------------ */

export function formatInstant(iso: string | null, precision: VsiTimePrecision = 'INSTANT'): string {
  if (!iso) return 'sem horário';
  const day = `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return precision === 'DAY' ? `${day} (hora não informada)` : `${day} ${iso.slice(11, 16)}Z`;
}
const shortDay = (iso: string | null): string => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const isoDay = (value: string | number): string => {
  const s = String(value);
  return s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s;
};

/* ----------------------------- clausulas --------------------------- */

type P = Record<string, string | number>;
const plural = (n: string | number, one: string, many: string): string => (Number(n) === 1 ? one : many);

export const CLAUSE_TEMPLATES: Record<VsiClauseCode, (p: P) => string> = {
  VERDICT_OK: () => 'Todas as pontas foram lidas nesta execução e não há falha nem risco.',
  VERDICT_WARNING: (p) => `Serviço operacional com ${p.count} ${plural(p.count ?? 0, 'risco identificado', 'riscos identificados')}.`,
  VERDICT_FAILED: (p) => `${p.count} ${plural(p.count ?? 0, 'falha comprovada', 'falhas comprovadas')} pela leitura do equipamento.`,
  VERDICT_INCONCLUSIVE: () => 'A evidência disponível não basta para afirmar o estado do serviço.',
  VERDICT_NO_CURRENT_READING: (p) =>
    `Não há leitura direta nesta execução; a mais recente tem ${p.ageDays} ${plural(p.ageDays ?? 0, 'dia', 'dias')}. O estado de hoje só se afirma com nova coleta.`,
  FAILED_OTHER_PATH_ACTIVE: (p) => `Há outro caminho ativo e comprovado em ${p.hosts}; isso não reduz a severidade da falha.`,
  REDUNDANCY_PROVEN: (p) => `Redundância do acesso comprovada (${p.mechanism}): ativo em ${p.active}; standby esperado em ${p.standby}.`,
  REDUNDANCY_PATH_DOWN: (p) => `Caminho de acesso em falha inesperada em ${p.hosts}.`,
  REDUNDANCY_ROLE_UNKNOWN: (p) => `Papel do acesso não determinado em ${p.hosts}.`,
  REDUNDANCY_NO_ACTIVE_PATH: (p) => `Nenhum caminho ativo foi comprovado; standby lido em ${p.hosts}.`,
  REDUNDANCY_ROLE_NOT_ASSIGNED: (p) =>
    `E-Trunk/LACP lidos em ${p.hosts}, mas o papel ativo/standby não foi atribuído: o motor só o decide quando também lê a VSI.`,
  REDUNDANCY_NOT_READ: () => 'A redundância do acesso não foi lida; a ausência de proteção não está comprovada.',
  REDUNDANCY_STALE: () => 'A leitura da redundância é antiga e não comprova o papel atual.',
  REDUNDANCY_NOT_EVALUATED_BY_ENGINE: () => 'O motor legado não avalia redundância (E-Trunk/LACP).',
  SERVICE_PROVEN: (p) => `VSI, AC e PW lidos diretamente e operacionais em ${p.read} de ${p.total} PEs.`,
  SERVICE_ISSUE: (p) => `Falha de serviço em ${p.hosts}.`,
  SERVICE_NOT_CONFIRMED: (p) =>
    `VSI, AC e PW lidos diretamente em ${p.read} de ${p.total} PEs. E-Trunk Master ou LACP ativo não comprovam que a VSI encaminha.`,
  SERVICE_LEGACY_CHECKS: (p) =>
    `O motor legado aprovou ${p.ok} de ${p.total} verificações de VSI, PW e AC em ${p.read} de ${p.endpoints} PEs. Ele não devolve o estado de cada AC como dado estruturado.`,
  SERVICE_LAST_READING_STALE: (p) =>
    `Na última leitura direta (${isoDay(p.date ?? '')}) a VSI estava ${p.state === 'UP' ? 'up' : p.state === 'DOWN' ? 'down' : 'em estados diferentes entre as pontas'} em ${p.read} de ${p.total} PEs.`,
  MAC_PROVEN: (p) =>
    `Aprendizado MAC lido em ${p.read} de ${p.total} PEs: ${p.viaAc} pelo AC, ${p.viaPw} pelo PW${Number(p.unresolved ?? 0) > 0 ? `, ${p.unresolved} de origem não classificada` : ''}.`,
  MAC_ISSUE: (p) => `${p.count} ${plural(p.count ?? 0, 'achado', 'achados')} na tabela MAC.`,
  MAC_INCONCLUSIVE: (p) => `A origem de ${p.unresolved} MAC não foi comprovada.`,
  MAC_NOT_READ: () => 'A tabela MAC não foi lida em nenhum PE.',
  MAC_STALE: () => 'A leitura da tabela MAC é antiga.',
  MAC_NOT_EVALUATED_BY_ENGINE: () => 'O motor legado não coleta a tabela MAC da VSI.',
  EVIDENCE_COMPLETE: (p) => `Serviço lido diretamente em ${p.read} de ${p.total} PEs nesta execução.`,
  EVIDENCE_PARTIAL: (p) => `Serviço lido diretamente em ${p.read} de ${p.total} PEs; o restante vem do inventário ou não foi lido.`,
  EVIDENCE_STALE: (p) => `Só há leitura direta antiga (${isoDay(p.date ?? '')}), em ${p.read} de ${p.total} PEs.`,
  EVIDENCE_NONE: () => 'Nenhuma leitura direta de equipamento.',
  LEGACY_SUMMARY: (p) => String(p.text ?? ''),
  LEGACY_RUN_NOT_COMPLETED: (p) => `A execução do motor legado não foi concluída (${p.state}).`,
};

export function renderClause(clause: VsiClause): string {
  const template = (CLAUSE_TEMPLATES as Record<string, ((p: P) => string) | undefined>)[clause.code];
  if (!template) throw new Error(`Clausula de veredito sem modelo de frase: ${clause.code}`);
  return template(clause.params);
}

/* ------------------------------ rotulos ---------------------------- */

export const VERDICT_META: Record<VsiVerdictStatus, { label: string; tone: Tone }> = {
  OK: { label: 'OPERACIONAL', tone: 'ok' },
  WARNING: { label: 'ATENÇÃO', tone: 'warn' },
  FAILED: { label: 'FALHA COMPROVADA', tone: 'crit' },
  INCONCLUSIVE: { label: 'INCONCLUSIVO', tone: 'unk' },
  NO_CURRENT_READING: { label: 'SEM LEITURA ATUAL', tone: 'stale' },
};

export const AXIS_TITLE = {
  redundancy: 'Redundância do acesso',
  service: 'Serviço · VSI, AC, PW',
  mac: 'Aprendizado MAC',
  evidence: 'Evidência',
} as const;

const AXIS_TONE: Record<VsiAxisState, Tone> = {
  PROVEN_OK: 'ok',
  ENGINE_APPROVED: 'ok',
  ISSUE: 'crit',
  NOT_CONFIRMED: 'unk',
  NOT_READ: 'unk',
  STALE: 'stale',
  NOT_APPLICABLE: 'stale',
};
const AXIS_LABEL: Record<keyof typeof AXIS_TITLE, Record<VsiAxisState, string>> = {
  redundancy: { ENGINE_APPROVED: 'APROVADA PELO MOTOR', PROVEN_OK: 'COMPROVADA', ISSUE: 'FALHA', NOT_CONFIRMED: 'NÃO CONFIRMADA', NOT_READ: 'NÃO LIDA', STALE: 'LEITURA ANTIGA', NOT_APPLICABLE: 'NÃO AVALIADA' },
  service: { ENGINE_APPROVED: 'APROVADO PELAS VERIFICAÇÕES DO LEGADO', PROVEN_OK: 'COMPROVADO', ISSUE: 'FALHA', NOT_CONFIRMED: 'NÃO CONFIRMADO', NOT_READ: 'NÃO LIDO', STALE: 'LEITURA ANTIGA', NOT_APPLICABLE: 'NÃO AVALIADO' },
  mac: { ENGINE_APPROVED: 'APROVADO PELO MOTOR', PROVEN_OK: 'COMPROVADO', ISSUE: 'COM ACHADOS', NOT_CONFIRMED: 'INCONCLUSIVO', NOT_READ: 'NÃO LIDO', STALE: 'LEITURA ANTIGA', NOT_APPLICABLE: 'NÃO AVALIADO' },
  evidence: { ENGINE_APPROVED: 'APROVADA PELO MOTOR', PROVEN_OK: 'COMPLETA', ISSUE: 'FALHA', NOT_CONFIRMED: 'PARCIAL', NOT_READ: 'NENHUMA', STALE: 'ANTIGA', NOT_APPLICABLE: 'NÃO AVALIADA' },
};
export function axisMeta(axis: keyof typeof AXIS_TITLE, state: VsiAxisState): { title: string; label: string; tone: Tone } {
  return { title: AXIS_TITLE[axis], label: AXIS_LABEL[axis][state], tone: AXIS_TONE[state] };
}

export const KIND_ORDER: VsiFindingKind[] = ['FAILURE', 'RISK', 'INCONCLUSIVE', 'COLLECTION', 'STALE_DATA', 'STANDBY_EXPECTED', 'INFO'];
export const KIND_META: Record<VsiFindingKind, { label: string; tone: Tone; pending: boolean; open: boolean }> = {
  FAILURE: { label: 'Falha comprovada', tone: 'crit', pending: true, open: true },
  RISK: { label: 'Risco ou degradação', tone: 'warn', pending: true, open: true },
  INCONCLUSIVE: { label: 'Inconclusivo', tone: 'unk', pending: true, open: true },
  COLLECTION: { label: 'Falha de coleta (não é falha do serviço)', tone: 'collect', pending: true, open: false },
  STALE_DATA: { label: 'Dado obsoleto', tone: 'stale', pending: true, open: false },
  STANDBY_EXPECTED: { label: 'Standby esperado (não é problema)', tone: 'standby', pending: false, open: false },
  INFO: { label: 'Informativo: verificações sem problema e limitações de escopo', tone: 'ok', pending: false, open: false },
};
export const pendingCount = (findings: VsiFindingView[]): number => findings.filter((f) => KIND_META[f.kind].pending).length;

export const ROLE_META: Record<VsiPathRole, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'ACESSO ATIVO', tone: 'active' },
  STANDBY_EXPECTED: { label: 'ACESSO EM STANDBY ESPERADO', tone: 'standby' },
  DOWN_UNEXPECTED: { label: 'ACESSO EM FALHA INESPERADA', tone: 'crit' },
  ROLE_UNKNOWN: { label: 'PAPEL DO ACESSO INDETERMINADO', tone: 'unk' },
};

export function serviceBadge(e: VsiEndpointView): { label: string; tone: Tone } {
  switch (e.serviceState) {
    case 'PROVEN_OK':
      return { label: 'SERVIÇO COMPROVADO', tone: 'ok' };
    case 'ENGINE_APPROVED':
      return { label: 'VERIFICAÇÕES DO LEGADO APROVADAS', tone: 'ok' };
    case 'ISSUE':
      return { label: 'SERVIÇO COM FALHA', tone: 'crit' };
    case 'STALE':
      return { label: `SERVIÇO ${e.vsi.value?.state ?? ''} EM ${shortDay(e.vsi.observedAt)}`.replace('  ', ' '), tone: 'stale' };
    case 'EXPECTED_DOWN':
      return { label: 'VSI DOWN ESPERADO (BACKUP)', tone: 'standby' };
    default:
      return { label: e.collection === 'NOT_READ' ? 'NÃO LIDO' : 'SERVIÇO NÃO CONFIRMADO', tone: 'unk' };
  }
}

export function endpointBadges(e: VsiEndpointView, engine: VsiServiceDiagnosis['engine']): Array<{ label: string; tone: Tone }> {
  const badges: Array<{ label: string; tone: Tone }> = [];
  if (e.accessRole) badges.push(ROLE_META[e.accessRole]);
  badges.push(serviceBadge(e));
  if (!e.accessRole && e.collection !== 'NOT_READ') {
    const read = e.eTrunks.length > 0 || e.ethTrunks.length > 0;
    badges.push(
      engine === 'LEGACY'
        ? { label: 'REDUNDÂNCIA NÃO AVALIADA', tone: 'stale' }
        : { label: read ? 'PAPEL DO ACESSO NÃO ATRIBUÍDO' : 'REDUNDÂNCIA NÃO LIDA', tone: 'unk' },
    );
  }
  return badges;
}

/* ------------------- coleta x evidencia x servico ------------------ */

export interface StatusCell {
  key: 'collection' | 'evidence' | 'service';
  label: string;
  tone: Tone;
  lines: string[];
  details: string[];
}

/**
 * Tres perguntas diferentes por ponta, nunca fundidas:
 *  coleta    = os comandos pedidos voltaram inteiros?
 *  evidencia = o que foi lido basta para classificar esta ponta?
 *  servico   = o que a leitura diz sobre VSI/AC/PW?
 * Coleta completa com evidencia suficiente NAO pede nova leitura, mesmo com a VSI down (Backup).
 */
export function endpointStatusCells(e: VsiEndpointView, d: VsiServiceDiagnosis): StatusCell[] {
  const live = d.evidence.filter((x) => x.hostName === e.hostName && x.source === 'LIVE_SSH');
  const done = live.filter((x) => x.complete).length;
  const count = live.length > 0 ? [`${done} de ${live.length} comando(s) com saída completa`] : [];
  const COLLECTION: Record<VsiEndpointView['collection'], { label: string; tone: Tone; lines: string[] }> = {
    READ: { label: 'COLETA COMPLETA', tone: 'ok', lines: count },
    PARTIAL: { label: 'COLETA PARCIAL', tone: 'collect', lines: count },
    FAILED: { label: 'COLETA FALHOU', tone: 'collect', lines: count },
    NOT_AUTHORIZED: { label: 'COLETA NÃO AUTORIZADA', tone: 'collect', lines: [] },
    NOT_READ: { label: 'NÃO LIDO NESTA EXECUÇÃO', tone: 'unk', lines: [] },
  };
  const state = vsiEndpointEvidenceState(e);
  const evidence: StatusCell =
    state === 'SUFFICIENT'
      ? { key: 'evidence', label: 'EVIDÊNCIA SUFICIENTE', tone: 'ok', lines: ['Basta para classificar esta ponta. Nenhuma nova leitura é necessária aqui.'], details: [] }
      : state === 'NONE'
        ? { key: 'evidence', label: 'SEM EVIDÊNCIA AO VIVO', tone: 'unk', lines: e.missingEvidence.length > 0 ? [`Falta ler: ${e.missingEvidence.join(' · ')}`] : [], details: [] }
        : {
            key: 'evidence',
            label: 'EVIDÊNCIA INSUFICIENTE',
            tone: 'unk',
            lines: e.missingEvidence.length > 0 ? [`Falta ler: ${e.missingEvidence.join(' · ')}`] : ['A leitura obtida não basta para classificar esta ponta.'],
            details: [],
          };
  const service = serviceBadge(e);
  return [
    { key: 'collection', ...COLLECTION[e.collection], details: [] },
    evidence,
    {
      key: 'service',
      label: service.label,
      tone: service.tone,
      lines: e.serviceState === 'EXPECTED_DOWN' ? ['Estado esperado do lado Backup. O encaminhamento do serviço se comprova no PE Master.'] : [],
      details: (e.notAssessed ?? []).map((n) => `Não avaliado (não é pendência de leitura): ${n}`),
    },
  ];
}
export const STATUS_ROWS: Array<{ key: StatusCell['key']; label: string }> = [
  { key: 'collection', label: 'Coleta' },
  { key: 'evidence', label: 'Evidência' },
  { key: 'service', label: 'Estado do serviço' },
];

/* ------------------------------ celulas ---------------------------- */

export interface OriginView {
  kind: 'ssh' | 'snmp' | 'none' | 'fail';
  label: string;
}
export interface CellEntry {
  tone: Tone;
  label: string;
  lines: string[];
  details: string[];
  origin: OriginView;
  evidenceId: string | null;
}
export type LayerKey = 'etrunk' | 'lag' | 'vsi' | 'ac' | 'pw' | 'mac';
export const LAYERS: Array<{ group: string; rows: Array<{ key: LayerKey; label: string }> }> = [
  { group: 'Redundância do acesso', rows: [{ key: 'etrunk', label: 'Papel E-Trunk' }, { key: 'lag', label: 'Eth-Trunk · LACP' }] },
  { group: 'Serviço', rows: [{ key: 'vsi', label: 'VSI' }, { key: 'ac', label: 'AC' }, { key: 'pw', label: 'Pseudowire' }, { key: 'mac', label: 'Aprendizado MAC' }] },
];

export function originOf(o: VsiObserved<unknown>): OriginView {
  if (o.basis === 'COLLECTION_FAILED') return { kind: 'fail', label: 'coleta falhou' };
  if (o.basis === 'LIVE_SSH' && o.value !== null) {
    const age = o.freshness === 'AGED' ? ' · envelhecida' : o.freshness === 'STALE' ? ' · antiga' : '';
    return { kind: 'ssh', label: `SSH ${formatInstant(o.observedAt, o.timePrecision)}${age}` };
  }
  if (o.inventoryHint)
    return { kind: 'snmp', label: `SNMP ${formatInstant(o.inventoryHint.observedAt)}${o.inventoryHint.stale ? ' · obsoleto' : ''}` };
  return { kind: 'none', label: 'não lido' };
}

const evidenceOf = (o: VsiObserved<unknown>): string | null => o.evidenceId ?? o.inventoryHint?.evidenceId ?? null;

function upDown(
  o: VsiObserved<VsiUpDown>,
  opts: { expectedDown?: boolean; stalePersisted?: boolean } = {},
): { tone: Tone; label: string } {
  const live = o.basis === 'LIVE_SSH' && o.value !== null;
  // Registro obsoleto do inventario e obsoleto qualquer que seja o resultado da coleta desta execucao.
  if (!live && opts.stalePersisted) return { tone: 'stale', label: 'OBSOLETO' };
  if (o.basis === 'COLLECTION_FAILED') return { tone: 'collect', label: 'FALHA DE COLETA' };
  if (live) {
    if (o.freshness === 'STALE') return { tone: 'stale', label: `${o.value} EM ${shortDay(o.observedAt)}` };
    if (o.value === 'UP') return { tone: 'ok', label: 'UP' };
    return opts.expectedDown ? { tone: 'standby', label: 'DOWN · ESPERADO' } : { tone: 'crit', label: 'DOWN' };
  }
  return { tone: 'unk', label: 'NÃO CONFIRMADO' };
}
const hintLine = (o: VsiObserved<VsiUpDown>, extra = ''): string[] =>
  o.inventoryHint ? [`inventário: ${o.inventoryHint.value.toLowerCase()}${extra}${o.inventoryHint.stale ? ' · não conta como estado atual' : ''}`] : [];
const NONE: OriginView = { kind: 'none', label: 'não lido' };

/** Verificacao em texto do motor (legado): mostrada como verificacao, nunca como estado lido do componente. */
const CHECK_META: Record<VsiEngineCheck['status'], { tone: Tone; label: string }> = {
  OK: { tone: 'ok', label: 'APROVADO · VERIFICAÇÃO DO LEGADO' },
  WARNING: { tone: 'warn', label: 'ATENÇÃO · VERIFICAÇÃO DO LEGADO' },
  FAILED: { tone: 'crit', label: 'FALHA · VERIFICAÇÃO DO LEGADO' },
  INSUFFICIENT_DATA: { tone: 'unk', label: 'DADO INSUFICIENTE · VERIFICAÇÃO DO LEGADO' },
};
function checkEntries(e: VsiEndpointView, layers: Array<VsiEngineCheck['layer']>): CellEntry[] {
  return (e.engineChecks ?? [])
    .filter((c) => layers.includes(c.layer))
    .map((c) => ({
      ...CHECK_META[c.status],
      lines: [c.label],
      details: [c.message, 'estado do componente não devolvido como dado estruturado'],
      origin: c.evidenceIds.length > 0 ? { kind: 'ssh' as const, label: 'SSH · via verificação' } : { kind: 'none' as const, label: 'sem evidência ligada' },
      evidenceId: c.evidenceIds[0] ?? null,
    }));
}
const compact = (list: Array<string | null | undefined | false>): string[] => list.filter((v): v is string => Boolean(v));

export function buildCell(key: LayerKey, e: VsiEndpointView, d: VsiServiceDiagnosis): CellEntry[] {
  const legacy = d.engine === 'LEGACY';
  const standby = e.accessRole === 'STANDBY_EXPECTED';
  const hostName = (hostId: string | null): string | null => d.endpoints.find((x) => x.hostId !== null && x.hostId === hostId)?.hostName ?? null;

  if (key === 'etrunk') {
    if (e.eTrunks.length === 0)
      return [{ tone: legacy ? 'stale' : 'unk', label: legacy ? 'NÃO AVALIADO' : 'NÃO LIDO', lines: [legacy ? 'O motor legado não lê E-Trunk' : 'Redundância não consultada'], details: [], origin: NONE, evidenceId: null }];
    return e.eTrunks.map((t) => {
      const live = t.state.basis === 'LIVE_SSH' && t.state.value !== null;
      const stale = t.state.freshness === 'STALE';
      const tone: Tone = !live ? 'unk' : stale ? 'stale' : t.state.value === 'MASTER' ? 'active' : t.state.value === 'BACKUP' ? 'standby' : 'warn';
      return {
        tone,
        label: !live ? 'NÃO LIDO' : stale ? `${t.state.value} EM ${shortDay(t.state.observedAt)}` : String(t.state.value),
        lines: [compact([`E-Trunk ${t.id}`, t.peerIp && `peer ${t.peerIp}`, t.causation && `causa ${t.causation}`, t.priority !== null && t.peerPriority !== null && `prioridade ${t.priority} contra ${t.peerPriority} do par`]).join(' · ')],
        details: compact([t.detail]),
        origin: originOf(t.state),
        evidenceId: evidenceOf(t.state),
      };
    });
  }

  if (key === 'lag') {
    if (e.ethTrunks.length === 0) {
      const checks = checkEntries(e, ['lag']);
      if (checks.length > 0) return checks;
      const carriers = [...new Set(e.acs.map((a) => a.carrier).filter((c): c is string => Boolean(c)))];
      return [{ tone: legacy ? 'stale' : 'unk', label: legacy ? 'NÃO AVALIADO' : 'NÃO LIDO', lines: [carriers.length > 0 ? `${carriers.join(', ')} transporta o AC; estado LACP não lido` : 'Sem leitura direta'], details: [], origin: NONE, evidenceId: null }];
    }
    return e.ethTrunks.map((t) => {
      const count = `${t.selected ?? '?'}/${t.members.length} em uso`;
      const meta: Record<VsiPathRole, { tone: Tone; label: string }> = {
        ACTIVE: { tone: 'ok', label: `EM OPERAÇÃO · ${count}` },
        STANDBY_EXPECTED: { tone: 'standby', label: `STANDBY ESPERADO · ${count}` },
        DOWN_UNEXPECTED: { tone: 'crit', label: `FALHA INESPERADA · ${count}` },
        ROLE_UNKNOWN: { tone: 'unk', label: `PAPEL INDETERMINADO · ${count}` },
      };
      const stale = t.operStatus.freshness === 'STALE';
      return {
        tone: stale ? 'stale' : meta[t.role].tone,
        label: stale ? `LEITURA DE ${shortDay(t.operStatus.observedAt)}` : meta[t.role].label,
        lines: [compact([t.name, t.operStatus.value && `Operate status ${t.operStatus.value.toLowerCase()}`, t.workingMode && `modo ${t.workingMode}`]).join(' · ')],
        details: compact([
          t.members.map((m) => `${m.port} ${m.status ?? '?'}`).join(', '),
          t.eTrunkId !== null && `membro do E-Trunk ${t.eTrunkId}${t.memberCausation ? `, causa ${t.memberCausation}` : ''}${t.remoteEthTrunkId !== null ? ` · par remoto Eth-Trunk${t.remoteEthTrunkId}` : ''}`,
          t.detail,
        ]),
        origin: originOf(t.operStatus),
        evidenceId: evidenceOf(t.operStatus),
      };
    });
  }

  if (key === 'vsi') {
    const { inventoryHint: vsiHint, ...vsiRest } = e.vsi;
    const state: VsiObserved<VsiUpDown> = {
      ...vsiRest,
      value: e.vsi.value?.state ?? null,
      ...(vsiHint ? { inventoryHint: { ...vsiHint, value: vsiHint.value.state } } : {}),
    };
    const v = e.vsi.value;
    const h = e.vsi.inventoryHint?.value;
    return [{
      ...upDown(state, { expectedDown: standby }),
      lines: [v ? compact([v.signaling && `sinalização ${v.signaling}`, v.encapsulation && `encapsulamento ${v.encapsulation}`, v.mtu !== null && `MTU ${v.mtu}`]).join(' · ') || 'Lida diretamente' : 'Sem leitura direta'],
      details: compact([v?.rd && `RD ${v.rd}`, ...hintLine(state, compact([h?.mtu != null && ` · MTU ${h.mtu}`, h?.rd && ` · RD ${h.rd}`]).join(''))]),
      origin: originOf(e.vsi),
      evidenceId: evidenceOf(e.vsi),
    }];
  }

  if (key === 'ac') {
    if (e.acs.length === 0) {
      const checks = checkEntries(e, ['ac', 'interface']);
      if (checks.length > 0) return checks;
    }
    if (e.acs.length === 0)
      return [{ tone: 'unk', label: 'NÃO CONFIRMADO', lines: [legacy ? 'O motor legado não devolve a lista de ACs' : 'Nenhum AC conhecido para esta ponta'], details: [], origin: NONE, evidenceId: null }];
    return e.acs.map((a) => ({
      ...upDown(a.state, { expectedDown: standby || a.role === 'STANDBY_EXPECTED' }),
      lines: [compact([a.interfaceName, a.blocked === false && 'desbloqueado', a.blocked === true && 'BLOQUEADO', a.state.value === null && 'sem leitura direta']).join(' · ')],
      details: compact([a.vlan && `VLAN ${a.vlan}`, a.detail, ...hintLine(a.state)]),
      origin: originOf(a.state),
      evidenceId: evidenceOf(a.state),
    }));
  }

  if (key === 'pw') {
    if (e.pws.length === 0)
      return [{ tone: 'unk', label: 'NÃO CONFIRMADO', lines: ['Nenhum PW conhecido para esta ponta'], details: [], origin: NONE, evidenceId: null }];
    return e.pws.map((p) => ({
      ...upDown(p.state, { expectedDown: standby, stalePersisted: p.stale }),
      lines: [compact([p.peerAddress || hostName(p.peerHostId) || 'peer não identificado', p.state.value === null && !p.stale && 'sem leitura direta']).join(' · ')],
      details: compact([
        p.localLabel !== null && p.remoteLabel !== null && `labels ${p.localLabel} / ${p.remoteLabel}`,
        p.tunnel && `túnel ${p.tunnel}`,
        p.detail,
        ...hintLine(p.state),
      ]),
      origin: originOf(p.state),
      evidenceId: evidenceOf(p.state),
    }));
  }

  // mac
  const m = e.mac.value;
  if (e.mac.basis !== 'LIVE_SSH' || !m)
    return [
      legacy
        ? { tone: 'stale', label: 'NÃO AVALIADO', lines: ['O motor legado não coleta a tabela MAC'], details: [], origin: NONE, evidenceId: null }
        : standby
          ? { tone: 'standby', label: 'NÃO ESPERADO', lines: ['Sem aprendizado esperado enquanto em Backup'], details: ['tabela não coletada'], origin: NONE, evidenceId: null }
          : { tone: 'unk', label: 'NÃO LIDO', lines: ['Tabela não coletada'], details: [], origin: NONE, evidenceId: null },
    ];
  const stale = e.mac.freshness === 'STALE';
  return [{
    tone: m.viaUnresolved > 0 ? 'unk' : stale ? 'stale' : 'ok',
    label: stale ? `LIDO EM ${shortDay(e.mac.observedAt)}` : m.viaUnresolved > 0 ? 'APRENDENDO · ORIGEM NÃO CLASSIFICADA' : 'APRENDENDO',
    lines: [`${m.total} MAC(s): ${Object.entries(m.byLearnedFrom).map(([k, n]) => `${n} em ${k}`).join(' · ')}`],
    details: compact([
      `${m.viaAc} pelo AC · ${m.viaPw} pelo PW${m.viaUnresolved > 0 ? ` · ${m.viaUnresolved} de origem não classificada` : ''}`,
      m.viaUnresolved > 0 ? 'interface de aprendizado preservada como o equipamento mostrou; não é presumida AC nem PW' : null,
    ]),
    origin: originOf(e.mac),
    evidenceId: evidenceOf(e.mac),
  }];
}

/* --------------------------- achados/passos ------------------------ */

export function stepsForFinding(f: VsiFindingView, steps: VsiNextStep[]): Array<{ step: VsiNextStep; number: number }> {
  return steps
    .map((step, i) => ({ step, number: i + 1 }))
    .filter(({ step }) => f.nextStepIds.includes(step.id) || step.reasonFindingIds.includes(f.id));
}

const CERTAINTY: Record<VsiFindingView['certainty'], string> = {
  CONFIRMED: 'confirmado',
  PROBABLE: 'provável',
  HYPOTHESIS: 'hipótese',
  INCONCLUSIVE: 'inconclusivo',
};
export const certaintyText = (f: VsiFindingView): string => `Fato: ${CERTAINTY[f.certainty]} · Consequência: ${CERTAINTY[f.impactCertainty]}`;

/** Titulo comum quando o mesmo codigo se repete em varios PEs. */
export const GROUP_TITLE: Record<string, string> = {
  ENDPOINT_SERVICE_NOT_READ: 'VSI, AC e PW não foram lidos diretamente',
  PATH_DOWN_UNEXPECTED: 'Caminho de acesso em falha inesperada',
  COLLECTION_OUTPUT_INCOMPLETE: 'Saída incompleta na coleta',
  COLLECTION_OPERATION_SKIPPED: 'Operação não executada na coleta',
  VSI_EVIDENCE_MISSING: 'Saída da VSI ausente ou incompleta',
};
export const ORIGIN_LABEL: Record<VsiServiceDiagnosis['origin'], string> = {
  ENGINE_RUN: 'execução real',
  LEGACY_JOB: 'job do motor legado',
  REPLAY: 'replay: motor real sobre capturas gravadas, sem SSH',
  FIXTURE: 'fixture montada à mão',
};

export const ENGINE_LABEL: Record<VsiServiceDiagnosis['engine'], string> = { VSI_MCP: 'VSI/MCP', LEGACY: 'Legado' };
export const READING_KIND: Record<VsiServiceDiagnosis['readings'][number]['kind'], string> = {
  SSH_SESSION: 'Sessão SSH',
  MANUAL_SSH_CAPTURE: 'Captura SSH manual',
  SNMP_CYCLE: 'Inventário SNMP',
};
