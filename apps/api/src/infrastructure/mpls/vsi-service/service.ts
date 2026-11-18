import { randomUUID } from 'node:crypto';
import type { AuthUser, HostRecord, MplsVsi, VsiServiceDiagnosis } from '@gmj/shared';
import type { HostRepository } from '../../persistence/host-repository';
import type { MplsRepository } from '../mpls-repository';
import type { ToolEnvelope } from '../vsi-mcp/contracts';
import { VsiMcpToolError, type VsiMcpTools } from '../vsi-mcp/tools';
import { aggregateVsiService, type AggregateParticipant, type DiagnoseVsiData } from './aggregator';

/**
 * Diagnostico VSI/VPLS por SERVICO: descobre os PEs participantes, chama `diagnose_vsi` em cada
 * PE autorizado e agrega tudo num `VsiServiceDiagnosis`.
 *
 * Nao abre SSH por conta propria: toda leitura passa por `VsiMcpTools.call`, com a mesma
 * aprovacao one-shot, allowlist de comandos, perfil por host e auditoria. Um PE sem `approvalId`
 * NAO e lido e aparece como participante nao lido.
 */

export const VSI_SERVICE_LIMITS = Object.freeze({ requestedEndpoints: 6, participants: 8, retainedRuns: 50 });

type Operator = Pick<AuthUser, 'id' | 'username' | 'role'>;

export interface VsiServiceEndpointRequest {
  hostId: string;
  /** Sem aprovacao o PE nao e lido (so entra como participante). */
  approvalId?: string | undefined;
  interfaces?: string[] | undefined;
  vlanId?: number | undefined;
  carrierInterfaces?: string[] | undefined;
  eTrunkIds?: number[] | undefined;
}
export interface VsiServiceRunRequest {
  vsiName: string;
  endpoints: VsiServiceEndpointRequest[];
  includeMac?: boolean | undefined;
  homologation?: boolean | undefined;
}

export interface VsiServiceDeps {
  hosts: Pick<HostRepository, 'getHost'>;
  mpls: Pick<MplsRepository, 'listVsis'>;
  tools: Pick<VsiMcpTools, 'call'>;
  engineVersion: string;
  now?: () => Date;
  newRunId?: () => string;
}

export class VsiServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VsiServiceError';
  }
}

interface Candidate {
  host: HostRecord | null;
  hostName: string;
  hostId: string | null;
  loopback: string | null;
  discoveredBy: AggregateParticipant['discoveredBy'];
  inventory: MplsVsi | null;
}

export class VsiServiceDiagnosticService {
  private readonly runs = new Map<string, VsiServiceDiagnosis>();

  constructor(private readonly deps: VsiServiceDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  get(runId: string): VsiServiceDiagnosis {
    const run = this.runs.get(runId);
    if (!run) throw new VsiServiceError(404, 'RUN_NOT_FOUND', 'Execução não encontrada (os resultados ficam só em memória).');
    return run;
  }

  /** Execucoes guardadas em memoria, da mais recente para a mais antiga. Nao executa nada. */
  list(): VsiServiceDiagnosis[] {
    return [...this.runs.values()].reverse();
  }

  /**
   * Participantes = PEs pedidos + peers dos PWs do inventario (seguindo `remoteHostId`), ate o
   * limite. Peer sem host correspondente entra assim mesmo, identificado pelo IP: nenhum
   * participante conhecido e omitido.
   */
  private async discover(request: VsiServiceRunRequest): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const inventoryOf = async (hostId: string): Promise<MplsVsi | null> =>
      (await this.deps.mpls.listVsis(hostId)).find((v) => v.name === request.vsiName) ?? null;
    for (const ep of request.endpoints) {
      const host = await this.deps.hosts.getHost(ep.hostId);
      if (!host) throw new VsiServiceError(404, 'HOST_NOT_FOUND', `Host ${ep.hostId} não encontrado`);
      if (out.some((c) => c.hostId === host.id)) throw new VsiServiceError(400, 'DUPLICATE_ENDPOINT', `Host ${host.id} repetido no pedido`);
      out.push({ host, hostId: host.id, hostName: host.name, loopback: null, discoveredBy: 'REQUESTED', inventory: await inventoryOf(host.id) });
    }
    for (let i = 0; i < out.length && out.length < VSI_SERVICE_LIMITS.participants; i++) {
      for (const pw of out[i]!.inventory?.pws ?? []) {
        if (out.length >= VSI_SERVICE_LIMITS.participants) break;
        if (pw.remoteHostId) {
          const known = out.find((c) => c.hostId === pw.remoteHostId);
          if (known) {
            known.loopback ??= pw.remoteIp;
            continue;
          }
          const host = await this.deps.hosts.getHost(pw.remoteHostId);
          if (host) {
            out.push({ host, hostId: host.id, hostName: host.name, loopback: pw.remoteIp, discoveredBy: 'PW_PEER', inventory: await inventoryOf(host.id) });
            continue;
          }
        }
        if (!out.some((c) => c.loopback === pw.remoteIp))
          out.push({ host: null, hostId: null, hostName: pw.remoteIp, loopback: pw.remoteIp, discoveredBy: 'PW_PEER', inventory: null });
      }
    }
    return out;
  }

