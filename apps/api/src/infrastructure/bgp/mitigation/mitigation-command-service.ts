import type { HostRecord } from '@gmj/shared';
import type {
  MitigationActivationInput,
  MitigationExecutor,
  MitigationRemovalInput,
} from './mitigation-executor';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import type { MitigationProfileRecord, MitigationRepository } from './mitigation-repository';
import {
  policyExecutionScope,
  syncPolicyRuntime,
} from './mitigation-policy-scope';
import { effectiveBandwidthBps } from './bandwidth-parser';
import { interfaceMitigationScope } from './mitigation-scope';
import {
  DEFAULT_BOGON_PREFIX_LIST,
  DEFAULT_TARGET_PREFIX_LIST,
} from './mitigation-planner';
import { SimulationCommandExecutor } from './simulation-command-executor';
import type { MitigationNodePair } from './mitigation-planner';
import type {
  MitigationNotification,
  MitigationNotificationEvent,
  NotificationPublisher,
} from './notification-publisher';
import type { MitigationBlockReason, MitigationState } from './mitigation-types';
import type {
  MitigationPreflightInput,
  MitigationPreflightMode,
  MitigationPreflightResult,
} from './huawei-mitigation-executor';
import { PolicyScopeBusyError, type PolicyScopeLock } from './mitigation-policy-lock';

// Servico unico das acoes de mitigacao.
//
// A UI e o n8n inbound chamam ESTE servico - nao existe logica exclusiva de
// webhook. O executor e injetado: nesta entrega e o mock (sem escrita real no
// Huawei), e a verificacao de read-back acontece sempre.

export const MITIGATION_COMMAND_ACTIONS = [
  'STATUS',
  'SIMULATE_ACTIVATE',
  'ACTIVATE',
  'SIMULATE_REMOVE',
  'REMOVE',
] as const;

export type MitigationCommandAction = (typeof MITIGATION_COMMAND_ACTIONS)[number];

export const MUTATING_ACTIONS: readonly MitigationCommandAction[] = ['ACTIVATE', 'REMOVE'];

/**
 * Estados de runtime em que o vinculo ainda DEPENDE da RT na policy. Como a
 * policy e a unidade BGP, um REMOVE manual derruba a mitigacao de TODOS os
 * vinculos: se algum estiver ativo (ou em reconciliacao, fail-closed) a UI
 * exige confirmacao explicita do escopo inteiro.
 */
export const REMOVAL_SCOPE_ACTIVE_STATES: readonly MitigationState[] = [
  'MITIGATING',
  'MITIGATED',
  'RECOVERING',
  'RECOVERY_PENDING',
  'RECONCILIATION_REQUIRED',
];

/**
 * O equipamento ja foi alterado, mas o runtime local nao foi sincronizado por
 * completo (repositorio indisponivel/parcial). Nunca reportar sucesso "limpo".
 */
export const RUNTIME_SYNC_FAILED_WARNING =
  'Equipamento alterado, mas o runtime local não foi sincronizado por completo; revalide a policy (RECONCILIATION_REQUIRED).';

export interface MitigationCommandInput {
  requestId: string;
  action: MitigationCommandAction;
  profileId: string;
  /**
   * REMOVE manual em policy compartilhada: o operador confirma que sabe que a
   * retirada atinge TODOS os vinculos ativos do escopo `device + policy`.
   */
  acknowledgeScopeRemoval?: boolean;
}

export interface MitigationSharedTargetSummary {
  interfaceId: string | null;
  interfaceName: string | null;
  customer: string | null;
  peerAddress: string | null;
  addressFamily: string | null;
}

/** Vinculo ATIVO do MESMO escopo fisico que um REMOVE manual tambem atinge. */
export interface MitigationRemovalScopeEntry {
  profileId: string;
  interfaceId: string | null;
  interfaceName: string | null;
  customer: string | null;
  peerAddress: string | null;
  addressFamily: string | null;
  runtimeState: string;
}

/**
 * Escopo AFETADO por um REMOVE manual: informativo na resposta e base do gate
 * `SCOPE_CONFIRMATION_REQUIRED` quando ha vinculo ativo na mesma policy.
 */
export interface MitigationRemovalScopeSummary {
  deviceId: string;
  policy: string;
  /** Outros vinculos do escopo com mitigacao ativa/pendente HOJE. */
  affected: MitigationRemovalScopeEntry[];
}

/** Resultado da publicacao na camada de MIDIAS (best effort). */
export interface MitigationNotificationOutcome {
  published: boolean;
  skipped: boolean;
}

