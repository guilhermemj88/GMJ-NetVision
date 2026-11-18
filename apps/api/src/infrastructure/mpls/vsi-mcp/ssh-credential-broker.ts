import { createHash } from 'node:crypto';
import type { HostRepository } from '../../persistence/host-repository';
import { checkVsiMcpScope, matchVsiMcpProfile, type VsiMcpAccessProfile } from './access-profile';
import { buildVsiMcpCommand, type VsiMcpOperation, type VsiMcpOperationKind } from './command-policy';
import { interfaceName as interfaceNameValid } from '../vsi-diagnostic-policy';

/**
 * SshCredentialBroker: UNICO caminho do motor VSI/MCP ate a senha SSH cadastrada.
 *
 * Reutiliza o cofre existente (`HostRepository.getDecryptedSshCredentials`, AES-256-GCM sobre `SshCredential`):
 * nao cria armazenamento, copia de chave, arquivo de senha nem rota nova.
 *
 * Modelo de autorizacao (tudo validado ANTES de abrir o cofre):
 *   1. finalidade autorizada;
 *   2. identidade SSH resolvida PELO BROKER, contra inventario + perfil de acesso lidos por ele (o chamador nao
 *      entrega perfil: recebe de volta `SshConnection` e e obrigado a usar esses parametros);
 *   3. plano da sessao dentro do TETO do escopo aprovado (VSI exata, comandos permitidos por sequencia,
 *      sem repeticao, `profile.maxInterfaces`, listas fechadas do perfil);
 *   4. grant criado pelo consumo da aprovacao ADMIN one-shot, vinculado a approvalId + host + escopo (VSI) +
 *      finalidade + digest da identidade/perfil, com sequencia estrita;
 *   5. so entao o cofre e aberto, imediatamente antes da sessao.
 *
 * Nenhuma mensagem de erro, evento de auditoria ou valor devolvido carrega a senha, hash dela ou o nome do equipamento.
 */

/** Finalidades autorizadas a pedir a senha. Nova finalidade exige mudanca de codigo e revisao. */
export const SSH_CREDENTIAL_PURPOSES = ['VSI_DIAGNOSTIC_LIVE'] as const;
export type SshCredentialPurpose = (typeof SSH_CREDENTIAL_PURPOSES)[number];

/** VSI especifica: 2 sessoes no maximo (1 e 2, em sequencia). Descoberta de host: 1 sessao. */
export const SSH_GRANT_MAX_SESSIONS = 2;
export type SshSessionSequence = 1 | 2;
/** Validade do grant apos o consumo da aprovacao (nunca alem da validade da propria aprovacao). */
export const SSH_GRANT_TTL_MS = 120_000;

const MESSAGES = {
  PURPOSE_NOT_AUTHORIZED: 'Finalidade nao autorizada para uso da credencial SSH',
  SCOPE_NOT_AUTHORIZED: 'Escopo de aprovacao desconhecido',
  SERVICE_ACCOUNT_ROLE: 'Conta de servico com papel ADMIN nao pode executar diagnostico operacional',
  OPERATOR_REQUIRED: 'Operador executor nao identificado',
  PLAN_NOT_AUTHORIZED: 'Operacao fora do escopo autorizado pela aprovacao',
  PROFILE_INVALID: 'Perfil de acesso invalido ou fora da validade',
  FINGERPRINT_NOT_PINNED: 'Fingerprint SSH nao fixada no perfil',
  HOST_NOT_FOUND: 'Equipamento nao cadastrado',
  IDENTITY_MISMATCH: 'Identidade do equipamento diverge do cadastro',
  IDENTITY_CHANGED: 'Identidade SSH ou perfil mudou desde a aprovacao',
  CREDENTIAL_UNAVAILABLE: 'Credencial SSH indisponivel',
  GRANT_REQUIRED: 'Autorizacao one-shot consumida e obrigatoria para abrir a sessao',
  GRANT_MISMATCH: 'Autorizacao nao corresponde a este equipamento ou escopo',
  GRANT_EXPIRED: 'Autorizacao expirada',
  GRANT_EXHAUSTED: 'Autorizacao ja utilizada',
  GRANT_SEQUENCE: 'Sessao fora da sequencia autorizada',
} as const;

