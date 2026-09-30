import type { HostRecord } from '@gmj/shared';
import {
  allNodesOf,
  parseConfiguredIpPrefixNames,
  parseHuaweiRoutePolicyNodes,
  parseHuaweiRoutePolicyNodesLenient,
} from './huawei-bgp-policy-parser';
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
import {
  DEFAULT_BOGON_PREFIX_LIST,
  DEFAULT_TARGET_PREFIX_LIST,
} from './mitigation-planner';
import {
  assertMitigationCommandShape,
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
  type MitigationWritePlan,
} from './mitigation-write-guard';

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

export class HuaweiMitigationExecutor {
  private readonly rt: string;
  private readonly labels: { bogonPrefixList: string; targetPrefixList: string };

  constructor(private readonly deps: HuaweiMitigationExecutorDeps) {
    this.rt = deps.rt ?? DEFAULT_MITIGATION_RT;
    this.labels = deps.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    };
  }

  /** Leitura real liberada para este device (HUAWEI + allowlist). */
  enabledFor(device: HostRecord | null | undefined): boolean {
    return canReadLive(this.deps.config, device?.id);
  }

  private assertWriteAllowed(device: HostRecord): void {
    if (!canWriteLive(this.deps.config, device?.id)) {
      throw new Error(
        'MITIGATION_WRITE_DISABLED: escrita real desabilitada (executor/allowlist/live_write)',
      );
    }
  }

  private writePlan(input: MitigationActivationInput | MitigationRemovalInput): MitigationWritePlan {
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
   * Preflight READ-ONLY. Nunca lanca: qualquer falha vira `ok:false` com o motivo
   * em `blockedReasons`, para o operador ver exatamente o que divergiu.
   */
  async preflight(
    device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
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

    let configuration: MitigationSshConfiguration | null = null;
    let readError = 'SSH indisponivel';
    try {
      configuration = await this.deps.ssh.readMitigationConfiguration(device);
    } catch (error) {
      readError = safeErrorMessage(error);
    }

    const routePolicyConfiguration = configuration?.routePolicyConfiguration ?? null;
    const prefixListConfiguration = configuration?.prefixListConfiguration ?? null;
    // O REMOVE so precisa da route-policy; o ACTIVATE tambem exige as ip-prefix.
    const sshReadBackOk =
      routePolicyConfiguration !== null &&
      (mode === 'REMOVE' || prefixListConfiguration !== null);
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
    const mitigationNodeMatches =
      routePolicyConfiguration !== null && verification.mitigationOk;
    const bothMatch = bogonNodeMatches && mitigationNodeMatches;
    const partial = (bogonNodeMatches || mitigationNodeMatches) && !bothMatch;

    if (mode === 'ACTIVATE') {
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
      checks.push({
        id: 'target_prefix_list',
        ok: targetExists,
        detail: targetExists
          ? `ip-prefix ${input.targetPrefixList} definida`
          : `ip-prefix ${input.targetPrefixList} ausente`,
      });
    } else {
      // REMOVE: o par TEM de estar presente e exatamente correto. Nunca remover
      // "as cegas" um node com conteudo diferente.
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
            ? `node ${input.mitigationNode} = permit + if-match ${input.targetPrefixList} + RT ${input.rt}`
            : `node de mitigacao ${input.mitigationNode} diferente do esperado`,
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
      readBackNodes: readBackNodes.map((entry) => entry.node),
      readBackSummary,
      readBackExcerpt: readBackOutput ? excerpt(readBackOutput) : '',
      checks,
      blockedReasons,
    };
  }

  async activate(device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }> {
    this.assertWriteAllowed(device);
    const commands = buildMitigationActivateCommands(this.writePlan(input));
    assertMitigationCommandShape(commands);
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
    const nodes = parseHuaweiRoutePolicyNodes(source).get(policyName) ?? [];
    const bogons = nodes
      .filter(
        (entry) =>
          entry.action === 'deny' && entry.ifMatchIpPrefix.includes(this.labels.bogonPrefixList),
      )
      .map((entry) => entry.node);
    const mitigations = nodes
      .filter(
        (entry) =>
          entry.action === 'permit' &&
          entry.ifMatchIpPrefix.includes(this.labels.targetPrefixList) &&
          entry.routeTargets.includes(rt),
      )
      .map((entry) => entry.node);
    if (bogons.length !== 1 || mitigations.length !== 1) return null;
    return { bogonNode: bogons[0]!, mitigationNode: mitigations[0]! };
  }

  /** READ-ONLY: estado atual da policy para o read-back obrigatorio. */
  async readRoutePolicy(device: HostRecord, policyName: string): Promise<string> {
    return this.deps.ssh.readMitigationRoutePolicy(device, policyName);
  }
}
