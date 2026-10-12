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
}

export interface PolicyReconcileDeps {
  repository: MitigationRepository;
  hosts: { getHost(id: string): Promise<HostRecord | null> };
  /** Leitura READ-ONLY do read-back real da policy (display route-policy). */
  readPolicy(device: HostRecord, policyName: string): Promise<string>;
  labels?: { bogonPrefixList: string; targetPrefixList: string };
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
  const targets: PolicyScopeTargetAssessment[] = input.targets.map((target) => {
    if (!target.pair) {
      return {
        profileId: target.profileId,
        runtimeState: target.runtimeState,
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
    };
  }
  if (targets.every((target) => target.bogonOk && target.mitigationOk)) {
    return {
      policyName: input.policyName,
      state: 'MITIGATED',
      detail: 'par de mitigacao presente e valido para todos os targets da policy',
      targets,
    };
  }
  if (targets.every((target) => target.removalOk)) {
    return {
      policyName: input.policyName,
      state: 'NORMAL',
      detail: 'nenhum node de mitigacao presente para os targets da policy',
      targets,
    };
  }
  const reasons = targets
    .map((target) => (target.reason ? `${target.profileId}: ${target.reason}` : null))
    .filter((reason): reason is string => reason !== null);
  return {
    policyName: input.policyName,
    state: 'RECONCILIATION_REQUIRED',
    detail: reasons.join('; ') || 'leitura do equipamento inconclusiva',
    targets,
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
}): string {
  return sha256(
    [
      input.deviceId,
      input.policyName,
      sha256(input.readBack),
      input.assessment.state,
      ...input.assessment.targets.map(
        (target) => `${target.profileId}:${target.runtimeState ?? '-'}`,
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
    return {
      deviceId: scope.deviceId,
      policyName: scope.policyName,
      state: assessment.state,
      detail: assessment.detail,
      readAt: readAt.toISOString(),
      previewId,
      targets: assessment.targets.map((target) => ({
        profileId: target.profileId,
        runtimeState: target.runtimeState,
        proposedRuntimeState: assessment.state,
        change: target.runtimeState !== assessment.state,
      })),
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
    const fresh = await this.assessWithToken(scope);
    if (fresh.previewId !== previewId) {
      throw new PolicyReconcileStaleError(
        'Preview expirado: o equipamento ou os runtimes mudaram desde a leitura; gere um novo preview.',
      );
    }
    const synced = await syncPolicyRuntime(
      this.deps.repository,
      scope,
      fresh.assessment.state,
      this.now(),
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
      }),
      readAt: this.now(),
    };
  }
}
