import type { HostRecord } from '@gmj/shared';
import { AGLINK_BGP_PLAN, aglinkBaselineIntact, bgpPlanLabels } from './aglink-bgp-plan';
import {
  allNodesOf,
  parseConfiguredIpPrefixNames,
  parseHuaweiRoutePolicyNodes,
  parseHuaweiRoutePolicyNodesLenient,
} from './huawei-bgp-policy-parser';
import { assertIpv4MitigationContract, precedenceConflictNodes } from './mitigation-contract';
import { DEFAULT_MITIGATION_RT } from './mitigation-config';
import {
  canReadLive,
  canWriteLive,
  type MitigationExecutionConfig,
} from './mitigation-execution-config';
import {
  verifyActivation,
  type MitigationActivationInput,
  type MitigationRemovalInput,
} from './mitigation-executor';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import { planNodeOccupancy, type NodeOccupancyPlan } from './mitigation-node-snapshot';
import {
  baselineDriftReasons,
  captureMitigationBaseline,
  isBaselineRecordComplete,
  MemoryMitigationBaselineStore,
  type MitigationBaselineRecord,
  type MitigationBaselineStore,
} from './mitigation-baseline-record';
import { type PreservedClauses } from './mitigation-policy-clauses';
import {
  BGP_CONFIGURATION_COMMAND,
  EXTCOMMUNITY_FILTER_COMMAND,
  ROUTE_POLICY_CONFIGURATION_COMMAND,
  captureBeforeEvidence,
  DEFAULT_PHYSICAL_TIMING,
  verifyMitigationPhysical,
  verifyRestorationPhysical,
  type RestorationPhysicalVerification,
  type DisplayReader,
  type MitigationPhysicalVerification,
  type PhysicalBeforeEvidence,
  type PhysicalVerificationTiming,
} from './mitigation-physical-verification';
import { checkMitigationExport, MITIGATION_EXPORT_SHADOWED } from './mitigation-export-shadow';
import {
  contractRefusalMessage,
  deriveMitigationNode2Contract,
  sameMitigationNode2Contract,
  type MitigationNode2Contract,
} from './mitigation-node2-contract';
import {
  assertMitigationCommandShape,
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
  type MitigationWritePlan,
} from './mitigation-write-guard';
import {
  inspectPolicyMitigation,
  type PolicyMitigationPhysical,
} from './mitigation-policy-physical';

/**
 * Executor REAL (Huawei VRP), manual e fail-closed.
 *
 * Nao existe caminho automatico: quem chama e sempre o comando manual
 * (UI/n8n inbound) apos confirmacao humana. O executor:
 *
 *   - so LE o device quando `MITIGATION_EXECUTOR=HUAWEI` e o device esta na
 *     allowlist (`MITIGATION_ALLOWED_DEVICE_IDS`);
 *   - so ESCREVE quando, alem disso, `MITIGATION_LIVE_WRITE_ENABLED=true`;
 *   - roda o preflight READ-ONLY imediatamente antes da escrita;
 *   - monta os comandos a partir do par validado (nunca de texto livre);
 *   - exige read-back depois do commit (commit sozinho nunca e prova).
 *
 * Reutiliza a mesma sessao/credenciais do discovery (`MitigationSshPort`), sem
 * abrir uma segunda infraestrutura de SSH.
 */

export interface MitigationSshConfiguration {
  routePolicyConfiguration: string | null;
  prefixListConfiguration: string | null;
  warnings: string[];
}

/** Porta minima consumida do servico SSH existente (facilita teste/fake). */
export interface MitigationSshPort {
  readMitigationConfiguration(device: HostRecord): Promise<MitigationSshConfiguration>;
  readMitigationRoutePolicy(device: HostRecord, policyName: string): Promise<string>;
  applyMitigationCommands(
    device: HostRecord,
    commands: readonly string[],
  ): Promise<{ ok: boolean; output: string | null }>;
  /**
   * READ-ONLY: `display` de evidencia fisica (peer, rotas, routing-table...). OBRIGATORIA:
   * sem ela o executor real nem e construido (nunca VERIFIED sem prova fisica).
   */
  readMitigationDisplays(
    device: HostRecord,
    commands: readonly string[],
  ): Promise<Array<{ command: string; output: string | null }>>;
}

export type MitigationPreflightMode = 'ACTIVATE' | 'REMOVE';

export interface MitigationPreflightInput {
  /**
   * ACTIVATE: prova que o par esta LIVRE e que o estado bate com o discovery.
   * REMOVE:   prova que o par esperado esta PRESENTE e exatamente correto (nao
   *           exige nodes livres nem compara com o snapshot original).
   */
  mode: MitigationPreflightMode;
  policyName: string;
  bogonNode: number;
  mitigationNode: number;
  rt: string;
  bogonPrefixList: string;
  targetPrefixList: string;
  /** Nodes lidos no ultimo discovery; `null` = sem snapshot (fail-closed). */
  expectedExistingNodes: readonly number[] | null;
}

export interface MitigationPreflightCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface MitigationPreflightResult {
  ok: boolean;
  mode: MitigationPreflightMode;
  deviceId: string;
  deviceName: string;
  deviceHost: string | null;
  policyName: string;
  existingNodes: number[];
  bogonNode: number;
  mitigationNode: number;
  bogonPrefixList: string;
  bogonPrefixListExists: boolean;
  targetPrefixList: string;
  targetPrefixListExists: boolean;
  rt: string;
  sshReadBackOk: boolean;
  /** REMOVE: o node de DENY existe e e exatamente deny + if-match BOGONS. */
  bogonNodeExists: boolean;
  bogonNodeMatches: boolean;
  /** REMOVE: o node existe e e exatamente permit + if-match alvo + RT. */
  mitigationNodeExists: boolean;
  mitigationNodeMatches: boolean;
  /** Apenas UM dos nodes esta correto -> reconciliation required. */
  partial: boolean;
  /** Ocupacao dos nodes do par + snapshot dos nodes preexistentes (Caso B). */
  nodeOccupancy?: NodeOccupancyPlan | null;
  /** Atributos normais do cliente que o node de mitigacao deve repor. */
  preservedClauses?: PreservedClauses | null;
  /**
   * ACTIVATE: contrato do node 2 derivado e validado do baseline fisico
   * (`null` = policy inelegivel; o motivo esta no check `mitigation_contract`).
   */
  mitigationContract?: MitigationNode2Contract | null;
  baselineRecord?: MitigationBaselineRecord | null;
  /** Nodes lidos pelo MESMO parser do read-back pos-commit (display route-policy). */
  readBackNodes: number[];
  /** Resumo do MESMO verify usado no pos-commit, sobre a saida real. */
  readBackSummary: string;
  /** Trecho da saida real (prova do formato do equipamento). */
  readBackExcerpt: string;
  checks: MitigationPreflightCheck[];
  blockedReasons: string[];
}

