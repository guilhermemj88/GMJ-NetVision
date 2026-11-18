import {
  composeVsiServiceDiagnosis,
  type MplsVsi,
  type VsiEndpointInput,
  type VsiEvidenceRef,
  type VsiFindingComponent,
  type VsiFindingView,
  type VsiNextStep,
  type VsiObserved,
  type VsiPathRole,
  type VsiPwLinkView,
  type VsiReading,
  type VsiResultOrigin,
  type VsiServiceComposeInput,
  type VsiServiceDiagnosis,
  type VsiUpDown,
} from '@gmj/shared';
import type { ToolEnvelope } from '../vsi-mcp/contracts';
import type { EndpointDiagnosis, EndpointFacts, Finding } from '../vsi-mcp/correlator';
import { isPersistedPwStale } from '../vsi-mcp/redundancy';

/**
 * Agregacao multi-PE: junta os envelopes de `diagnose_vsi` (um por PE) e o inventario persistido
 * num unico `VsiServiceDiagnosis`.
 *
 * NAO reclassifica nada: papeis, achados e severidades sao os do motor. Esta camada so
 *  - posiciona cada fato com sua origem (leitura direta, inventario, nao lido, coleta falhou);
 *  - mantem TODO participante descoberto, lido ou nao;
 *  - transforma problemas de coleta em achados de COLETA (nunca em falha do servico);
 *  - deixa eixos e veredito para `composeVsiServiceDiagnosis`.
 */

/** O que `diagnose_vsi` devolve em `data` (campos `facts` e `collectionIssues` sao os acrescimos aditivos). */
export interface DiagnoseVsiData {
  diagnosis: EndpointDiagnosis;
  platform: unknown;
  sessionsOpened: number;
  facts?: Pick<EndpointFacts, 'vsi' | 'interfaces' | 'evidenceIds'> & {
    carriers: NonNullable<EndpointFacts['carriers']>;
    vlan: EndpointFacts['vlan'] | null;
    redundancy: EndpointFacts['redundancy'] | null;
    persistedAcs: string[] | null;
    persistedPws: EndpointFacts['persistedPws'] | null;
  };
}

export interface AggregateParticipant {
  hostId: string | null;
  hostName: string;
  loopback: string | null;
  discoveredBy: VsiEndpointInput['discoveredBy'];
  /** Resultado de `diagnose_vsi` neste PE; null = nao executado. */
  envelope: ToolEnvelope<DiagnoseVsiData> | null;
  /** Motivo de nao haver envelope. */
  notRead?: 'NOT_REQUESTED' | 'NOT_AUTHORIZED' | 'FAILED';
  notReadDetail?: string;
  /** Registro do inventario (SNMP) da VSI neste PE, se existir. */
  inventory: MplsVsi | null;
}

export interface AggregateInput {
  runId: string;
  engineVersion: string;
  origin: VsiResultOrigin;
  vsiName: string;
  operator: { username: string; role: string } | null;
  startedAt: string;
  completedAt: string;
  demonstration?: { label: string; provenance: string } | null;
  participants: AggregateParticipant[];
}

const upDown = (v: string | null | undefined): VsiUpDown | null => (v === 'UP' ? 'UP' : v === 'DOWN' ? 'DOWN' : null);

function componentOf(code: string): VsiFindingComponent {
  if (code.startsWith('PERSISTED_')) return 'INVENTORY';
  if (code.startsWith('MAC_') || code.startsWith('NO_MAC')) return 'MAC';
  if (code.startsWith('ETRUNK_') || code.startsWith('REDUNDANCY_') || code === 'STANDBY_PATH_IDLE' || code === 'PATH_ROLE_UNKNOWN') return 'E_TRUNK';
  if (code.startsWith('TRUNK_')) return 'ETH_TRUNK';
  if (code.startsWith('PW_') || code === 'ALL_PW_DOWN') return 'PW';
  if (code.startsWith('AC_') || code === 'NO_AC' || code.startsWith('DUPLICATE_BINDING')) return 'AC';
  if (code.startsWith('VLAN_') || code.startsWith('ENCAPSULATION_') || code.startsWith('TAG_') || code.startsWith('CARRIER_') || code.startsWith('TRAFFIC_')) return 'ENCAPSULATION';
  if (code.startsWith('COMPARISON_')) return 'COLLECTION';
  return 'VSI';
}