export interface MitigationCommandResult {
  ok: boolean;
  requestId: string;
  action: MitigationCommandAction;
  status: string;
  profileId: string;
  customer: string | null;
  device: string | null;
  /** Nome legivel da interface (ex.: Eth-Trunk1.3011). */
  interface: string | null;
  /** Identificador interno da interface, mantido para correlacao. */
  interfaceId: string | null;
  addressFamily: string | null;
  policy: string | null;
  /** Compatibilidade: mesmo valor de mitigationNode. */
  node: number | null;
  /** Node de DENY (BOGONS) do par. */
  bogonNode: number | null;
  /** Node de PERMIT (PREFIX8to24 + RT) do par. */
  mitigationNode: number | null;
  rt: string | null;
  sharedPolicy: boolean;
  sharedPolicyTargets: MitigationSharedTargetSummary[];
  affectedPeers: string[];
  verified: boolean;
  executedAt: string;
  idempotent: boolean;
  commandPreview: string[];
  verification: { command: string; summary: string } | null;
  /** Estado da notificacao: nunca transforma sucesso em falha. */
  notification: MitigationNotificationOutcome;
  /**
   * Preflight READ-ONLY do equipamento real. Presente apenas quando o executor
   * HUAWEI esta habilitado para o device; o caminho MOCK nao o inclui.
   */
  preflight?: MitigationPreflightResult;
  /** Presente apenas quando o REMOVE foi reconciliado com o PAR ATIVO do equipamento. */
  pairSource?: 'RUNTIME' | 'DEVICE';
  /** Motivo de bloqueio administrativo (ex.: MITIGATION_EXCLUDED). */
  blockedReason?: MitigationBlockReason | null;
  /**
   * Presente quando o escopo `device + policy` tem OUTRO vinculo ativo (ou o
   * REMOVE foi bloqueado pedindo confirmacao). Ausente em REMOVE simples.
   */
  removalScope?: MitigationRemovalScopeSummary;
  safeError?: string;
}

/** Resultado interno da acao: `run` anexa a notificacao no fim. */
type MitigationActionResult = Omit<MitigationCommandResult, 'notification'>;

/**
 * Porta estreita do executor REAL (Huawei). Fica ausente por padrao: sem ela o
 * servico roda 100% no MOCK, exatamente como na Fase 12.
 */
export interface MitigationLiveExecutorPort {
  enabledFor(device: HostRecord | null | undefined): boolean;
  preflight(
    device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult>;
  activate(device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }>;
  remove(device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }>;
  readRoutePolicy(device: HostRecord, policyName: string): Promise<string>;
  /** READ-ONLY: par ativo no equipamento (reconciliacao do REMOVE). */
  resolveActivePair(
    device: HostRecord,
    policyName: string,
    rt: string,
  ): Promise<{ bogonNode: number; mitigationNode: number } | null>;
}

export interface MitigationCommandDeps {
  repository: MitigationRepository;
  hosts: { getHost(id: string): Promise<HostRecord | null> };
  executor: MitigationExecutor;
  notifications?: NotificationPublisher;
  /** Prefix-lists do par (config do motor; nunca vem do Telegram/n8n). */
  labels?: { bogonPrefixList: string; targetPrefixList: string };
  /** Executor real de Huawei. Ausente = MOCK (fail-closed). */
  live?: MitigationLiveExecutorPort;
  /** existingNodes do ultimo discovery, para o preflight fail-closed. */
  expectedNodes?: (profileId: string) => Promise<number[] | null>;
  /**
   * F4: exclusao mutua por policy fisica (deviceId + policyName). Ausente =
   * comportamento anterior (sem lock). UI, n8n e AUTO usam ESTE servico.
   */
  scopeLock?: PolicyScopeLock;
  now?: () => Date;
}

type MitigationCommandBase = Omit<
  MitigationActionResult,
  'ok' | 'status' | 'verified' | 'commandPreview' | 'verification' | 'safeError'
>;

/**
 * Resultado guardado por requestId: repetir a MESMA acao com o mesmo id devolve
 * a primeira resposta, sem tocar no equipamento de novo.
 */
export class MitigationCommandService {
  private readonly processed = new Map<string, MitigationCommandResult>();
  private readonly now: () => Date;
  private readonly preview = new SimulationCommandExecutor();
  private readonly labels: { bogonPrefixList: string; targetPrefixList: string };

  constructor(private readonly deps: MitigationCommandDeps) {
    this.now = deps.now ?? (() => new Date());
    this.labels = deps.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    };
  }

  async execute(input: MitigationCommandInput): Promise<MitigationCommandResult> {
    const mutating = MUTATING_ACTIONS.includes(input.action);
    if (mutating) {
      const previous = this.processed.get(input.requestId);
      if (previous) return { ...previous, idempotent: true };
    }

    const result = await this.run(input);
    if (mutating && result.ok) this.processed.set(input.requestId, result);
    return { ...result, idempotent: false };
  }

