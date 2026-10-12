import { createHash } from 'node:crypto';
import type { HostRecord } from '@gmj/shared';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import type { MitigationRepository } from './mitigation-repository';
import { plannedPairOf } from './mitigation-command-service';
import {
  DEFAULT_BOGON_PREFIX_LIST,
  DEFAULT_TARGET_PREFIX_LIST,
} from './mitigation-planner';
import {
  profilesForPolicyScope,
  syncPolicyRuntime,
  type PolicyExecutionScope,
} from './mitigation-policy-scope';
import { inspectPolicyMitigation, type PolicyMitigationPhysical } from './mitigation-policy-physical';
import type { PolicyScopeLock } from './mitigation-policy-lock';

// RECONCILIACAO READ-ONLY do estado FISICO de uma route-policy.
//
// Somente o read-back REAL (`display route-policy`) entra aqui. Interface
// metadata nunca decide runtime de mitigacao. Os verificadores sao os MESMOS
// do comando (verifyActivation/verifyRemoval) - nenhum parser novo.

export type PolicyPhysicalState = 'MITIGATED' | 'NORMAL' | 'RECONCILIATION_REQUIRED';

export interface PolicyScopeTarget {
  profileId: string;
  addressFamily: string;
  mitigationRt: string;
  /** Par planejado do profile; `null` = sem plano, nada a reconciliar. */
  pair: { bogonNode: number; mitigationNode: number } | null;
  runtimeState: string | null;
}

export interface PolicyScopeTargetAssessment {
  profileId: string;
  runtimeState: string | null;
  /** Par PLANEJADO do runtime (detalhe; o estado fisico vem do read-back). */
  pair: { bogonNode: number; mitigationNode: number } | null;
  bogonOk: boolean;
  mitigationOk: boolean;
  removalOk: boolean;
  reason: string | null;
}

export interface PolicyScopeAssessment {
  deviceId: string;
  policyName: string;
  state: PolicyPhysicalState;
  detail: string;
  targets: PolicyScopeTargetAssessment[];
  /** Estrutura FISICA completa lida no read-back (evidencia do estado). */
  physical: PolicyMitigationPhysical;
}

export interface PolicyReconcileDeps {
  repository: MitigationRepository;
  hosts: { getHost(id: string): Promise<HostRecord | null> };
  /** Leitura READ-ONLY do read-back real da policy (display route-policy). */
  readPolicy(device: HostRecord, policyName: string): Promise<string>;
  labels?: { bogonPrefixList: string; targetPrefixList: string };
  /** F4: o APPLY LOCAL entra na MESMA serializacao do command service. */
  lock?: PolicyScopeLock;
  now?: () => Date;
}

/** O preview ficou velho (equipamento ou runtimes mudaram): gere outro. */
export class PolicyReconcileStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyReconcileStaleError';
  }
}

export interface PolicyReconcileTargetPreview {
  profileId: string;
  runtimeState: string | null;
  proposedRuntimeState: PolicyPhysicalState;
  /** Par fisico que sera propagado quando o estado proposto for MITIGATED. */
  proposedPair: { bogonNode: number; mitigationNode: number } | null;
  change: boolean;
}

/**
 * PREVIEW: leitura real do equipamento + estado proposto. Nenhuma escrita -
 * nem no Huawei, nem no banco do NetVision.
 */
export interface PolicyReconcilePreview {
  deviceId: string;
  policyName: string;
  state: PolicyPhysicalState;
  detail: string;
  /** Estrutura fisica completa (nodes BOGONS, mitigacao, suspeitos, par). */
  physical: PolicyMitigationPhysical;
  readAt: string;
  /** Token da leitura; o APPLY LOCAL exige este id e revalida antes de gravar. */
  previewId: string;
  targets: PolicyReconcileTargetPreview[];
}

/** APPLY LOCAL: gravou SOMENTE o runtime no banco do NetVision. */
export interface PolicyReconcileApplyResult {
  deviceId: string;
  policyName: string;
  state: PolicyPhysicalState;
  previewId: string;
  readAt: string;
  applied: number;
  failed: number;
}

/**
 * Estado fisico a partir de um read-back REAL, fail-closed:
 *
 * - MITIGATED: o par esperado de TODOS os targets esta presente e valido
 *   (deny + BOGONS e permit + PREFIX8to24 + RT);
 * - NORMAL: nenhum node de mitigacao de nenhum target esta presente;
 * - RECONCILIATION_REQUIRED: leitura parcial/inconclusiva ou plano ausente.
 */