export type SshCredentialBrokerErrorCode = keyof typeof MESSAGES;

/** Erro SEMPRE com mensagem fixa: nada dinamico (host, usuario, valor) entra no texto. */
export class SshCredentialBrokerError extends Error {
  constructor(readonly code: SshCredentialBrokerErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SshCredentialBrokerError';
  }
}

/** Escopo da aprovacao one-shot (mesma string usada no consumo): descoberta de host ou uma VSI exata. */
export type ParsedApprovalScope = { kind: 'DISCOVERY' } | { kind: 'VSI'; vsiName: string };
const VSI_SCOPE = /^vsi-name:([A-Za-z0-9_.:-]{1,64})$/;

export function parseApprovalScope(scope: unknown): ParsedApprovalScope | null {
  if (scope === 'vsi-host:discovery') return { kind: 'DISCOVERY' };
  const match = typeof scope === 'string' ? VSI_SCOPE.exec(scope) : null;
  return match ? { kind: 'VSI', vsiName: match[1]! } : null;
}

/** Plano de UMA sessao: o que sera executado, declarado antes de conectar. */
export interface SshOperationPlan {
  /** Escopo da aprovacao consumida (`vsi-name:<VSI>` ou `vsi-host:discovery`). */
  scope: string;
  sequence: SshSessionSequence;
  /** Operacoes da sessao, inclusive `VERSION` (que o coletor sempre envia primeiro). */
  operations: readonly VsiMcpOperation[];
}

/** Parametros de conexao AUTORITATIVOS: o cliente SSH so pode usar estes. */
export interface SshConnection {
  readonly endpoint: string;
  readonly port: number;
  readonly username: string;
  readonly context: string | null;
  readonly fingerprint: string;
  /** Copia congelada do perfil resolvido pelo broker (familia, prompts, validade, listas fechadas). */
  readonly profile: Readonly<VsiMcpAccessProfile>;
  /** sha256 do perfil inteiro + identidade: igual entre sessoes da mesma aprovacao, ou a sessao e negada. */
  readonly digest: string;
}

export interface SshCredentialRequest {
  purpose: SshCredentialPurpose;
  hostId: string;
  plan: SshOperationPlan;
}

export interface SshSessionRequest extends SshCredentialRequest {
  /** Aprovacao ja consumida por `consumeApproval`; sem ela nao ha descriptografia. */
  approvalId: string | undefined;
  /** Identidade autenticada de quem EXECUTA; tem de ser a mesma que consumiu a aprovacao (vinculada ao grant). */
  operatorId?: string | undefined;
  /** So para auditoria: a sessao e de homologacao. */
  homologation?: boolean | undefined;
}

/** Entregue somente ao callback. `password` nao e enumeravel e `toJSON` nao a revela. */
export interface SshSecret {
  readonly password: string;
}

/** Quem executa: identidade autenticada da requisicao (nunca um texto do chamador de ferramenta). */
export interface SshOperator {
  id: string;
  username: string;
  role: string;
}

export interface SshCredentialBrokerAuditEvent {
  action: 'GRANT_ISSUED' | 'PREFLIGHT_DENIED' | 'LEASE_GRANTED' | 'LEASE_DENIED' | 'ACS_OBSERVED';
  purpose: string;
  hostId: string;
  approvalId?: string;
  /** Escopo da aprovacao (inclui a VSI exata): `vsi-name:<VSI>` ou `vsi-host:discovery`. */
  scope?: string;
  /** Operador que EXECUTA (o grant o guarda: vale para todas as sessoes da aprovacao). */
  operatorId?: string;
  /** Quem CRIOU a aprovacao (o aprovador), quando conhecido. */
  approvedBy?: string;
  sequence?: number;
  homologation?: boolean;
  /** Numero de ACs registrados (ACS_OBSERVED); nunca valores sensiveis. */
  count?: number;
  code?: SshCredentialBrokerErrorCode;
}

/** O que o coletor precisa do broker (permite um duble de teste explicito, nunca um default). */
export interface SshCredentialBrokerPort {
  /** Valida identidade e teto do plano SEM grant e SEM tocar no cofre; devolve os parametros de conexao autoritativos. */
  preflight(request: SshCredentialRequest): Promise<SshConnection>;
  withCredential<T>(request: SshSessionRequest, use: (secret: SshSecret, connection: SshConnection) => Promise<T>): Promise<T>;
  /** Registra os ACs vistos na sessao 1 (so restringe a sessao 2). Opcional nos dubles de teste. */
  observeAcs?(request: { approvalId: string | undefined; hostId: string; scope: string; names: readonly string[]; operatorId?: string | undefined }): void;
}