  private async run(input: MitigationCommandInput): Promise<MitigationCommandResult> {
    const notification: MitigationNotificationOutcome = { published: false, skipped: true };
    const result = await this.executeAction(input, notification);
    return { ...result, notification };
  }

  private async executeAction(
    input: MitigationCommandInput,
    outcome: MitigationNotificationOutcome,
  ): Promise<MitigationActionResult> {
    const executedAt = this.now().toISOString();
    const base = {
      requestId: input.requestId,
      action: input.action,
      profileId: input.profileId,
      idempotent: false,
      executedAt,
    };

    const profile = await this.deps.repository.getProfile(input.profileId);
    if (!profile) {
      return {
        ...base,
        ok: false,
        status: 'PROFILE_NOT_FOUND',
        customer: null,
        device: null,
        interface: null,
        interfaceId: null,
        addressFamily: null,
        policy: null,
        node: null,
        bogonNode: null,
        mitigationNode: null,
        rt: null,
        sharedPolicy: false,
        sharedPolicyTargets: [],
        affectedPeers: [],
        verified: false,
        commandPreview: [],
        verification: null,
        safeError: 'Perfil de mitigacao nao encontrado',
      };
    }

    // F4: comandos MUTANTES rodam serializados por policy FISICA
    // (deviceId + policyName). A leitura fresca do runtime, o preflight, a
    // escrita Huawei, o read-back e a sincronizacao do escopo acontecem
    // DENTRO do lock; sem lock o caminho e o mesmo de antes.
    if (MUTATING_ACTIONS.includes(input.action) && this.deps.scopeLock) {
      const scope = policyExecutionScope(profile);
      try {
        return await this.deps.scopeLock.run(scope, () =>
          this.executeScopedAction(input, outcome, profile, base),
        );
      } catch (error) {
        if (error instanceof PolicyScopeBusyError) {
          return this.policyBusyResult(input, profile, base);
        }
        throw error;
      }
    }
    return this.executeScopedAction(input, outcome, profile, base);
  }