  async run(request: VsiServiceRunRequest, operator: Operator): Promise<VsiServiceDiagnosis> {
    if (request.endpoints.length === 0 || request.endpoints.length > VSI_SERVICE_LIMITS.requestedEndpoints)
      throw new VsiServiceError(400, 'INVALID_ENDPOINTS', `Informe de 1 a ${VSI_SERVICE_LIMITS.requestedEndpoints} PEs`);
    const startedAt = this.now();
    const candidates = await this.discover(request);

    const participants: AggregateParticipant[] = [];
    for (const c of candidates) {
      const ep = request.endpoints.find((e) => e.hostId === c.hostId);
      const base = { hostId: c.hostId, hostName: c.hostName, loopback: c.loopback, discoveredBy: c.discoveredBy, inventory: c.inventory };
      if (!ep?.approvalId) {
        participants.push({ ...base, envelope: null, notRead: 'NOT_REQUESTED' });
        continue;
      }
      try {
        // Uma chamada por PE, em sequencia: mesma aprovacao one-shot, allowlist e auditoria do motor.
        const envelope = (await this.deps.tools.call(
          'diagnose_vsi',
          {
            hostId: ep.hostId,
            vsiName: request.vsiName,
            approvalId: ep.approvalId,
            includeMac: request.includeMac !== false,
            ...(ep.interfaces ? { interfaces: ep.interfaces } : {}),
            ...(ep.vlanId !== undefined ? { vlanId: ep.vlanId } : {}),
            ...(ep.carrierInterfaces ? { carrierInterfaces: ep.carrierInterfaces } : {}),
            ...(ep.eTrunkIds ? { eTrunkIds: ep.eTrunkIds } : {}),
            homologation: request.homologation === true,
          },
          operator,
        )) as ToolEnvelope<DiagnoseVsiData>;
        participants.push({ ...base, envelope });
      } catch (error) {
        if (!(error instanceof VsiMcpToolError)) throw error;
        // Papel insuficiente ou pedido invalido valem para a execucao inteira; aprovacao e por PE.
        if (error.httpStatus === 403 || error.httpStatus === 400) throw new VsiServiceError(error.httpStatus, error.code, error.message);
        participants.push({
          ...base,
          envelope: null,
          notRead: error.httpStatus === 423 ? 'NOT_AUTHORIZED' : 'FAILED',
          notReadDetail: `${error.code}: ${error.message}`,
        });
      }
    }

    const result = aggregateVsiService({
      runId: this.deps.newRunId?.() ?? randomUUID(),
      engineVersion: this.deps.engineVersion,
      origin: 'ENGINE_RUN',
      vsiName: request.vsiName,
      operator: { username: operator.username, role: operator.role },
      startedAt,
      completedAt: this.now(),
      participants,
    });
    this.runs.set(result.runId, result);
    while (this.runs.size > VSI_SERVICE_LIMITS.retainedRuns) this.runs.delete(this.runs.keys().next().value as string);
    return result;
  }
}