interface Grant {
  hostId: string;
  scope: string;
  parsedScope: ParsedApprovalScope;
  purpose: SshCredentialPurpose;
  identityDigest: string;
  maxSessions: number;
  expiresAt: number;
  /** Proxima sessao aceita (1, 2 e depois nenhuma). */
  next: number;
  inFlight: boolean;
  /** Uma sessao falhou: a aprovacao esta encerrada (sem repeticao automatica). */
  closed: boolean;
  /** Comandos ja reservados por esta aprovacao (exceto `display version`): nenhum se repete. */
  executed: Set<string>;
  /** Total de `INTERFACE_CONFIG` de AC reservadas (teto: profile.maxInterfaces). */
  interfaces: number;
  operatorId: string;
  approvedBy: string;
  /** ACs vistos na SESSAO 1 (evidencia); a sessao 2 so pode ler ACs desta lista. null = nada observado ainda. */
  observedAcs: Set<string> | null;
}

export interface SshCredentialBrokerDeps {
  hosts: Pick<HostRepository, 'getHost' | 'getDecryptedSshCredentials'>;
  /** Fonte AUTORITATIVA dos perfis de acesso (o broker a le; o chamador nao entrega perfil). */
  profiles: () => Promise<VsiMcpAccessProfile[]>;
  /**
   * Consome a aprovacao ADMIN one-shot (lanca se ausente/expirada/usada/de outro escopo/criada pelo proprio executor).
   * Devolve a validade e quem a criou.
   */
  consumeApproval: (approvalId: string | undefined, hostId: string, scope: string, executor: string) => { expiresAt: string; createdBy: string };
  /** Usernames de contas de SERVICO (ex.: a do MCP). Uma conta de servico com papel ADMIN nunca executa. */
  serviceAccounts?: () => ReadonlySet<string>;
  audit?: (event: SshCredentialBrokerAuditEvent) => void;
  now?: () => number;
  allowedPurposes?: readonly SshCredentialPurpose[];
}