  /**
   * Corpo da acao com escopo reconciliado (runtime -> preflight -> escrita ->
   * read-back -> persistencia). Extraido para rodar sob o lock de escopo (F4).
   */
  private async executeScopedAction(
    input: MitigationCommandInput,
    outcome: MitigationNotificationOutcome,
    profile: MitigationProfileRecord,
    base: {
      requestId: string;
      action: MitigationCommandAction;
      profileId: string;
      idempotent: boolean;
      executedAt: string;
    },
  ): Promise<MitigationActionResult> {
    const peers = await this.read(() => this.deps.repository.listProfilePeers(profile.id), []);
    const runtime = await this.read(() => this.deps.repository.getRuntime(profile.id), null);
    // A mitigacao e o PAR (BOGONS + mitigacao). Compatibilidade: um runtime
    // antigo com apenas plannedNode continua sendo aceito como
    // mitigationNode, mas sem bogonNode o par e incompleto.
    let pair = plannedPairOf(runtime);
    let pairSource: 'RUNTIME' | 'DEVICE' = 'RUNTIME';
    const activate = input.action === 'SIMULATE_ACTIVATE' || input.action === 'ACTIVATE';
    const host = await this.read(() => this.deps.hosts.getHost(profile.deviceId), null);
    const shared = await this.read(() => this.sharedTargets(profile), {
      sharedPolicy: false,
      targets: [] as MitigationSharedTargetSummary[],
    });
    // REMOVE MANUAL: levanta o escopo realmente afetado ANTES de qualquer
    // escrita. A policy e a unidade BGP; a retirada atinge os irmaos ativos.
    const removalScope =
      input.action === 'REMOVE'
        ? await this.read(() => this.activeScopeSiblings(profile), null)
        : null;

    // Executor REAL so quando explicitamente habilitado (HUAWEI + allowlist).
    // `enabledFor` autoriza a LEITURA; a ESCRITA ainda exige live_write e e
    // re-checada dentro do proprio executor.
    // O executor real nao depende de haver plano no runtime: o REMOVE reconcilia
    // com o equipamento, e um runtime vazio (ex.: API reiniciada sem migration)
    // nao pode impedir a retirada do par que ESTA ativo.
    const live: MitigationLiveExecutorPort | null =
      host && this.deps.live?.enabledFor(host) ? this.deps.live : null;

    // REMOVE: reconcilia com o equipamento. O que importa e o par ATIVO hoje —
    // um plano antigo (ou o planejador) nao pode mandar remover outro node.
    if (live && host && !activate) {
      const activePair = await this.read(
        () => live.resolveActivePair(host, profile.policyName, profile.mitigationRt),
        null,
      );
      if (activePair) {
        pair = activePair;
        pairSource = 'DEVICE';
      }
    }

    // Rotulos legiveis do alvo: o n8n monta a mensagem com o NOME da interface
    // e o cliente, nunca com o id interno do banco.
    const label = resolveInterfaceLabel(host, profile.interfaceId);
    const primaryPeer = peers.find((peer) => peer.primary)?.peerAddress ?? null;
    const effectiveBandwidth = effectiveBandwidthOf(profile);

    const common: MitigationCommandBase = {
      ...base,
      customer: label.customer,
      device: host ? host.displayName || host.hostname : profile.deviceId,
      interface: label.interfaceName ?? profile.interfaceId,
      interfaceId: profile.interfaceId,
      addressFamily: profile.addressFamily,
      policy: profile.policyName,
      node: pair?.mitigationNode ?? null,
      bogonNode: pair?.bogonNode ?? null,
      mitigationNode: pair?.mitigationNode ?? null,
      rt: profile.mitigationRt,
      sharedPolicy: shared.sharedPolicy,
      sharedPolicyTargets: shared.targets,
      affectedPeers: peers.map((peer) => peer.peerAddress).sort(),
      ...(removalScope && removalScope.affected.length > 0 ? { removalScope } : {}),
    };

    // Preflight READ-ONLY imediatamente antes de qualquer escrita. Sem ele a
    // escrita nao acontece (fail-closed).
    // GATE OBRIGATORIO (backend, caminho canonico): target com exclusao
    // administrativa nunca gera/toca comando de mitigacao. Vale para UI, n8n,
    // AUTO futuro e qualquer chamador deste servico. REMOVE segue permitido
    // (retirada de mitigacao existente nao pode ser impedida).
    if (activate && profile.mitigationExcluded === true) {
      return {
        ...common,
        ok: false,
        status: 'MITIGATION_EXCLUDED',
        verified: false,
        commandPreview: [],
        verification: null,
        blockedReason: 'MITIGATION_EXCLUDED',
        safeError: 'Mitigacao desativada administrativamente para este peer',
      };
    }

    // GATE PREVENTIVO POR PEER (camada 2): "nunca mitigar este peer" vale mesmo
    // quando o target ainda nao tem profile (uplink/transit/IX/backbone sem banda
    // declarada). Se QUALQUER peer do target estiver marcado, o ACTIVATE para
    // aqui - antes de preflight, SSH e do executor Huawei.
    if (activate) {
      const peerExclusions = await this.read(
        () =>
          this.deps.repository.listPeerExclusions({
            deviceId: profile.deviceId,
            peerAddresses: peers.map((peer) => peer.peerAddress),
          }),
        [],
      );
      const blockedPeer = peers.find((peer) =>
        peerExclusions.some((row) => row.peerAddress === peer.peerAddress),
      );
      if (blockedPeer) {
        return {
          ...common,
          ok: false,
          status: 'MITIGATION_EXCLUDED',
          verified: false,
          commandPreview: [],
          verification: null,
          blockedReason: 'PEER_MITIGATION_EXCLUDED',
          safeError:
            `Mitigacao bloqueada: o peer ${blockedPeer.peerAddress} esta marcado como ` +
            '"nunca mitigar este peer"',
        };
      }
    }

    // REMOVE MANUAL EM POLICY COMPARTILHADA: se outro vinculo do MESMO escopo
    // ainda esta ativo, a retirada precisa de confirmacao explicita do operador
    // (que ve a lista completa em `removalScope`). Fail-closed: sem o ack o
    // comando nao chega ao preflight nem ao equipamento.
    if (
      input.action === 'REMOVE' &&
      removalScope &&
      removalScope.affected.length > 0 &&
      input.acknowledgeScopeRemoval !== true
    ) {
      return {
        ...common,
        ok: false,
        status: 'SCOPE_CONFIRMATION_REQUIRED',
        verified: false,
        commandPreview: [],
        verification: null,
        safeError:
          `Remocao bloqueada: a policy ${removalScope.policy} e compartilhada por ` +
          `${removalScope.affected.length} vinculo(s) ainda ativo(s); confirme a remocao do escopo inteiro`,
      };
    }

    const liveMode: MitigationPreflightMode =
      input.action === 'SIMULATE_ACTIVATE' || input.action === 'ACTIVATE'
        ? 'ACTIVATE'
        : 'REMOVE';

    let preflight: MitigationPreflightResult | null = null;
    if (live && host && pair) {
      // O snapshot do discovery faz sentido apenas no ACTIVATE: depois de uma
      // ativacao real os nodes 1 e 2 passam a existir (esperado [1,2,11,50]),
      // entao o REMOVE prova o PAR PRESENTE em vez de comparar o snapshot.
      const expectedExistingNodes =
        liveMode === 'ACTIVATE' && this.deps.expectedNodes
          ? await this.read(() => this.deps.expectedNodes!(profile.id), null)
          : null;
      preflight = await live.preflight(host, {
        mode: liveMode,
        policyName: profile.policyName,
        bogonNode: pair.bogonNode,
        mitigationNode: pair.mitigationNode,
        rt: profile.mitigationRt,
        bogonPrefixList: this.labels.bogonPrefixList,
        targetPrefixList: this.labels.targetPrefixList,
        expectedExistingNodes,
      });
    }

    const activationInput: MitigationActivationInput = {
      policyName: profile.policyName,
      bogonNode: pair?.bogonNode ?? 0,
      mitigationNode: pair?.mitigationNode ?? 0,
      rt: profile.mitigationRt,
      bogonPrefixList: this.labels.bogonPrefixList,
      targetPrefixList: this.labels.targetPrefixList,
    };
    const removalInput: MitigationRemovalInput = {
      policyName: profile.policyName,
      bogonNode: pair?.bogonNode ?? 0,
      mitigationNode: pair?.mitigationNode ?? 0,
    };

    if (input.action === 'STATUS') {
      return {
        ...common,
        ok: true,
        status: runtime?.state ?? 'NOT_READY',
        verified: false,
        commandPreview: [],
        verification: null,
      };
    }

    if (pair === null) {
      return {
        ...common,
        ok: false,
        status: 'REVALIDATION_FAILED',
        verified: false,
        commandPreview: [],
        verification: null,
        safeError: 'Sem par de nodes planejado para este alvo (reexecute o discovery)',
      };
    }

    const preview = activate
      ? this.preview.buildMitigation(profile.policyName, pair, profile.mitigationRt, this.labels)
          .commands
      : this.preview.buildRecovery(profile.policyName, pair).commands;

    if (input.action === 'SIMULATE_ACTIVATE' || input.action === 'SIMULATE_REMOVE') {
      await this.publish(
        input.action === 'SIMULATE_ACTIVATE'
          ? 'MITIGATION_SIMULATION_TRIGGERED'
          : 'MITIGATION_REMOVE_SIMULATED',
        {
          ...common,
          verified: null,
          primaryPeer,
          effectiveBandwidthBps: effectiveBandwidth,
          simulation: true,
        },
        outcome,
      );
      return {
        ...common,
        ok: true,
        status: activate ? 'WOULD_ACTIVATE' : 'WOULD_REMOVE',
        verified: false,
        commandPreview: preview,
        verification: null,
        ...(preflight ? { preflight } : {}),
        ...(pairSource === 'DEVICE' ? { pairSource } : {}),
      };
    }

    // ---- execucao (MOCK por padrao; HUAWEI so com live_write + allowlist) ----
    const liveDevice = live && host ? host : null;
    /**
     * A ESCRITA REAL foi iniciada? Depois deste ponto o equipamento pode ter
     * recebido (parte d)a alteracao: se o resultado fisico nao for comprovado,
     * o runtime do escopo inteiro vai para RECONCILIATION_REQUIRED. Falha de
     * preflight/validacao ANTES daqui nao altera runtime nenhum.
     */
    let writeAttempted = false;
    try {
      let readBack: string;
      if (activate) {
        if (liveDevice && live) {
          // Fail-closed: sem preflight OK o equipamento NAO recebe escrita.
          if (!preflight?.ok) return this.preflightBlocked(common, preview, preflight);
          writeAttempted = true;
          await live.activate(liveDevice, activationInput);
          readBack = await live.readRoutePolicy(liveDevice, profile.policyName);
        } else {
          await this.deps.executor.activate(activationInput);
          readBack = await this.deps.executor.readRoutePolicy(profile.policyName);
        }
        const check = verifyActivation(
          profile.policyName,
          readBack,
          pair,
          profile.mitigationRt,
          this.labels,
        );
        const sync = await this.record(profile, activate, check.verified, pair, null);
        await this.publish(
          check.verified ? 'MITIGATION_VERIFIED' : 'MITIGATION_FAILED',
          {
            ...common,
            verified: check.verified,
            primaryPeer,
            effectiveBandwidthBps: effectiveBandwidth,
            simulation: !liveDevice,
          },
          outcome,
        );
        return {
          ...common,
          ok: check.verified,
          status: check.verified ? 'ACTIVATED_VERIFIED' : 'REVALIDATION_FAILED',
          verified: check.verified,
          commandPreview: preview,
          verification: { command: `display route-policy ${profile.policyName}`, summary: check.summary },
          ...(preflight ? { preflight } : {}),
          ...(sync.ok ? {} : { safeError: RUNTIME_SYNC_FAILED_WARNING }),
          ...(check.verified ? {} : { safeError: check.summary }),
        };
      }

      if (liveDevice && live) {
        if (!preflight?.ok) return this.preflightBlocked(common, preview, preflight);
        writeAttempted = true;
        await live.remove(liveDevice, removalInput);
        readBack = await live.readRoutePolicy(liveDevice, profile.policyName);
      } else {
        await this.deps.executor.remove(removalInput);
        readBack = await this.deps.executor.readRoutePolicy(profile.policyName);
      }
      const check = verifyRemoval(profile.policyName, readBack, pair);
      const sync = await this.record(profile, false, check.verified, pair, null);
      await this.publish(
        check.verified ? 'MITIGATION_REMOVED_VERIFIED' : 'MITIGATION_FAILED',
        {
          ...common,
          verified: check.verified,
          primaryPeer,
          effectiveBandwidthBps: effectiveBandwidth,
          simulation: !liveDevice,
        },
        outcome,
      );
      return {
        ...common,
        ok: check.verified,
        status: check.verified ? 'REMOVED_VERIFIED' : 'REVALIDATION_FAILED',
        verified: check.verified,
        commandPreview: preview,
        verification: { command: `display route-policy ${profile.policyName}`, summary: check.summary },
        ...(preflight ? { preflight } : {}),
        ...(pairSource === 'DEVICE' ? { pairSource } : {}),
        ...(sync.ok ? {} : { safeError: RUNTIME_SYNC_FAILED_WARNING }),
        ...(check.verified ? {} : { safeError: check.summary }),
      };
    } catch (error) {
      // Escrita iniciada + estado fisico NAO comprovado: o runtime do escopo
      // inteiro vira RECONCILIATION_REQUIRED (fail-closed). O evento continua
      // no profile originador. Falha ANTES da escrita nao toca runtime.
      if (writeAttempted) {
        await this.record(profile, activate, false, pair, executionReason(error));
      }
      await this.publish(
        'MITIGATION_FAILED',
        {
          ...common,
          verified: false,
          primaryPeer,
          effectiveBandwidthBps: effectiveBandwidth,
          simulation: !liveDevice,
        },
        outcome,
      );
      return {
        ...common,
        ok: false,
        status: 'REVALIDATION_FAILED',
        verified: false,
        commandPreview: preview,
        verification: null,
        ...(preflight ? { preflight } : {}),
        safeError: `Falha ao executar a acao no equipamento: ${executionReason(error)}`,
      };
    }
  }

