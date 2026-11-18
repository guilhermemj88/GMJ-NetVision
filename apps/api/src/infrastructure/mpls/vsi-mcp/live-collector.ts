import { createHash } from 'node:crypto';
import type { HostRecord } from '@gmj/shared';
import type { HostRepository } from '../../persistence/host-repository';
import { SshClientImpl } from '../../ssh/ssh-client-impl';
import { diagnosticSessionPreparation } from '../../ssh/diagnostic-session-preparation';
import { isCompleteObservation } from '../vsi-diagnostic-observation';
import { safeVsiOutput } from '../vsi-diagnostic-policy';
import { safeVsiMcpCommand, type VsiMcpOperation, type VsiMcpOperationKind } from './command-policy';
import { classifyHuaweiVersion, resolveCapability, type HuaweiPlatform } from './platform';
import { checkVsiMcpScope, VsiMcpProfileError } from './access-profile';
import { VsiMcpPolicyError } from './command-policy';
import {
  redactSecret, scrubSshMessage, SshCredentialBrokerError,
  type SshCredentialBrokerPort, type SshOperationPlan, type SshSessionSequence,
} from './ssh-credential-broker';

export const VSI_MCP_LIMITS = Object.freeze({
  commandMs: 12_000,
  sessionMs: 45_000,
  outputBytes: 131_072,
  maxOperationsPerSession: 14,
  /** Sessoes SSH simultaneas em todo o processo (todos os hosts). */
  globalConcurrency: 2,
  /** Intervalo minimo entre sessoes no MESMO equipamento (evita rajadas sobre o roteador). */
  perHostCooldownMs: 8_000,
});

export interface LiveCapture {
  operation: VsiMcpOperation;
  command: string;
  stdout: string;
  completedAt: string;
  durationMs: number;
  sha256: string;
  complete: boolean;
}

export interface SkippedOperation {
  operation: VsiMcpOperation;
  reason: 'CANDIDATE_NOT_HOMOLOGATED' | 'NOT_SUPPORTED';
  note: string;
}

export interface LiveSessionResult {
  platform: HuaweiPlatform;
  prompt: string;
  captures: LiveCapture[];
  skipped: SkippedOperation[];
}

export class VsiMcpLiveError extends Error {
  constructor(
    readonly code:
      | 'SSH_CREDENTIAL_UNAVAILABLE'
      | 'CREDENTIAL_ACCESS_DENIED'
      | 'PLATFORM_MISMATCH'
      | 'PROFILE_EXPIRED'
      | 'TOO_MANY_OPERATIONS'
      | 'BUSY'
      | 'SSH_FAILED'
      | 'ABORTED'
      | 'INCOMPLETE_CAPTURE',
    message: string,
  ) {
    super(message);
    this.name = 'VsiMcpLiveError';
  }
}

export { checkVsiMcpScope };

export interface VsiMcpLiveCollector {
  /**
   * Valida SEM abrir SSH: perfil valido do host, operacoes autorizadas e escopo fechado (VLAN/interfaces).
   * Chamado antes de consumir a aprovacao one-shot, para que um pedido fora do escopo nao a gaste.
   */
  preflight?(host: HostRecord, operations: readonly VsiMcpOperation[], scope?: string): Promise<void>;
  /** Teto de interfaces (`profile.maxInterfaces`) do perfil AUTORITATIVO do host. */
  maxInterfaces?(host: HostRecord, scope: string): Promise<number>;
  /** ACs vistos na sessao 1 (evidencia): a sessao 2 so poderá ler estes. */
  observeAcs?(host: HostRecord, scope: string, approvalId: string | undefined, names: readonly string[], operatorId?: string): void;
  /**
   * UMA sessao SSH por chamada, comandos executados em sequencia. `display version`
   * e sempre o primeiro e confirma a familia declarada no perfil.
   */
  collect(
    host: HostRecord,
    operations: readonly VsiMcpOperation[],
    options: {
      signal: AbortSignal;
      homologation?: boolean;
      audit: (command: string) => void;
      /** Aprovacao one-shot ja consumida (via broker): sem ela a credencial nao e descriptografada. */
      approvalId?: string | undefined;
      /** Identidade autenticada de quem executa (vinculada ao grant). */
      operatorId?: string | undefined;
      /** Escopo da aprovacao consumida (`vsi-name:<VSI>` | `vsi-host:discovery`): obrigatorio no coletor real. */
      scope?: string | undefined;
      /** 1 (padrao) ou 2: a continuacao da MESMA aprovacao (ver SshCredentialBroker). */
      sequence?: 1 | 2;
      /** Segunda sessao da MESMA chamada: aguarda o intervalo minimo em vez de falhar com BUSY. */
      pace?: boolean;
    },
  ): Promise<LiveSessionResult>;
}

