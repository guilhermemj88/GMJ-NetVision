import type { AuthUser, HostRecord, MplsVsi } from '@gmj/shared';
import type { HostRepository } from '../../persistence/host-repository';
import type { MplsRepository } from '../mpls-repository';
import {
  VSI_MCP_TOOLS,
  approvalScope,
  type ToolCollectionIssue,
  type ToolEnvelope,
  type ToolInput,
  type ToolError,
  type ToolEvidence,
  type ToolStatus,
  type VsiMcpToolName,
} from './contracts';
import type { VsiMcpOperation } from './command-policy';
import {
  compareEndpoints,
  diagnoseEndpoint,
  acVlanTransform,
  type EndpointFacts,
} from './correlator';
import {
  VsiMcpLiveError,
  type LiveCapture,
  type LiveSessionResult,
  type SkippedOperation,
  type VsiMcpLiveCollector,
} from './live-collector';
import { VsiMcpProfileError } from './access-profile';
import { parseInterfaceConfig, parseMacTable, parseVlanInfo, parseVsiList, parseVsiVerbose } from './parsers';
import { eTrunkFromBrief, isPersistedPwStale, normalizeRd, parseETrunk, parseETrunkBrief, parseEthTrunk, type RedundancyFacts } from './redundancy';
import { VsiMcpPolicyError } from './command-policy';

type Operator = Pick<AuthUser, 'id' | 'username' | 'role'>;

/** Entrada comum das ferramentas que leem uma VSI ao vivo (campos opcionais por ferramenta). */
type LiveViewInput = ToolInput<'get_vsi_details'> &
  Partial<Pick<ToolInput<'diagnose_vsi'>, 'includeMac' | 'interfaces' | 'homologation' | 'vlanId' | 'carrierInterfaces' | 'eTrunkIds'>> &
  Partial<Pick<ToolInput<'get_vsi_mac_table'>, 'maxEntries'>>;

export interface VsiMcpDeps {
  hosts: Pick<HostRepository, 'getHost'>;
  mpls: Pick<MplsRepository, 'listVsis'>;
  live: VsiMcpLiveCollector | null;
  /** Consome a aprovacao one-shot (lanca se ausente/expirada/usada/de outro escopo). */
  /** `operator` e a identidade AUTENTICADA de quem executa: a aprovacao nao pode ter sido criada por ele. */
  consumeApproval: (approvalId: string | undefined, hostId: string, scope: string, operator: Operator) => void | Promise<void>;
  /** Valida a aprovacao SEM consumi-la (homologacao por OPERATOR). Ausente = homologacao por OPERATOR recusada. */
  peekApproval?: (approvalId: string | undefined, hostId: string, scope: string, operator: Operator) => void | Promise<void>;
  audit: (event: { tool: VsiMcpToolName; operatorId: string; hostId: string; command: string }) => void;
  now?: () => Date;
  /** Prazo total por chamada de ferramenta. */
  deadlineMs?: number;
}

export class VsiMcpToolError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VsiMcpToolError';
  }
}

const EXCERPT = 1200;

export class VsiMcpTools {
  constructor(private readonly deps: VsiMcpDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Ponto de entrada unico: valida schema, autoriza e despacha. */
  async call(tool: VsiMcpToolName, rawInput: unknown, operator: Operator): Promise<ToolEnvelope> {
    const parsed = VSI_MCP_TOOLS[tool].safeParse(rawInput ?? {});
    if (!parsed.success)
      throw new VsiMcpToolError(400, 'INVALID_INPUT', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300));
    const data = parsed.data as { source?: string; homologation?: boolean };

    const live = this.requiresLive(tool, data);
    if (live && !['ADMIN', 'OPERATOR'].includes(operator.role))
      throw new VsiMcpToolError(403, 'FORBIDDEN', 'Execucao ao vivo exige ADMIN ou OPERATOR');
    if (data.homologation === true && operator.role !== 'ADMIN') {
      // OPERATOR so homologa com aprovacao ADMIN one-shot valida, especifica e AINDA CONSUMIVEL (conferida aqui, antes de
      // qualquer SSH e de qualquer consumo). Nao amplia nenhum outro privilegio do OPERATOR.
      if (operator.role !== 'OPERATOR' || !live)
        throw new VsiMcpToolError(403, 'FORBIDDEN', 'Modo de homologacao exige ADMIN, ou OPERATOR com aprovacao ADMIN valida');
      await this.requireHomologationApprovals(tool, parsed.data, operator);
    }
    if (live && !this.deps.live) throw new VsiMcpToolError(503, 'LIVE_DISABLED', 'Diagnostico ao vivo desabilitado nesta instalacao');

    const signal = AbortSignal.timeout(this.deps.deadlineMs ?? 90_000);
    switch (tool) {
      case 'list_vsi': {
        const input = parsed.data as ToolInput<'list_vsi'>;
        return input.source === 'LIVE' ? this.listLive(input, operator, signal) : this.listPersisted(input);
      }
      case 'get_vsi_details':
      case 'get_vsi_ac_bindings':
      case 'get_vsi_pseudowires': {
        const input = parsed.data as ToolInput<'get_vsi_details'>;
        return input.source === 'LIVE'
          ? this.liveVsiView(tool, input, operator, signal)
          : this.persistedVsiView(tool, input);
      }
      case 'get_vsi_mac_table':
      case 'get_vsi_vlan_encapsulation':
      case 'diagnose_vsi':
        return this.liveVsiView(tool, parsed.data as LiveViewInput, operator, signal);
      case 'compare_vsi_endpoints':
        return this.compare(parsed.data as ToolInput<'compare_vsi_endpoints'>, operator, signal);
    }
  }