  /**
   * F4: outra operacao detem o lock do MESMO escopo fisico. Nenhuma escrita foi
   * tentada; o chamador (UI/n8n/AUTO) recebe um codigo explicito em `status`.
   */
  private async policyBusyResult(
    input: MitigationCommandInput,
    profile: MitigationProfileRecord,
    base: {
      requestId: string;
      action: MitigationCommandAction;
      profileId: string;
      idempotent: boolean;
      executedAt: string;
    },
  ): Promise<MitigationActionResult> {
    const host = await this.read(() => this.deps.hosts.getHost(profile.deviceId), null);
    const label = resolveInterfaceLabel(host, profile.interfaceId);
    return {
      ...base,
      ok: false,
      status: 'POLICY_BUSY',
      customer: label.customer,
      device: host ? host.displayName || host.hostname : profile.deviceId,
      interface: label.interfaceName ?? profile.interfaceId,
      interfaceId: profile.interfaceId,
      addressFamily: profile.addressFamily,
      policy: profile.policyName,
      node: null,
      bogonNode: null,
      mitigationNode: null,
      rt: profile.mitigationRt,
      sharedPolicy: false,
      sharedPolicyTargets: [],
      affectedPeers: [],
      verified: false,
      commandPreview: [],
      verification: null,
      safeError:
        'Policy ocupada por outra operacao no mesmo equipamento (deviceId + policy). Nenhuma escrita foi feita; tente novamente.',
    };
  }