/** Semaforo simples + exclusao por host: nunca duas sessoes no mesmo equipamento. */
class SessionGate {
  private active = 0;
  private readonly hosts = new Set<string>();
  private readonly lastEnd = new Map<string, number>();
  constructor(private readonly cooldownMs: number = VSI_MCP_LIMITS.perHostCooldownMs) {}
  /** Espera o intervalo minimo restante (cancelavel); nao fura a exclusao por host nem o limite global. */
  async waitCooldown(hostId: string, signal: AbortSignal): Promise<void> {
    const remaining = this.cooldownMs - (Date.now() - (this.lastEnd.get(hostId) ?? 0));
    if (remaining <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new VsiMcpLiveError('ABORTED', 'Operacao abortada'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, remaining + 50);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  acquire(hostId: string): () => void {
    const since = Date.now() - (this.lastEnd.get(hostId) ?? 0);
    if (since < this.cooldownMs)
      throw new VsiMcpLiveError('BUSY', `Aguarde ${Math.ceil((this.cooldownMs - since) / 1000)}s: intervalo minimo entre sessoes neste equipamento`);
    if (this.hosts.has(hostId)) throw new VsiMcpLiveError('BUSY', 'Ja existe uma sessao de diagnostico neste equipamento');
    if (this.active >= VSI_MCP_LIMITS.globalConcurrency)
      throw new VsiMcpLiveError('BUSY', 'Limite de sessoes SSH simultaneas atingido');
    this.active++;
    this.hosts.add(hostId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.hosts.delete(hostId);
      this.lastEnd.set(hostId, Date.now());
    };
  }
}

/**
 * Reutiliza o cofre de credenciais do inventario e o `SshClientImpl` em modo
 * diagnostico (fingerprint fixada, allowlist exata, saida limitada, prompt
 * confirmado). Nao abre conexao propria nem implementa SSH novo.
 */
export class SshVsiMcpLiveCollector implements VsiMcpLiveCollector {
  private readonly gate: SessionGate;

  constructor(
    private readonly hosts: Pick<HostRepository, 'getHost'>,
    /**
     * UNICO caminho ate a senha SSH E fonte autoritativa de identidade/perfil: o coletor nao le o cofre nem o
     * arquivo de perfis, e so pode conectar com os parametros que o broker devolve.
     */
    private readonly broker: SshCredentialBrokerPort,
    private readonly clientFactory: (opts: ConstructorParameters<typeof SshClientImpl>[0]) => Pick<SshClientImpl, 'execute'> = (
      opts,
    ) => new SshClientImpl(opts),
    cooldownMs: number = VSI_MCP_LIMITS.perHostCooldownMs,
  ) {
    this.gate = new SessionGate(cooldownMs);
  }

  private plan(scope: string | undefined, sequence: SshSessionSequence, operations: readonly VsiMcpOperation[]): SshOperationPlan {
    // Sem escopo nao ha como delimitar o que a aprovacao autoriza: falha fechada.
    if (!scope) throw new VsiMcpLiveError('CREDENTIAL_ACCESS_DENIED', 'Escopo da aprovacao ausente');
    return { scope, sequence, operations: [{ kind: 'VERSION' } as VsiMcpOperation, ...operations.filter((o) => o.kind !== 'VERSION')] };
  }

  private async freshHost(host: HostRecord): Promise<HostRecord> {
    const fresh = await this.hosts.getHost(host.id);
    if (!fresh || JSON.stringify(fresh.ssh) !== JSON.stringify(host.ssh) || fresh.sshEnabled !== host.sshEnabled)
      throw new VsiMcpLiveError('SSH_FAILED', 'Inventario do host mudou durante a operacao');
    return fresh;
  }

  async preflight(host: HostRecord, operations: readonly VsiMcpOperation[], scope?: string): Promise<void> {
    const fresh = await this.freshHost(host);
    // Identidade, fingerprint fixada, validade e TETO do escopo conferidos ANTES de a aprovacao ser consumida.
    try {
      await this.broker.preflight({ purpose: 'VSI_DIAGNOSTIC_LIVE', hostId: fresh.id, plan: this.plan(scope, 1, operations) });
    } catch (error) {
      throw mapBrokerError(error);
    }
  }

  observeAcs(host: HostRecord, scope: string, approvalId: string | undefined, names: readonly string[], operatorId?: string): void {
    try {
      this.broker.observeAcs?.({ approvalId, hostId: host.id, scope, names, operatorId });
    } catch (error) {
      throw mapBrokerError(error);
    }
  }

  async maxInterfaces(host: HostRecord, scope: string): Promise<number> {
    const fresh = await this.freshHost(host);
    try {
      return (await this.broker.preflight({ purpose: 'VSI_DIAGNOSTIC_LIVE', hostId: fresh.id, plan: this.plan(scope, 1, []) })).profile.maxInterfaces;
    } catch (error) {
      throw mapBrokerError(error);
    }
  }

  async collect(
    host: HostRecord,
    operations: readonly VsiMcpOperation[],
    options: { signal: AbortSignal; homologation?: boolean; audit: (command: string) => void; pace?: boolean; approvalId?: string | undefined; operatorId?: string | undefined; scope?: string | undefined; sequence?: 1 | 2 },
  ): Promise<LiveSessionResult> {
    if (operations.length + 1 > VSI_MCP_LIMITS.maxOperationsPerSession)
      throw new VsiMcpLiveError('TOO_MANY_OPERATIONS', 'Operacoes demais para uma sessao');
    options.signal.throwIfAborted();

    // Inventario pode ter mudado desde que o chamador leu o host.
    const fresh = await this.freshHost(host);
    const sequence: SshSessionSequence = options.sequence ?? 1;

    // Perfil AUTORITATIVO: resolvido pelo broker (inventario + arquivo de perfis lidos por ele), com o teto do escopo.
    let resolved;
    try {
      resolved = await this.broker.preflight({ purpose: 'VSI_DIAGNOSTIC_LIVE', hostId: fresh.id, plan: this.plan(options.scope, sequence, operations) });
    } catch (error) {
      throw mapBrokerError(error);
    }
    const profile = resolved.profile;
    const preparation = diagnosticSessionPreparation({ disablePagingTemporary: profile.disablePagingTemporary });
    if (!preparation) throw new VsiMcpLiveError('SSH_FAILED', 'Preparacao de sessao nao confirmada');

    // Decide ANTES de abrir a conexao o que pode ser enviado.
    const planned: Array<{ operation: VsiMcpOperation; command: string }> = [];
    const skipped: SkippedOperation[] = [];
    for (const operation of [{ kind: 'VERSION' } as VsiMcpOperation, ...operations]) {
      const decision = resolveCapability(profile.family, operation.kind as VsiMcpOperationKind, options.homologation === true);
      if (!decision.allowed) {
        skipped.push({
          operation,
          reason: decision.reason === 'NOT_SUPPORTED' ? 'NOT_SUPPORTED' : 'CANDIDATE_NOT_HOMOLOGATED',
          note: decision.note,
        });
        continue;
      }
      const command = safeVsiMcpCommand(operation); // lanca se nao for estritamente leitura
      if (!planned.some((p) => p.command === command)) planned.push({ operation, command });
    }
    if (!planned.some((p) => p.operation.kind === 'VERSION'))
      throw new VsiMcpLiveError('PLATFORM_MISMATCH', 'Versao nao pode ser confirmada');

    if (options.pace) await this.gate.waitCooldown(fresh.id, options.signal);
    const release = this.gate.acquire(fresh.id);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason ?? 'OPERATOR_CANCELLED');
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    const timer = setTimeout(
      () => controller.abort(Date.parse(profile.expiresAt) <= Date.now() ? 'PROFILE_EXPIRED' : 'COMMAND_TIMEOUT'),
      Math.min(VSI_MCP_LIMITS.sessionMs, Math.max(0, Date.parse(profile.expiresAt) - Date.now())),
    );

    const captures: LiveCapture[] = [];
    let platform: HuaweiPlatform = { family: 'UNKNOWN', model: null, release: null, matchedLine: null };
    let mismatch = false;
    let startedAt = Date.now();
    const commands = planned.map((p) => p.command);
    // Ordem enviada ao canal: preparacao, (contexto de virtual-system), comandos.
    const prefix: string[] = profile.context ? [preparation, profile.context] : [preparation];
    const expected = [...prefix, ...commands];
    let seen = 0;

    try {
      // A senha so existe dentro deste callback: descriptografada pelo broker, apos grant e validacoes, e descartada ao fim.
      // O grant e vinculado ao que sera EXECUTADO de fato (planned), nao ao que foi pedido.
      await this.broker.withCredential(
        {
          purpose: 'VSI_DIAGNOSTIC_LIVE', hostId: fresh.id, approvalId: options.approvalId, operatorId: options.operatorId,
          homologation: options.homologation === true,
          plan: { scope: options.scope as string, sequence, operations: planned.map((p) => p.operation) },
        },
        async (secret, connection) => {
          // O perfil usado no planejamento e o da conexao tem de ser o MESMO: senao nenhum byte e enviado.
          if (connection.digest !== resolved.digest) throw new SshCredentialBrokerError('IDENTITY_CHANGED');
          const sanitize = (v: string) => redactSecret(safeVsiOutput(v), secret.password);
          const client = this.clientFactory({
            // Unica origem dos parametros de conexao: o que o broker validou.
            port: connection.port,
            username: connection.username,
            password: secret.password,
            contextCommand: connection.context,
            readyTimeout: 8000,
            shellTimeoutMs: VSI_MCP_LIMITS.commandMs,
            commandIdleMs: VSI_MCP_LIMITS.commandMs,
            diagnostic: {
              fingerprint: connection.fingerprint,
              initialPrompt: profile.initialPrompt,
              expectedPrompt: profile.expectedPrompt,
              allowedCommands: commands,
              outputBytes: VSI_MCP_LIMITS.outputBytes,
              signal: controller.signal,
              sessionPreparation: preparation,
              onCommand: (command) => {
                options.signal.throwIfAborted();
                if (Date.parse(profile.expiresAt) <= Date.now()) throw new Error('PROFILE_EXPIRED');
                if (command !== expected[seen]) throw new Error('UNAUTHORIZED_COMMAND_SEQUENCE');
                // Defesa em profundidade: revalida antes de qualquer byte ir ao canal.
                if (seen >= prefix.length) safeVsiMcpCommand(planned[seen - prefix.length]!.operation);
                startedAt = Date.now();
                options.audit(command);
                seen++;
              },
              onCommandComplete: (item) => {
                if (prefix.includes(item.command)) return;
                const stdout = sanitize(item.stdout);
                const plannedItem = planned.find((p) => p.command === item.command);
                if (!plannedItem) throw new Error('UNPLANNED_COMMAND_OUTPUT');
                if (item.command === 'display version') {
                  platform = classifyHuaweiVersion(stdout);
                  if (platform.family !== profile.family) {
                    mismatch = true;
                    throw new Error('PLATFORM_MISMATCH');
                  }
                }
                captures.push({
                  operation: plannedItem.operation,
                  command: item.command,
                  stdout,
                  completedAt: item.completedAt,
                  durationMs: Date.now() - startedAt,
                  sha256: createHash('sha256').update(stdout).digest('hex'),
                  complete: isCompleteObservation(
                    { command: item.command, stdout, complete: true, completedAt: item.completedAt },
                    profile.expectedPrompt,
                  ),
                });
              },
            },
          });
          // O endpoint efetivamente usado e o da conexao validada, nunca outro.
          await client.execute(connection.endpoint, commands);
        },
      );
    } catch (error) {
      if (error instanceof SshCredentialBrokerError) throw mapBrokerError(error);
      if (error instanceof VsiMcpProfileError || error instanceof VsiMcpPolicyError) throw error;
      if (mismatch) throw new VsiMcpLiveError('PLATFORM_MISMATCH', `Familia declarada ${profile.family} difere da detectada ${platform.family}`);
      if (controller.signal.aborted) {
        const reason = String(controller.signal.reason ?? '');
        throw new VsiMcpLiveError(reason === 'PROFILE_EXPIRED' ? 'PROFILE_EXPIRED' : 'ABORTED', reason || 'Operacao abortada');
      }
      throw new VsiMcpLiveError('SSH_FAILED', error instanceof Error ? scrubSshMessage(error.message) : 'Falha SSH');
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      release();
    }

    if (captures.length !== planned.length)
      throw new VsiMcpLiveError('INCOMPLETE_CAPTURE', 'Sessao terminou sem todas as capturas planejadas');
    return { platform, prompt: profile.expectedPrompt, captures, skipped };
  }
}

/** Traduz erro do broker para o erro do coletor; so codigos e mensagens fixas, nunca dados do equipamento. */
function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof SshCredentialBrokerError)) return error;
  if (error.code === 'CREDENTIAL_UNAVAILABLE') return new VsiMcpLiveError('SSH_CREDENTIAL_UNAVAILABLE', 'Credencial SSH indisponivel');
  if (error.code === 'PROFILE_INVALID') return new VsiMcpLiveError('PROFILE_EXPIRED', error.message);
  return new VsiMcpLiveError('CREDENTIAL_ACCESS_DENIED', error.message);
}