export function assessPolicyPhysicalState(input: {
  policyName: string;
  readBack: string;
  labels: { bogonPrefixList: string; targetPrefixList: string };
  targets: readonly PolicyScopeTarget[];
}): Omit<PolicyScopeAssessment, 'deviceId'> {
  // EVIDENCIA FISICA COMPLETA: a classificacao vem da POLICY INTEIRA (todos
  // os nodes de mitigacao presentes no read-back), nunca apenas da ausencia do
  // par planejado. Par fisico diferente do plano NAO vira NORMAL.
  const physical = inspectPolicyMitigation({
    policyName: input.policyName,
    readBack: input.readBack,
    rts: [...new Set(input.targets.map((target) => target.mitigationRt))],
    labels: input.labels,
  });

  const targets: PolicyScopeTargetAssessment[] = input.targets.map((target) => {
    if (!target.pair) {
      return {
        profileId: target.profileId,
        runtimeState: target.runtimeState,
        pair: null,
        bogonOk: false,
        mitigationOk: false,
        removalOk: false,
        reason: 'sem par de nodes planejado para este target',
      };
    }
    const activation = verifyActivation(
      input.policyName,
      input.readBack,
      target.pair,
      target.mitigationRt,
      input.labels,
    );
    const removal = verifyRemoval(input.policyName, input.readBack, target.pair);
    return {
      profileId: target.profileId,
      runtimeState: target.runtimeState,
      pair: { ...target.pair },
      bogonOk: activation.bogonOk,
      mitigationOk: activation.mitigationOk,
      removalOk: removal.verified,
      reason: activation.verified ? null : activation.summary,
    };
  });

  if (targets.length === 0) {
    return {
      policyName: input.policyName,
      state: 'RECONCILIATION_REQUIRED',
      detail: 'policy sem targets persistidos; nada pode ser confirmado no equipamento',
      targets,
      physical,
    };
  }

  return {
    policyName: input.policyName,
    state: physical.state,
    detail: physical.detail,
    targets,
    physical,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Token da leitura: muda quando o read-back do equipamento OU os runtimes
 * mudam. O APPLY LOCAL so grava se o token ainda for o mesmo - um preview
 * velho nunca e aplicado sobre um estado fisico diferente.
 */
function previewToken(input: {
  deviceId: string;
  policyName: string;
  readBack: string;
  assessment: { state: PolicyPhysicalState; targets: readonly PolicyScopeTargetAssessment[] };
  physical: PolicyMitigationPhysical;
}): string {
  return sha256(
    [
      input.deviceId,
      input.policyName,
      sha256(input.readBack),
      input.assessment.state,
      // Evidencia fisica COMPLETA: qualquer mudanca de nodes (inclusive um par
      // diferente do planejado) muda o token e invalida o preview (HTTP 409).
      `bogon:[${input.physical.bogonNodes.join(',')}]`,
      `mitigacao:[${input.physical.mitigationNodes.join(',')}]`,
      `suspeitos:[${input.physical.partialNodes
        .map((entry) => `${entry.node}:${entry.reason}`)
        .join('|')}]`,
      input.physical.pair
        ? `par:${input.physical.pair.bogonNode}-${input.physical.pair.mitigationNode}`
        : 'par:-',
      ...input.assessment.targets.map(
        (target) =>
          `${target.profileId}:${target.runtimeState ?? '-'}:${
            target.pair ? `${target.pair.bogonNode}-${target.pair.mitigationNode}` : '-'
          }`,
      ),
    ].join('\n'),
  );
}

export class MitigationPolicyReconciler {
  private readonly labels: { bogonPrefixList: string; targetPrefixList: string };
  private readonly now: () => Date;

  constructor(private readonly deps: PolicyReconcileDeps) {
    this.labels = deps.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    };
    this.now = deps.now ?? (() => new Date());
  }

  /** Avalia UMA policy fisica (device + policyName). Nenhuma escrita. */
  async assess(scope: PolicyExecutionScope): Promise<PolicyScopeAssessment> {
    const { assessment } = await this.assessWithToken(scope);
    return { deviceId: scope.deviceId, ...assessment };
  }

  /**
   * FASE PREVIEW (operacao explicita do operador): le a policy REAL no
   * equipamento e devolve estado fisico + proposta por profile. Zero escrita
   * no Huawei e zero alteracao de runtime.
   */
  async preview(scope: PolicyExecutionScope): Promise<PolicyReconcilePreview> {
    const { assessment, previewId, readAt } = await this.assessWithToken(scope);
    const proposedPair =
      assessment.state === 'MITIGATED' ? (assessment.physical.pair ?? null) : null;
    return {
      deviceId: scope.deviceId,
      policyName: scope.policyName,
      state: assessment.state,
      detail: assessment.detail,
      physical: assessment.physical,
      readAt: readAt.toISOString(),
      previewId,
      targets: assessment.targets.map((target) => {
        const pairChange =
          proposedPair !== null &&
          (target.pair === null ||
            target.pair.bogonNode !== proposedPair.bogonNode ||
            target.pair.mitigationNode !== proposedPair.mitigationNode);
        return {
          profileId: target.profileId,
          runtimeState: target.runtimeState,
          proposedRuntimeState: assessment.state,
          proposedPair,
          change: target.runtimeState !== assessment.state || pairChange,
        };
      }),
    };
  }

  /**
   * FASE APPLY LOCAL: revalida o preview contra uma NOVA leitura do
   * equipamento (read-only) e, se nada mudou, grava SOMENTE o runtime no
   * banco do NetVision. Nunca envia comando de configuracao ao Huawei.
   */
  async applyLocal(
    scope: PolicyExecutionScope,
    previewId: string,
  ): Promise<PolicyReconcileApplyResult> {
    if (this.deps.lock) {
      // F4: o APPLY LOCAL disputa o MESMO escopo com o command service.
      return this.deps.lock.run(scope, () => this.applyLocalLocked(scope, previewId));
    }
    return this.applyLocalLocked(scope, previewId);
  }

  private async applyLocalLocked(
    scope: PolicyExecutionScope,
    previewId: string,
  ): Promise<PolicyReconcileApplyResult> {
    const fresh = await this.assessWithToken(scope);
    if (fresh.previewId !== previewId) {
      throw new PolicyReconcileStaleError(
        'Preview expirado: o equipamento ou os runtimes mudaram desde a leitura; gere um novo preview.',
      );
    }
    // MITIGATED: propaga o par FISICO para todos os profiles do escopo,
    // reparando plano x equipamento sob autorizacao explicita do operador.
    const activePair =
      fresh.assessment.state === 'MITIGATED' ? fresh.assessment.physical.pair : null;
    const synced = await syncPolicyRuntime(
      this.deps.repository,
      scope,
      fresh.assessment.state,
      this.now(),
      activePair,
    );
    return {
      deviceId: scope.deviceId,
      policyName: scope.policyName,
      state: fresh.assessment.state,
      previewId,
      readAt: fresh.readAt.toISOString(),
      applied: synced.updated,
      failed: synced.failed,
    };
  }

  private async assessWithToken(scope: PolicyExecutionScope): Promise<{
    assessment: Omit<PolicyScopeAssessment, 'deviceId'>;
    previewId: string;
    readAt: Date;
  }> {
    const host = await this.deps.hosts.getHost(scope.deviceId);
    if (!host) throw new Error(`Equipamento nao encontrado: ${scope.deviceId}`);
    const profiles = await profilesForPolicyScope(this.deps.repository, scope);
    const targets: PolicyScopeTarget[] = [];
    for (const profile of profiles) {
      const runtime = await this.deps.repository.getRuntime(profile.id);
      targets.push({
        profileId: profile.id,
        addressFamily: profile.addressFamily,
        mitigationRt: profile.mitigationRt,
        pair: plannedPairOf(runtime),
        runtimeState: runtime?.state ?? null,
      });
    }
    const readBack = await this.deps.readPolicy(host, scope.policyName);
    const assessment = assessPolicyPhysicalState({
      policyName: scope.policyName,
      readBack,
      labels: this.labels,
      targets,
    });
    return {
      assessment,
      previewId: previewToken({
        deviceId: scope.deviceId,
        policyName: scope.policyName,
        readBack,
        assessment,
        physical: assessment.physical,
      }),
      readAt: this.now(),
    };
  }
}