  /**
   * Aborta ANTES de qualquer escrita quando o preflight READ-ONLY nao passou.
   * O motivo agregado (`blockedReasons`) vai em `safeError` e o resultado
   * detalhado em `preflight`.
   */
  private preflightBlocked(
    base: MitigationCommandBase,
    preview: string[],
    preflight: MitigationPreflightResult | null,
  ): MitigationActionResult {
    const reasons = preflight?.blockedReasons.join('; ') || 'preflight read-only indisponivel';
    return {
      ...base,
      ok: false,
      status: 'REVALIDATION_FAILED',
      verified: false,
      commandPreview: preview,
      verification: null,
      ...(preflight ? { preflight } : {}),
      safeError: `Preflight read-only falhou: ${reasons}`,
    };
  }

  /**
   * Outros targets que usam a MESMA policy FISICA (mesmo device + mesmo nome).
   * Policy de outro equipamento com nome igual nunca e o mesmo objeto. Aviso,
   * NAO bloqueio.
   */
  private async sharedTargets(
    profile: MitigationProfileRecord,
  ): Promise<{ sharedPolicy: boolean; targets: MitigationSharedTargetSummary[] }> {
    const scope = policyExecutionScope(profile);
    const profiles = await this.deps.repository.listProfiles({ deviceId: scope.deviceId });
    const others = profiles.filter(
      (candidate) => candidate.policyName === scope.policyName && candidate.id !== profile.id,
    );
    const targets: MitigationSharedTargetSummary[] = [];
    for (const other of others) {
      const peers = await this.read(() => this.deps.repository.listProfilePeers(other.id), []);
      const otherHost = await this.read(() => this.deps.hosts.getHost(other.deviceId), null);
      const otherLabel = resolveInterfaceLabel(otherHost, other.interfaceId);
      const peer =
        peers.find((candidate) => candidate.primary)?.peerAddress ??
        peers[0]?.peerAddress ??
        null;
      targets.push({
        interfaceId: other.interfaceId,
        interfaceName: otherLabel.interfaceName,
        customer: otherLabel.customer,
        peerAddress: peer,
        addressFamily: other.addressFamily,
      });
    }
    return { sharedPolicy: targets.length > 0, targets };
  }

