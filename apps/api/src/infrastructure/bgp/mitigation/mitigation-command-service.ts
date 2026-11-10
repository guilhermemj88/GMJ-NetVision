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
  profilesForPolicyScope,
  syncPolicyRuntime,
} from './mitigation-policy-scope';
import { effectiveBandwidthBps } from './bandwidth-parser';
import { interfaceMitigationScope } from './mitigation-scope';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
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
import {
  ScopeConfirmationStore,
  scopeConfirmationHash,
  type ScopeConfirmationFailure,
  type ScopeConfirmationRequester,
  type ScopeConfirmationScope,
} from './mitigation-scope-confirmation';
import { contractRefusalMessage, type MitigationNode2Contract } from './mitigation-node2-contract';
import {
  PHYSICAL_UNVERIFIED_FAILURE_KIND,
  PHYSICAL_UNVERIFIED_MESSAGE,
  PHYSICAL_UNVERIFIED_STATUS,
  PHYSICAL_UNVERIFIED_TAG,
  type MitigationPhysicalVerification,
  type PhysicalBeforeEvidence,
} from './mitigation-physical-verification';
import {
  selectMitigationScopePrefixes,
  type MitigationScopePrefixReader,
  type MitigationScopePrefixSelection,
} from './mitigation-scope-prefixes';

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

/** Prefixo do `requestId` gerado pelo motor AUTO (`auto-activate-<id>-...`). */
export const AUTO_COMMAND_REQUEST_PREFIX = 'auto-activate-';

/** Status do comando AUTO recusado pelo kill switch global da automacao. */
export const AUTO_EXECUTION_DISABLED_STATUS = 'AUTO_EXECUTION_DISABLED';

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

/**
 * A retirada fisica foi verificada, mas o registro do baseline nao pode ser
 * descartado. O estado fisico esta correto; o ownership nao — o proximo REMOVE
 * exigiria reconciliacao manual e o operador precisa saber disso.
 */
export const BASELINE_RELEASE_FAILED_WARNING =
  'Retirada física verificada, mas o registro do baseline (ownership) não pôde ser descartado; reconciliação manual obrigatória antes do próximo REMOVE.';

export interface MitigationAutoEvidence {
  sampleAt: string;
  continuityKey: string;
  sequenceStartedAt?: string;
  samplesOver?: number;
}

export interface MitigationCommandInput {
  /** Internal durable journal identity; never accepted from the HTTP schemas. */
  autoOperationId?: string;
  /**
   * Origem declarada do comando. `AUTO` = fiacao do motor automatico; ausente =
   * manual. O kill switch global usa este campo (mais o prefixo do `requestId` e
   * a evidencia de telemetria) para reconhecer comando automatico.
   */
  origin?: 'AUTO' | 'MANUAL';
  autoEvidence?: MitigationAutoEvidence;
  requestId: string;
  action: MitigationCommandAction;
  profileId: string;
  /**
   * REMOVE manual em policy compartilhada: o operador confirma que sabe que a
   * retirada atinge TODOS os vinculos ativos do escopo `device + policy`.
   * Caminho da UI (sessao autenticada, lista exibida na tela).
   */
  acknowledgeScopeRemoval?: boolean;
  /**
   * REMOVE manual em policy compartilhada pelo canal do n8n/Telegram: token de
   * USO UNICO emitido pelo gate, vinculado ao escopo fisico + composicao exata
   * dos vinculos. Substitui o booleano no inbound (nunca aceito por engano de
   * outro perfil, expirado ou reutilizado).
   */
  scopeConfirmationToken?: string;
  /**
   * REMOVE vinculado a UMA mitigacao (botao do Telegram): referencia recebida no evento
   * MITIGATION_VERIFIED. Presente, o REMOVE so executa se ela for a mitigacao ATIVA do escopo;
   * caso contrario `MITIGATION_REFERENCE_STALE`, sem preflight e sem escrita.
   */
  mitigationRef?: string;
  /** Identidade do operador no Telegram (auditoria; nunca autoriza sozinha). */
  confirmedBy?: string | null;
  /**
   * Chat/grupo do Telegram onde a solicitacao foi exibida. O token emitido fica
   * vinculado a ele: o mesmo botao encaminhado para outro grupo nao confirma.
   */
  chatId?: string | null;
}

/**
 * O comando e de ORIGEM AUTOMATICA? Qualquer um dos sinais basta (fail-closed):
 * a origem declarada pela fiacao do motor, o prefixo do `requestId` do motor ou
 * a evidencia de telemetria que so o motor anexa. Um comando manual que imite o
 * prefixo e tratado como AUTO (fica MAIS restrito, nunca menos).
 */
export function isAutomaticCommand(
  input: Pick<MitigationCommandInput, 'origin' | 'requestId' | 'autoEvidence' | 'autoOperationId'>,
): boolean {
  return (
    input.origin === 'AUTO' ||
    input.requestId.startsWith(AUTO_COMMAND_REQUEST_PREFIX) ||
    input.requestId.startsWith('auto-remove-') ||
    input.autoOperationId !== undefined ||
    input.autoEvidence !== undefined
  );
}

/**
 * Resumo da confirmacao de escopo devolvido ao chamador. `token` so existe no
 * canal do n8n e NUNCA entra em notificacao/ log.
 */