/** Tipos de operacao permitidos por escopo/sequencia (allowlist positiva). */
const DISCOVERY_KINDS: ReadonlySet<VsiMcpOperationKind> = new Set(['VERSION', 'VSI_LIST']);
const VSI_FIRST_KINDS: ReadonlySet<VsiMcpOperationKind> = new Set([
  'VERSION', 'VSI_VERBOSE', 'VSI_MAC', 'INTERFACE_CONFIG', 'VLAN_INFO', 'ETH_TRUNK_INFO', 'ETRUNK_BRIEF', 'ETRUNK_INFO',
]);
/** A 2a sessao e CONTINUACAO da leitura da VSI: nunca le a VSI de novo nem lista VSIs. */
const VSI_CONTINUATION_KINDS: ReadonlySet<VsiMcpOperationKind> = new Set([
  'VERSION', 'VSI_MAC', 'INTERFACE_CONFIG', 'VLAN_INFO', 'ETH_TRUNK_INFO', 'ETRUNK_BRIEF', 'ETRUNK_INFO',
]);
const VERSION_COMMAND = 'display version';

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const MAX_OBSERVED_ACS = 64;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as object)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export class SshCredentialBroker implements SshCredentialBrokerPort {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly deps: SshCredentialBrokerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private audit(event: SshCredentialBrokerAuditEvent): void {
    try {
      this.deps.audit?.(event);
    } catch {
      /* auditoria nunca derruba nem expoe a operacao */
    }
  }

  private allowed(purpose: unknown): purpose is SshCredentialPurpose {
    return (this.deps.allowedPurposes ?? SSH_CREDENTIAL_PURPOSES).includes(purpose as SshCredentialPurpose);
  }

  /**
   * Consome a aprovacao one-shot e registra o grant, vinculado a approvalId + host + ESCOPO (VSI exata) + finalidade
   * + digest da identidade/perfil vigente. Antes de consumir, valida finalidade, escopo e identidade: uma falha
   * dessas NAO gasta a aprovacao. Erros da aprovacao (423) seguem inalterados para o chamador.
   */
  async consumeApproval(
    approvalId: string | undefined,
    hostId: string,
    scope: string,
    operator: SshOperator,
    purpose: SshCredentialPurpose = 'VSI_DIAGNOSTIC_LIVE',
  ): Promise<void> {
    const base = { purpose: String(purpose), hostId, scope, ...(operator?.id ? { operatorId: operator.id } : {}) };
    let parsed: ParsedApprovalScope;
    let connection: SshConnection;
    try {
      if (!this.allowed(purpose)) throw new SshCredentialBrokerError('PURPOSE_NOT_AUTHORIZED');
      if (!operator || !operator.id || !operator.username) throw new SshCredentialBrokerError('OPERATOR_REQUIRED');
      // Conta de servico (ex.: MCP) com papel ADMIN nao executa: ADMIN pode criar aprovacao, e executor nao aprova.
      if (operator.role === 'ADMIN' && this.deps.serviceAccounts?.().has(operator.username))
        throw new SshCredentialBrokerError('SERVICE_ACCOUNT_ROLE');
      const scoped = parseApprovalScope(scope);
      if (!scoped) throw new SshCredentialBrokerError('SCOPE_NOT_AUTHORIZED');
      parsed = scoped;
      connection = await this.resolveConnection(hostId, [{ kind: 'VERSION' }]);
    } catch (error) {
      this.audit({ action: 'LEASE_DENIED', ...base, ...codeOf(error) });
      throw error;
    }
    // Separacao de funcoes: a aprovacao e recusada ANTES de ser marcada como usada se o executor for quem a criou.
    let approval: { expiresAt: string; createdBy: string };
    try {
      approval = this.deps.consumeApproval(approvalId, hostId, scope, operator.username);
    } catch (error) {
      this.audit({ action: 'LEASE_DENIED', ...base, ...(approvalId ? { approvalId } : {}) });
      throw error;
    }
    const now = this.now();
    this.purge(now);
    const approvalExpiry = Date.parse(approval.expiresAt);
    this.grants.set(approvalId as string, {
      hostId,
      scope,
      parsedScope: parsed,
      purpose,
      identityDigest: connection.digest,
      maxSessions: parsed.kind === 'DISCOVERY' ? 1 : SSH_GRANT_MAX_SESSIONS,
      expiresAt: Math.min(now + SSH_GRANT_TTL_MS, Number.isFinite(approvalExpiry) ? approvalExpiry : now),
      next: 1,
      inFlight: false,
      closed: false,
      executed: new Set(),
      interfaces: 0,
      operatorId: operator.id,
      approvedBy: approval.createdBy,
      observedAcs: null,
    });
    this.audit({ action: 'GRANT_ISSUED', ...base, approvalId: approvalId as string, approvedBy: approval.createdBy });
  }

  /**
   * Registra os ACs que a SESSAO 1 mostrou (evidencia). So vale depois de a sessao 1 CONCLUIR com sucesso, uma unica
   * vez, para o mesmo host/escopo/aprovacao. Nao amplia nenhum comando: so RESTRINGE o que a sessao 2 pode ler.
   */
  observeAcs(request: { approvalId: string | undefined; hostId: string; scope: string; names: readonly string[]; operatorId?: string | undefined }): void {
    const grant = request.approvalId ? this.grants.get(request.approvalId) : undefined;
    if (!grant) throw new SshCredentialBrokerError('GRANT_REQUIRED');
    if (grant.hostId !== request.hostId || grant.scope !== request.scope || grant.operatorId !== request.operatorId)
      throw new SshCredentialBrokerError('GRANT_MISMATCH');
    if (grant.expiresAt <= this.now()) throw new SshCredentialBrokerError('GRANT_EXPIRED');
    // so apos a sessao 1 terminar bem (next === 2), sem sessao aberta, sem falha e sem observacao anterior
    if (grant.closed || grant.inFlight || grant.next !== 2 || grant.observedAcs !== null || grant.parsedScope.kind !== 'VSI')
      throw new SshCredentialBrokerError('GRANT_SEQUENCE');
    const valid = request.names.filter((n) => typeof n === 'string' && interfaceNameValid(n)).slice(0, MAX_OBSERVED_ACS);
    grant.observedAcs = new Set(valid);
    this.audit({
      action: 'ACS_OBSERVED', purpose: grant.purpose, hostId: grant.hostId, scope: grant.scope, approvalId: request.approvalId as string,
      operatorId: grant.operatorId, approvedBy: grant.approvedBy, count: valid.length,
    });
  }

  /** Identidade + teto do plano, sem grant e sem cofre: o chamador roda ANTES de consumir a aprovacao. */
  async preflight(request: SshCredentialRequest): Promise<SshConnection> {
    try {
      if (!this.allowed(request.purpose)) throw new SshCredentialBrokerError('PURPOSE_NOT_AUTHORIZED');
      const connection = await this.resolveConnection(request.hostId, request.plan.operations);
      this.checkPlan(request.plan, connection.profile);
      return connection;
    } catch (error) {
      this.audit({ action: 'PREFLIGHT_DENIED', purpose: String(request.purpose), hostId: request.hostId, sequence: request.plan.sequence, ...codeOf(error) });
      throw error;
    }
  }

  /**
   * Descriptografa SOMENTE aqui, depois de todas as validacoes e do grant, e entrega ao callback junto com os
   * parametros de conexao autoritativos. Nada e guardado em campo, cache ou log; erros do callback sao redigidos.
   */
  async withCredential<T>(
    request: SshSessionRequest,
    use: (secret: SshSecret, connection: SshConnection) => Promise<T>,
  ): Promise<T> {
    const base = {
      purpose: String(request.purpose), hostId: request.hostId, sequence: request.plan.sequence, scope: request.plan.scope,
      ...(request.approvalId ? { approvalId: request.approvalId } : {}),
      ...(request.homologation ? { homologation: true } : {}),
    };
    const who = (g: Grant | undefined) => (g ? { operatorId: g.operatorId, approvedBy: g.approvedBy } : {});
    let password: string;
    let connection: SshConnection;
    let grant: Grant | undefined;
    try {
      if (!this.allowed(request.purpose)) throw new SshCredentialBrokerError('PURPOSE_NOT_AUTHORIZED');
      connection = await this.resolveConnection(request.hostId, request.plan.operations);
      const { commands, acCommands } = this.checkPlan(request.plan, connection.profile);
      grant = this.reserveGrant(request, connection, commands, acCommands);
      const credentials = await this.deps.hosts.getDecryptedSshCredentials(request.hostId);
      if (typeof credentials?.password !== 'string' || credentials.password.length === 0)
        throw new SshCredentialBrokerError('CREDENTIAL_UNAVAILABLE');
      password = credentials.password;
    } catch (error) {
      // Falha depois de reservar a vaga (ex.: cofre nao decifra) encerra a aprovacao: nenhuma tentativa automatica.
      if (grant?.inFlight) {
        grant.inFlight = false;
        grant.closed = true;
      }
      this.audit({ action: 'LEASE_DENIED', ...base, ...who(grant ?? (request.approvalId ? this.grants.get(request.approvalId) : undefined)), ...codeOf(error) });
      if (error instanceof SshCredentialBrokerError || isPassThrough(error)) throw error;
      throw new SshCredentialBrokerError('CREDENTIAL_UNAVAILABLE');
    }
    const reserved = grant as Grant;
    this.audit({ action: 'LEASE_GRANTED', ...base, ...who(reserved) });

    const secret = {} as { password: string };
    Object.defineProperty(secret, 'password', { value: password, enumerable: false });
    Object.defineProperty(secret, 'toJSON', { value: () => '[REDACTED]', enumerable: false });
    try {
      const result = await use(Object.freeze(secret), connection);
      reserved.inFlight = false;
      reserved.next += 1; // so uma sessao concluida com sucesso libera a continuacao
      return result;
    } catch (error) {
      reserved.inFlight = false;
      reserved.closed = true;
      throw redact(error, password);
    }
  }

  /**
   * Identidade autoritativa: host do inventario + perfil lido AQUI. O chamador nao entrega perfil.
   * Erros de perfil/escopo (`VsiMcpProfileError`) seguem inalterados para preservar o contrato das ferramentas.
   */
  private async resolveConnection(hostId: string, operations: readonly VsiMcpOperation[]): Promise<SshConnection> {
    const host = await this.deps.hosts.getHost(hostId);
    if (!host) throw new SshCredentialBrokerError('HOST_NOT_FOUND');
    if (host.id !== hostId) throw new SshCredentialBrokerError('IDENTITY_MISMATCH');
    if (!host.sshEnabled || !host.ssh) throw new SshCredentialBrokerError('IDENTITY_MISMATCH');
    if (!host.ssh.credentialConfigured) throw new SshCredentialBrokerError('CREDENTIAL_UNAVAILABLE');
    const kinds = [...new Set(['VERSION', ...operations.map((o) => o.kind)])] as VsiMcpOperationKind[];
    const profile = matchVsiMcpProfile(await this.deps.profiles(), host, kinds, this.now());
    if (profile.hostId !== hostId) throw new SshCredentialBrokerError('IDENTITY_MISMATCH');
    if (!FINGERPRINT.test(profile.fingerprint)) throw new SshCredentialBrokerError('FINGERPRINT_NOT_PINNED');
    const now = this.now();
    if (Date.parse(profile.validFrom) > now || Date.parse(profile.expiresAt) <= now)
      throw new SshCredentialBrokerError('PROFILE_INVALID');
    const frozen = deepFreeze(structuredClone(profile));
    return Object.freeze({
      endpoint: frozen.endpoint, port: frozen.port, username: frozen.username, context: frozen.context,
      fingerprint: frozen.fingerprint, profile: frozen,
      digest: createHash('sha256').update(canonicalJson(frozen)).digest('hex'),
    });
  }

  /** Teto do plano dentro do escopo aprovado (estatico: nao depende de grant). */
  private checkPlan(plan: SshOperationPlan, profile: VsiMcpAccessProfile): { commands: string[]; acCommands: string[] } {
    const scope = parseApprovalScope(plan.scope);
    if (!scope) throw new SshCredentialBrokerError('SCOPE_NOT_AUTHORIZED');
    const maxSequence = scope.kind === 'DISCOVERY' ? 1 : SSH_GRANT_MAX_SESSIONS;
    if (plan.sequence !== 1 && plan.sequence !== 2) throw new SshCredentialBrokerError('GRANT_SEQUENCE');
    if (plan.sequence > maxSequence) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');
    const allowedKinds =
      scope.kind === 'DISCOVERY' ? DISCOVERY_KINDS : plan.sequence === 1 ? VSI_FIRST_KINDS : VSI_CONTINUATION_KINDS;
    const commands: string[] = [];
    const acCommands: string[] = [];
    for (const operation of plan.operations) {
      if (!allowedKinds.has(operation.kind)) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');
      if ('vsiName' in operation && (scope.kind !== 'VSI' || operation.vsiName !== scope.vsiName))
        throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED'); // VSI exata
      const command = buildVsiMcpCommand(operation); // VsiMcpPolicyError segue inalterado
      if (commands.includes(command)) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED'); // nada se repete
      commands.push(command);
      if (operation.kind === 'INTERFACE_CONFIG' && operation.role !== 'CARRIER') acCommands.push(command);
    }
    if (acCommands.length > profile.maxInterfaces) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');
    checkVsiMcpScope(profile, plan.operations); // VLAN, portadoras e E-Trunks: listas fechadas do perfil
    return { commands, acCommands };
  }

  /** Valida o grant contra o pedido e RESERVA a sessao (estado alterado de forma sincrona: sem janela de corrida). */
  private reserveGrant(request: SshSessionRequest, connection: SshConnection, commands: string[], acCommands: string[]): Grant {
    const now = this.now();
    const grant = request.approvalId ? this.grants.get(request.approvalId) : undefined;
    if (!grant) throw new SshCredentialBrokerError('GRANT_REQUIRED');
    // host + escopo (VSI) + EXECUTOR: a identidade que consumiu a aprovacao e a unica que a usa nas sessoes
    if (grant.hostId !== request.hostId || grant.scope !== request.plan.scope || grant.operatorId !== request.operatorId)
      throw new SshCredentialBrokerError('GRANT_MISMATCH');
    if (grant.purpose !== request.purpose) throw new SshCredentialBrokerError('PURPOSE_NOT_AUTHORIZED');
    if (grant.expiresAt <= now) {
      this.grants.delete(request.approvalId as string);
      throw new SshCredentialBrokerError('GRANT_EXPIRED');
    }
    if (grant.closed || grant.next > grant.maxSessions) throw new SshCredentialBrokerError('GRANT_EXHAUSTED');
    if (grant.inFlight || request.plan.sequence !== grant.next) throw new SshCredentialBrokerError('GRANT_SEQUENCE');
    if (grant.identityDigest !== connection.digest) throw new SshCredentialBrokerError('IDENTITY_CHANGED');

    const scoped = grant.parsedScope;
    const fresh = commands.filter((c) => c !== VERSION_COMMAND);
    if (fresh.some((c) => grant.executed.has(c))) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED'); // nada se repete
    if (request.plan.sequence === 2) {
      // continuacao: so depois de a sessao 1 ter lido a VSI exata do escopo
      const verbose = scoped.kind === 'VSI' ? `display vsi name ${scoped.vsiName} verbose` : null;
      if (!verbose || !grant.executed.has(verbose)) throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');
    }
    if (grant.interfaces + acCommands.length > connection.profile.maxInterfaces)
      throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');

    if (request.plan.sequence === 2) {
      // Reforco: os ACs lidos na sessao 2 tem de ter sido VISTOS na sessao 1 (evidencia), nao apenas passar no regex.
      const names = request.plan.operations
        .filter((o): o is Extract<VsiMcpOperation, { kind: 'INTERFACE_CONFIG' }> => o.kind === 'INTERFACE_CONFIG' && o.role !== 'CARRIER')
        .map((o) => o.interfaceName);
      if (names.length > 0 && (!grant.observedAcs || names.some((n) => !grant.observedAcs!.has(n))))
        throw new SshCredentialBrokerError('PLAN_NOT_AUTHORIZED');
    }

    grant.inFlight = true;
    for (const c of fresh) grant.executed.add(c);
    grant.interfaces += acCommands.length;
    return grant;
  }

  private purge(now: number): void {
    for (const [id, grant] of this.grants) if (grant.expiresAt + 60_000 <= now) this.grants.delete(id);
  }
}

