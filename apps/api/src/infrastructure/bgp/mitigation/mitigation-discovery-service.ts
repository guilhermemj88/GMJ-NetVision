import type { HostRecord } from '@gmj/shared';
import type { BgpDiscoveryOutcome, DiscoveredBgpPeer } from '../bgp-discovery-service';
import { effectiveBandwidthBps } from './bandwidth-parser';
import { DEFAULT_MITIGATION_RT } from './mitigation-config';
import {
  allNodesOf,
  nodesApplyingRouteTarget,
  parseHuaweiBgpPolicyConfiguration,
  parseHuaweiRoutePolicyNodes,
  permitNodesOf,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';
import type { BgpMitigationConfigSource } from './mitigation-config-source';
import { interfaceMitigationScope, type MitigationInterfaceScope } from './mitigation-scope';
import { prefixStatus, selectTemporaryNode } from './mitigation-planner';
import type { MitigationRepository } from './mitigation-repository';
import type { BandwidthSource, MitigationBlockReason, PrefixStatus } from './mitigation-types';

// Discovery DDoS (Fase 4) - READ-ONLY e SIMULATION_ONLY.
//
// Consome o discovery BGP existente (nao reimplementa a correlacao peer->interface),
// aplica o filtro de escopo por banda explicita na alias/description, resolve a policy
// de IMPORT e os nodes da route-policy e persiste o profile via MitigationRepository
// (nunca Prisma direto).
//
// Decisoes documentadas:
//  - identidade do profile e (deviceId, policyName): a acao pertence a POLICY/CLIENTE,
//    entao varios peers que compartilham a policy viram UM profile com N peers;
//  - interface considerada e a do peer de menor endereco (deterministico); se os peers
//    da policy apontam para interfaces diferentes, o profile fica NOT_READY com
//    INTERFACE_AMBIGUOUS (nunca inferimos);
//  - currentPrefixCount e o MAIOR contador entre os peers da policy (a route-policy e
//    avaliada por sessao); qualquer peer com contagem desconhecida torna UNKNOWN;
//  - "node de mitigacao" e o node de PERMIT que aplica a route-target do motor
//    (deps.mitigationRt). O parser devolve as RTs por node e a classificacao acontece
//    aqui - um node normal que aplica outra RT nao e confundido com mitigacao;
//  - nome do cliente e derivado apenas removendo o token de banda do texto original,
//    que continua preservado em interfaceDescriptionRaw;
//  - interface que perdeu a banda sai do escopo: o profile NAO e apagado, mas o runtime
//    e marcado DISABLED para nunca seguir ativo em silencio;
//  - profile NOT_READY NUNCA e persistido como NORMAL. Como MitigationState nao tem um
//    estado proprio de "nao pronto", usamos RECONCILIATION_REQUIRED: o worker nao pode
//    tratar esse profile como pronto e a condicao precisa ser revalidada/reconciliada.

export type MitigationReadiness = 'READY' | 'NOT_READY';

export interface MitigationDiscoveryProfile {
  /** `null` quando a policy IN nao pode ser resolvida (profile nao persistido). */
  policyName: string | null;
  customer: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceDescriptionRaw: string | null;
  detectedBandwidthBps: bigint | null;
  effectiveBandwidthBps: bigint | null;
  bandwidthSource: BandwidthSource;
  peerAddresses: string[];
  prefixCount: number | null;
  prefixLimit: number;
  prefixStatus: PrefixStatus;
  /** Todos os nodes existentes na policy (permit + deny). */
  existingNodes: number[];
  /** Nodes de permit que ja aplicam a RT de mitigacao do motor. */
  mitigationNodes: number[];
  firstNormalNode: number | null;
  plannedNode: number | null;
  readiness: MitigationReadiness;
  blockedReason: MitigationBlockReason | null;
}

export interface MitigationDiscoveryResult {
  deviceId: string;
  scannedPeers: number;
  candidateInterfaces: number;
  ignoredNoBandwidth: number;
  createdProfiles: number;
  updatedProfiles: number;
  blockedProfiles: number;
  outOfScopeProfiles: string[];
  ambiguousPeers: string[];
  profiles: MitigationDiscoveryProfile[];
  warnings: string[];
}

export interface BgpMitigationDiscoveryDeps {
  bgpDiscovery: { discover(device: HostRecord): Promise<BgpDiscoveryOutcome> };
  configSource: BgpMitigationConfigSource;
  repository: MitigationRepository;
  /** Limite de prefixos usado no guard de seguranca (default 100). */
  prefixLimit?: number;
  /** Route-target de mitigacao do motor; so ela classifica um node como mitigado. */
  mitigationRt?: string;
  now?: () => Date;
}

interface Candidate {
  peer: DiscoveredBgpPeer;
  scope: MitigationInterfaceScope;
}

// Ordem de precedencia do motivo de bloqueio (o mais especifico vence).
const BLOCK_PRIORITY: readonly MitigationBlockReason[] = [
  'INTERFACE_AMBIGUOUS',
  'READBACK_FAILED',
  'POLICY_NOT_FOUND',
  'PREFIX_UNKNOWN',
  'PREFIX_LIMIT_EXCEEDED',
  'NO_SAFE_TEMPORARY_NODE',
];

function pickBlockReason(
  reasons: readonly (MitigationBlockReason | null)[],
): MitigationBlockReason | null {
  let best: MitigationBlockReason | null = null;
  for (const reason of reasons) {
    if (!reason) continue;
    if (best === null || BLOCK_PRIORITY.indexOf(reason) < BLOCK_PRIORITY.indexOf(best)) {
      best = reason;
    }
  }
  return best;
}

// Maior contador de prefixos entre os peers da policy. Qualquer peer com contagem
// desconhecida torna o resultado UNKNOWN - nunca mitigamos as cegas.
export function aggregatePrefixCount(values: readonly (bigint | null)[]): number | null {
  if (values.length === 0) return null;
  if (values.some((value) => value === null)) return null;
  return Math.max(...values.map((value) => Number(value)));
}

export class BgpMitigationDiscoveryService {
  private readonly prefixLimit: number;
  private readonly mitigationRt: string;
  private readonly now: () => Date;

  constructor(private readonly deps: BgpMitigationDiscoveryDeps) {
    this.prefixLimit = deps.prefixLimit ?? 100;
    this.mitigationRt = deps.mitigationRt ?? DEFAULT_MITIGATION_RT;
    this.now = deps.now ?? (() => new Date());
  }

  /** Entrada principal: roda o discovery BGP existente e depois o de mitigacao. */
  async discoverMitigationProfiles(device: HostRecord): Promise<MitigationDiscoveryResult> {
    const outcome = await this.deps.bgpDiscovery.discover(device);
    return this.discoverFromBgpOutcome(device, outcome);
  }

  /** Mesma logica, consumindo um resultado BGP ja obtido (testavel isolado). */
  async discoverFromBgpOutcome(
    device: HostRecord,
    outcome: BgpDiscoveryOutcome,
  ): Promise<MitigationDiscoveryResult> {
    const now = this.now();
    const warnings: string[] = [...outcome.warnings];

    // UMA leitura agregada de configuracao por device - nunca um comando por peer.
    const snapshot = await this.deps.configSource.readMitigationConfig(device);
    warnings.push(...snapshot.warnings);

    const policies = snapshot.bgpConfiguration
      ? parseHuaweiBgpPolicyConfiguration(snapshot.bgpConfiguration)
      : null;
    const nodeMap = snapshot.routePolicyConfiguration
      ? parseHuaweiRoutePolicyNodes(snapshot.routePolicyConfiguration)
      : null;

    const existingPolicyNames = new Set(
      (await this.deps.repository.listProfiles({ deviceId: device.id })).map(
        (profile) => profile.policyName,
      ),
    );

    const candidates: Candidate[] = [];
    const ambiguousPeers: string[] = [];
    let ignoredNoBandwidth = 0;

    for (const peer of outcome.peers) {
      if (peer.correlationStatus !== 'MATCHED' || !peer.interfaceId) {
        if (peer.correlationStatus === 'AMBIGUOUS') ambiguousPeers.push(peer.peerAddress);
        continue;
      }
      const scope = interfaceMitigationScope({
        alias: peer.interfaceAlias ?? '',
        description: peer.interfaceDescription ?? '',
      });
      if (!scope.inScope) {
        ignoredNoBandwidth += 1;
        continue;
      }
      candidates.push({ peer, scope });
    }

    const byPolicy = new Map<string, Candidate[]>();
    const unresolved: Candidate[] = [];
    for (const candidate of candidates) {
      const policyName = policies
        ? resolvePeerInboundPolicy(candidate.peer.peerAddress, policies)
        : null;
      if (!policyName) {
        unresolved.push(candidate);
        continue;
      }
      const group = byPolicy.get(policyName) ?? [];
      group.push(candidate);
      byPolicy.set(policyName, group);
    }

    const profiles: MitigationDiscoveryProfile[] = [];
    const touchedProfileIds = new Set<string>();
    let createdProfiles = 0;
    let updatedProfiles = 0;

    for (const [policyName, group] of [...byPolicy.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const sorted = [...group].sort((left, right) =>
        left.peer.peerAddress.localeCompare(right.peer.peerAddress),
      );
      const primary = sorted[0]!;
      const interfaceAmbiguous = new Set(group.map((item) => item.peer.interfaceId)).size > 1;

      const policyNodes = nodeMap?.get(policyName) ?? null;
      const existingNodes = policyNodes ? allNodesOf(policyNodes) : [];
      const mitigationNodes = policyNodes
        ? nodesApplyingRouteTarget(policyNodes, this.mitigationRt)
        : [];
      const normalNodes = policyNodes
        ? permitNodesOf(policyNodes).filter((node) => !mitigationNodes.includes(node))
        : [];
      const nodeDecision = policyNodes
        ? selectTemporaryNode({ normalNodes, occupiedNodes: existingNodes })
        : null;

      const prefixCount = aggregatePrefixCount(sorted.map((item) => item.peer.cliReceivedPrefixes));
      const status = prefixStatus(prefixCount, this.prefixLimit);

      const blockedReason = pickBlockReason([
        interfaceAmbiguous ? 'INTERFACE_AMBIGUOUS' : null,
        nodeMap === null ? 'READBACK_FAILED' : null,
        nodeMap !== null && policyNodes === null ? 'POLICY_NOT_FOUND' : null,
        status === 'UNKNOWN' ? 'PREFIX_UNKNOWN' : null,
        status === 'EXCEEDED' ? 'PREFIX_LIMIT_EXCEEDED' : null,
        nodeDecision?.blocked ? 'NO_SAFE_TEMPORARY_NODE' : null,
      ]);

      const profile = await this.deps.repository.upsertProfile({
        deviceId: device.id,
        policyName,
        interfaceId: primary.peer.interfaceId,
        detectedBandwidthBps: primary.scope.detectedBandwidthBps,
        bandwidthSource: primary.scope.bandwidthSource,
        prefixLimit: this.prefixLimit,
      });
      touchedProfileIds.add(profile.id);
      if (existingPolicyNames.has(policyName)) updatedProfiles += 1;
      else createdProfiles += 1;

      await this.deps.repository.replaceProfilePeers(
        profile.id,
        sorted.map((item) => ({
          peerAddress: item.peer.peerAddress,
          addressFamily: item.peer.addressFamily,
          primary: item.peer.peerAddress === primary.peer.peerAddress,
        })),
      );

      // plannedNode e SEMPRE reescrito (valor ou null) para nao sobreviver a uma
      // condicao que deixou de existir (nodes 1..9 ocupados, policy trocada, etc.).
      const plannedNode = nodeDecision?.node ?? null;
      const runtime = await this.deps.repository.getRuntime(profile.id);
      await this.deps.repository.upsertRuntime(profile.id, {
        lastValidatedAt: now,
        lastReconciledAt: now,
        plannedNode,
        ...(blockedReason !== null
          ? { state: 'RECONCILIATION_REQUIRED' as const }
          : runtime === null ||
              runtime.state === 'DISABLED' ||
              runtime.state === 'RECONCILIATION_REQUIRED'
            ? { state: 'NORMAL' as const }
            : {}),
      });

      profiles.push({
        policyName,
        customer: primary.scope.customerDisplayName,
        interfaceId: profile.interfaceId,
        interfaceName: primary.peer.interfaceName,
        interfaceDescriptionRaw: primary.scope.descriptionRaw,
        detectedBandwidthBps: profile.detectedBandwidthBps,
        effectiveBandwidthBps: effectiveBandwidthBps(profile),
        bandwidthSource: profile.bandwidthSource,
        peerAddresses: sorted.map((item) => item.peer.peerAddress),
        prefixCount,
        prefixLimit: this.prefixLimit,
        prefixStatus: status,
        existingNodes,
        mitigationNodes,
        firstNormalNode: nodeDecision?.firstNormalNode ?? null,
        plannedNode,
        readiness: blockedReason === null ? 'READY' : 'NOT_READY',
        blockedReason,
      });
    }

    // Candidatos com banda mas sem policy IN resolvivel: reportados como NOT_READY,
    // sem persistir um profile com nome de policy inventado.
    for (const candidate of [...unresolved].sort((left, right) =>
      left.peer.peerAddress.localeCompare(right.peer.peerAddress),
    )) {
      const { peer, scope } = candidate;
      const prefixCount =
        peer.cliReceivedPrefixes === null ? null : Number(peer.cliReceivedPrefixes);
      profiles.push({
        policyName: null,
        customer: scope.customerDisplayName,
        interfaceId: peer.interfaceId,
        interfaceName: peer.interfaceName,
        interfaceDescriptionRaw: scope.descriptionRaw,
        detectedBandwidthBps: scope.detectedBandwidthBps,
        effectiveBandwidthBps: scope.detectedBandwidthBps,
        bandwidthSource: scope.bandwidthSource,
        peerAddresses: [peer.peerAddress],
        prefixCount,
        prefixLimit: this.prefixLimit,
        prefixStatus: prefixStatus(prefixCount, this.prefixLimit),
        existingNodes: [],
        mitigationNodes: [],
        firstNormalNode: null,
        plannedNode: null,
        readiness: 'NOT_READY',
        blockedReason: policies === null ? 'READBACK_FAILED' : 'POLICY_NOT_FOUND',
      });
    }

    const outOfScopeProfiles = await this.reconcileOutOfScope(
      device,
      touchedProfileIds,
      now,
      warnings,
    );

    return {
      deviceId: device.id,
      scannedPeers: outcome.peers.length,
      candidateInterfaces: new Set(candidates.map((item) => item.peer.interfaceId)).size,
      ignoredNoBandwidth,
      createdProfiles,
      updatedProfiles,
      blockedProfiles: profiles.filter((profile) => profile.readiness === 'NOT_READY').length,
      outOfScopeProfiles,
      ambiguousPeers,
      profiles,
      warnings,
    };
  }

  // Profiles que existiam, tinham peers e NAO apareceram neste discovery sairam de
  // escopo (perdeu banda, policy mudou). Nada e apagado: o runtime vira DISABLED e o
  // plannedNode antigo e limpo, para o profile parar de contar para mitigacao.
  private async reconcileOutOfScope(
    device: HostRecord,
    touchedProfileIds: ReadonlySet<string>,
    now: Date,
    warnings: string[],
  ): Promise<string[]> {
    const outOfScope: string[] = [];
    for (const profile of await this.deps.repository.listProfiles({ deviceId: device.id })) {
      if (touchedProfileIds.has(profile.id)) continue;
      const runtime = await this.deps.repository.getRuntime(profile.id);
      if (runtime?.state === 'DISABLED' && runtime.plannedNode === null) continue;
      const peers = await this.deps.repository.listProfilePeers(profile.id);
      if (peers.length === 0) continue;
      await this.deps.repository.upsertRuntime(profile.id, {
        state: 'DISABLED',
        plannedNode: null,
        lastReconciledAt: now,
      });
      outOfScope.push(profile.policyName);
      warnings.push(
        `policy ${profile.policyName}: fora do escopo automatico; runtime marcado como DISABLED (historico preservado)`,
      );
    }
    return outOfScope;
  }
}