export interface MitigationScopeConfirmationSummary {
  required: boolean;
  token?: string;
  expiresAt?: string;
  scopeHash?: string;
  confirmedBy?: string | null;
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
  timingsMs?: { preflight: number; execution: number; readback: number };
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
  /**
   * Verificacao FISICA pos-escrita (efeito no BGP), presente na ativacao real cujo
   * read-back de texto conferiu. `outcome !== 'PASS'` => status
   * `ACTIVATED_UNVERIFIED_PHYSICAL` (nunca sucesso, sem rollback automatico).
   */
  physicalVerification?: MitigationPhysicalVerification;
  /** Presente apenas quando o REMOVE foi reconciliado com o PAR ATIVO do equipamento. */
  pairSource?: 'RUNTIME' | 'DEVICE';
  /** Motivo de bloqueio administrativo (ex.: MITIGATION_EXCLUDED). */
  blockedReason?: MitigationBlockReason | null;
  /**
   * Presente quando o escopo `device + policy` tem OUTRO vinculo ativo (ou o
   * REMOVE foi bloqueado pedindo confirmacao). Ausente em REMOVE simples.
   */
  removalScope?: MitigationRemovalScopeSummary;
  /** Presente apenas quando o gate de escopo participou da decisao. */
  scopeConfirmation?: MitigationScopeConfirmationSummary;
  safeError?: string;
}

/** Resultado interno da acao: `run` anexa a notificacao no fim. */
export type MitigationActionResult = Omit<MitigationCommandResult, 'notification'>;

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
  /**
   * Ownership, sem comando: invalida o registro do baseline apos uma retirada
   * verificada. Opcional para nao obrigar harnesses/fakes de leitura.
   */
  releaseBaseline?(device: HostRecord, policyName: string): Promise<void>;
  /**
   * READ-ONLY, PRE-escrita (em paralelo ao preflight): estado dos peers do cliente.
   * Ausente (fakes de leitura) = sem verificacao fisica; o executor Huawei real a implementa.
   */
  captureMitigationEvidence(
    device: HostRecord,
    customerPeers: readonly string[],
  ): Promise<PhysicalBeforeEvidence | null>;
  /** READ-ONLY, POS-escrita: prova o efeito no BGP. Nunca lanca. */
  verifyMitigationPhysical(
    device: HostRecord,
    input: {
      contract: MitigationNode2Contract;
      customerPeers: readonly string[];
      before: PhysicalBeforeEvidence | null;
    },
  ): Promise<MitigationPhysicalVerification>;
}

export interface MitigationCommandDeps {
  manualCommands?: {
    begin(
      input: MitigationCommandInput,
      scope: { deviceId: string; policyName: string },
    ): Promise<MitigationActionResult | null>;
    authorize(input: MitigationCommandInput): Promise<boolean>;
    complete(
      input: MitigationCommandInput,
      result: MitigationActionResult,
      real: boolean,
    ): Promise<void>;
  };
  afterAutomaticCommand?: (
    input: MitigationCommandInput,
    result: MitigationActionResult,
    real: boolean,
  ) => Promise<void>;
  requireAutomaticAuthorization?: boolean;
  autoWriteAuthorization?: (
    input: MitigationCommandInput,
    pair: { bogonNode: number; mitigationNode: number } | null,
  ) => Promise<boolean>;
  beforeManualWrite?: (deviceId: string, policyName: string) => Promise<void>;
  /** AUTO only: recheck recent UP telemetry AFTER preflight, BEFORE any write. */
  autoEvidence?: (profileId: string, evidence?: MitigationAutoEvidence) => Promise<boolean>;
  /**
   * KILL SWITCH GLOBAL (`MITIGATION_AUTO_EXECUTION_ENABLED`). Ausente ou erro =
   * execucao automatica DESLIGADA (fail-closed). Manual nunca e afetado.
   */
  autoExecutionEnabled?: () => boolean;
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
  /**
   * Confirmacoes de retirada por escopo fisico (canal n8n/Telegram). Ausente =
   * store proprio, em memoria, com TTL de 10 min.
   */
  scopeConfirmations?: ScopeConfirmationStore;
  /** Prazo (ms) da confirmacao de escopo. Default 10 min. */
  scopeConfirmationTtlMs?: number;
  /**
   * Chamado APOS uma retirada verificada do escopo fisico: o motor AUTO precisa
   * esquecer a sequencia de amostras anterior (nenhuma reativacao imediata por
   * evidencia colhida antes da retirada).
   */
  onScopeRemoved?: (scope: {
    deviceId: string;
    policyName: string;
    profileIds: string[];
  }) => void | Promise<void>;
  /**
   * ESCOPO VERIFICADO: le os prefixos REAIS recebidos do cliente para o alvo.
   *
   * Consultado SOMENTE depois de uma escrita real verificada (ATIVACAO), para
   * anexar `prefixes` ao evento `MITIGATION_VERIFIED`. Best effort por
   * contrato: ausente, excecao ou leitura incompleta => `prefixes: null` e
   * `'prefixes'` em `fieldsUnavailable`. Nunca altera `verified`, o resultado
   * fisico, o `eventId` nem o ACK.
   */
  scopePrefixes?: MitigationScopePrefixReader;
  /** ASN local do device (apenas `prependLocal` do parser de escopo). */
  scopePrefixesLocalAs?: (deviceId: string) => Promise<bigint | null>;
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
  private readonly processed = new Map<
    string,
    { identity: string; result: MitigationCommandResult }
  >();
  private readonly pending = new Map<
    string,
    { identity: string; promise: Promise<MitigationCommandResult> }
  >();
  private readonly now: () => Date;
  private readonly preview = new SimulationCommandExecutor();
  private readonly labels: { bogonPrefixList: string; targetPrefixList: string };
  private readonly scopeConfirmations: ScopeConfirmationStore;

