import { createHash, randomUUID } from 'node:crypto';
import {
  VSI_DIAGNOSTIC_LIMITS as limits,
  type AuthUser,
  type HostRecord,
  type MplsVsi,
  type VsiDiagnosticResult as Result,
  type VsiDiagnosticCategory as Category,
  type VsiDiagnosticStatus as Status,
  type VsiDiagnosticEndpoint as Endpoint,
} from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import type { MplsRepository } from './mpls-repository';
import type { VsiDiagnosticRunner } from './vsi-diagnostic-ssh';
import { vsiCommand } from './vsi-diagnostic-policy';
import {
  observeMplsLoopback,
  observeVsi,
  isCompleteObservation,
  type CompleteCliObservation,
} from './vsi-diagnostic-observation';
import { selectRemoteCandidate, correlateReciprocalVsi } from './vsi-diagnostic-reciprocal';
import { correlateVsiEvidence } from './vsi-probe-correlation';
import { observeHuaweiPing, type PingTarget } from './vsi-probe-observation';
import { parseInterface } from './vsi-diagnostic-parser';
import { precheckVsiInventory, VsiInventoryError } from './vsi-diagnostic-inventory';
export class VsiDiagnosticError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
type Job = {
  result: Result;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  vsi: MplsVsi;
  host: HostRecord;
  wireCommands: number;
};
async function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('DIAGNOSTIC_ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export class VsiDiagnosticService {
  private readonly jobs = new Map<string, Job>();
  private readonly reserved = new Set<string>();
  private readonly queue: Job[] = [];
  private running: Promise<void> | null = null;
  private closing = false;
  constructor(
    private readonly hosts: Pick<HostRepository, 'getHost' | 'listHosts' | 'getInterfaceHistory'>,
    private readonly mpls: Pick<MplsRepository, 'listVsis' | 'getHostOverview'>,
    private readonly ssh: VsiDiagnosticRunner,
    private readonly audit: (event: {
      diagnosticId: string;
      operatorId: string;
      hostId: string;
      command: string;
    }) => void = () => {},
    private readonly beforeStart: (hostId: string, vsiId: string, approvalId?: string) => void = () => {},
  ) {}
  async start(
    hostId: string,
    vsiId: string,
    operator: Pick<AuthUser, 'id' | 'username' | 'role'>,
    approvalId?: string,
  ): Promise<Result> {
    if (!['ADMIN', 'OPERATOR'].includes(operator.role))
      throw new VsiDiagnosticError('Execução exige ADMIN ou OPERATOR', 403);
    this.beforeStart(hostId, vsiId, approvalId);
    if (this.closing) throw new VsiDiagnosticError('Serviço encerrando', 503);
    const key = JSON.stringify([hostId, vsiId]);
    if (this.reserved.has(key))
      throw new VsiDiagnosticError('Esta VSI já está em diagnóstico', 409);
    if (this.reserved.size >= limits.queue + 1)
      throw new VsiDiagnosticError('Fila de diagnóstico cheia', 429);
    this.reserved.add(key);
    try {
      const preflight = AbortSignal.timeout(8000);
      const host = await abortable(preflight, this.hosts.getHost(hostId));
      if (!host) throw new VsiDiagnosticError('Host inexistente', 404);
      const vsi = (await abortable(preflight, this.mpls.listVsis(hostId))).find(
        (v) => v.id === vsiId && v.hostId === hostId,
      );
      if (!vsi) throw new VsiDiagnosticError('VSI inexistente neste host', 404);
      if (this.closing) throw new VsiDiagnosticError('Serviço encerrando', 503);
      const endpoint: Endpoint = {
        hostId,
        name: host.name,
        vsiId,
        vsiName: vsi.name,
        loopback: null,
        association: 'LOCAL',
      };
      const result: Result = {
        diagnosticId: randomUUID(),
        hostId,
        vsiId,
        vsiName: vsi.name,
        operator: { id: operator.id, username: operator.username, role: operator.role },
        state: 'QUEUED',
        stage: 'Aguardando execução',
        progress: [{ stage: 'Aguardando execução', at: new Date().toISOString() }],
        startedAt: new Date().toISOString(),
        completedAt: null,
        overallStatus: 'INSUFFICIENT_DATA',
        summary: 'Diagnóstico solicitado; nenhuma conclusão disponível.',
        local: endpoint,
        remotes: [],
        checks: [],
        evidence: [],
        probes: [],
        warnings: [
          'AAA = NOT_VERIFIED; privilégios da conta não foram verificados pelo diagnóstico.',
        ],
        nextTests: [],
      };
      for (const [id, old] of this.jobs) {
        if (this.jobs.size < limits.retainedJobs) break;
        if (old.result.completedAt) this.jobs.delete(id);
      }
      if (this.jobs.size >= limits.retainedJobs)
        throw new VsiDiagnosticError('Limite de resultados retidos atingido', 429);
      const controller = new AbortController();
      const job: Job = {
        wireCommands: 0,
        result,
        controller,
        host,
        vsi,
        timer: setTimeout(() => {
          controller.abort('TOTAL_TIMEOUT');
          if (result.state === 'QUEUED') this.complete(job, 'TIMED_OUT');
        }, limits.totalMs),
      };
      this.jobs.set(result.diagnosticId, job);
      this.queue.push(job);
      this.drain();
      return structuredClone(result);
    } catch (error) {
      this.reserved.delete(key);
      if (error instanceof VsiDiagnosticError) throw error;
      throw new VsiDiagnosticError(
        'Não foi possível ler o contexto persistido da VSI no prazo permitido',
        503,
      );
    }
  }
  get(id: string, hostId: string, vsiId: string): Result {
    const job = this.jobs.get(id);
    if (!job || job.result.hostId !== hostId || job.result.vsiId !== vsiId)
      throw new VsiDiagnosticError('Diagnóstico não encontrado', 404);
    return structuredClone(job.result);
  }
  cancel(
    id: string,
    hostId: string,
    vsiId: string,
    operator: Pick<AuthUser, 'id' | 'role'>,
  ): Result {
    const result = this.get(id, hostId, vsiId);
    const job = this.jobs.get(id)!;
    if (
      operator.role === 'VIEWER' ||
      (operator.role !== 'ADMIN' && operator.id !== result.operator.id)
    )
      throw new VsiDiagnosticError('Cancelamento não autorizado', 403);
    if (!job.result.completedAt) {
      job.controller.abort('OPERATOR_CANCELLED');
      if (job.result.state === 'QUEUED') this.complete(job, 'CANCELLED');
    }
    return this.get(id, hostId, vsiId);
  }
  private complete(job: Job, state: Result['state'] = 'COMPLETED') {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    const r = job.result;
    r.state = state;
    this.stage(
      job,
      state === 'CANCELLED'
        ? 'Cancelado'
        : state === 'TIMED_OUT'
          ? 'Tempo limite atingido'
          : 'Concluído',
    );
    r.completedAt = new Date().toISOString();
    clearTimeout(job.timer);
    this.reserved.delete(JSON.stringify([r.hostId, r.vsiId]));
    if (state !== 'COMPLETED') {
      r.overallStatus = 'INSUFFICIENT_DATA';
      r.summary = 'Investigação interrompida; consultar evidências parciais.';
      return;
    }
    const failed = r.checks.filter((c) => c.status === 'FAILED');
    const missing = r.checks.some((c) => c.required && c.status === 'INSUFFICIENT_DATA');
    const warning = r.checks.some((c) => c.status === 'WARNING');
    r.overallStatus = failed.length
      ? 'FAILED'
      : missing
        ? 'INSUFFICIENT_DATA'
        : warning
          ? 'WARNING'
          : 'OK';
    if (failed.some((c) => c.category === 'AC' || c.category === 'INTERFACE')) {
      r.summary =
        'Há falha observada em interface/AC. O acesso é uma localização provável; consulte equipamento e interface nas evidências.';
      r.nextTests.push(
        'Verificar o circuito de acesso e a ponta do cliente na interface indicada, sem alterar a configuração.',
      );
    } else if (
      failed.some((c) => c.category === 'PW') &&
      failed.some((c) => c.category === 'LOOPBACK_REACHABILITY')
    ) {
      r.summary =
        'PW indisponível e teste IP entre loopbacks sem resposta. Há hipótese de falha de transporte; isso não confirma causa física ou caminho MPLS.';
      r.nextTests.push(
        'Correlacionar IGP/LDP/LSP e enlaces da topologia entre os PEs. Saltos ausentes não comprovam rompimento físico.',
      );
    } else if (
      failed.some((c) => c.category === 'PW') &&
      r.probes.some((p) => p.lossPercent === 0)
    ) {
      r.summary =
        'Conectividade IP entre loopbacks observada, com PW indisponível. Investigar L2VPN/MPLS; ping IP não valida o pseudowire.';
      r.nextTests.push(
        'Verificar peers, labels, parâmetros de sinalização e túneis do PW indicado.',
      );
    } else
      r.summary = failed.length
        ? 'Falhas observadas; consultar checks e evidências para localizar o componente.'
        : missing
          ? 'Dados insuficientes para concluir o serviço. Evidências persistidas e consultas concluídas estão discriminadas.'
          : warning
            ? 'Há anomalias ou divergências; consultar evidências e limitações.'
            : 'Os testes obrigatórios concluídos não indicaram falha no serviço investigado.';
  }
  private drain() {
    if (this.running || this.closing) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.controller.signal.aborted) {
      this.drain();
      return;
    }
    this.running = this.execute(job).finally(() => {
      this.running = null;
      this.drain();
    });
  }
  private check(
    r: Result,
    hostId: string,
    category: Category,
    label: string,
    status: Status,
    message: string,
    evidence: string[] = [],
    required = true,
    durationMs = 0,
  ) {
    r.checks.push({
      id: randomUUID(),
      category,
      label,
      status,
      hostId,
      message,
      evidence,
      durationMs,
      required,
      certainty:
        status === 'FAILED' || status === 'OK'
          ? 'CONFIRMED'
          : status === 'WARNING'
            ? 'PROBABLE'
            : 'INCONCLUSIVE',
    });
  }
  private stage(job: Job, value: string) {
    job.result.stage = value;
    job.result.progress ??= [];
    job.result.progress.push({ stage: value, at: new Date().toISOString() });
  }
  private safeCode(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    return /^(?:SSH_[A-Z_]+|VALIDATED_COMMAND_PROFILE_REQUIRED|INVALID_CONTEXT_PROFILE|INVENTORY_CHANGED|PROFILE_EXPIRED|NOT_HOMOLOGATED|DIAGNOSTIC_ABORTED|AC_NOT_PROVEN)$/.test(
      code,
    )
      ? code
      : 'COMMAND_NOT_COMPLETED';
  }
  private addEvidence(
    job: Job,
    host: HostRecord,
    item: CompleteCliObservation & { durationMs?: number; sha256?: string },
  ) {
    if (job.result.completedAt || job.controller.signal.aborted) return;
    if (
      job.result.evidence
        .filter((e) => e.source === 'LIVE_SSH')
        .reduce((n, e) => n + Buffer.byteLength(e.output), 0) +
        Buffer.byteLength(item.stdout) >
      limits.totalOutputBytes
    )
      throw new Error('SSH_DIAGNOSTIC_OUTPUT_LIMIT');
    job.result.evidence.push({
      id: randomUUID(),
      diagnosticId: job.result.diagnosticId,
      hostId: host.id,
      source: 'LIVE_SSH',
      observedAt: item.complete ? item.completedAt : null,
      collectedAt: new Date().toISOString(),
      command: item.command,
      output: item.stdout,
      complete: item.complete,
      sha256: item.sha256 ?? createHash('sha256').update(item.stdout).digest('hex'),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    });
  }
  private auditCommand(job: Job, host: HostRecord, command: string) {
    job.controller.signal.throwIfAborted();
    if (job.wireCommands >= 14) throw new Error('SSH_DIAGNOSTIC_COMMAND_BUDGET');
    this.audit({
      diagnosticId: job.result.diagnosticId,
      operatorId: job.result.operator.id,
      hostId: host.id,
      command,
    });
    job.wireCommands++;
  }
  private async collectFresh(job: Job, host: HostRecord, vsi: MplsVsi, endpoint: Endpoint) {
    const r = job.result;
    r.evidence.push({
      id: randomUUID(),
      diagnosticId: r.diagnosticId,
      hostId: host.id,
      source: 'PERSISTED_SNMP',
      observedAt: vsi.lastSeenAt,
      collectedAt: new Date().toISOString(),
      command: null,
      output: JSON.stringify({
        name: vsi.name,
        rd: vsi.rd,
        status: vsi.status,
        acs: vsi.acs,
        pws: vsi.pws,
      }),
    });
    this.stage(
      job,
      `Validando e coletando ${endpoint.association === 'LOCAL' ? 'PE local' : 'PE remoto'}: ${host.name}`,
    );
    const observations = new Map<string, CompleteCliObservation>();
    let platform: PingTarget['platform'] | null = null;
    try {
      const collected = await abortable(
        job.controller.signal,
        this.ssh.collectEndpoint(
          host,
          vsi.name,
          job.controller.signal,
          (command) => this.auditCommand(job, host, command),
          (observation) => {
            this.addEvidence(job, host, observation);
            observations.set(observation.command, observation);
            this.stage(job, `${host.name}: ${observation.command}`);
          },
        ),
      );
      platform = collected.platform;
    } catch (error) {
      this.check(
        r,
        host.id,
        'VSI',
        'Coleta atual',
        'INSUFFICIENT_DATA',
        `Coleta não concluída (${this.safeCode(error)}); resultados parciais preservados.`,
      );
      if (
        this.safeCode(error) === 'INVENTORY_CHANGED' ||
        this.safeCode(error) === 'SSH_DIAGNOSTIC_HOST_KEY_MISMATCH' ||
        this.safeCode(error) === 'SSH_DIAGNOSTIC_CONTEXT_MISMATCH'
      )
        throw error;
    }
    job.controller.signal.throwIfAborted();
    const prompt = `<${host.name}>`,
      ldp = observations.get('display mpls ldp'),
      brief = observations.get('display ip interface brief'),
      v = observations.get(vsiCommand({ kind: 'VSI', argument: vsi.name }));
    if (
      [...observations.values()].some(
        (c) =>
          !isCompleteObservation(c, prompt) ||
          Date.parse(c.completedAt) < Date.parse(r.startedAt) ||
          Date.parse(c.completedAt) > Date.now(),
      )
    ) {
      this.check(
        r,
        host.id,
        'VSI',
        'Evidência da execução',
        'INSUFFICIENT_DATA',
        'Saída incompleta ou timestamp fora desta execução; probes bloqueados.',
      );
      return { captures: null, platform: null, facts: null };
    }
    const loopback = ldp && brief ? observeMplsLoopback(ldp, brief, prompt) : null;
    if (loopback?.status === 'CONFIRMED_LOOPBACK')
      endpoint.loopback = {
        address: loopback.address,
        interfaceName: loopback.interfaceName,
        routingContext: 'GLOBAL',
        evidence: r.evidence
          .filter(
            (e) =>
              e.hostId === host.id &&
              ['display mpls ldp', 'display ip interface brief'].includes(e.command ?? ''),
          )
          .map((e) => e.id),
      };
    this.check(
      r,
      host.id,
      'UNDERLAY',
      'LoopBack atual',
      endpoint.loopback ? 'OK' : 'INSUFFICIENT_DATA',
      endpoint.loopback
        ? `CONFIRMED_LOOPBACK ${endpoint.loopback.interfaceName} ${endpoint.loopback.address}; GLOBAL.`
        : 'LoopBack não comprovada nesta execução; management IP não é substituto.',
    );
    const facts = v ? observeVsi(v, vsi.name, prompt) : null;
    if (facts) endpoint.observedVsi = facts;
    this.check(
      r,
      host.id,
      'VSI',
      'VSI atual',
      facts?.status === 'UP' ? 'OK' : facts?.status === 'DOWN' ? 'FAILED' : 'INSUFFICIENT_DATA',
      `VSI ${vsi.name}: ${facts?.status ?? 'não confirmada'}.`,
    );
    if (facts && facts.status !== vsi.status)
      this.check(
        r,
        host.id,
        'VSI',
        'Divergência CLI/SNMP',
        'WARNING',
        'Estado CLI atual difere do índice persistido; horários preservados.',
        r.evidence
          .filter(
            (e) =>
              e.hostId === host.id && (e.source === 'PERSISTED_SNMP' || e.command === v?.command),
          )
          .map((e) => e.id),
        false,
      );
    for (const peer of facts?.peers ?? [])
      this.check(
        r,
        host.id,
        'PW',
        `PW ${peer.address}`,
        peer.state === 'UP' ? 'OK' : peer.state === 'DOWN' ? 'FAILED' : 'INSUFFICIENT_DATA',
        `Peer observado ${peer.address}; PW ${peer.state ?? 'não confirmado'}; VC-ID CLI ${peer.vcId ?? 'desconhecido'}; labels ${peer.inboundLabel ?? '?'} / ${peer.outboundLabel ?? '?'}. Índice persistido não é VC-ID.`,
      );
    const acName = facts?.attachments.length === 1 ? facts.attachments[0]!.interfaceName : null;
    const ac = acName
      ? observations.get(vsiCommand({ kind: 'INTERFACE', argument: acName }))
      : undefined;
    const state =
      ac && isCompleteObservation(ac, prompt) ? parseInterface(ac.stdout, acName!) : null;
    this.check(
      r,
      host.id,
      'AC',
      `AC ${acName ?? 'não comprovada'}`,
      state
        ? state.physical === 'UP' && state.logical === 'UP'
          ? 'OK'
          : 'FAILED'
        : 'INSUFFICIENT_DATA',
      state
        ? `${acName}: físico ${state.physical}, lógico ${state.logical}; vínculo proveniente da VSI atual.`
        : 'AC não confirmada por CLI nesta execução. VLAN isolada não cria vínculo.',
    );
    return {
      captures:
        ldp &&
        brief &&
        v &&
        ac &&
        state &&
        facts?.status &&
        facts.attachments.length === 1 &&
        ['UP', 'DOWN'].includes(facts.attachments[0]!.state ?? '') &&
        facts.peers.length === 1 &&
        facts.peers[0]!.state
          ? { ldp, brief, vsi: v, ac }
          : null,
      platform,
      facts,
    };
  }
  private async execute(job: Job) {
    const r = job.result;
    r.state = 'RUNNING';
    try {
      this.stage(job, 'Preparando diagnóstico e validando os PEs');
      const hosts = await abortable(job.controller.signal, this.hosts.listHosts());
      const indexed = job.vsi.pws.length === 1 ? job.vsi.pws[0] : null;
      const indexedHosts = indexed
        ? indexed.remoteHostId
          ? hosts.filter((h) => h.id === indexed.remoteHostId)
          : hosts.filter((h) => h.ip === indexed.remoteIp || h.managementIp === indexed.remoteIp)
        : [];
      const peerHosts = indexed
        ? hosts.filter((h) => h.ip === indexed.remoteIp || h.managementIp === indexed.remoteIp)
        : [];
      if (
        indexedHosts.length !== 1 ||
        indexedHosts[0]!.id === job.host.id ||
        peerHosts.length !== 1 ||
        peerHosts[0]!.id !== indexedHosts[0]!.id
      ) {
        this.check(
          r,
          job.host.id,
          'PW',
          'Índice inicial',
          'INSUFFICIENT_DATA',
          'É necessário um único candidato remoto no inventário antes do SSH.',
        );
        this.complete(job);
        return;
      }
      // Re-read the indexed service and capability before either SSH collection.
      const indexedRemote = indexedHosts[0]!;
      const localOverview = await abortable(
        job.controller.signal,
        this.mpls.getHostOverview(job.host.id),
      );
      const remoteOverview = await abortable(
        job.controller.signal,
        this.mpls.getHostOverview(indexedRemote.id),
      );
      const localVsis = localOverview.vsis.filter(
        (v) => v.id === job.vsi.id && v.hostId === job.host.id && v.name === job.vsi.name,
      );
      const remoteVsis = remoteOverview.vsis.filter(
        (v) => v.hostId === indexedRemote.id && v.name === job.vsi.name,
      );
      if (localVsis.length !== 1 || remoteVsis.length !== 1)
        throw new VsiInventoryError('PERSISTED_VSI_IDENTITY_MISMATCH');
      const currentLocal = localVsis[0]!,
        indexedRemoteVsi = remoteVsis[0]!;
      if (
        currentLocal.pws.length !== job.vsi.pws.length ||
        currentLocal.pws.some(
          (pw, i) =>
            pw.remoteIp !== job.vsi.pws[i]?.remoteIp ||
            pw.remoteHostId !== job.vsi.pws[i]?.remoteHostId,
        )
      )
        throw new VsiInventoryError('INVENTORY_CHANGED');
      for (const [host, peer, vsi, overview, side] of [
        [job.host, indexedRemote, currentLocal, localOverview, 'LOCAL'],
        [indexedRemote, job.host, indexedRemoteVsi, remoteOverview, 'REMOTE'],
      ] as const) {
        const limitation = precheckVsiInventory({
          host,
          peer,
          vsi,
          overview,
          expectedName: job.vsi.name,
          now: Date.now(),
        });
        if (limitation) {
          r.warnings.push(
            `${side}_PW_SNMP_UNAVAILABLE: PW SNMP indisponível no PE ${host.name}; validação será realizada pelo diagnóstico SSH.`,
          );
          r.evidence.push({
            id: randomUUID(),
            diagnosticId: r.diagnosticId,
            hostId: host.id,
            source: 'PERSISTED_SNMP',
            observedAt: limitation.observedAt,
            collectedAt: new Date().toISOString(),
            command: null,
            output: JSON.stringify({ ...limitation, vsiName: vsi.name, pws: vsi.pws }),
          });
        }
      }
      job.vsi = currentLocal;
      await abortable(job.controller.signal, this.ssh.validate(job.host, job.controller.signal));
      await abortable(
        job.controller.signal,
        this.ssh.validate(indexedHosts[0]!, job.controller.signal),
      );
      const local = await this.collectFresh(job, job.host, job.vsi, r.local);
      const addresses = [...new Set((local.facts?.peers ?? []).map((p) => p.address))];
      const candidates = addresses.length ? addresses : job.vsi.pws.map((p) => p.remoteIp);
      if (candidates.length !== 1) {
        this.check(
          r,
          job.host.id,
          'PW',
          'PE remoto',
          'INSUFFICIENT_DATA',
          'É necessário um único peer comprovável; nenhum probe foi executado.',
        );
        this.complete(job);
        return;
      }
      const peer = candidates[0]!;
      const persisted = job.vsi.pws.filter((p) => p.remoteIp === peer);
      const matches =
        persisted.length === 1 && persisted[0]!.remoteHostId
          ? hosts.filter((h) => h.id === persisted[0]!.remoteHostId)
          : hosts.filter((h) => h.managementIp === peer || h.ip === peer);
      if (
        matches.length !== 1 ||
        matches[0]!.id === job.host.id ||
        matches[0]!.id !== indexedHosts[0]!.id
      ) {
        this.check(
          r,
          job.host.id,
          'PW',
          'PE remoto',
          'INSUFFICIENT_DATA',
          'Host remoto desconhecido ou associação ambígua.',
        );
        this.complete(job);
        return;
      }
      const remote = matches[0]!;
      const vsis = [indexedRemoteVsi];
      const selection = selectRemoteCandidate(
        vsis.map((v) => ({
          hostId: v.hostId,
          name: v.name,
          rd: v.rd,
          signalingType: v.signalingType,
          pws: v.pws,
        })),
        remote.id,
        {
          name: job.vsi.name,
          rd: local.facts?.rd ?? job.vsi.rd,
          signaling: local.facts?.signaling ?? job.vsi.signalingType,
          address: r.local.loopback?.address ?? '',
        },
      );
      const selected = selection.candidate
        ? vsis.filter(
            (v) => v.name === selection.candidate!.name && v.rd === selection.candidate!.rd,
          )
        : [];
      if (selected.length !== 1) {
        this.check(
          r,
          remote.id,
          'VSI',
          'VSI remota',
          'INSUFFICIENT_DATA',
          'Candidato remoto por RD/sinalização ausente ou ambíguo.',
        );
        this.complete(job);
        return;
      }
      const remoteVsi = selected[0]!;
      const endpoint: Endpoint = {
        hostId: remote.id,
        name: remote.name,
        vsiId: remoteVsi.id,
        vsiName: remoteVsi.name,
        loopback: null,
        association: persisted[0]?.remoteHostId ? 'PERSISTED_REMOTE_ID' : 'EXACT_INVENTORY_IP',
      };
      r.remotes.push(endpoint);
      const other = await this.collectFresh(job, remote, remoteVsi, endpoint);
      if (
        !local.captures ||
        !other.captures ||
        !local.platform ||
        !other.platform ||
        !r.local.loopback ||
        !endpoint.loopback ||
        endpoint.loopback.address !== peer
      ) {
        this.check(
          r,
          remote.id,
          'UNDERLAY',
          'Gates de probes',
          'INSUFFICIENT_DATA',
          'Coleta atual incompleta ou peer/LoopBack divergentes. Nenhum probe liberado.',
        );
        this.complete(job);
        return;
      }
      const reciprocal = correlateReciprocalVsi(
        {
          evidence: local.captures.vsi,
          name: job.vsi.name,
          prompt: `<${job.host.name}>`,
          loopback: observeMplsLoopback(
            local.captures.ldp,
            local.captures.brief,
            `<${job.host.name}>`,
          ),
        },
        {
          evidence: other.captures.vsi,
          name: remoteVsi.name,
          prompt: `<${remote.name}>`,
          loopback: observeMplsLoopback(
            other.captures.ldp,
            other.captures.brief,
            `<${remote.name}>`,
          ),
        },
      );
      const matching =
        reciprocal.status === 'CONFIRMED_RECIPROCAL_VSI' &&
        reciprocal.labelComparisons.every((c) => c.classification === 'MATCH');
      this.check(
        r,
        remote.id,
        'PW',
        'Reciprocidade e labels',
        matching ? 'OK' : 'INSUFFICIENT_DATA',
        matching
          ? 'Peers recíprocos e labels cruzados MATCH na execução atual.'
          : 'Peer/labels não comprovados; probes bloqueados.',
      );
      if (!matching) {
        this.complete(job);
        return;
      }
      const targets = {
        LOCAL: {
          hostId: job.host.id,
          name: job.host.name,
          source: r.local.loopback.address,
          destination: endpoint.loopback.address,
          platform: local.platform,
        },
        REMOTE: {
          hostId: remote.id,
          name: remote.name,
          source: endpoint.loopback.address,
          destination: r.local.loopback.address,
          platform: other.platform,
        },
      };
      const pings = {} as Record<
        'LOCAL' | 'REMOTE',
        CompleteCliObservation & { durationMs: number; errorCode?: string }
      >;
      for (const direction of ['LOCAL', 'REMOTE'] as const) {
        job.controller.signal.throwIfAborted();
        this.stage(
          job,
          `Testando conectividade ${direction === 'LOCAL' ? job.host.name : remote.name}`,
        );
        const target = targets[direction],
          host = direction === 'LOCAL' ? job.host : remote,
          operation = {
            kind: 'PING' as const,
            source: target.source,
            destination: target.destination,
          };
        const command = vsiCommand(operation),
          start = Date.now();
        let stdout = '',
          errorCode: string | undefined;
        try {
          stdout = await abortable(
            job.controller.signal,
            this.ssh.run(host, operation, job.controller.signal, (c) =>
              this.auditCommand(job, host, c),
            ),
          );
        } catch (error) {
          errorCode = this.safeCode(error);
          if (errorCode === 'SSH_DIAGNOSTIC_HOST_KEY_MISMATCH' || errorCode === 'INVENTORY_CHANGED')
            throw error;
        }
        job.controller.signal.throwIfAborted();
        const observation = {
          command,
          stdout,
          complete: !errorCode,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          ...(errorCode ? { errorCode } : {}),
        };
        this.addEvidence(job, host, observation);
        if (errorCode) r.evidence.at(-1)!.errorCode = errorCode;
        pings[direction] = observation;
        const parsed = errorCode ? null : observeHuaweiPing(observation, direction, target);
        if (!parsed)
          this.check(
            r,
            host.id,
            'LOOPBACK_REACHABILITY',
            'Ping atual',
            'INSUFFICIENT_DATA',
            `PROBE_FAILED: ${errorCode ?? 'saída não reconhecida'}.`,
            [],
            true,
          );
      }
      this.stage(job, 'Correlacionando evidências');
      job.controller.signal.throwIfAborted();
      const correlation = correlateVsiEvidence({
        startedAt: r.startedAt,
        collectedAt: new Date().toISOString(),
        vsiName: job.vsi.name,
        targets,
        pings,
        endpoints: { LOCAL: local.captures, REMOTE: other.captures },
      });
      r.underlayClassification = correlation.classification;
      r.probes = correlation.probes.map((probe, i) => ({
        ...probe,
        ...(correlation.observedPings[i]
          ? {
              transmitted: correlation.observedPings[i]!.transmitted,
              received: correlation.observedPings[i]!.received,
            }
          : {}),
        tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
      }));
      r.checks.push(
        ...correlation.checks.map((c) => ({
          ...c,
          id: randomUUID(),
          evidence: r.evidence
            .filter((e) => e.hostId === c.hostId && e.command?.startsWith('ping -a '))
            .map((e) => e.id),
        })),
      );
      r.warnings.push(
        ...correlation.warnings,
        'Traceroute real desabilitado: NOT_HOMOLOGATED.',
        'F1A, cliente final, porta física, CRC, LLDP e LSP detalhado não avaliados.',
      );
      this.complete(job);
      if (r.overallStatus === 'OK' && correlation.serviceConfirmed) {
        r.summary = correlation.summary;
        if (r.warnings.some((w) => w.startsWith('REMOTE_PW_SNMP_UNAVAILABLE:')))
          r.summary += ' O PE remoto não expõe evidência PW pela fonte SNMP utilizada.';
      }
    } catch (error) {
      if (job.controller.signal.aborted)
        this.complete(
          job,
          job.controller.signal.reason === 'OPERATOR_CANCELLED' ? 'CANCELLED' : 'TIMED_OUT',
        );
      else {
        this.check(
          r,
          job.host.id,
          'VSI',
          'Investigação parcial',
          'INSUFFICIENT_DATA',
          error instanceof VsiInventoryError
            ? `${error.message}: pré-checagem do inventário bloqueada antes do SSH.`
            : 'Etapa interrompida; evidências anteriores preservadas. Nenhum retry automático.',
        );
        this.complete(job);
      }
    }
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values())
      if (!job.result.completedAt) {
        job.controller.abort('OPERATOR_CANCELLED');
        if (job.result.state === 'QUEUED') this.complete(job, 'CANCELLED');
      }
    await this.running;
  }
}