  private requiresLive(tool: VsiMcpToolName, input: { source?: string }): boolean {
    if (['get_vsi_mac_table', 'get_vsi_vlan_encapsulation', 'diagnose_vsi', 'compare_vsi_endpoints'].includes(tool)) return true;
    return input.source === 'LIVE';
  }

  /* ----------------------------- persistidas ---------------------------- */

  private envelope<T>(tool: VsiMcpToolName, init: Partial<ToolEnvelope<T>> & { status: ToolStatus }): ToolEnvelope<T> {
    const env = {
      tool,
      generatedAt: this.now().toISOString(),
      hostId: null,
      vsiName: null,
      data: null,
      evidence: [],
      skipped: [],
      warnings: [],
      errors: [],
      ...init,
    };
    // Aditivo: so reorganiza o que ja esta em evidence/skipped/errors. Nao muda status nem achados.
    const collectionIssues: ToolCollectionIssue[] = [
      ...env.evidence
        .filter((e) => e.source === 'LIVE_SSH' && !e.complete)
        .map((e) => ({ code: 'OUTPUT_INCOMPLETE' as const, hostId: e.hostId, command: e.command, evidenceId: e.id, detail: 'Saida sem o prompt final (paginada, truncada ou recusada): nao foi usada pela metade.' })),
      ...env.skipped.map((s) => ({ code: 'OPERATION_SKIPPED' as const, hostId: s.hostId, command: s.command, evidenceId: null, detail: `${s.reason}: ${s.note}` })),
      ...env.errors.map((e) => ({ code: 'COLLECTION_ERROR' as const, hostId: e.hostId ?? env.hostId, command: null, evidenceId: null, detail: `${e.code}: ${e.message}` })),
    ];
    return { ...env, collectionIssues };
  }