  /**
   * Outros vinculos da MESMA policy fisica que HOJE dependem da mitigacao.
   * Somente leitura: base do gate de confirmacao do REMOVE manual.
   */
  private async activeScopeSiblings(
    profile: MitigationProfileRecord,
  ): Promise<MitigationRemovalScopeSummary> {
    const scope = policyExecutionScope(profile);
    const profiles = await this.deps.repository.listProfiles({ deviceId: scope.deviceId });
    const affected: MitigationRemovalScopeEntry[] = [];
    for (const candidate of profiles) {
      if (candidate.id === profile.id) continue;
      if (candidate.policyName !== scope.policyName) continue;
      const runtime = await this.read(() => this.deps.repository.getRuntime(candidate.id), null);
      const state = runtime?.state ?? null;
      if (!state || !REMOVAL_SCOPE_ACTIVE_STATES.includes(state)) continue;
      const peers = await this.read(() => this.deps.repository.listProfilePeers(candidate.id), []);
      const host = await this.read(() => this.deps.hosts.getHost(candidate.deviceId), null);
      const label = resolveInterfaceLabel(host, candidate.interfaceId);
      affected.push({
        profileId: candidate.id,
        interfaceId: candidate.interfaceId,
        interfaceName: label.interfaceName,
        customer: label.customer,
        peerAddress:
          peers.find((peer) => peer.primary)?.peerAddress ?? peers[0]?.peerAddress ?? null,
        addressFamily: candidate.addressFamily,
        runtimeState: state,
      });
    }
    affected.sort((left, right) => left.profileId.localeCompare(right.profileId));
    return { deviceId: scope.deviceId, policy: scope.policyName, affected };
  }

  /**
   * Registra o evento SEMPRE no profile ORIGINADOR da acao e sincroniza o
   * runtime de TODOS os profiles da MESMA policy fisica: os nodes da policy
   * valem para todos que a compartilham no equipamento.
   *
   * - read-back confirmado: MITIGATED (ativacao) / NORMAL (retirada);
   * - read-back NAO confirmado (parcial/inconclusivo): RECONCILIATION_REQUIRED
   *   no escopo inteiro (fail-closed; nunca um MITIGATED isolado).
   *
   * `ok=false` = o equipamento foi alterado mas o estado local nao foi
   * sincronizado por completo; o chamador reporta isso na resposta.
   */
  private async record(
    profile: MitigationProfileRecord,
    activated: boolean,
    verified: boolean,
    pair: MitigationNodePair,
    safeError: string | null,
  ): Promise<{ ok: boolean }> {
    const state: MitigationState = !verified
      ? 'RECONCILIATION_REQUIRED'
      : activated
        ? 'MITIGATED'
        : 'NORMAL';
    const eventOk = await this.read(async () => {
      await this.deps.repository.createEvent({
        profileId: profile.id,
        type: activated ? 'ACTIVATE' : 'REMOVE',
        newState: state,
        plannedNode: pair.mitigationNode,
        success: verified,
        verified,
        safeError,
      });
      return true;
    }, false);
    // O par fisico ATIVO so e propagado quando o read-back confirmou a
    // ativacao; na retirada os planos permanecem como estao.
    const activePair = activated && verified ? pair : null;
    const synced = await this.read(
      () =>
        syncPolicyRuntime(
          this.deps.repository,
          policyExecutionScope(profile),
          state,
          this.now(),
          activePair,
        ),
      { updated: 0, failed: 1 },
    );
    return { ok: eventOk && synced.failed === 0 };
  }