function codeOf(error: unknown): { code?: SshCredentialBrokerErrorCode } {
  return error instanceof SshCredentialBrokerError ? { code: error.code } : {};
}

/** Erros de perfil/politica seguem inalterados (contrato das ferramentas); nada neles carrega segredo. */
function isPassThrough(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'VsiMcpProfileError' || name === 'VsiMcpPolicyError';
}

/** Formas em que uma senha pode aparecer num texto: literal, JSON, URL, base64 (com e sem padding). */
export function secretVariants(password: string): string[] {
  if (!password) return [];
  const base64 = Buffer.from(password, 'utf8').toString('base64');
  return [...new Set([
    password,
    JSON.stringify(password).slice(1, -1),
    encodeURIComponent(password),
    base64,
    base64.replace(/=+$/, ''),
  ])].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

export function redactSecret(text: string, password: string): string {
  let out = text;
  for (const variant of secretVariants(password)) out = out.split(variant).join('[REMOVIDO]');
  return out;
}

/** Mensagem de erro de biblioteca segura para sair do processo: sem segredo e sem endereco/porta do equipamento. */
export function scrubSshMessage(message: string, password?: string): string {
  const clean = password ? redactSecret(message, password) : message;
  return clean
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[ENDPOINT]')
    .replace(/\[[0-9a-f:]+\](?::\d{1,5})?/gi, '[ENDPOINT]')
    .slice(0, 120);
}

/** Remove a senha de qualquer erro que atravesse o broker (mensagem, pilha e nome; formas literal/JSON/URL/base64). */
function redact(error: unknown, password: string): unknown {
  if (error instanceof SshCredentialBrokerError) return error;
  if (!(error instanceof Error)) return new Error('Falha SSH');
  const dirty = (text: string) => secretVariants(password).some((v) => text.includes(v));
  if (!dirty(error.message) && !dirty(error.stack ?? '') && !dirty(error.name)) return error;
  const clean = new Error(redactSecret(error.message, password));
  clean.name = dirty(error.name) ? 'Error' : error.name;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && !dirty(code)) (clean as { code?: string }).code = code;
  return clean;
}