export interface HuaweiMitigationExecutorDeps {
  ssh: MitigationSshPort;
  config: MitigationExecutionConfig;
  rt?: string;
  labels?: { bogonPrefixList: string; targetPrefixList: string };
  /**
   * Registro DURAVEL do baseline (B5). Ausente = store em memoria do processo
   * (nunca persistente); producao injeta o store duravel.
   */
  baseline?: MitigationBaselineStore;
  /** Verificacao fisica pos-escrita: tempos/relogio injetaveis (testes). */
  physical?: {
    timing?: PhysicalVerificationTiming;
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : 'SSH command failed';
}

/** Trecho curto e seguro da saida real do equipamento (evidencia do read-back). */
function excerpt(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

/** Trecho curto da resposta do equipamento para o motivo da falha (auditavel). */
function deviceExcerpt(output: string | null): string {
  const text = (output ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return 'SSH command failed';
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function sameNodes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * B6 (verificacao adicional): os comandos do ACTIVATE vem do baseline do
 * PREFLIGHT, mas o snapshot persistido vem de uma segunda leitura fisica feita
 * imediatamente antes da escrita. Se as duas leituras divergirem, a escrita e
 * bloqueada — nunca se ajusta o comando automaticamente.
 */
function activationBaselineDiverged(readBack: string, input: MitigationActivationInput): string[] {
  const record = input.preflightBaseline;
  if (
    !isBaselineRecordComplete(record) ||
    record.policyName !== input.policyName ||
    record.bogonNode !== 1 ||
    record.mitigationNode !== 2
  )
    return ['preflight permanent baseline evidence unavailable'];
  return baselineDriftReasons(record, readBack);
}

export class HuaweiMitigationExecutor {
  private readonly rt: string;
  private readonly labels: { bogonPrefixList: string; targetPrefixList: string };
  private readonly baseline: MitigationBaselineStore;

  constructor(private readonly deps: HuaweiMitigationExecutorDeps) {
    if (typeof deps.ssh?.readMitigationDisplays !== 'function') {
      throw new Error(
        'MITIGATION_PHYSICAL_PORT_REQUIRED: o transporte precisa de readMitigationDisplays ' +
          '(verificacao fisica obrigatoria)',
      );
    }
    this.rt = deps.rt ?? DEFAULT_MITIGATION_RT;
    this.labels = deps.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    };
    this.baseline = deps.baseline ?? new MemoryMitigationBaselineStore();
  }

  /** Leitura real liberada para este device (HUAWEI + allowlist). */
  enabledFor(device: HostRecord | null | undefined): boolean {
    return canReadLive(this.deps.config, device?.id);
  }

  /**
   * B5/B6: grava o fingerprint dos nodes PERMANENTES imediatamente antes da
   * escrita. Exige armazenamento DURAVEL (nunca memoria do processo), compara a
   * leitura fisica com o baseline que gerou os comandos e confirma o registro
   * relendo-o do proprio store. Qualquer falha interrompe o ACTIVATE antes de
   * qualquer comando chegar ao equipamento.
   */
  private async captureAndSaveBaseline(
    device: HostRecord,
    input: MitigationActivationInput,
  ): Promise<void> {
    if (this.baseline.durable !== true) {
      throw new Error(
        'MITIGATION_BASELINE_RECORD_UNAVAILABLE: escrita real exige armazenamento duravel ' +
          'do baseline (MemoryMitigationBaselineStore so vale para MOCK/testes)',
      );
    }
    let readBack: string;
    let configuration: MitigationSshConfiguration;

    try {
      // Mesma leitura do preflight (config + ip-prefix): a comparacao das duas
      // leituras usa exatamente as mesmas listas que geraram os comandos.
      configuration = await this.deps.ssh.readMitigationConfiguration(device);
      readBack = configuration.routePolicyConfiguration ?? '';
    } catch (error) {
      throw new Error(`MITIGATION_BASELINE_RECORD_UNAVAILABLE: ${safeErrorMessage(error)}`);
    }
    // Os comandos vieram do baseline do PREFLIGHT; o snapshot vem desta segunda
    // leitura fisica. Divergencia entre as duas leituras bloqueia a escrita —
    // nunca se adapta o comando automaticamente.
    assertIpv4MitigationContract(input);
    // Node 0 surgido entre o preflight e esta segunda leitura: mesma familia de
    // conflito de ocupacao — nunca escrever por cima de precedencia alheia.
    const secondReadPrecedence = precedenceConflictNodes(
      parseHuaweiRoutePolicyNodes(readBack).get(input.policyName) ?? [],
    );
    if (secondReadPrecedence.length > 0)
      throw new Error(
        `MITIGATION_NODE_OCCUPIED: ${device.displayName || device.hostname} ${input.policyName} ` +
          `node [${secondReadPrecedence.join(',')}] precede o par reservado`,
      );
    const occupancy = planNodeOccupancy({
      readBack,
      policyName: input.policyName,
      pair: { bogonNode: 1, mitigationNode: 2 },
      capturedAt: new Date().toISOString(),
    });
    if (occupancy.blocked)
      throw new Error(
        `MITIGATION_NODE_OCCUPIED: ${device.displayName || device.hostname} ${input.policyName} nodes [${occupancy.conflictingNodes.join(',')}]`,
      );
    if (!input.preflightBaseline)
      throw new Error('MITIGATION_BASELINE_RECORD_UNAVAILABLE: preflight baseline record missing');
    if (input.preflightBaseline.deviceId !== device.id)
      throw new Error('MITIGATION_BASELINE_DIVERGED: device mismatch');
    const diverged = activationBaselineDiverged(readBack, input);
    if (diverged.length > 0) {
      throw new Error(`MITIGATION_BASELINE_DIVERGED: ${diverged.join('; ')}`);
    }
    // O contrato do node 2 vem do preflight; a segunda leitura fisica (policy + ip-prefix)
    // precisa derivar EXATAMENTE o mesmo contrato (lista, LP, RT e entradas da lista).
    const secondContract = deriveMitigationNode2Contract(readBack, input.policyName, {
      prefixListConfiguration: configuration.prefixListConfiguration,
      requirePrefixListProof: true,
      bogonPrefixList: this.labels.bogonPrefixList,
    });
    if (!secondContract.eligible) throw new Error(contractRefusalMessage(secondContract));
    if (
      !input.mitigationContract ||
      !sameMitigationNode2Contract(input.mitigationContract, secondContract.contract)
    )
      throw new Error(
        'MITIGATION_CONTRACT_DIVERGED: contrato do node 2 do preflight diverge da segunda leitura fisica',
      );
    const record = captureMitigationBaseline({
      deviceId: device.id,
      policyName: input.policyName,
      readBack,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
    });
    if (!record || !isBaselineRecordComplete(record)) {
      throw new Error('MITIGATION_BASELINE_RECORD_UNAVAILABLE: policy nao reconhecida');
    }
    try {
      await this.baseline.save(record);
    } catch (error) {
      throw new Error(`MITIGATION_BASELINE_RECORD_UNAVAILABLE: ${safeErrorMessage(error)}`);
    }
    // B6.5: prova de que o registro EXISTE no store, no escopo correto, antes da
    // primeira escrita (vale tambem para o store persistente real).
    const saved = await this.loadBaseline(device, input.policyName);
    if (
      saved === null ||
      saved.readBackSha256 !== record.readBackSha256 ||
      saved.bogonNode !== input.bogonNode ||
      saved.mitigationNode !== input.mitigationNode
    ) {
      throw new Error(
        'MITIGATION_BASELINE_RECORD_UNAVAILABLE: registro nao confirmado apos a gravacao',
      );
    }
  }

  /** Registro confiavel do ACTIVATE (escopo + integridade verificadas). */
  private async loadBaseline(
    device: HostRecord,
    policyName: string,
  ): Promise<MitigationBaselineRecord | null> {
    let record: MitigationBaselineRecord | null;
    try {
      record = await this.baseline.load({ deviceId: device.id, policyName });
    } catch {
      return null;
    }
    if (!isBaselineRecordComplete(record)) return null;
    if (record.deviceId !== device.id || record.policyName !== policyName) return null;
    return record;
  }

  private assertWriteAllowed(device: HostRecord): void {
    if (!canWriteLive(this.deps.config, device?.id)) {
      throw new Error(
        'MITIGATION_WRITE_DISABLED: escrita real desabilitada (executor/allowlist/live_write)',
      );
    }
  }

  private writePlan(
    input: MitigationActivationInput | MitigationRemovalInput,
  ): MitigationWritePlan {
    return {
      policyName: input.policyName,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      rt: 'rt' in input ? input.rt : this.rt,
      bogonPrefixList: this.labels.bogonPrefixList,
      targetPrefixList: this.labels.targetPrefixList,
    };
  }

  /**
   * F3: estrutura FISICA de mitigacao da POLICY INTEIRA, a partir do read-back
   * REAL (`display route-policy`) - nunca do runtime/plano. Usada nas duas
   * direcoes do preflight (ACTIVATE nao instala segundo par; REMOVE nao
   * retira par com estrutura ambigua).
   */
  private inspectMitigation(
    input: MitigationPreflightInput,
    readBack: string | null,
  ): PolicyMitigationPhysical {
    return inspectPolicyMitigation({
      policyName: input.policyName,
      readBack: readBack ?? '',
      rts: [input.rt, this.rt],
      labels: {
        bogonPrefixList: input.bogonPrefixList,
        targetPrefixList: input.targetPrefixList,
      },
    });
  }

  /**
   * Preflight READ-ONLY. Nunca lanca: qualquer falha vira `ok:false` com o motivo
   * em `blockedReasons`, para o operador ver exatamente o que divergiu.
   */
  async preflight(
    device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
    input = bgpPlanLabels(input.policyName, input);
    const checks: MitigationPreflightCheck[] = [];
    const mode = input.mode;
    const deviceHost = device?.ssh?.host ?? null;
    const deviceOk = Boolean(device?.id) && device?.sshEnabled === true && deviceHost !== null;
    checks.push({
      id: 'device',
      ok: deviceOk,
      detail: deviceOk
        ? `device autorizado: ${device.id} (${deviceHost})`
        : 'device sem SSH habilitado/configurado',
    });

    // Evidencia do EXPORT (config BGP + extcommunity-filter) lida em paralelo ao resto.
    const exportEvidence =
      mode === 'ACTIVATE' && deviceOk ? this.readExportEvidence(device) : Promise.resolve(null);
    let configuration: MitigationSshConfiguration | null = null;
    let readError = 'SSH indisponivel';
    try {
      configuration = await this.deps.ssh.readMitigationConfiguration(device);
    } catch (error) {
      readError = safeErrorMessage(error);
    }

    const routePolicyConfiguration = configuration?.routePolicyConfiguration ?? null;
    const prefixListConfiguration = configuration?.prefixListConfiguration ?? null;
    if (input.policyName === AGLINK_BGP_PLAN.policy) {
      const prefixLines = (prefixListConfiguration ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter((line) => line.startsWith('ip ip-prefix AGLINK-BLOCO-TODO-23 '));
      checks.push({
        id: 'aglink_bgp_semantics',
        ok:
          aglinkBaselineIntact(routePolicyConfiguration ?? '') &&
          prefixLines.join() === AGLINK_BGP_PLAN.prefixDefinition,
        detail:
          'AGLINK: baseline localpref 1100/RT 140 e prefixo autorizado /23 ge23 le24 devem permanecer intactos',
      });
    }
    // O REMOVE so precisa da route-policy; o ACTIVATE tambem exige as ip-prefix.
    const sshReadBackOk =
      routePolicyConfiguration !== null && (mode === 'REMOVE' || prefixListConfiguration !== null);
    checks.push({
      id: 'ssh_read_back',
      ok: sshReadBackOk,
      detail: sshReadBackOk ? 'leitura de configuracao OK' : readError,
    });

    const nodes = routePolicyConfiguration
      ? (parseHuaweiRoutePolicyNodes(routePolicyConfiguration).get(input.policyName) ?? [])
      : [];
    const existingNodes = allNodesOf(nodes);
    const policyExists = routePolicyConfiguration !== null && nodes.length > 0;
    checks.push({
      id: 'policy',
      ok: policyExists,
      detail: policyExists
        ? `policy ${input.policyName} existe (nodes ${existingNodes.join(', ') || 'nenhum'})`
        : `policy ${input.policyName} nao encontrada`,
    });

    // Prova de READ-BACK REAL: roda exatamente o comando usado depois do commit
    // e passa a saida pelo MESMO parser/verify. Valida o formato REAL do
    // equipamento ANTES de qualquer escrita (fail-closed se nao interpretar).
    let readBackOutput: string | null = null;
    let readBackError: string | null = null;
    let nodeOccupancy: NodeOccupancyPlan | null = null;
    const preservedClauses: PreservedClauses | null = null;
    let mitigationContract: MitigationNode2Contract | null = null;
    try {
      readBackOutput = await this.deps.ssh.readMitigationRoutePolicy(device, input.policyName);
    } catch (error) {
      readBackError = safeErrorMessage(error);
    }
    const readBackParsed = readBackOutput
      ? parseHuaweiRoutePolicyNodesLenient(readBackOutput)
      : null;
    const readBackNodes = readBackParsed?.get(input.policyName) ?? [];
    const readBackOk = readBackOutput !== null && readBackNodes.length > 0;
    const readBackSummary = verifyActivation(
      input.policyName,
      readBackOutput ?? '',
      { bogonNode: input.bogonNode, mitigationNode: input.mitigationNode },
      input.rt,
      {
        bogonPrefixList: input.bogonPrefixList,
        targetPrefixList: input.targetPrefixList,
      },
    ).summary;
    checks.push({
      id: 'route_policy_readback',
      ok: readBackOk,
      detail: readBackOk
        ? `display route-policy ${input.policyName} reconhecido (nodes ${readBackNodes
            .map((entry) => entry.node)
            .join(', ')})`
        : (readBackError ??
          `display route-policy ${input.policyName} sem nodes reconheciveis pelo parser`),
    });

    const prefixNames = prefixListConfiguration
      ? parseConfiguredIpPrefixNames(prefixListConfiguration)
      : [];
    const bogonExists =
      prefixListConfiguration !== null && prefixNames.includes(input.bogonPrefixList);
    const targetExists =
      prefixListConfiguration !== null && prefixNames.includes(input.targetPrefixList);

    // Conteudo ATUAL dos nodes do par (mesma semantica do read-back).
    const verification = verifyActivation(
      input.policyName,
      routePolicyConfiguration ?? '',
      { bogonNode: input.bogonNode, mitigationNode: input.mitigationNode },
      input.rt,
      {
        bogonPrefixList: input.bogonPrefixList,
        targetPrefixList: input.targetPrefixList,
      },
    );
    const bogonNodeExists = nodes.some((entry) => entry.node === input.bogonNode);
    const mitigationNodeExists = nodes.some((entry) => entry.node === input.mitigationNode);
    const bogonNodeMatches = routePolicyConfiguration !== null && verification.bogonOk;
    const mitigationNodeMatches = routePolicyConfiguration !== null && verification.mitigationOk;
    const bothMatch = bogonNodeMatches && mitigationNodeMatches;
    const partial = (bogonNodeMatches || mitigationNodeMatches) && !bothMatch;

    // INTEGRIDADE DO READ-BACK: o `display route-policy` TEM de listar os
    // MESMOS nodes do config-read. Divergencia = saida truncada/parcial: sem
    // isso, uma leitura incompleta poderia "provar" ausencia de nodes e
    // liberar ACTIVATE (segundo par) ou REMOVE (retirada parcial). Fail-closed
    // nas DUAS direcoes.
    const readBackNodeNumbers = [...readBackNodes.map((entry) => entry.node)].sort(
      (left, right) => left - right,
    );
    const configNodeNumbers = [...existingNodes].sort((left, right) => left - right);
    const readBackIntegrity =
      readBackOutput !== null && sameNodes(readBackNodeNumbers, configNodeNumbers);
    checks.push({
      id: 'readback_integrity',
      ok: readBackIntegrity,
      detail: readBackIntegrity
        ? `read-back completo (nodes [${configNodeNumbers.join(', ')}] iguais ao config)`
        : `read-back divergente/incompleto: display [${readBackNodeNumbers.join(', ') || 'nenhum'}] x config [${configNodeNumbers.join(', ') || 'nenhum'}]`,
    });

    if (mode === 'ACTIVATE') {
      // B6: escrita real exige registro DURAVEL do baseline. Sem store
      // persistente (ausente/desabilitado) o ACTIVATE para aqui — a memoria do
      // processo nunca e aceita como fallback (um restart perderia o registro e
      // tornaria o REMOVE imprevisivel).
      const baselineStoreOk =
        !canWriteLive(this.deps.config, device.id) || this.baseline.durable === true;
      checks.push({
        id: 'baseline_record_store',
        ok: baselineStoreOk,
        detail: baselineStoreOk
          ? 'armazenamento do baseline disponivel para escrita real'
          : 'MITIGATION_BASELINE_RECORD_UNAVAILABLE: escrita real exige armazenamento ' +
            'duravel do baseline (MemoryMitigationBaselineStore so vale para MOCK/testes)',
      });
      // OCUPACAO DOS NODES TEMPORARIOS (Caso A x Caso B).
      // Nodes livres: criar. Nodes ocupados: NUNCA sobrescrever - capturar o
      // snapshot integral de cada node preexistente, identificar quais nodes
      // conflitam e BLOQUEAR (nao existe procedimento de substituicao
      // autorizado). O snapshot fica no resultado para informar o conflito e
      // permitir restauracao exata se a substituicao for autorizada um dia.
      const occupancy = planNodeOccupancy({
        readBack: routePolicyConfiguration ?? '',
        policyName: input.policyName,
        pair: { bogonNode: input.bogonNode, mitigationNode: input.mitigationNode },
        capturedAt: new Date().toISOString(),
      });
      nodeOccupancy = occupancy;

      // CONTRATO DO NODE 2: clone estreito do node permanente do cliente, provado
      // pelo baseline fisico (um permit com if-match/LP/RT 140, prefix-list existente,
      // sem deny anterior que alcance a lista). Inelegivel => nenhum comando existe.
      const derivation = deriveMitigationNode2Contract(
        routePolicyConfiguration ?? '',
        input.policyName,
        {
          prefixListConfiguration,
          requirePrefixListProof: true,
          bogonPrefixList: input.bogonPrefixList,
        },
      );
      mitigationContract = derivation.eligible ? derivation.contract : null;
      checks.push({
        id: 'mitigation_contract',
        ok: derivation.eligible,
        detail: derivation.eligible
          ? derivation.notes.join('; ')
          : contractRefusalMessage(derivation),
      });
      if (derivation.eligible) {
        // O export do peer de mitigacao precisa deixar a rota 660 do cliente chegar ao
        // permit MITIGACAO (nenhum deny anterior pode casar a lista do cliente).
        const evidence = await exportEvidence;
        const shadow = evidence
          ? checkMitigationExport({
              contract: derivation.contract,
              routePolicyConfiguration: evidence.routePolicyConfiguration,
              prefixListConfiguration,
              bgpConfiguration: evidence.bgpConfiguration,
              extcommunityFilterOutput: evidence.extcommunityFilterOutput,
            })
          : null;
        checks.push({
          id: 'mitigation_export',
          ok: shadow?.ok === true,
          detail: !shadow
            ? `${MITIGATION_EXPORT_SHADOWED}: leitura do export (config BGP / extcommunity-filter) indisponivel`
            : shadow.ok
              ? `export ${shadow.exportPolicy} do peer ${shadow.mitigationPeer}: nenhum deny anterior ao permit MITIGACAO casa a lista do cliente`
              : `${MITIGATION_EXPORT_SHADOWED}: ${shadow.reasons.join('; ')}`,
        });
      }
      checks.push({
        id: 'ipv4_contract',
        ok:
          input.bogonNode === 1 &&
          input.mitigationNode === 2 &&
          input.bogonPrefixList === 'BOGONS' &&
          input.rt === '268568:660',
        detail: 'exact fixed IPv4 node contract',
      });
      // Node 0 tem precedencia sobre o par: com ele a mitigacao fica inerte e
      // nao ha regra aprovada de convivencia. Bloqueia (fail-closed).
      const precedence = precedenceConflictNodes(nodes);
      checks.push({
        id: 'permanent_precedence',
        ok: precedence.length === 0,
        detail:
          precedence.length === 0
            ? 'nenhum node precede o par reservado 1/2'
            : `node(s) ${precedence.join(', ')} precedem o par reservado 1/2 (conflito de precedencia nao autorizado)`,
      });
      checks.push({
        id: 'node_occupancy',
        ok: !occupancy.blocked,
        detail:
          occupancy.status === 'FREE_PAIR'
            ? `nodes ${input.bogonNode} e ${input.mitigationNode} livres (caso A)`
            : `${occupancy.status}: nodes [${occupancy.conflictingNodes.join(', ')}] ja existem ` +
              `(caso B) - snapshot ${occupancy.snapshots.length} capturado(s), ` +
              `motivo ${occupancy.reason}`,
      });

      const bogonFree =
        routePolicyConfiguration !== null && !existingNodes.includes(input.bogonNode);
      checks.push({
        id: 'bogon_node_free',
        ok: bogonFree,
        detail: bogonFree
          ? `node ${input.bogonNode} livre (BOGONS)`
          : `node ${input.bogonNode} ja ocupado`,
      });

      const mitigationFree =
        routePolicyConfiguration !== null && !existingNodes.includes(input.mitigationNode);
      checks.push({
        id: 'mitigation_node_free',
        ok: mitigationFree,
        detail: mitigationFree
          ? `node ${input.mitigationNode} livre (mitigacao)`
          : `node ${input.mitigationNode} ja ocupado`,
      });

      const expected = input.expectedExistingNodes;
      const expectedOk = expected !== null && sameNodes(expected, existingNodes);
      checks.push({
        id: 'existing_nodes',
        ok: expectedOk,
        detail:
          expected === null
            ? 'sem snapshot do discovery para comparar existingNodes'
            : `esperado [${expected.join(', ')}], lido [${existingNodes.join(', ')}]`,
      });

      checks.push({
        id: 'bogon_prefix_list',
        ok: bogonExists,
        detail: bogonExists
          ? `ip-prefix ${input.bogonPrefixList} definida`
          : `ip-prefix ${input.bogonPrefixList} ausente`,
      });
      // F3: NUNCA instalar um SEGUNDO par de mitigacao na mesma policy fisica.
      // A prova e o read-back REAL (`display route-policy`), exatamente como a
      // verificacao pos-escrita; runtime e plano NAO decidem nada aqui.
      // Estrutura suspeita/parcial/multipla ou leitura inconclusiva BLOQUEIA
      // (reconciliacao obrigatoria) - o AUTO tambem passa por este preflight.
      const physical = this.inspectMitigation(input, readBackOutput);
      checks.push({
        id: 'policy_mitigation_scope',
        ok: physical.state === 'NORMAL',
        detail: physical.detail,
      });
    } else {
      // REMOVE: o par TEM de estar presente e exatamente correto. Nunca remover
      // "as cegas" um node com conteudo diferente.
      // F3-REMOVE: com estrutura AMBIGUA (multiplos pares, nodes suspeitos ou
      // leitura inconclusiva) a retirada fica bloqueada - remover UM par e
      // sincronizar o escopo como NORMAL esconderia o que sobrou.
      //
      // B5: o baseline NAO e mais heuristico. O registro gravado ANTES da
      // primeira escrita do ACTIVATE e a unica fonte dos nodes permanentes;
      // qualquer node novo/alterado/removido desde entao BLOQUEIA a retirada.
      const baselineRecord = await this.loadBaseline(device, input.policyName);
      const driftReasons =
        baselineRecord === null || readBackOutput === null
          ? ['registro de baseline ausente para esta mitigacao']
          : baselineDriftReasons(baselineRecord, readBackOutput);
      checks.push({
        id: 'policy_baseline_record',
        ok: baselineRecord !== null && driftReasons.length === 0,
        detail:
          baselineRecord === null
            ? 'MITIGATION_BASELINE_RECORD_MISSING: sem registro confiavel do ACTIVATE ' +
              '(a configuracao atual NAO e presumida original)'
            : driftReasons.length > 0
              ? `MITIGATION_BASELINE_DRIFT: ${driftReasons.join('; ')}`
              : `nodes permanentes identicos ao registro ${baselineRecord.capturedAt} ` +
                `[${baselineRecord.nodes.map((entry) => entry.node).join(', ') || 'nenhum'}]`,
      });
      const removalPhysical = this.inspectMitigation(input, readBackOutput);
      checks.push({
        id: 'policy_mitigation_scope',
        ok: removalPhysical.state !== 'RECONCILIATION_REQUIRED',
        detail:
          removalPhysical.state === 'RECONCILIATION_REQUIRED'
            ? `${removalPhysical.detail} (reconciliacao obrigatoria antes de retirar)`
            : 'estrutura de mitigacao reconhecida',
      });

      checks.push({
        id: 'bogon_node_present',
        ok: bogonNodeExists && bogonNodeMatches,
        detail: !bogonNodeExists
          ? `node BOGONS ${input.bogonNode} ausente`
          : bogonNodeMatches
            ? `node ${input.bogonNode} = deny + if-match ${input.bogonPrefixList}`
            : `node BOGONS ${input.bogonNode} diferente do esperado (deny + if-match ${input.bogonPrefixList})`,
      });
      checks.push({
        id: 'mitigation_node_present',
        ok: mitigationNodeExists && mitigationNodeMatches,
        detail: !mitigationNodeExists
          ? `node de mitigacao ${input.mitigationNode} ausente`
          : mitigationNodeMatches
            ? `node ${input.mitigationNode} = permit + apply extcommunity rt ${input.rt} (sem if-match)`
            : `node de mitigacao ${input.mitigationNode} diferente do esperado (permit + somente apply extcommunity rt ${input.rt}, sem additive)`,
      });
    }

    const rtOk = input.rt === this.rt;
    checks.push({
      id: 'route_target',
      ok: rtOk,
      detail: `esperada ${this.rt}, recebida ${input.rt}`,
    });

    const blockedReasons = checks
      .filter((check) => !check.ok)
      .map((check) => `${check.id}: ${check.detail}`);

    return {
      ok: blockedReasons.length === 0,
      mode,
      deviceId: device?.id ?? '',
      deviceName: device?.displayName || device?.hostname || device?.id || '',
      deviceHost,
      policyName: input.policyName,
      existingNodes,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      bogonPrefixList: input.bogonPrefixList,
      bogonPrefixListExists: bogonExists,
      targetPrefixList: input.targetPrefixList,
      targetPrefixListExists: targetExists,
      rt: input.rt,
      sshReadBackOk,
      bogonNodeExists,
      bogonNodeMatches,
      mitigationNodeExists,
      mitigationNodeMatches,
      partial,
      nodeOccupancy,
      preservedClauses,
      mitigationContract,
      baselineRecord:
        mode === 'ACTIVATE' && routePolicyConfiguration
          ? captureMitigationBaseline({
              deviceId: device.id,
              policyName: input.policyName,
              readBack: routePolicyConfiguration,
              bogonNode: input.bogonNode,
              mitigationNode: input.mitigationNode,
            })
          : null,
      readBackNodes: readBackNodes.map((entry) => entry.node),
      readBackSummary,
      readBackExcerpt: readBackOutput ? excerpt(readBackOutput) : '',
      checks,
      blockedReasons,
    };
  }

  async activate(
    device: HostRecord,
    input: MitigationActivationInput,
  ): Promise<{ output: string }> {
    this.assertWriteAllowed(device);
    const commands = buildMitigationActivateCommands(
      this.writePlan(input),
      input.mitigationContract,
    );
    assertMitigationCommandShape(commands);
    // B5: o fingerprint dos nodes PERMANENTES e gravado ANTES da primeira
    // escrita. Sem ele nao existe retirada confiavel depois.
    await this.captureAndSaveBaseline(device, input);
    const result = await this.deps.ssh.applyMitigationCommands(device, commands);
    if (!result.ok) {
      throw new Error(`MITIGATION_WRITE_FAILED: ${deviceExcerpt(result.output)}`);
    }
    return { output: result.output ?? '' };
  }

  async remove(device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    this.assertWriteAllowed(device);
    const commands = buildMitigationRemovalCommands({
      policyName: input.policyName,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
    });
    assertMitigationCommandShape(commands);
    // F1: invalidate the old ownership BEFORE touching hardware, retaining its
    // complete baseline. A timeout or failed RELEASED can never reactivate it.
    if (this.baseline.durable !== true) throw Error('MITIGATION_BASELINE_RECORD_UNAVAILABLE');
    await this.baseline.beginRemoval(
      { deviceId: device.id, policyName: input.policyName },
      input.requestId,
    );
    if ((await this.baseline.load({ deviceId: device.id, policyName: input.policyName })) !== null)
      throw Error('MITIGATION_BASELINE_REMOVAL_INTENT_UNCONFIRMED');
    const result = await this.deps.ssh.applyMitigationCommands(device, commands);
    if (!result.ok) {
      throw new Error(`MITIGATION_WRITE_FAILED: ${deviceExcerpt(result.output)}`);
    }
    return { output: result.output ?? '' };
  }

  /**
   * READ-ONLY: par ATIVO hoje no equipamento para esta policy (reconciliacao).
   *
   * Usado SOMENTE para REMOVE: identifica o node de DENY com a prefix-list
   * BOGONS e o node de PERMIT com a prefix-list alvo + a RT esperada. Nunca
   * calcula nodes novos e nunca toca no planejador — apenas le o que JA existe.
   * Fail-closed: sem exatamente UM de cada, devolve `null`.
   */
  async resolveActivePair(
    device: HostRecord,
    policyName: string,
    rt: string,
  ): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    let configuration: MitigationSshConfiguration;
    try {
      configuration = await this.deps.ssh.readMitigationConfiguration(device);
    } catch {
      return null;
    }
    const source = configuration.routePolicyConfiguration;
    if (source === null) return null;
    const record = await this.loadBaseline(device, policyName);
    if (
      !record ||
      record.bogonNode !== 1 ||
      record.mitigationNode !== 2 ||
      baselineDriftReasons(record, source).length
    )
      return null;
    const verification = verifyActivation(
      policyName,
      source,
      { bogonNode: 1, mitigationNode: 2 },
      rt,
      this.labels,
    );
    return verification.verified ? { bogonNode: 1, mitigationNode: 2 } : null;
  }

  /** Leitura best-effort (nunca lanca) da evidencia de export; `null` = indisponivel. */
  private async readExportEvidence(device: HostRecord): Promise<{
    bgpConfiguration: string;
    routePolicyConfiguration: string;
    extcommunityFilterOutput: string;
  } | null> {
    try {
      const reads = await this.deps.ssh.readMitigationDisplays(device, [
        BGP_CONFIGURATION_COMMAND,
        ROUTE_POLICY_CONFIGURATION_COMMAND,
        EXTCOMMUNITY_FILTER_COMMAND,
      ]);
      const by = new Map(reads.map((read) => [read.command, read.output]));
      const bgpConfiguration = by.get(BGP_CONFIGURATION_COMMAND) ?? null;
      const routePolicyConfiguration = by.get(ROUTE_POLICY_CONFIGURATION_COMMAND) ?? null;
      const extcommunityFilterOutput = by.get(EXTCOMMUNITY_FILTER_COMMAND) ?? null;
      return bgpConfiguration && routePolicyConfiguration && extcommunityFilterOutput
        ? { bgpConfiguration, routePolicyConfiguration, extcommunityFilterOutput }
        : null;
    } catch {
      return null;
    }
  }

  private displayReader(device: HostRecord): DisplayReader | null {
    const reader = this.deps.ssh.readMitigationDisplays;
    return reader ? (commands) => reader.call(this.deps.ssh, device, commands) : null;
  }

  /**
   * READ-ONLY, PRE-escrita: estado dos peers do cliente (Established, rotas recebidas).
   * Roda em paralelo ao preflight, sem somar ao tempo pre-escrita. `null` = indisponivel
   * (a verificacao fisica sera inconclusiva).
   */
  async captureMitigationEvidence(
    device: HostRecord,
    customerPeers: readonly string[],
  ): Promise<PhysicalBeforeEvidence | null> {
    const read = this.displayReader(device);
    if (!read || customerPeers.length === 0) return null;
    try {
      return await captureBeforeEvidence(read, customerPeers);
    } catch {
      return null;
    }
  }

  /**
   * READ-ONLY, POS-escrita e read-back: prova o EFEITO da mitigacao no BGP. Nunca lanca:
   * qualquer falha vira INCONCLUSIVE. Sem rollback automatico.
   */
  async verifyMitigationPhysical(
    device: HostRecord,
    input: {
      contract: MitigationNode2Contract;
      customerPeers: readonly string[];
      before: PhysicalBeforeEvidence | null;
      /**
       * Teto do orcamento TOTAL em ms (o tempo que resta do lock da policy). A verificacao
       * nunca passa dele; orcamento insuficiente => INCONCLUSIVE (nunca sucesso).
       */
      maxBudgetMs?: number;
    },
  ): Promise<MitigationPhysicalVerification> {
    const read = this.displayReader(device);
    const baseTiming = this.deps.physical?.timing ?? DEFAULT_PHYSICAL_TIMING;
    const timing =
      input.maxBudgetMs !== undefined && Number.isFinite(input.maxBudgetMs)
        ? { ...baseTiming, budgetMs: Math.max(0, Math.min(baseTiming.budgetMs, input.maxBudgetMs)) }
        : this.deps.physical?.timing;
    if (timing && timing.budgetMs <= 0) {
      return {
        outcome: 'INCONCLUSIVE',
        summary:
          'verificacao fisica INCONCLUSIVE: sem tempo restante no lock da policy para verificar',
        checks: [
          {
            id: 'lock_budget',
            outcome: 'INCONCLUSIVE',
            detail: 'sem tempo restante no lock da policy para a verificacao fisica',
          },
        ],
        attempts: 0,
        elapsedMs: 0,
        mitigationPeer: null,
        eligiblePrefixes: [],
        customerPeers: [...input.customerPeers],
      };
    }
    if (!read) {
      return {
        outcome: 'INCONCLUSIVE',
        summary: 'verificacao fisica INCONCLUSIVE: transporte sem leitura de evidencia fisica',
        checks: [
          {
            id: 'transport',
            outcome: 'INCONCLUSIVE',
            detail: 'transporte sem leitura de evidencia fisica',
          },
        ],
        attempts: 0,
        elapsedMs: 0,
        mitigationPeer: null,
        eligiblePrefixes: [],
        customerPeers: [...input.customerPeers],
      };
    }
    try {
      return await verifyMitigationPhysical({
        read,
        contract: input.contract,
        customerPeers: input.customerPeers,
        before: input.before,
        ...(timing ? { timing } : {}),
        ...(this.deps.physical?.sleep ? { sleep: this.deps.physical.sleep } : {}),
        ...(this.deps.physical?.clock ? { clock: this.deps.physical.clock } : {}),
      });
    } catch (error) {
      return {
        outcome: 'INCONCLUSIVE',
        summary: `verificacao fisica INCONCLUSIVE: ${safeErrorMessage(error)}`,
        checks: [{ id: 'verification', outcome: 'INCONCLUSIVE', detail: safeErrorMessage(error) }],
        attempts: 0,
        elapsedMs: 0,
        mitigationPeer: null,
        eligiblePrefixes: [],
        customerPeers: [...input.customerPeers],
      };
    }
  }

  /**
   * READ-ONLY, M4: REEXECUTA a verificacao fisica de uma mitigacao JA aplicada (reconciliacao).
   * Deriva o contrato da configuracao atual (sem estado PRE: ver `reverify`). Nunca lanca.
   */
  async reverifyMitigationPhysical(
    device: HostRecord,
    input: { policyName: string; customerPeers: readonly string[] },
  ): Promise<MitigationPhysicalVerification> {
    const inconclusive = (detail: string): MitigationPhysicalVerification => ({
      outcome: 'INCONCLUSIVE',
      summary: `verificacao fisica INCONCLUSIVE: ${detail}`,
      checks: [{ id: 'reverify', outcome: 'INCONCLUSIVE', detail }],
      attempts: 0,
      elapsedMs: 0,
      mitigationPeer: null,
      eligiblePrefixes: [],
      customerPeers: [...input.customerPeers],
    });
    const read = this.displayReader(device);
    if (!read) return inconclusive('transporte sem leitura de evidencia fisica');
    try {
      const configuration = await this.deps.ssh.readMitigationConfiguration(device);
      const derived = deriveMitigationNode2Contract(
        configuration.routePolicyConfiguration ?? '',
        input.policyName,
        {
          prefixListConfiguration: configuration.prefixListConfiguration,
          requirePrefixListProof: true,
          bogonPrefixList: this.labels.bogonPrefixList,
        },
      );
      if (!derived.eligible) return inconclusive(contractRefusalMessage(derived));
      return await verifyMitigationPhysical({
        read,
        contract: derived.contract,
        customerPeers: input.customerPeers,
        before: null,
        reverify: true,
        ...(this.deps.physical?.timing ? { timing: this.deps.physical.timing } : {}),
        ...(this.deps.physical?.sleep ? { sleep: this.deps.physical.sleep } : {}),
        ...(this.deps.physical?.clock ? { clock: this.deps.physical.clock } : {}),
      });
    } catch (error) {
      return inconclusive(safeErrorMessage(error));
    }
  }

  /**
   * READ-ONLY: prova que o efeito BGP de uma mitigacao foi DESFEITO (reconciliacao de escopo em
   * quarentena). Deriva o contrato da configuracao atual. Nunca lanca: falha vira INCONCLUSIVE.
   */
  async verifyRestorationPhysical(
    device: HostRecord,
    input: { policyName: string; customerPeers: readonly string[] },
  ): Promise<RestorationPhysicalVerification> {
    const inconclusive = (detail: string): RestorationPhysicalVerification => ({
      outcome: 'INCONCLUSIVE',
      summary: `restauracao BGP INCONCLUSIVE: ${detail}`,
      checks: [{ id: 'restoration', outcome: 'INCONCLUSIVE', detail }],
      mitigationPeer: null,
      eligiblePrefixes: [],
      customerPeers: [...input.customerPeers],
    });
    const read = this.displayReader(device);
    if (!read) return inconclusive('transporte sem leitura de evidencia fisica');
    try {
      const configuration = await this.deps.ssh.readMitigationConfiguration(device);
      const derived = deriveMitigationNode2Contract(
        configuration.routePolicyConfiguration ?? '',
        input.policyName,
        {
          prefixListConfiguration: configuration.prefixListConfiguration,
          requirePrefixListProof: true,
          bogonPrefixList: this.labels.bogonPrefixList,
        },
      );
      if (!derived.eligible) return inconclusive(contractRefusalMessage(derived));
      return await verifyRestorationPhysical({
        read,
        contract: derived.contract,
        customerPeers: input.customerPeers,
      });
    } catch (error) {
      return inconclusive(safeErrorMessage(error));
    }
  }

  /** READ-ONLY: estado atual da policy para o read-back obrigatorio. */
  async readRoutePolicy(device: HostRecord, policyName: string): Promise<string> {
    return this.deps.ssh.readMitigationRoutePolicy(device, policyName);
  }

  /**
   * OWNERSHIP (nenhum comando no equipamento): descarta o registro do baseline
   * do escopo depois de uma retirada VERIFICADA. A partir daqui um par igual
   * que apareca na policy nao pertence mais ao NetVision e o REMOVE volta a
   * exigir um ACTIVATE novo (que recaptura o baseline antes de escrever).
   */
  async releaseBaseline(device: HostRecord, policyName: string): Promise<void> {
    await this.baseline.release({ deviceId: device.id, policyName });
  }
}