  private async publish(
    event: MitigationNotificationEvent,
    info: {
      profileId: string | null;
      requestId: string | null;
      customer: string | null;
      device: string | null;
      interface: string | null;
      addressFamily: string | null;
      primaryPeer: string | null;
      verified: boolean | null;
      /**
       * `true` em SIMULATE_* e no caminho MOCK; `false` quando o comando foi
       * realmente aplicado no equipamento pelo executor Huawei.
       */
      simulation: boolean;
      effectiveBandwidthBps: bigint | null;
      policy: string | null;
      node: number | null;
      bogonNode: number | null;
      mitigationNode: number | null;
      rt: string | null;
      affectedPeers: string[];
      sharedPolicy: boolean;
      sharedPolicyTargets: MitigationSharedTargetSummary[];
    },
    outcome: MitigationNotificationOutcome,
  ): Promise<void> {
    const publisher = this.deps.notifications;
    if (!publisher) return;
    const notification: MitigationNotification = {
      event,
      eventId: info.requestId,
      profileId: info.profileId,
      simulation: info.simulation,
      customer: info.customer,
      device: info.device,
      interfaceName: info.interface,
      addressFamily: (info.addressFamily as 'IPV4' | 'IPV6' | null) ?? null,
      peer: info.primaryPeer ?? info.affectedPeers[0] ?? null,
      affectedPeers: info.affectedPeers,
      detectedBandwidthBps: null,
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: info.effectiveBandwidthBps,
      trafficBps: null,
      thresholdBps: null,
      policy: info.policy,
      node: info.mitigationNode ?? info.node,
      bogonNode: info.bogonNode,
      mitigationNode: info.mitigationNode ?? info.node,
      rt: info.rt,
      verified: info.verified,
      sharedPolicy: info.sharedPolicy,
      sharedPolicyTargets: info.sharedPolicyTargets.map((target) => ({
        interfaceName: target.interfaceName,
        peerAddress: target.peerAddress,
        customer: target.customer,
        addressFamily: target.addressFamily,
      })),
      occurredAt: this.now().toISOString(),
    };
    // best-effort: falha de midia NUNCA afeta o motor
    const result = await this.read(() => publisher.publish(notification), {
      published: false,
      skipped: true,
    });
    outcome.published = result.published;
    outcome.skipped = result.skipped;
  }

  private async read<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation();
    } catch {
      return fallback;
    }
  }
}

/**
 * Converte o id interno da interface em rotulos legiveis para a notificacao.
 *
 * Usa exatamente o mesmo parser do discovery (alias > description), entao o
 * nome do cliente na mensagem e o mesmo que o operador ve na tela.
 */
function resolveInterfaceLabel(
  host: HostRecord | null,
  interfaceId: string | null,
): { interfaceName: string | null; customer: string | null } {
  // Host sem interfaces carregadas nao pode derrubar o comando inteiro.
  const interfaces = Array.isArray(host?.interfaces) ? host.interfaces : [];
  const networkInterface = interfaces.find((item) => item.id === interfaceId) ?? null;
  if (!networkInterface) return { interfaceName: null, customer: null };
  return {
    interfaceName: networkInterface.name,
    customer: interfaceMitigationScope(networkInterface).customerDisplayName,
  };
}

/**
 * Par planejado do runtime. `plannedNode` antigo vale como mitigationNode
 * (compatibilidade), mas o par so existe com os DOIS nodes.
 */
export function plannedPairOf(runtime: {
  plannedNode: number | null;
  plannedBogonNode: number | null;
  plannedMitigationNode: number | null;
} | null): MitigationNodePair | null {
  const mitigationNode = runtime?.plannedMitigationNode ?? runtime?.plannedNode ?? null;
  const bogonNode = runtime?.plannedBogonNode ?? null;
  if (mitigationNode === null || bogonNode === null) return null;
  return { bogonNode, mitigationNode };
}

export function effectiveBandwidthOf(profile: {
  detectedBandwidthBps: bigint | null;
  bandwidthOverrideBps: bigint | null;
}): bigint | null {
  return effectiveBandwidthBps(profile);
}

/** Motivo (curto) da falha de execucao, sem derrubar a resposta segura. */
function executionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return 'motivo desconhecido';
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