function inventoryText(p: AggregateParticipant, v: MplsVsi): string {
  return [
    'Inventário SNMP (banco do NetVision) — não é saída de equipamento',
    `VSI ${v.name} @ ${p.hostName}`,
    `  leitura: ${v.lastSeenAt}`,
    `  operationalStatus: ${v.operationalStatus}   mtu: ${v.mtu ?? '—'}   rd: ${v.rd ?? '—'}`,
    ...v.acs.map((a) => `  AC  ${a.interface?.name ?? `ifIndex ${a.ifIndex}`}   status ${a.status}   lido ${a.lastSeenAt}`),
    ...v.pws.map((w) => `  PW  ${w.remoteIp}   state ${w.state}   labels ${w.inboundLabel ?? '—'} / ${w.outboundLabel ?? '—'}   lido ${w.lastSeenAt}`),
  ].join('\n');
}

export function aggregateVsiService(input: AggregateInput): VsiServiceDiagnosis {
  const readings: VsiReading[] = [];
  const evidence: VsiEvidenceRef[] = [];
  const findings: Array<Omit<VsiFindingView, 'kind'>> = [];
  const nextSteps: VsiNextStep[] = [];
  const hostByLoopback = new Map(input.participants.filter((p) => p.loopback && p.hostId).map((p) => [p.loopback!, p.hostId!]));
  const hostIdOfPeer = (address: string, hinted?: string | null): string | null => hinted ?? hostByLoopback.get(address) ?? null;

  const endpoints: VsiEndpointInput[] = input.participants.map((p) => {
    const key = p.hostId ?? p.hostName;
    const env = p.envelope;
    const data = env?.data ?? null;
    const facts = data?.facts ?? null;
    const diagnosis = data?.diagnosis ?? null;

    // --- leituras e evidencias ---
    let sshReading: string | null = null;
    if (env && env.evidence.some((e) => e.source === 'LIVE_SSH')) {
      sshReading = `ssh-${key}`;
      const live = env.evidence.filter((e) => e.source === 'LIVE_SSH');
      readings.push({
        id: sshReading,
        kind: 'SSH_SESSION',
        hostId: p.hostId,
        hostName: p.hostName,
        startedAt: live.map((e) => e.collectedAt).sort()[0] ?? env.generatedAt,
        inThisRun: true,
        outcome: env.status === 'ERROR' ? 'FAILED' : env.collectionIssues.length > 0 ? 'PARTIAL' : 'OK',
        scope: `${live.length} comando(s) somente leitura · ${data?.sessionsOpened ?? 1} sessão(ões)`,
      });
      for (const e of live)
        evidence.push({
          id: e.id,
          readingId: sshReading,
          hostId: p.hostId,
          hostName: p.hostName,
          source: 'LIVE_SSH',
          command: e.command,
          collectedAt: e.collectedAt,
          observedAt: e.collectedAt,
          complete: e.complete,
          bytes: e.bytes,
          sha256: e.sha256,
          output: e.excerpt,
          outputTruncated: e.excerpt !== null && e.bytes > Buffer.byteLength(e.excerpt),
          note: e.excerpt !== null && e.bytes > Buffer.byteLength(e.excerpt) ? `Trecho: início da saída (${e.bytes} bytes no total). O sha256 é da saída inteira.` : null,
        });
    }
    let invReading: string | null = null;
    let invEvidence: string | null = null;
    if (p.inventory) {
      invReading = `inv-${key}`;
      invEvidence = `inv:${key}`;
      readings.push({ id: invReading, kind: 'SNMP_CYCLE', hostId: p.hostId, hostName: p.hostName, startedAt: p.inventory.lastSeenAt, inThisRun: false, outcome: 'OK', scope: 'inventário: VSI, AC, PW' });
      const text = inventoryText(p, p.inventory);
      evidence.push({
        id: invEvidence,
        readingId: invReading,
        hostId: p.hostId,
        hostName: p.hostName,
        source: 'PERSISTED_SNMP',
        command: null,
        collectedAt: p.inventory.lastSeenAt,
        observedAt: p.inventory.lastSeenAt,
        complete: true,
        bytes: Buffer.byteLength(text),
        sha256: null,
        output: text,
        note: 'Registro do banco do NetVision. Não é saída de equipamento e não comprova o estado atual.',
      });
    }
    const evidenceIds = new Set(evidence.map((e) => e.id));
    const evId = (id: string | undefined | null): string | null => (id && evidenceIds.has(id) ? id : null);
    const at = (id: string | null): string | null => evidence.find((e) => e.id === id)?.collectedAt ?? env?.generatedAt ?? null;
    const live = <T>(value: T, evidenceId: string | null): VsiObserved<T> => ({ value, basis: 'LIVE_SSH', readingId: sshReading, evidenceId, observedAt: at(evidenceId), freshness: null });
    const absent = <T>(hint?: { value: T; observedAt: string; stale?: boolean }, failed = false): VsiObserved<T> => ({
      value: null,
      basis: failed ? 'COLLECTION_FAILED' : 'NOT_READ',
      readingId: hint ? invReading : null,
      evidenceId: null,
      observedAt: null,
      freshness: null,
      ...(hint ? { inventoryHint: { value: hint.value, observedAt: hint.observedAt, stale: hint.stale ?? false, evidenceId: invEvidence } } : {}),
    });

    // --- VSI ---
    const inv = p.inventory;
    const invState = inv ? upDown(inv.operationalStatus) : null;
    const vsiEv = evId(facts?.evidenceIds.vsi);
    const vsiFailed = !!env && !facts?.vsi && env.evidence.some((e) => (e.command ?? '').startsWith('display vsi name'));
    const invVsiHint = inv && invState ? { value: { state: invState, signaling: null, encapsulation: null, mtu: inv.mtu, rd: inv.rd }, observedAt: inv.lastSeenAt } : undefined;
    const vsi: VsiEndpointInput['vsi'] =
      facts?.vsi && facts.vsi.state
        ? live({ state: facts.vsi.state, signaling: facts.vsi.signaling, encapsulation: facts.vsi.encapsulationType, mtu: facts.vsi.mtu, rd: facts.vsi.rd }, vsiEv)
        : absent(invVsiHint, vsiFailed);

    const roleOf = (kind: 'AC' | 'ETH_TRUNK', name: string): VsiPathRole | null => diagnosis?.pathRoles?.find((r) => r.kind === kind && r.name === name)?.role ?? null;

    // --- ACs ---
    const acs: VsiEndpointInput['acs'] = facts?.vsi
      ? facts.vsi.acs.map((a) => ({
          interfaceName: a.interfaceName,
          state: a.state ? live(a.state, vsiEv) : absent<VsiUpDown>(),
          blocked: a.acBlockState === null ? null : !/unblock/i.test(a.acBlockState),
          role: roleOf('AC', a.interfaceName),
          carrier: facts.interfaces[a.interfaceName]?.parentInterface ?? null,
          vlan: null,
          detail: facts.interfaces[a.interfaceName] ? null : 'configuração da interface não coletada',
        }))
      : (inv?.acs ?? []).map((a) => {
          const state = upDown(a.status);
          return {
            interfaceName: a.interface?.name ?? `ifIndex ${a.ifIndex}`,
            state: absent<VsiUpDown>(state ? { value: state, observedAt: a.lastSeenAt } : undefined, vsiFailed),
            blocked: null,
            role: null,
            carrier: null,
            vlan: null,
          };
        });

    // --- PWs: os lidos; do inventario, so os que a leitura direta NAO trouxe ---
    const livePws: VsiEndpointInput['pws'] = (facts?.vsi?.pws ?? []).map((w) => ({
      peerAddress: w.peerAddress,
      peerHostId: hostIdOfPeer(w.peerAddress),
      state: w.state ? live(w.state, vsiEv) : absent<VsiUpDown>(),
      localLabel: w.localLabel,
      remoteLabel: w.remoteLabel,
      tunnel: w.tunnelType,
      stale: false,
      detail: w.macFlapping != null ? `MAC flapping ${w.macFlapping}` : null,
    }));
    const invPws: VsiEndpointInput['pws'] = (inv?.pws ?? [])
      .filter((w) => !livePws.some((l) => l.peerAddress === w.remoteIp))
      .map((w) => {
        const stale = isPersistedPwStale(w.lastSeenAt, inv!.lastSeenAt);
        const state = upDown(w.state);
        return {
          peerAddress: w.remoteIp,
          peerHostId: hostIdOfPeer(w.remoteIp, w.remoteHostId),
          state: absent<VsiUpDown>(state ? { value: state, observedAt: w.lastSeenAt, stale } : undefined, vsiFailed && !facts?.vsi),
          localLabel: w.inboundLabel,
          remoteLabel: w.outboundLabel,
          tunnel: null,
          stale,
          detail: stale ? 'registro mais antigo que a leitura da própria VSI no inventário' : facts?.vsi ? 'consta só no inventário; a leitura direta da VSI não trouxe este PW' : null,
        };
      });

    // --- redundancia ---
    const red = facts?.redundancy ?? null;
    const eTrunkEv = (id: number): string | null => evId(red?.evidenceIds?.eTrunks?.[id]);
    const eTrunks: VsiEndpointInput['eTrunks'] = Object.entries(red?.eTrunks ?? {}).map(([id, t]) => ({
      id: Number(id),
      state: t.state ? live(t.state, eTrunkEv(Number(id))) : absent<'MASTER' | 'BACKUP' | 'INITIALIZE'>(),
      causation: t.causation,
      priority: t.priority,
      peerPriority: t.peerPriority,
      peerIp: t.peerIp,
      members: t.members.map((m) => ({ interfaceName: m.interfaceName, state: m.state, causation: m.causation, remoteId: m.remoteId })),
      detail: compactText([t.bfdSession && `BFD ${t.bfdSession}`, t.revertDelaySeconds !== null && `revert-delay ${t.revertDelaySeconds} s`, t.members.length === 0 && 'tabela de membros não lida (só o resumo)']),
    }));
    const ethTrunks: VsiEndpointInput['ethTrunks'] = Object.entries(red?.ethTrunks ?? {}).map(([name, t]) => {
      const cfg = facts?.carriers[name];
      const member = Object.values(red?.eTrunks ?? {}).flatMap((e) => e.members).find((m) => m.interfaceName === name);
      return {
        name,
        operStatus: t.operStatus ? live(t.operStatus, evId(red?.evidenceIds?.ethTrunks?.[name])) : absent<VsiUpDown>(),
        workingMode: t.workingMode,
        selected: t.workingMode === 'LACP' ? t.members.filter((m) => m.status === 'SELECTED').length : t.upPorts,
        members: t.members.map((m) => ({ port: m.portName, status: m.status })),
        eTrunkId: cfg?.eTrunkId ?? null,
        remoteEthTrunkId: cfg?.remoteEthTrunkId ?? member?.remoteId ?? null,
        role: roleOf('ETH_TRUNK', name) ?? 'ROLE_UNKNOWN',
        memberCausation: member?.causation ?? null,
        detail: cfg ? null : 'configuração do trunk não coletada ou incompleta',
      };
    });

    // --- MAC ---
    const macEv = evId(facts?.evidenceIds.macs);
    const m = diagnosis?.macSummary ?? null;
    const mac: VsiEndpointInput['mac'] = m
      ? live({ total: m.total, viaAc: m.viaAc, viaPw: m.viaPw, viaUnresolved: m.viaUnresolved, byLearnedFrom: m.byLearnedFrom }, macEv)
      : absent(undefined, diagnosis?.coverage.mac === 'MISSING');

    // --- achados do motor (texto e severidade intactos) ---
    (diagnosis?.findings ?? []).forEach((f: Finding, i) =>
      findings.push({
        id: `${key}:${f.code}:${i}`,
        code: f.code,
        severity: f.severity,
        certainty: f.certainty,
        impactCertainty: f.impactCertainty,
        origin: 'ENGINE',
        hostId: p.hostId,
        hostName: p.hostName,
        component: componentOf(f.code),
        title: f.title,
        explanation: f.explanation,
        caveat: f.caveat,
        evidenceIds: f.evidence.filter((id) => evidenceIds.has(id)),
        nextStepIds: [],
      }),
    );

    // --- problemas de COLETA: achados proprios, nunca falha do servico ---
    (env?.collectionIssues ?? []).forEach((issue, i) => {
      const code = issue.code === 'OUTPUT_INCOMPLETE' ? 'COLLECTION_OUTPUT_INCOMPLETE' : issue.code === 'OPERATION_SKIPPED' ? 'COLLECTION_OPERATION_SKIPPED' : 'COLLECTION_COMMAND_FAILED';
      findings.push({
        id: `${key}:collect:${i}`,
        code,
        severity: 'INFO',
        certainty: 'CONFIRMED',
        impactCertainty: 'INCONCLUSIVE',
        origin: 'ENGINE',
        hostId: p.hostId,
        hostName: p.hostName,
        component: 'COLLECTION',
        title:
          issue.code === 'OUTPUT_INCOMPLETE'
            ? `Saída incompleta: ${issue.command ?? 'comando'}`
            : issue.code === 'OPERATION_SKIPPED'
              ? `Operação não executada: ${issue.command ?? ''}`
              : 'Falha na sessão de coleta',
        explanation: issue.detail,
        caveat: 'Problema de coleta. Não diz nada sobre o estado do serviço.',
        evidenceIds: issue.evidenceId && evidenceIds.has(issue.evidenceId) ? [issue.evidenceId] : [],
        nextStepIds: [],
      });
    });
    if (!env && p.notRead && p.notRead !== 'NOT_REQUESTED')
      findings.push({
        id: `${key}:collect:not-run`,
        code: p.notRead === 'NOT_AUTHORIZED' ? 'COLLECTION_NOT_AUTHORIZED' : 'COLLECTION_COMMAND_FAILED',
        severity: 'INFO',
        certainty: 'CONFIRMED',
        impactCertainty: 'INCONCLUSIVE',
        origin: 'AGGREGATOR',
        hostId: p.hostId,
        hostName: p.hostName,
        component: 'COLLECTION',
        title: p.notRead === 'NOT_AUTHORIZED' ? `Leitura não autorizada em ${p.hostName}` : `Leitura não executada em ${p.hostName}`,
        explanation: p.notReadDetail ?? 'O diagnóstico deste PE não foi executado.',
        caveat: 'Problema de coleta. Não diz nada sobre o estado do serviço.',
        evidenceIds: [],
        nextStepIds: [],
      });

    // --- passo sugerido para todo PE cujo servico nao foi lido ---
    if (!facts?.vsi)
      nextSteps.push({
        id: `step-read-${key}`,
        hostId: p.hostId,
        hostName: p.hostName,
        title: 'Ler a VSI diretamente neste PE',
        command: `display vsi name ${input.vsiName} verbose`,
        homologated: null,
        reason: env ? 'A leitura da VSI não foi obtida nesta execução.' : 'Este PE participa do serviço e não foi lido.',
        // aponta para o achado do motor (saida da VSI ausente) quando existe; senao, para o achado da composicao
        reasonFindingIds: [findings.find((f) => f.code === 'VSI_EVIDENCE_MISSING' && f.hostName === p.hostName)?.id ?? `agg-not-read-${key}`],
        evidenceIds: invEvidence ? [invEvidence] : [],
      });

    const DIMENSION: Record<string, string> = { VSI_STATE: 'estado da VSI', AC_STATE: 'estado do AC', PW_STATE: 'estado dos PWs', AC_BINDING: 'binding do AC', MAC_LEARNING: 'aprendizado MAC', ENCAPSULATION: 'encapsulamento' };
    // Dimensao NOT_EVALUATED nem sempre e leitura pendente. Numa ponta em standby comprovado, estado de VSI/AC/PW
    // e MAC nao sao avaliados porque o down e esperado; MAC nao solicitado e escolha da execucao. So o restante
    // e evidencia que falta ler.
    const dims = diagnosis ? Object.entries(diagnosis.dimensions).filter(([, v]) => v === 'NOT_EVALUATED').map(([k]) => k) : [];
    const standby = diagnosis?.operationalRole === 'STANDBY_EXPECTED';
    const byStandby = standby ? dims.filter((k) => ['VSI_STATE', 'AC_STATE', 'PW_STATE', 'MAC_LEARNING'].includes(k)) : [];
    const macNotRequested = !standby && dims.includes('MAC_LEARNING') && diagnosis?.coverage.mac === 'NOT_REQUESTED';
    const pending = dims.filter((k) => !byStandby.includes(k) && !(macNotRequested && k === 'MAC_LEARNING')).map((k) => DIMENSION[k] ?? k);
    const notEvaluated = pending.length > 0 ? [`não avaliado pelo motor: ${pending.join(', ')}`] : [];
    const notAssessed = [
      ...(byStandby.length > 0
        ? [`${byStandby.map((k) => DIMENSION[k] ?? k).join(', ')}: ponta em standby comprovado; o down é esperado e o encaminhamento só se comprova no PE Master`]
        : []),
      ...(macNotRequested ? ['aprendizado MAC: não solicitado nesta execução'] : []),
    ];
    return {
      hostId: p.hostId,
      hostName: p.hostName,
      platform: typeof data?.platform === 'object' && data.platform !== null && 'family' in data.platform ? String((data.platform as { family: unknown }).family) : null,
      loopback: p.loopback,
      discoveredBy: p.discoveredBy,
      collection: !env
        ? p.notRead === 'NOT_AUTHORIZED'
          ? 'NOT_AUTHORIZED'
          : p.notRead === 'FAILED'
            ? 'FAILED'
            : 'NOT_READ'
        : env.status === 'ERROR' || !diagnosis
          ? 'FAILED'
          : // COLETA, nao conclusao: so e parcial quando algum comando falhou/veio incompleto ou a VSI nao foi lida.
            // O `status` INCONCLUSIVE do motor fala do diagnostico e nao rebaixa uma coleta que terminou inteira.
            env.collectionIssues.length > 0 || !facts?.vsi
            ? 'PARTIAL'
            : 'READ',
      // O motor so correlaciona papel quando leu a VSI. Se E-Trunk/LACP foram lidos e ele nao atribuiu papel,
      // o papel da ponta e DESCONHECIDO (nunca ativo/standby por inferencia desta camada).
      accessRole: diagnosis?.operationalRole ?? (eTrunks.length > 0 || ethTrunks.length > 0 ? 'ROLE_UNKNOWN' : null),
      vsi,
      acs,
      pws: [...livePws, ...invPws],
      ethTrunks,
      eTrunks,
      mac,
      missingEvidence: [
        ...new Set([
          ...(diagnosis?.pathRoles ?? []).flatMap((r) => r.missingEvidence),
          ...(!diagnosis?.operationalRole && (eTrunks.length > 0 || ethTrunks.length > 0) ? [`display vsi name ${input.vsiName} verbose (sem ela o papel ativo/standby não é correlacionado)`] : []),
          ...notEvaluated,
          ...(env ? [] : ['toda a leitura ao vivo desta ponta']),
        ]),
      ],
      ...(notAssessed.length > 0 ? { notAssessed } : {}),
    };
  });

  // --- PWs entre participantes (um link por par) ---
  const links: VsiPwLinkView[] = [];
  for (const e of endpoints)
    for (const pw of e.pws) {
      const b = endpoints.find((o) => o.hostId !== null && o.hostId === pw.peerHostId) ?? null;
      const seen = links.some((l) => (l.aHostId === e.hostId && l.bAddress === pw.peerAddress) || (b !== null && l.aHostId === b.hostId && l.bHostId === e.hostId));
      if (seen) continue;
      const back = b?.pws.find((x) => x.peerHostId === e.hostId || (e.loopback !== null && x.peerAddress === e.loopback)) ?? null;
      const a = pw.state.value;
      const r = back?.state.value ?? null;
      links.push({
        aHostId: e.hostId,
        bHostId: b?.hostId ?? null,
        bAddress: pw.peerAddress,
        state: pw.stale ? 'STALE' : a === null ? 'NOT_CONFIRMED' : a === 'UP' && r === 'UP' ? 'UP_BOTH' : a === 'DOWN' && r !== 'UP' ? 'DOWN' : 'UP_ONE_SIDE',
        labelsMatch:
          back && pw.localLabel !== null && pw.remoteLabel !== null && back.localLabel !== null && back.remoteLabel !== null
            ? pw.localLabel === back.remoteLabel && pw.remoteLabel === back.localLabel
            : null,
        findingIds: [],
      });
    }

  // os passos apontam para o achado "nao lido" que a composicao cria; se o PE foi lido, o passo nao existe
  const compose: VsiServiceComposeInput = {
    engine: 'VSI_MCP',
    engineVersion: input.engineVersion,
    runId: input.runId,
    origin: input.origin,
    vsiName: input.vsiName,
    operator: input.operator,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    demonstration: input.demonstration ?? null,
    endpoints,
    links,
    findings,
    nextSteps,
    readings,
    evidence,
  };
  return composeVsiServiceDiagnosis(compose);
}

function compactText(parts: Array<string | false | null | undefined>): string | null {
  const kept = parts.filter((v): v is string => Boolean(v));
  return kept.length > 0 ? kept.join(' · ') : null;
}