  constructor(private readonly deps: MitigationCommandDeps) {
    this.now = deps.now ?? (() => new Date());
    this.labels = deps.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    };
    this.scopeConfirmations =
      deps.scopeConfirmations ??
      new ScopeConfirmationStore({
        now: this.now,
        ...(deps.scopeConfirmationTtlMs === undefined
          ? {}
          : { ttlMs: deps.scopeConfirmationTtlMs }),
      });
  }

  /**
   * Perfil de origem de uma confirmacao de escopo pendente (uso unico).
   *
   * O callback do Telegram carrega SOMENTE o token: o NetVision resolve o
   * perfil a partir da confirmacao emitida, nunca do texto do botao.
   */
  scopeConfirmationProfile(token: string): string | null {
    const record = this.scopeConfirmations.peek(token);
    if (!record || record.usedAtMs !== null) return null;
    if (this.now().getTime() > record.expiresAtMs) return null;
    return record.originProfileId;
  }

  /**
   * Cancelamento explicito (botao `rmc:`): revoga o token pendente SEM tocar no
   * equipamento. Depois disso o mesmo token nao confirma mais nada.
   */
  revokeScopeConfirmation(
    token: string,
    meta: { confirmedBy?: string | null; chatId?: string | null } = {},
  ): { ok: boolean; status: string; safeError?: string } {
    const result = this.scopeConfirmations.revoke(token, meta);
    if (result.ok) {
      return { ok: true, status: 'SCOPE_CONFIRMATION_REVOKED' };
    }
    return { ok: false, status: result.code, safeError: result.message };
  }

  async execute(input: MitigationCommandInput): Promise<MitigationCommandResult> {
    // Never serve an old idempotency receipt as authorization for AUTO REMOVE.
    if (input.action === 'REMOVE' && isAutomaticCommand(input)) return this.run(input);
    if (!MUTATING_ACTIONS.includes(input.action)) return this.run(input);
    const identity = JSON.stringify([
      input.profileId,
      input.action,
      input.origin ?? 'MANUAL',
      isAutomaticCommand(input),
      input.autoOperationId ?? null,
    ]);
    const previous = this.processed.get(input.requestId);
    const pending = this.pending.get(input.requestId);
    if (
      (previous && previous.identity !== identity) ||
      (pending && pending.identity !== identity)
    ) {
      // NUNCA reutilizar (nem esperar) o recibo de OUTRA operacao: `policy`,
      // `interface`, `verification`, `notification` e `preflight` de outro
      // perfil nao podem aparecer nesta resposta. Conflito e resposta completa
      // por si so - nada aqui e herdado da operacao anterior.
      return {
        requestId: input.requestId,
        action: input.action,
        profileId: input.profileId,
        idempotent: false,
        executedAt: this.now().toISOString(),
        ok: false,
        status: 'IDEMPOTENCY_CONFLICT',
        verified: false,
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
        commandPreview: [],
        verification: null,
        notification: { published: false, skipped: true },
        safeError: 'requestId already belongs to a different command; no write attempted',
      };
    }
    if (previous) return { ...previous.result, idempotent: true };
    if (pending) return { ...(await pending.promise), idempotent: true };
    const promise = this.run(input);
    this.pending.set(input.requestId, { identity, promise });
    try {
      const result = await promise;
      if (result.ok) this.processed.set(input.requestId, { identity, result });
      return result;
    } finally {
      this.pending.delete(input.requestId);
    }
  }

  private async run(input: MitigationCommandInput): Promise<MitigationCommandResult> {
    const notification: MitigationNotificationOutcome = { published: false, skipped: true };
    const result = await this.executeAction(input, notification);
    return { ...result, notification };
  }

  /**
   * Ownership do baseline, SEM comando no equipamento.
   *
   * Somente uma retirada VERIFICADA descarta o registro; qualquer outro
   * desfecho o mantem (o par pode continuar no hardware). Executor MOCK/teste
   * nao tem registro duravel — nada a fazer.
   */
  private async releaseBaselineAfterRemoval(
    liveDevice: HostRecord | null,
    policyName: string,
    verified: boolean,
  ): Promise<'RELEASED' | 'SKIPPED' | 'FAILED'> {
    if (!verified || !liveDevice || !this.deps.live?.releaseBaseline) return 'SKIPPED';
    try {
      await this.deps.live.releaseBaseline(liveDevice, policyName);
      return 'RELEASED';
    } catch {
      return 'FAILED';
    }
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
    if (input.action === 'REMOVE' && isAutomaticCommand(input)) {
      return {
        ...base,
        ok: false,
        status: this.autoExecutionBlocked(input)
          ? AUTO_EXECUTION_DISABLED_STATUS
          : 'AUTO_REMOVE_FORBIDDEN',
        verified: false,
        customer: null,
        device: profile.deviceId,
        interface: null,
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
        commandPreview: [],
        verification: null,
        safeError:
          'REMOVE exige acao manual autorizada no Telegram ou na interface NetVision; AUTO REMOVE e proibido.',
      };
    }
    const scoped = async () => {
      const journal = this.deps.manualCommands;
      const manual = MUTATING_ACTIONS.includes(input.action) && !isAutomaticCommand(input);
      const staleReference = (safeError: string) => ({
        ...base,
        ok: false,
        status: 'MITIGATION_REFERENCE_STALE',
        verified: false,
        customer: null,
        device: profile.deviceId,
        interface: null,
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
        commandPreview: [],
        verification: null,
        safeError,
      });
      // Sem journal duravel a referencia nao pode ser conferida: fail-closed.
      if (manual && input.mitigationRef && !journal)
        return staleReference(
          'Referencia de mitigacao nao verificavel neste ambiente; nenhuma escrita foi iniciada.',
        );
      if (manual && journal) {
        try {
          const cached = await journal.begin(input, policyExecutionScope(profile));
          if (cached) return cached;
        } catch (error) {
          if (error instanceof Error && error.message === 'MITIGATION_REFERENCE_STALE')
            return staleReference(
              'Este botao pertence a uma mitigacao anterior, que nao e a mitigacao ativa deste cliente; nenhuma escrita foi iniciada. Use o alerta da mitigacao atual.',
            );
          return {
            ...base,
            ok: false,
            status: 'MANUAL_RECONCILIATION_REQUIRED',
            verified: false,
            customer: null,
            device: profile.deviceId,
            interface: null,
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
            commandPreview: [],
            verification: null,
            safeError:
              'Journal manual indisponivel ou requestId exige reconciliacao; nenhuma nova escrita foi iniciada.',
          };
        }
      }
      const result = await this.executeScopedAction(input, outcome, profile, base);
      if (manual && journal) {
        try {
          const host = await this.deps.hosts.getHost(profile.deviceId);
          await journal.complete(
            input,
            result,
            !!host && this.deps.live?.enabledFor(host) === true,
          );
        } catch {
          return {
            ...result,
            ok: false,
            safeError:
              'Readback concluido, mas ownership/outbox manual nao foram sincronizados; reconciliacao obrigatoria.',
          };
        }
      }
      if (!manual && MUTATING_ACTIONS.includes(input.action) && this.deps.afterAutomaticCommand) {
        try {
          const host = await this.deps.hosts.getHost(profile.deviceId);
          await this.deps.afterAutomaticCommand(
            input,
            result,
            !!host && this.deps.live?.enabledFor(host) === true,
          );
        } catch {
          return {
            ...result,
            ok: false,
            safeError:
              'Readback concluido, mas journal/outbox AUTO nao foram sincronizados; reconciliacao obrigatoria.',
          };
        }
      }
      return result;
    };
    if (MUTATING_ACTIONS.includes(input.action) && this.deps.scopeLock) {
      const scope = policyExecutionScope(profile);
      try {
        return await this.deps.scopeLock.run(scope, scoped);
      } catch (error) {
        if (error instanceof PolicyScopeBusyError) {
          return this.policyBusyResult(input, profile, base);
        }
        throw error;
      }
    }
    return scoped();
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
    if (MUTATING_ACTIONS.includes(input.action) && !isAutomaticCommand(input)) {
      // Manual intent also revokes ownership on an idempotent ACTIVATE.
      await this.deps.beforeManualWrite?.(profile.deviceId, profile.policyName);
    }
    const timingsMs = { preflight: 0, execution: 0, readback: 0 };
    const deferred =
      !!this.deps.manualCommands &&
      MUTATING_ACTIONS.includes(input.action) &&
      !isAutomaticCommand(input);
    const timed = async <T>(stage: keyof typeof timingsMs, work: () => Promise<T>): Promise<T> => {
      const start = this.now().getTime();
      try {
        return await work();
      } finally {
        timingsMs[stage] += this.now().getTime() - start;
      }
    };
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

    // GATE DE ESCOPO (fail-closed): sem confirmacao valida nada chega ao
    // preflight nem ao equipamento. O canal n8n/Telegram usa um token de uso
    // unico vinculado ao escopo + composicao; a UI mantem o ack booleano.
    const scopeGate = this.evaluateScopeGate(input, profile, removalScope);

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
      ...(activate ? { timingsMs } : {}),
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
      ...(scopeGate.summary ? { scopeConfirmation: scopeGate.summary } : {}),
    };

    // KILL SWITCH GLOBAL (entrada): comando mutante de origem AUTO com a
    // execucao automatica desligada para aqui - antes de preflight e SSH. Vale
    // para qualquer perfil (manual, promovido, legado, allowlist).
    if (MUTATING_ACTIONS.includes(input.action) && this.autoExecutionBlocked(input)) {
      return this.autoExecutionDisabledResult(common, []);
    }

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

    // REMOVE MANUAL EM POLICY COMPARTILHADA: o gate acima ja decidiu. Sem
    // confirmacao valida (ack da UI ou token do Telegram) o comando nao chega ao
    // preflight nem ao equipamento.
    if (scopeGate.blockedStatus) {
      return {
        ...common,
        ok: false,
        status: scopeGate.blockedStatus,
        verified: false,
        commandPreview: [],
        verification: null,
        ...(scopeGate.blockedMessage ? { safeError: scopeGate.blockedMessage } : {}),
      };
    }

    const liveMode: MitigationPreflightMode =
      input.action === 'SIMULATE_ACTIVATE' || input.action === 'ACTIVATE' ? 'ACTIVATE' : 'REMOVE';

    let preflight: MitigationPreflightResult | null = null;
    let beforeEvidence: PhysicalBeforeEvidence | null = null;
    if (live && host && pair) {
      // O snapshot do discovery faz sentido apenas no ACTIVATE: depois de uma
      // ativacao real os nodes 1 e 2 passam a existir (esperado [1,2,11,50]),
      // entao o REMOVE prova o PAR PRESENTE em vez de comparar o snapshot.
      const expectedExistingNodes =
        liveMode === 'ACTIVATE' && this.deps.expectedNodes
          ? await this.read(() => this.deps.expectedNodes!(profile.id), null)
          : null;
      // A evidencia PRE-escrita dos peers do cliente roda EM PARALELO ao preflight: nao soma ao
      // tempo pre-escrita. Falha => `null` (a verificacao fisica pos-escrita fica inconclusiva).
      const captureEvidence =
        input.action === 'ACTIVATE' && live.captureMitigationEvidence
          ? live
              .captureMitigationEvidence(
                host,
                peers.map((peer) => peer.peerAddress),
              )
              .catch(() => null)
          : Promise.resolve(null);
      const [preflightResult, evidence] = await timed('preflight', () =>
        Promise.all([
          live.preflight(host, {
            mode: liveMode,
            policyName: profile.policyName,
            bogonNode: pair.bogonNode,
            mitigationNode: pair.mitigationNode,
            rt: profile.mitigationRt,
            bogonPrefixList: this.labels.bogonPrefixList,
            targetPrefixList: this.labels.targetPrefixList,
            expectedExistingNodes,
          }),
          captureEvidence,
        ]),
      );
      preflight = preflightResult;
      beforeEvidence = evidence;
    }

    // CONTRATO DO NODE 2: caminho real = derivado e validado pelo preflight fisico; caminho
    // MOCK/simulacao = derivado da policy simulada. Sem contrato nao existe lista de comandos.
    let mitigationContract: MitigationNode2Contract | null = preflight?.mitigationContract ?? null;
    let contractRefusal: string | null = null;
    if (activate && !preflight && this.deps.executor.mitigationContract) {
      const derived = await this.read(
        () => this.deps.executor.mitigationContract!(profile.policyName),
        null,
      );
      if (derived?.eligible) mitigationContract = derived.contract;
      else if (derived) contractRefusal = contractRefusalMessage(derived);
    }

    const activationInput: MitigationActivationInput = {
      policyName: profile.policyName,
      bogonNode: pair?.bogonNode ?? 0,
      mitigationNode: pair?.mitigationNode ?? 0,
      rt: profile.mitigationRt,
      bogonPrefixList: this.labels.bogonPrefixList,
      targetPrefixList: this.labels.targetPrefixList,
      ...(preflight?.baselineRecord ? { preflightBaseline: preflight.baselineRecord } : {}),
      ...(mitigationContract ? { mitigationContract } : {}),
    };
    const removalInput: MitigationRemovalInput = {
      requestId: input.requestId,
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

    // The same exact contract is used for preview, fake and real transports.
    const liveDevice = live && host ? host : null;
    let preview: string[];
    try {
      preview = activate
        ? this.preview.buildMitigation(
            profile.policyName,
            pair,
            profile.mitigationRt,
            this.labels,
            activationInput.mitigationContract,
          ).commands
        : this.preview.buildRecovery(profile.policyName, pair).commands;
    } catch (error) {
      // Builder fail-closed: sem baseline derivado/seguro NAO existe lista de
      // comandos — nem em MOCK. Nada foi escrito e o runtime nao muda.
      if (preflight) {
        // A causa fisica real (estrutura/ocupacao/read-back) e mais informativa
        // do que a falta de baseline derivado.
        return this.preflightBlocked(common, [], preflight);
      }
      return {
        ...common,
        ok: false,
        status: 'REVALIDATION_FAILED',
        verified: false,
        commandPreview: [],
        verification: null,
        safeError: contractRefusal ?? executionReason(error),
      };
    }

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
        deferred,
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
    if (isAutomaticCommand(input) && this.deps.requireAutomaticAuthorization && !liveDevice) {
      return {
        ...common,
        ok: false,
        status: 'AUTO_REAL_EXECUTOR_REQUIRED',
        verified: false,
        commandPreview: preview,
        verification: null,
      };
    }
    const authorizeWrite = async () => {
      if (isAutomaticCommand(input)) {
        if (input.action !== 'ACTIVATE') throw new Error('AUTO_REMOVE_FORBIDDEN');
        if (
          this.deps.requireAutomaticAuthorization &&
          !(await this.deps.autoWriteAuthorization?.(input, pair).catch(() => false))
        ) {
          throw new Error('AUTO_DURABLE_OWNERSHIP_REQUIRED');
        }
      } else if (this.deps.manualCommands && !(await this.deps.manualCommands.authorize(input)))
        throw new Error('MANUAL_JOURNAL_AUTHORIZATION_FAILED');
      if (this.autoExecutionBlocked(input)) throw new Error('AUTO_EXECUTION_DISABLED');
    };
    /**
     * A ESCRITA REAL foi iniciada? Depois deste ponto o equipamento pode ter
     * recebido (parte d)a alteracao: se o resultado fisico nao for comprovado,
     * o runtime do escopo inteiro vai para RECONCILIATION_REQUIRED. Falha de
     * preflight/validacao ANTES daqui nao altera runtime nenhum.
     */
    let writeAttempted = false;
    /**
     * A escrita foi INICIADA (inclusive no executor MOCK). Governa o uso unico
     * da confirmacao de escopo: uma tentativa que chegou ao equipamento consome
     * o token mesmo que o resultado seja desconhecido.
     */
    let writeStarted = false;
    try {
      let readBack: string;
      if (activate) {
        if (liveDevice && live) {
          // Fail-closed: sem preflight OK o equipamento NAO recebe escrita.
          if (!preflight?.ok) return this.preflightBlocked(common, preview, preflight);
          if (
            isAutomaticCommand(input) &&
            (this.deps.requireAutomaticAuthorization || this.deps.autoEvidence) &&
            !(await this.deps.autoEvidence?.(profile.id, input.autoEvidence).catch(() => false))
          ) {
            return {
              ...common,
              ok: false,
              status: 'AUTO_TELEMETRY_UNAVAILABLE',
              verified: false,
              commandPreview: preview,
              verification: null,
              preflight,
              safeError:
                'AUTO: telemetria recente, UP e acima do limiar indisponivel apos preflight',
            };
          }
          // KILL SWITCH (ultima barreira): reconsultado APOS preflight e
          // revalidacao da evidencia, imediatamente antes da escrita Huawei.
          if (this.autoExecutionBlocked(input)) {
            return this.autoExecutionDisabledResult(common, preview, preflight);
          }
          await authorizeWrite();
          writeAttempted = true;
          await timed('execution', () => live.activate(liveDevice, activationInput));
          readBack = await timed('readback', () =>
            live.readRoutePolicy(liveDevice, profile.policyName),
          );
        } else {
          if (this.autoExecutionBlocked(input)) {
            return this.autoExecutionDisabledResult(common, preview, preflight);
          }
          await authorizeWrite();
          await timed('execution', () => this.deps.executor.activate(activationInput));
          readBack = await timed('readback', () =>
            this.deps.executor.readRoutePolicy(profile.policyName),
          );
        }
        const check = verifyActivation(
          profile.policyName,
          readBack,
          pair,
          profile.mitigationRt,
          this.labels,
          activationInput.mitigationContract,
        );
        // VERIFICACAO FISICA (somente leitura): so depois de escrita REAL cujo read-back de texto
        // conferiu. Prova o EFEITO no BGP; PASS e a unica forma de MITIGATION_VERIFIED.
        // Falha/inconclusivo NUNCA e sucesso e NAO dispara rollback automatico.
        let physical: MitigationPhysicalVerification | null = null;
        if (check.verified && liveDevice && live) {
          physical = activationInput.mitigationContract
            ? await live.verifyMitigationPhysical(liveDevice, {
                contract: activationInput.mitigationContract,
                customerPeers: peers.map((peer) => peer.peerAddress),
                before: beforeEvidence,
              })
            : null;
          if (physical === null) {
            physical = {
              outcome: 'INCONCLUSIVE',
              summary: 'verificacao fisica INCONCLUSIVE: contrato do node 2 ausente',
              checks: [],
              attempts: 0,
              elapsedMs: 0,
              mitigationPeer: null,
              eligiblePrefixes: [],
              customerPeers: peers.map((peer) => peer.peerAddress),
            };
          }
        }
        const physicalFailed = physical !== null && physical.outcome !== 'PASS';
        const finalVerified = check.verified && !physicalFailed;
        const physicalError = physicalFailed
          ? `${PHYSICAL_UNVERIFIED_TAG}: ${physical!.summary}`
          : null;
        // ESCOPO VERIFICADO: so depois de uma escrita REAL e verificada. Leitura
        // READ-ONLY, best effort: nunca altera `check.verified` nem o resultado.
        // Fora desse caminho o campo simplesmente NAO existe (consumidores
        // antigos e eventos simulados seguem identicos).
        const scopePrefixes =
          finalVerified && liveDevice
            ? await this.readScopePrefixes(profile, primaryPeer)
            : undefined;
        const sync = await this.record(profile, activate, finalVerified, pair, physicalError);
        await this.publish(
          finalVerified ? 'MITIGATION_VERIFIED' : 'MITIGATION_FAILED',
          {
            ...common,
            verified: finalVerified,
            primaryPeer,
            effectiveBandwidthBps: effectiveBandwidth,
            simulation: !liveDevice,
            scopePrefixes,
            ...(physicalFailed ? { failureKind: PHYSICAL_UNVERIFIED_FAILURE_KIND } : {}),
          },
          outcome,
          deferred,
        );
        return {
          ...common,
          ok: finalVerified,
          status: finalVerified
            ? 'ACTIVATED_VERIFIED'
            : physicalFailed
              ? PHYSICAL_UNVERIFIED_STATUS
              : 'REVALIDATION_FAILED',
          verified: finalVerified,
          commandPreview: preview,
          verification: {
            command: `display route-policy ${profile.policyName}`,
            summary: physicalFailed ? `${check.summary}; ${physical!.summary}` : check.summary,
          },
          ...(preflight ? { preflight } : {}),
          ...(physical ? { physicalVerification: physical } : {}),
          ...(sync.ok ? {} : { safeError: RUNTIME_SYNC_FAILED_WARNING }),
          ...(check.verified
            ? physicalFailed
              ? { safeError: physicalError! }
              : {}
            : { safeError: check.summary }),
        };
      }

      // This physical REMOVE branch is reachable only from an authorized human action.
      if (this.autoExecutionBlocked(input)) {
        return this.autoExecutionDisabledResult(common, preview, preflight);
      }
      if (liveDevice && live) {
        if (!preflight?.ok) return this.preflightBlocked(common, preview, preflight);
        await authorizeWrite();
        writeAttempted = true;
        writeStarted = true;
        await live.remove(liveDevice, removalInput);
        readBack = await live.readRoutePolicy(liveDevice, profile.policyName);
      } else {
        // Mesma semantica do caminho real: assim que o executor e acionado, o
        // estado fisico e desconhecido e uma excecao exige reconciliacao.
        await authorizeWrite();
        writeAttempted = true;
        writeStarted = true;
        await this.deps.executor.remove(removalInput);
        readBack = await this.deps.executor.readRoutePolicy(profile.policyName);
      }
      const check = verifyRemoval(profile.policyName, readBack, pair);
      // D3: retirada VERIFICADA invalida o registro do baseline (ownership).
      // Sem isso um par identico criado depois por terceiros seria adotado como
      // NetVision. Falha aqui nao desmente o estado fisico: apenas obriga o
      // operador a limpar o registro antes do proximo REMOVE.
      const release = await this.releaseBaselineAfterRemoval(
        liveDevice,
        profile.policyName,
        check.verified,
      );
      // D3 fail-closed: sem a persistencia do descarte, o ownership fica INCERTO.
      // A retirada fisica aconteceu, mas a operacao NAO e dada por concluida: o
      // runtime vai para reconciliacao e nenhuma operacao nova e liberada nesse
      // escopo (um par identico criado depois nao pode ser adotado).
      const removed = check.verified && release !== 'FAILED';
      const sync = await this.record(profile, false, removed, pair, null);
      // A retirada INVALIDA a sequencia de amostras anterior: o AUTO precisa de
      // evidencia NOVA (triggerSamples amostras novas) antes de reativar.
      await this.resetScopeSequences(profile);
      await this.publish(
        removed ? 'MITIGATION_REMOVED_VERIFIED' : 'MITIGATION_FAILED',
        {
          ...common,
          verified: removed,
          primaryPeer,
          effectiveBandwidthBps: effectiveBandwidth,
          simulation: !liveDevice,
        },
        outcome,
        deferred,
      );
      return {
        ...common,
        ok: removed,
        status: removed ? 'REMOVED_VERIFIED' : 'REVALIDATION_FAILED',
        verified: removed,
        commandPreview: preview,
        verification: {
          command: `display route-policy ${profile.policyName}`,
          summary: check.verified
            ? release === 'FAILED'
              ? `${check.summary}; ${BASELINE_RELEASE_FAILED_WARNING}`
              : check.summary
            : check.summary,
        },
        ...(preflight ? { preflight } : {}),
        ...(pairSource === 'DEVICE' ? { pairSource } : {}),
        ...(sync.ok ? {} : { safeError: RUNTIME_SYNC_FAILED_WARNING }),
        ...(removed
          ? {}
          : { safeError: release === 'FAILED' ? BASELINE_RELEASE_FAILED_WARNING : check.summary }),
      };
    } catch (error) {
      // Escrita iniciada + estado fisico NAO comprovado: o runtime do escopo
      // inteiro vira RECONCILIATION_REQUIRED (fail-closed). O evento continua
      // no profile originador. Falha ANTES da escrita nao toca runtime.
      if (writeAttempted) {
        await this.record(profile, activate, false, pair, executionReason(error));
        if (!activate) await this.resetScopeSequences(profile);
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
        deferred,
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
    } finally {
      // Uso unico: o token so e consumido de fato quando uma ESCRITA foi
      // tentada. Bloqueio anterior (preflight, telemetria AUTO, policy ocupada)
      // devolve a confirmacao para o operador tentar de novo dentro do prazo.
      if (!writeStarted && scopeGate.consumedToken) {
        this.scopeConfirmations.release(scopeGate.consumedToken);
      }
    }
  }

  /**
   * GATE de retirada em policy compartilhada.
   *
   * Regras (fail-closed):
   *  - REMOVE sem vinculo ativo irmao: nada a confirmar;
   *  - UI: ack booleano explicito (`acknowledgeScopeRemoval`), contrato antigo;
   *  - Telegram/n8n: token de USO UNICO, com prazo, vinculado ao escopo fisico
   *    (device + policy), ao perfil originador e a composicao EXATA dos vinculos;
   *  - token invalido/expirado/reutilizado/escopo alterado bloqueia e devolve
   *    uma confirmacao NOVA ja com a lista atualizada.
   */
  private evaluateScopeGate(
    input: MitigationCommandInput,
    profile: MitigationProfileRecord,
    removalScope: MitigationRemovalScopeSummary | null,
  ): {
    blockedStatus?: string;
    blockedMessage?: string;
    summary?: MitigationScopeConfirmationSummary;
    consumedToken?: string;
  } {
    if (input.action !== 'REMOVE' || !removalScope) {
      return {};
    }
    const hasAffected = removalScope.affected.length > 0;
    // Sem vinculo ativo irmao e sem token: retirada simples, nada a confirmar.
    if (!hasAffected && !input.scopeConfirmationToken) {
      return {};
    }
    const scope: ScopeConfirmationScope = {
      deviceId: removalScope.deviceId,
      policyName: removalScope.policy,
      originProfileId: profile.id,
      affected: removalScope.affected.map((entry) => ({
        profileId: entry.profileId,
        runtimeState: entry.runtimeState,
      })),
    };
    const confirmedBy = input.confirmedBy?.trim() ? input.confirmedBy.trim().slice(0, 120) : null;
    const chatId = input.chatId?.trim() ? input.chatId.trim().slice(0, 120) : null;
    const requester = { requestedBy: confirmedBy, chatId };

    // Token apresentado: validado SEMPRE, mesmo que o escopo ja tenha se
    // esvaziado. Uma confirmacao de uso unico nunca autoriza uma segunda
    // execucao (replay depois do sucesso cai em USED/SCOPE_CHANGED).
    if (input.scopeConfirmationToken) {
      const consumed = this.scopeConfirmations.consume(input.scopeConfirmationToken, scope, {
        confirmedBy,
        chatId,
      });
      if (!consumed.ok) {
        return this.blockedScopeConfirmation(scope, consumed.code, consumed.message, requester);
      }
      return {
        summary: {
          required: true,
          scopeHash: consumed.record.scopeHash,
          confirmedBy: consumed.record.confirmedBy,
        },
        consumedToken: consumed.record.token,
      };
    }

    if (input.acknowledgeScopeRemoval === true) {
      return {
        summary: {
          required: true,
          scopeHash: scopeConfirmationHash(scope),
          confirmedBy,
        },
      };
    }

    return this.blockedScopeConfirmation(
      scope,
      'SCOPE_CONFIRMATION_REQUIRED',
      `Remocao bloqueada: a policy ${removalScope.policy} e compartilhada por ` +
        `${removalScope.affected.length} vinculo(s) ainda ativo(s); confirme a remocao do escopo inteiro`,
      requester,
    );
  }

  private blockedScopeConfirmation(
    scope: ScopeConfirmationScope,
    code: ScopeConfirmationFailure,
    message: string,
    requester: ScopeConfirmationRequester = {},
  ): {
    blockedStatus: string;
    blockedMessage: string;
    summary: MitigationScopeConfirmationSummary;
  } {
    const issue = this.scopeConfirmations.issue(scope, requester);
    return {
      blockedStatus: code,
      blockedMessage: message,
      summary: {
        required: true,
        token: issue.token,
        expiresAt: issue.expiresAt,
        scopeHash: issue.scopeHash,
        confirmedBy: null,
      },
    };
  }

  /**
   * Depois de uma retirada do escopo fisico, a sequencia de gatilho pertence a
   * evidencia ANTERIOR: zera os contadores persistidos de TODOS os vinculos da
   * policy e avisa o motor AUTO (que tambem descarta o cache em memoria). Uma
   * nova ativacao automatica passa a exigir `triggerSamples` amostras NOVAS.
   */
  private async resetScopeSequences(profile: MitigationProfileRecord): Promise<void> {
    const scope = policyExecutionScope(profile);
    const profiles = await this.read(
      () => profilesForPolicyScope(this.deps.repository, scope),
      [] as MitigationProfileRecord[],
    );
    for (const member of profiles) {
      await this.read(
        () =>
          this.deps.repository.upsertRuntime(member.id, { triggerCounter: 0, recoveryCounter: 0 }),
        null,
      );
    }
    try {
      await this.deps.onScopeRemoved?.({
        deviceId: scope.deviceId,
        policyName: scope.policyName,
        profileIds: profiles.map((member) => member.id),
      });
    } catch {
      // Observabilidade nunca transforma retirada verificada em falha.
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
   * `true` = comando de origem AUTO com o kill switch desligado (ou sem a
   * dependencia: fail-closed). Comando manual nunca e afetado. Erro ao consultar
   * a flag conta como DESLIGADO.
   */
  private autoExecutionBlocked(input: MitigationCommandInput): boolean {
    if (!isAutomaticCommand(input)) return false;
    try {
      return this.deps.autoExecutionEnabled?.() !== true;
    } catch {
      return true;
    }
  }

  private autoExecutionDisabledResult(
    base: MitigationCommandBase,
    preview: string[],
    preflight: MitigationPreflightResult | null = null,
  ): MitigationActionResult {
    return {
      ...base,
      ok: false,
      status: AUTO_EXECUTION_DISABLED_STATUS,
      verified: false,
      commandPreview: preview,
      verification: null,
      ...(preflight ? { preflight } : {}),
      safeError:
        'Execucao automatica desligada (MITIGATION_AUTO_EXECUTION_ENABLED): nenhuma escrita automatica foi feita.',
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
        peers.find((candidate) => candidate.primary)?.peerAddress ?? peers[0]?.peerAddress ?? null;
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
      /** ESCOPO VERIFICADO: presente na ativacao real verificada. */
      scopePrefixes?: MitigationScopePrefixSelection | undefined;
      /** Subtipo de MITIGATION_FAILED (ex.: UNVERIFIED_PHYSICAL). */
      failureKind?: string;
    },
    outcome: MitigationNotificationOutcome,
    deferred = false,
  ): Promise<void> {
    if (deferred) return; // ownership, journal result and outbox commit together.
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
      ...(info.failureKind
        ? { failureKind: info.failureKind, failureMessage: PHYSICAL_UNVERIFIED_MESSAGE }
        : {}),
      ...(info.scopePrefixes
        ? {
            prefixes: info.scopePrefixes.prefixes,
            fieldsUnavailable: info.scopePrefixes.fieldsUnavailable,
          }
        : {}),
    };
    // best-effort: falha de midia NUNCA afeta o motor
    const result = await this.read(() => publisher.publish(notification), {
      published: false,
      skipped: true,
    });
    outcome.published = result.published;
    outcome.skipped = result.skipped;
  }

  /**
   * ESCOPO VERIFICADO (best effort, fail-closed).
   *
   * Le os prefixos REAIS recebidos do cliente no escopo ja mitigado. Qualquer
   * ausencia/erro/ambiguidade resulta em `prefixes: null` + `fieldsUnavailable`,
   * nunca em lista parcial e nunca em falha do comando: o resultado fisico ja
   * foi verificado antes desta leitura.
   */
  private async readScopePrefixes(
    profile: MitigationProfileRecord,
    primaryPeer: string | null,
  ): Promise<MitigationScopePrefixSelection> {
    const reader = this.deps.scopePrefixes;
    if (!reader || primaryPeer === null) return { prefixes: null, fieldsUnavailable: ['prefixes'] };
    const localAs = await this.read(
      () => this.deps.scopePrefixesLocalAs?.(profile.deviceId) ?? Promise.resolve(null),
      null,
    );
    const evidence = await this.read(
      () =>
        reader({
          profileId: profile.id,
          deviceId: profile.deviceId,
          policyName: profile.policyName,
          peerAddress: primaryPeer,
          addressFamily: (profile.addressFamily as 'IPV4' | 'IPV6' | null) ?? null,
        }),
      null,
    );
    return selectMitigationScopePrefixes({
      evidence,
      expected: {
        profileId: profile.id,
        policy: profile.policyName,
        peer: primaryPeer,
        addressFamily: (profile.addressFamily as 'IPV4' | 'IPV6' | null) ?? null,
      },
      localAs,
    });
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
export function plannedPairOf(
  runtime: {
    plannedNode: number | null;
    plannedBogonNode: number | null;
    plannedMitigationNode: number | null;
  } | null,
): MitigationNodePair | null {
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