  /**
   * Homologacao por OPERATOR: TODA aprovacao necessaria tem de existir, ser do host/escopo exatos, nao ter expirado, nao
   * ter sido usada e nao ter sido criada pelo proprio executor. Falha fechada se `peekApproval` nao estiver ligado.
   */
  private async requireHomologationApprovals(tool: VsiMcpToolName, rawInput: unknown, operator: Operator): Promise<void> {
    const peek = this.deps.peekApproval;
    if (!peek) throw new VsiMcpToolError(403, 'HOMOLOGATION_REQUIRES_APPROVAL', 'Homologacao por OPERATOR exige a verificacao previa da aprovacao');
    const needed: Array<{ approvalId: string | undefined; hostId: string; scope: string }> = [];
    if (tool === 'compare_vsi_endpoints') {
      const i = rawInput as ToolInput<'compare_vsi_endpoints'>;
      for (const p of [i.a, i.b]) needed.push({ approvalId: p.approvalId, hostId: p.hostId, scope: approvalScope(p.vsiName) });
    } else if (tool === 'list_vsi') {
      const i = rawInput as ToolInput<'list_vsi'>;
      needed.push({ approvalId: i.approvalId, hostId: i.hostId, scope: approvalScope() });
    } else {
      const i = rawInput as { approvalId?: string; hostId: string; vsiName: string };
      needed.push({ approvalId: i.approvalId, hostId: i.hostId, scope: approvalScope(i.vsiName) });
    }
    const ids = needed.map((n) => n.approvalId);
    if (ids.some((id) => !id)) throw new VsiMcpToolError(403, 'HOMOLOGATION_REQUIRES_APPROVAL', 'Homologacao por OPERATOR exige approvalId');
    if (new Set(ids).size !== ids.length) throw new VsiMcpToolError(423, 'APPROVAL_REQUIRED', 'Cada ponta exige a sua propria aprovacao');
    for (const n of needed) {
      try {
        await peek(n.approvalId, n.hostId, n.scope, operator);
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode === 423)
          throw new VsiMcpToolError(423, 'APPROVAL_REQUIRED', (error as Error).message);
        throw error;
      }
    }
  }

  /** Consumo da aprovacao com a identidade do executor; recusas do broker (ex.: conta de servico ADMIN) viram 403 com codigo fixo. */
  private async consume(approvalId: string | undefined, hostId: string, scope: string, operator: Operator): Promise<void> {
    try {
      await this.deps.consumeApproval(approvalId, hostId, scope, operator);
    } catch (error) {
      const e = error as { name?: string; code?: string; message?: string };
      if (e?.name === 'SshCredentialBrokerError') throw new VsiMcpToolError(403, String(e.code ?? 'FORBIDDEN'), String(e.message ?? 'Recusado'));
      throw error;
    }
  }

  private async hostOrThrow(hostId: string): Promise<HostRecord> {
    const host = await this.deps.hosts.getHost(hostId);
    if (!host) throw new VsiMcpToolError(404, 'HOST_NOT_FOUND', 'Host inexistente');
    return host;
  }

  private persistedEvidence(host: HostRecord, vsi: MplsVsi | null, count: number): ToolEvidence {
    return {
      id: `${host.id}:persisted:${vsi?.name ?? 'all'}`,
      source: 'PERSISTED_SNMP',
      hostId: host.id,
      hostName: host.name,
      collectedAt: this.now().toISOString(),
      observedAt: vsi?.lastSeenAt ?? null,
      command: null,
      sha256: null,
      bytes: count,
      complete: true,
      excerpt: null,
    };
  }

  private async listPersisted(input: ToolInput<'list_vsi'>): Promise<ToolEnvelope> {
    const host = await this.hostOrThrow(input.hostId);
    const all = await this.deps.mpls.listVsis(host.id);
    const q = (input.q as string | undefined)?.toLowerCase();
    const rows = all
      .filter((v) => !q || v.name.toLowerCase().includes(q))
      .filter((v) => !input.state || v.operationalStatus === input.state)
      .slice(0, input.limit)
      .map((v) => ({
        name: v.name, operationalStatus: v.operationalStatus, adminStatus: v.adminStatus,
        signalingType: v.signalingType, vcType: v.vcType, mtu: v.mtu, vlanId: v.vlanId,
        acCount: v.acs.length, pwCount: v.pws.length,
        // PW com leitura mais antiga que a da VSI nao foi visto no ciclo atual: nao conta como UP.
        pwUp: v.pws.filter((p) => p.state === 'UP' && !isPersistedPwStale(p.lastSeenAt, v.lastSeenAt)).length,
        pwStale: v.pws.filter((p) => isPersistedPwStale(p.lastSeenAt, v.lastSeenAt)).length,
        lastSeenAt: v.lastSeenAt,
      }));
    const warnings: string[] = [];
    if (all.length === 0)
      warnings.push('Nenhuma VSI persistida para este host (coleta SNMP VPLS pode nao ser suportada neste modelo). Use a ferramenta de diagnostico ao vivo.');
    return this.envelope('list_vsi', {
      status: all.length === 0 ? 'INCONCLUSIVE' : 'OK',
      hostId: host.id,
      data: { total: all.length, returned: rows.length, vsis: rows },
      evidence: [this.persistedEvidence(host, null, all.length)],
      warnings,
    });
  }

  /**
   * Descoberta ao vivo (host sem SNMP VPLS): sonda `VERSION` (so `display version`) ou
   * `LIST` (`display vsi`). Aprovacao de escopo de host (nao ha nome de VSI ainda).
   */
  private async listLive(input: ToolInput<'list_vsi'>, operator: Operator, signal: AbortSignal): Promise<ToolEnvelope> {
    const host = await this.hostOrThrow(input.hostId);
    // Identidade/perfil/fingerprint validados ANTES de consumir a aprovacao one-shot (nenhum SSH aqui).
    try {
      await this.deps.live!.preflight?.(host, input.probe === 'VERSION' ? [] : [{ kind: 'VSI_LIST' }], approvalScope());
    } catch (e) {
      return this.liveError('list_vsi', host.id, null, e);
    }
    await this.consume(input.approvalId, host.id, approvalScope(), operator);
    const audit = (command: string) => this.deps.audit({ tool: 'list_vsi', operatorId: operator.id, hostId: host.id, command });
    try {
      const ops: VsiMcpOperation[] = input.probe === 'VERSION' ? [] : [{ kind: 'VSI_LIST' }];
      const session = await this.deps.live!.collect(host, ops, { signal, audit, homologation: input.homologation === true, approvalId: input.approvalId, operatorId: operator.id, scope: approvalScope() });
      const evidence = this.toEvidence(host, session);
      const skipped = this.mapSkipped(host, session.skipped);
      if (input.probe === 'VERSION')
        return this.envelope('list_vsi', { status: 'OK', hostId: host.id, evidence, skipped, data: { platform: session.platform } });
      if (session.skipped.some((s) => s.operation.kind === 'VSI_LIST'))
        return this.envelope('list_vsi', { status: 'NOT_SUPPORTED', hostId: host.id, evidence, skipped, data: { platform: session.platform },
          errors: [{ code: 'VSI_LIST_NOT_HOMOLOGATED', message: '`display vsi` ainda sem comprovacao nesta familia/versao.', hostId: host.id }] });
      const cap = session.captures.find((c) => c.operation.kind === 'VSI_LIST');
      const parsed = cap && cap.complete ? parseVsiList(cap.stdout) : null;
      if (!parsed || !parsed.complete)
        return this.envelope('list_vsi', { status: 'INCONCLUSIVE', hostId: host.id, evidence, skipped, data: { platform: session.platform },
          errors: [{ code: 'VSI_LIST_UNPARSED', message: 'Saida de `display vsi` ausente, incompleta ou em formato nao reconhecido.', hostId: host.id }] });
      const q = input.q?.toLowerCase();
      const rows = parsed.vsis.filter((v) => !q || v.name.toLowerCase().includes(q)).filter((v) => !input.state || v.state === input.state);
      return this.envelope('list_vsi', { status: 'OK', hostId: host.id, evidence, skipped,
        warnings: parsed.vsis.length === 0 ? ['`display vsi` aceito pelo equipamento e sem conteudo: nenhuma VSI configurada (observacao unica, nao ha outro indicio independente).'] : [],
        data: { platform: session.platform, total: parsed.vsis.length, returned: Math.min(rows.length, input.limit), vsis: rows.slice(0, input.limit) } });
    } catch (e) {
      return this.liveError('list_vsi', host.id, null, e);
    }
  }

  private async persistedVsiView(tool: VsiMcpToolName, input: ToolInput<'get_vsi_details'>): Promise<ToolEnvelope> {
    const host = await this.hostOrThrow(input.hostId);
    const vsi = (await this.deps.mpls.listVsis(host.id)).find((v) => v.name === input.vsiName);
    if (!vsi)
      return this.envelope(tool, {
        status: 'INCONCLUSIVE', hostId: host.id, vsiName: input.vsiName,
        warnings: ['VSI nao encontrada nos dados persistidos; tente source=LIVE (exige aprovacao).'],
        evidence: [this.persistedEvidence(host, null, 0)],
      });
    const ev = [this.persistedEvidence(host, vsi, 1)];
    if (tool === 'get_vsi_details')
      return this.envelope(tool, { status: 'OK', hostId: host.id, vsiName: vsi.name, evidence: ev, data: {
        name: vsi.name, operationalStatus: vsi.operationalStatus, adminStatus: vsi.adminStatus, signalingType: vsi.signalingType,
        encapsulation: vsi.vcType, mtu: vsi.mtu, rd: vsi.rd, rdNormalized: normalizeRd(vsi.rd), vsiIndex: vsi.vsiId, vlanId: vsi.vlanId, tunnelPolicy: vsi.tunnelPolicy,
        description: vsi.description, acCount: vsi.acs.length, pwCount: vsi.pws.length,
      } });
    if (tool === 'get_vsi_ac_bindings')
      return this.envelope(tool, { status: 'OK', hostId: host.id, vsiName: vsi.name, evidence: ev,
        warnings: ['Dados SNMP: lista de ACs sem configuracao de encapsulamento. Use diagnose_vsi/get_vsi_vlan_encapsulation para Dot1Q/QinQ.'],
        data: { acs: vsi.acs.map((a) => ({ interface: a.interface?.name ?? null, ifIndex: a.ifIndex, status: a.status, lastSeenAt: a.lastSeenAt })) } });
    const stalePws = vsi.pws.filter((p) => isPersistedPwStale(p.lastSeenAt, vsi.lastSeenAt));
    return this.envelope(tool, { status: 'OK', hostId: host.id, vsiName: vsi.name, evidence: ev,
      warnings: stalePws.length
        ? [`${stalePws.length} PW(s) com registro OBSOLETO (ultima leitura anterior a da VSI em ${vsi.lastSeenAt}): ${stalePws.map((p) => `${p.remoteIp} @${p.lastSeenAt}`).join(', ')}. O estado gravado nao representa o atual (a coleta SNMP nao remove PWs que deixaram de existir).`]
        : [],
      data: {
        pws: vsi.pws.map((p) => {
          const stale = isPersistedPwStale(p.lastSeenAt, vsi.lastSeenAt);
          return {
            peerAddress: p.remoteIp, remoteHost: p.remoteHost?.name ?? null, pwId: p.pwId, state: p.state, status: p.status,
            workingState: p.workingState, pwType: p.pwType, inboundLabel: p.inboundLabel, outboundLabel: p.outboundLabel, tunnelPolicy: p.tunnelPolicy,
            lastSeenAt: p.lastSeenAt, stale,
            /** Estado utilizavel: um registro obsoleto nunca e apresentado como UP. */
            effectiveState: stale ? 'STALE' : p.state,
          };
        }),
      } });
  }

  /* -------------------------------- ao vivo ------------------------------ */

  private persistedAcNames(vsis: MplsVsi[], vsiName: string): string[] | null {
    const vsi = vsis.find((v) => v.name === vsiName);
    const names = vsi?.acs.map((a) => a.interface?.name).filter((n): n is string => !!n);
    return names && names.length === vsi!.acs.length && names.length > 0 ? names : null;
  }

  private toEvidence(host: HostRecord, session: LiveSessionResult): ToolEvidence[] {
    return session.captures.map((c, i) => ({
      id: `${host.id}:live:${c.sha256.slice(0, 12)}:${i}`,
      source: 'LIVE_SSH' as const,
      hostId: host.id,
      hostName: host.name,
      collectedAt: c.completedAt,
      observedAt: null,
      command: c.command,
      sha256: c.sha256,
      bytes: Buffer.byteLength(c.stdout),
      complete: c.complete,
      excerpt: c.stdout.slice(0, EXCERPT),
    }));
  }

  private idOf(captures: LiveCapture[], evidence: ToolEvidence[], command: string): string | undefined {
    const i = captures.findIndex((c) => c.command === command);
    return i >= 0 ? evidence[i]?.id : undefined;
  }

  /**
   * Coleta uma ponta ao vivo: consome a aprovacao, abre 1 sessao (version + VSI [+ MAC
   * [+ configs conhecidas]]) e, se os ACs ainda forem desconhecidos, 1 segunda sessao
   * para as configuracoes de interface.
   */
  private async collectEndpoint(
    tool: VsiMcpToolName,
    host: HostRecord,
    p: { vsiName: string; approvalId: string | undefined; wantMac: boolean; wantConfigs: boolean; interfaces?: string[]; homologation?: boolean; vlanId?: number; carrierInterfaces?: string[]; eTrunkIds?: number[] },
    operator: Operator,
    signal: AbortSignal,
  ): Promise<{ facts: EndpointFacts; evidence: ToolEvidence[]; skipped: SkippedOperation[]; sessions: number; warnings: string[] }> {
    const collector = this.deps.live!;
    const audit = (command: string) => this.deps.audit({ tool, operatorId: operator.id, hostId: host.id, command });
    const warnings: string[] = [];

    // `interfaces` so pode nomear ACs que o NetVision ja conhece para esta VSI: nao e um canal para ler
    // a configuracao de interface arbitraria (portas fora disso so via lista fechada `carrierInterfaces` do perfil).
    const persistedNames = this.persistedAcNames(await this.deps.mpls.listVsis(host.id), p.vsiName);
    if (p.interfaces) {
      const outside = p.interfaces.filter((n) => !persistedNames?.includes(n));
      if (outside.length)
        throw new VsiMcpToolError(400, 'INTERFACE_NOT_AN_AC', `Interface(s) fora dos ACs conhecidos da VSI: ${outside.join(', ')}`);
    }
    // Teto `profile.maxInterfaces` do perfil AUTORITATIVO (resolvido pelo broker), nunca uma constante do chamador.
    const limit = (await collector.maxInterfaces?.(host, approvalScope(p.vsiName))) ?? 8;
    if (p.interfaces && p.interfaces.length > limit)
      throw new VsiMcpToolError(400, 'TOO_MANY_INTERFACES', `O perfil deste host permite ler ${limit} interface(s) por execucao`);
    let known = p.interfaces ?? (p.wantConfigs ? persistedNames : null);
    if (known && known.length > limit) {
      warnings.push(`VSI com ${known.length} ACs conhecidos; lidas as configuracoes de apenas ${limit}.`);
      known = known.slice(0, limit);
    }
    const ops1: VsiMcpOperation[] = [{ kind: 'VSI_VERBOSE', vsiName: p.vsiName }];
    if (p.wantConfigs && known) for (const n of known) ops1.push({ kind: 'INTERFACE_CONFIG', interfaceName: n });
    // VLAN e portas transportadoras (escopo fechado no perfil do host) vao antes do MAC.
    const vlanOps: VsiMcpOperation[] = [];
    if (p.vlanId !== undefined) vlanOps.push({ kind: 'VLAN_INFO', vlanId: p.vlanId });
    for (const n of p.carrierInterfaces ?? []) vlanOps.push({ kind: 'INTERFACE_CONFIG', interfaceName: n, role: 'CARRIER' });
    // Redundancia de acesso: LACP de cada Eth-Trunk transportador e os E-Trunks pedidos (escopo fechado no perfil).
    for (const n of p.carrierInterfaces ?? []) {
      const trunk = /^Eth-Trunk(\d+)$/i.exec(n);
      if (trunk && p.eTrunkIds) vlanOps.push({ kind: 'ETH_TRUNK_INFO', trunkId: Number(trunk[1]) });
    }
    // O `brief` confirma o estado Master/Backup por outra saida e serve de reserva se o comando completo falhar.
    if (p.eTrunkIds?.length) vlanOps.push({ kind: 'ETRUNK_BRIEF' });
    for (const id of p.eTrunkIds ?? []) vlanOps.push({ kind: 'ETRUNK_INFO', eTrunkId: id });
    // Perfil/escopo validados ANTES de consumir a aprovacao one-shot (nenhum SSH aqui).
    await collector.preflight?.(host, [...ops1, ...vlanOps, ...(p.wantMac ? [{ kind: 'VSI_MAC', vsiName: p.vsiName } as VsiMcpOperation] : [])], approvalScope(p.vsiName));
    await this.consume(p.approvalId, host.id, approvalScope(p.vsiName), operator);

    // O MAC (consulta mais pesada e, em varias familias, ainda candidata) sempre vai POR ULTIMO na
    // sessao final: se a sintaxe falhar, nada anterior se perde.
    const macDeferred = p.wantConfigs && !known;
    if (!macDeferred) ops1.push(...vlanOps);
    if (p.wantMac && !macDeferred) ops1.push({ kind: 'VSI_MAC', vsiName: p.vsiName });

    const s1 = await collector.collect(host, ops1, { signal, audit, homologation: p.homologation === true, approvalId: p.approvalId, operatorId: operator.id, scope: approvalScope(p.vsiName), sequence: 1 });
    let sessions = 1;
    const captures = [...s1.captures];
    const skipped = [...s1.skipped];
    const evidence = this.toEvidence(host, s1);
    const session = (): LiveSessionResult => ({ ...s1, captures });

    const verboseCap = captures.find((c) => c.operation.kind === 'VSI_VERBOSE');
    const vsi = verboseCap ? parseVsiVerbose(verboseCap.stdout, p.vsiName) : null;

    if (macDeferred && p.wantMac && !vsi?.complete)
      warnings.push('MAC nao consultado: a saida da VSI esta ausente/incompleta.');
    if (macDeferred && vsi?.complete && (vsi.acs.length > 0 || p.wantMac)) {
      // Evidencia da sessao 1: so estes ACs poderao ser lidos na sessao 2 (o broker recusa qualquer outro).
      collector.observeAcs?.(host, approvalScope(p.vsiName), p.approvalId, vsi.acs.map((a) => a.interfaceName), operator.id);
      const names = vsi.acs.map((a) => a.interfaceName).slice(0, limit);
      if (vsi.acs.length > limit) warnings.push(`VSI com ${vsi.acs.length} ACs; lidas as configuracoes de apenas ${limit}.`);
      const ops2: VsiMcpOperation[] = names.map((n) => ({ kind: 'INTERFACE_CONFIG', interfaceName: n }) as VsiMcpOperation);
      ops2.push(...vlanOps);
      if (p.wantMac) ops2.push({ kind: 'VSI_MAC', vsiName: p.vsiName });
      const s2 = await collector.collect(host, ops2, {
        signal, audit, homologation: p.homologation === true, pace: true, approvalId: p.approvalId, operatorId: operator.id, scope: approvalScope(p.vsiName), sequence: 2,
      });
      sessions = 2;
      captures.push(...s2.captures.filter((c) => c.operation.kind !== 'VERSION'));
      skipped.push(...s2.skipped.filter((s) => s.operation.kind !== 'VERSION'));
      evidence.push(...this.toEvidence(host, s2).filter((e) => e.command !== 'display version'));
    } else if (p.wantConfigs && known && vsi?.complete) {
      const uncovered = vsi.acs.map((a) => a.interfaceName).filter((n) => !known.includes(n));
      if (uncovered.length) warnings.push(`ACs vistos ao vivo sem configuracao lida: ${uncovered.join(', ')}.`);
    }

    const interfaces: EndpointFacts['interfaces'] = {};
    const ifEvidence: Record<string, string> = {};
    const carriers: NonNullable<EndpointFacts['carriers']> = {};
    const carrierEvidence: Record<string, string> = {};
    for (const c of captures) {
      if (c.operation.kind !== 'INTERFACE_CONFIG') continue;
      const cfg = parseInterfaceConfig(c.stdout, c.operation.interfaceName);
      if (cfg.complete) {
        const isCarrier = c.operation.role === 'CARRIER';
        (isCarrier ? carriers : interfaces)[c.operation.interfaceName] = cfg;
        const id = this.idOf(captures, evidence, c.command);
        if (id) (isCarrier ? carrierEvidence : ifEvidence)[c.operation.interfaceName] = id;
      }
    }
    const vlanCap = captures.find((c) => c.operation.kind === 'VLAN_INFO');
    const vlan = vlanCap && vlanCap.operation.kind === 'VLAN_INFO' ? parseVlanInfo(vlanCap.stdout, vlanCap.operation.vlanId) : null;
    const macCap = captures.find((c) => c.operation.kind === 'VSI_MAC');
    const macs = macCap ? parseMacTable(macCap.stdout, p.vsiName) : null;

    let redundancy: RedundancyFacts | null = null;
    for (const c of captures) {
      if (c.operation.kind !== 'ETH_TRUNK_INFO' && c.operation.kind !== 'ETRUNK_INFO') continue;
      redundancy ??= { ethTrunks: {}, eTrunks: {}, evidenceIds: { ethTrunks: {}, eTrunks: {} } };
      const id = this.idOf(captures, evidence, c.command);
      if (c.operation.kind === 'ETH_TRUNK_INFO') {
        const name = `Eth-Trunk${c.operation.trunkId}`;
        const parsed = parseEthTrunk(c.stdout, c.operation.trunkId);
        if (c.complete && parsed.complete) {
          redundancy.ethTrunks[name] = parsed;
          if (id) redundancy.evidenceIds!.ethTrunks![name] = id;
        } else warnings.push(`Saida de display eth-trunk ${c.operation.trunkId} ausente, incompleta ou em formato nao reconhecido: papel do trunk nao sera presumido.`);
      } else {
        const parsed = parseETrunk(c.stdout, c.operation.eTrunkId);
        if (c.complete && parsed.complete) {
          redundancy.eTrunks[c.operation.eTrunkId] = parsed;
          if (id) redundancy.evidenceIds!.eTrunks![c.operation.eTrunkId] = id;
        } else warnings.push(`Saida de display e-trunk ${c.operation.eTrunkId} ausente, incompleta ou em formato nao reconhecido: papel Master/Backup nao sera presumido.`);
      }
    }

    // `display e-trunk brief`: conferencia cruzada do estado e reserva quando o comando completo nao foi lido.
    const briefCap = captures.find((c) => c.operation.kind === 'ETRUNK_BRIEF');
    if (briefCap) {
      const brief = parseETrunkBrief(briefCap.stdout);
      if (!briefCap.complete || !brief.complete)
        warnings.push('Saida de display e-trunk brief ausente, incompleta ou em formato nao reconhecido: nao usada.');
      else
        for (const id of p.eTrunkIds ?? []) {
          redundancy ??= { ethTrunks: {}, eTrunks: {}, evidenceIds: { ethTrunks: {}, eTrunks: {} } };
          const detail = redundancy.eTrunks[id];
          const fromBrief = eTrunkFromBrief(brief, id);
          if (!fromBrief) warnings.push(`E-Trunk ${id} nao consta em display e-trunk brief.`);
          else if (detail && detail.state !== fromBrief.state) {
            // Duas leituras do mesmo equipamento que discordam: nenhuma e usada para decidir papel.
            delete redundancy.eTrunks[id];
            warnings.push(`display e-trunk ${id} (${detail.state}) e display e-trunk brief (${fromBrief.state}) divergem: estado do E-Trunk ${id} tratado como nao determinado.`);
          } else if (!detail) {
            redundancy.eTrunks[id] = fromBrief;
            const evId = this.idOf(captures, evidence, briefCap.command);
            if (evId) redundancy.evidenceIds!.eTrunks![id] = evId;
            warnings.push(`E-Trunk ${id}: usado somente o estado do brief (${fromBrief.state}); tabela de membros e causa nao lidas.`);
          }
        }
    }

    const persistedVsi = (await this.deps.mpls.listVsis(host.id)).find((v) => v.name === p.vsiName);
    const persistedAcs = this.persistedAcNames(persistedVsi ? [persistedVsi] : [], p.vsiName) ?? undefined;
    const facts: EndpointFacts = {
      ...(persistedAcs ? { persistedAcs } : {}),
      ...(persistedVsi && persistedVsi.pws.length
        ? { persistedPws: { vsiLastSeenAt: persistedVsi.lastSeenAt, pws: persistedVsi.pws.map((x) => ({ peerAddress: x.remoteIp, state: x.state, lastSeenAt: x.lastSeenAt })) } }
        : {}),
      ...(redundancy ? { redundancy } : {}),
      requested: { mac: p.wantMac },
      hostId: host.id,
      hostName: host.name,
      platform: session().platform,
      vsiName: p.vsiName,
      vsi: verboseCap && verboseCap.complete ? vsi : null,
      interfaces,
      macs: macCap && macCap.complete ? macs : null,
      ...(vlan && vlanCap?.complete ? { vlan } : {}),
      ...(Object.keys(carriers).length ? { carriers } : {}),
      evidenceIds: {
        ...(verboseCap ? { vsi: this.idOf(captures, evidence, verboseCap.command)! } : {}),
        ...(macCap ? { macs: this.idOf(captures, evidence, macCap.command)! } : {}),
        ...(vlanCap ? { vlan: this.idOf(captures, evidence, vlanCap.command)! } : {}),
        interfaces: ifEvidence,
        ...(Object.keys(carrierEvidence).length ? { carriers: carrierEvidence } : {}),
      },
    };
    return { facts, evidence, skipped, sessions, warnings };
  }

  private mapSkipped(host: HostRecord, skipped: SkippedOperation[]): ToolEnvelope['skipped'] {
    return skipped.map((s) => ({ hostId: host.id, command: s.operation.kind, reason: s.reason, note: s.note }));
  }

  private liveError(tool: VsiMcpToolName, hostId: string, vsiName: string | null, error: unknown): ToolEnvelope {
    if (error instanceof VsiMcpToolError) throw error;
    let errors: ToolError;
    let status: ToolStatus = 'ERROR';
    if (error instanceof VsiMcpLiveError) {
      errors = { code: error.code, message: error.message, hostId };
      if (error.code === 'PLATFORM_MISMATCH') status = 'NOT_SUPPORTED';
    } else if (error instanceof VsiMcpProfileError) {
      errors = { code: error.code, message: error.message, hostId };
      status = error.code === 'NO_PROFILE' || error.code === 'OPERATION_NOT_AUTHORIZED' ? 'NOT_SUPPORTED' : 'ERROR';
    } else if (error instanceof VsiMcpPolicyError) {
      errors = { code: error.code, message: error.message, hostId };
    } else if (error instanceof Error && (error as { statusCode?: number }).statusCode === 423) {
      // Aprovacao one-shot ausente/expirada/usada/de outro escopo (VsiDiagnosticError 423).
      throw new VsiMcpToolError(423, 'APPROVAL_REQUIRED', error.message);
    } else {
      errors = { code: 'UNEXPECTED', message: 'Falha inesperada na coleta', hostId };
    }
    return this.envelope(tool, { status, hostId, vsiName, errors: [errors] });
  }

  private async liveVsiView(tool: VsiMcpToolName, input: LiveViewInput, operator: Operator, signal: AbortSignal): Promise<ToolEnvelope> {
    const host = await this.hostOrThrow(input.hostId);
    const wantConfigs = ['get_vsi_ac_bindings', 'get_vsi_vlan_encapsulation', 'diagnose_vsi'].includes(tool);
    const wantMac = tool === 'get_vsi_mac_table' || (tool === 'diagnose_vsi' && input.includeMac !== false);
    let r;
    try {
      r = await this.collectEndpoint(tool, host, {
        vsiName: input.vsiName, approvalId: input.approvalId, wantMac, wantConfigs,
        ...(input.interfaces ? { interfaces: input.interfaces } : {}), homologation: input.homologation === true,
        ...(input.vlanId !== undefined ? { vlanId: input.vlanId } : {}),
        ...(input.carrierInterfaces ? { carrierInterfaces: input.carrierInterfaces } : {}),
        ...(input.eTrunkIds ? { eTrunkIds: input.eTrunkIds } : {}),
      }, operator, signal);
    } catch (e) {
      return this.liveError(tool, host.id, input.vsiName, e);
    }
    const { facts, evidence, skipped } = r;
    const base = { hostId: host.id, vsiName: input.vsiName as string, evidence, skipped: this.mapSkipped(host, skipped), warnings: r.warnings };
    const incomplete = !facts.vsi || (wantMac && !facts.macs && !skipped.some((s) => s.operation.kind === 'VSI_MAC'));

    if (tool === 'get_vsi_mac_table') {
      if (skipped.some((s) => s.operation.kind === 'VSI_MAC'))
        return this.envelope(tool, { ...base, status: 'NOT_SUPPORTED', errors: [{ code: 'MAC_QUERY_NOT_HOMOLOGATED', message: 'Consulta de MAC por VSI ainda sem comprovacao nesta familia/versao.', hostId: host.id }] });
      const m = facts.macs;
      if (!m) return this.envelope(tool, { ...base, status: 'INCONCLUSIVE', errors: [{ code: 'MAC_TABLE_INCOMPLETE', message: 'Saida de MAC ausente ou incompleta.', hostId: host.id }] });
      // Contagem por origem vem do resumo do correlator (AC/PW so com evidencia; o resto e nao classificado).
      const summary = diagnoseEndpoint(facts).macSummary;
      return this.envelope(tool, { ...base, status: 'OK', data: {
        total: m.entries.length, declaredTotal: m.declaredTotal,
        viaAc: summary?.viaAc ?? 0, viaPw: summary?.viaPw ?? m.entries.filter((e) => e.side === 'PW').length,
        viaUnresolved: summary?.viaUnresolved ?? 0,
        truncated: m.entries.length > (input.maxEntries ?? 200), entries: m.entries.slice(0, input.maxEntries ?? 200),
        summary,
      } });
    }

    if (tool === 'get_vsi_details' || tool === 'get_vsi_pseudowires' || tool === 'get_vsi_ac_bindings') {
      if (!facts.vsi) return this.envelope(tool, { ...base, status: 'INCONCLUSIVE', errors: [{ code: 'VSI_OUTPUT_INCOMPLETE', message: 'Saida da VSI ausente, paginada ou com nome divergente.', hostId: host.id }] });
      const v = facts.vsi;
      if (tool === 'get_vsi_details')
        return this.envelope(tool, { ...base, status: 'OK', data: {
          name: v.name, state: v.state, signaling: v.signaling, encapsulationType: v.encapsulationType, mtu: v.mtu, rd: v.rd, rdNormalized: normalizeRd(v.rd),
          vsiIndex: v.vsiIndex, acCount: v.acs.length, pwCount: v.pws.length, platform: facts.platform,
        } });
      if (tool === 'get_vsi_pseudowires') return this.envelope(tool, { ...base, status: 'OK', data: { pws: v.pws } });
      const diag = diagnoseEndpoint(facts);
      return this.envelope(tool, { ...base, status: 'OK', data: {
        acs: v.acs.map((a) => ({
          ...a,
          configCollected: !!facts.interfaces[a.interfaceName],
          l2BindingVsi: facts.interfaces[a.interfaceName]?.l2BindingVsi ?? null,
          parentInterface: facts.interfaces[a.interfaceName]?.parentInterface ?? null,
        })),
        bindingFindings: diag.findings.filter((f) => f.code.startsWith('DUPLICATE_BINDING') || f.code.startsWith('AC_')),
      } });
    }

    if (tool === 'get_vsi_vlan_encapsulation') {
      const paths = Object.values(facts.interfaces).map(acVlanTransform);
      return this.envelope(tool, { ...base, status: !facts.vsi || paths.length === 0 ? 'INCONCLUSIVE' : 'OK', data: { vlanPaths: paths, vsiEncapsulationType: facts.vsi?.encapsulationType ?? null, encapsulation: diagnoseEndpoint(facts).dimensions.ENCAPSULATION, vlan: facts.vlan ?? null, carriers: facts.carriers ?? {} } });
    }

    // diagnose_vsi
    const diagnosis = diagnoseEndpoint(facts);
    return this.envelope(tool, { ...base, status: incomplete ? 'INCONCLUSIVE' : diagnosis.status === 'FAILED' || diagnosis.status === 'WARNING' ? 'OK' : diagnosis.status, data: {
      diagnosis, platform: facts.platform, sessionsOpened: r.sessions,
      // Aditivo: os fatos JA analisados que sustentam `diagnosis` (sem as entradas da tabela MAC, resumidas em macSummary).
      facts: {
        vsi: facts.vsi, interfaces: facts.interfaces, carriers: facts.carriers ?? {}, vlan: facts.vlan ?? null,
        redundancy: facts.redundancy ?? null, persistedAcs: facts.persistedAcs ?? null, persistedPws: facts.persistedPws ?? null,
        evidenceIds: facts.evidenceIds,
      },
    } });
  }

  private async compare(input: ToolInput<'compare_vsi_endpoints'>, operator: Operator, signal: AbortSignal): Promise<ToolEnvelope> {
    const [ha, hb] = await Promise.all([this.hostOrThrow(input.a.hostId), this.hostOrThrow(input.b.hostId)]);
    const run = (host: HostRecord, p: ToolInput<'compare_vsi_endpoints'>['a']) =>
      this.collectEndpoint('compare_vsi_endpoints', host, {
        vsiName: p.vsiName, approvalId: p.approvalId, wantMac: input.includeMac !== false, wantConfigs: true,
        ...(p.interfaces ? { interfaces: p.interfaces } : {}), homologation: input.homologation === true,
      }, operator, signal);
    const [ra, rb] = await Promise.allSettled([run(ha, input.a), run(hb, input.b)]);
    const errors: ToolError[] = [];
    for (const [r, h] of [[ra, ha], [rb, hb]] as const)
      if (r.status === 'rejected') {
        const env = this.liveError('compare_vsi_endpoints', h.id, null, r.reason);
        errors.push(...env.errors);
      }
    if (ra.status !== 'fulfilled' || rb.status !== 'fulfilled')
      return this.envelope('compare_vsi_endpoints', {
        status: 'INCONCLUSIVE', errors,
        evidence: [...(ra.status === 'fulfilled' ? ra.value.evidence : []), ...(rb.status === 'fulfilled' ? rb.value.evidence : [])],
        warnings: ['Comparacao nao executada: uma das pontas falhou. Pontas bem sucedidas consumiram suas aprovacoes one-shot.'],
      });
    const cmp = compareEndpoints(ra.value.facts, rb.value.facts, {
      ...(input.a.peerAddress ? { peerAddressOnA: input.a.peerAddress } : {}),
      ...(input.b.peerAddress ? { peerAddressOnB: input.b.peerAddress } : {}),
    });
    return this.envelope('compare_vsi_endpoints', {
      status: cmp.status === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'OK',
      data: { comparison: cmp, endpoints: [{ hostId: ha.id, hostName: ha.name, vsiName: input.a.vsiName }, { hostId: hb.id, hostName: hb.name, vsiName: input.b.vsiName }] },
      evidence: [...ra.value.evidence, ...rb.value.evidence],
      skipped: [...this.mapSkipped(ha, ra.value.skipped), ...this.mapSkipped(hb, rb.value.skipped)],
      warnings: [...ra.value.warnings, ...rb.value.warnings],
    });
  }
}
