import type { HostRecord } from '@gmj/shared';
import { isHuaweiVrpDevice } from '../bgp/bgp-vendor';

/**
 * A1 (auditoria): politica do fallback CLI (SSH) do modulo MPLS.
 *
 * `sshEnabled` no host significa apenas "existe credencial e o host aceita
 * SSH" — NAO significa "pode receber comando da CLI Huawei". Sem esta politica,
 * o polling abria sessao em qualquer equipamento com SSH habilitado (Juniper,
 * OLT, servidor) e enviava `display vsi` / `display mpls ldp ...`.
 *
 * Tres condicoes, todas obrigatorias:
 *  1. SSH configurado (host + usuario);
 *  2. plataforma Huawei VRP (nao OLT, nao Juniper, nao desconhecida);
 *  3. habilitacao EXPLICITA por equipamento (desligada por padrao).
 */
export type MplsSshDenyReason =
  | 'SSH_NOT_CONFIGURED'
  | 'PLATFORM_NOT_HUAWEI_VRP'
  | 'NOT_ENABLED_FOR_DEVICE';

export type MplsSshDecision =
  | { allowed: true; reason: 'ALLOWED' }
  | { allowed: false; reason: MplsSshDenyReason };

/**
 * Modelos Huawei que NAO sao VRP de switch/roteador: OLT (MA5600/MA5800) e
 * BRAS/CX respondem a comandos diferentes e nao devem receber CLI de MPLS.
 */
export function mplsSshPlatform(
  device: Pick<HostRecord, 'vendor' | 'model' | 'deviceType'>,
): 'HUAWEI_VRP' | 'UNSUPPORTED' {
  return isHuaweiVrpDevice(device) ? 'HUAWEI_VRP' : 'UNSUPPORTED';
}

export function hasMplsSshCredentials(
  device: Pick<HostRecord, 'sshEnabled' | 'ssh'>,
): boolean {
  return Boolean(device.sshEnabled && device.ssh?.host && device.ssh.username);
}

export async function decideMplsSsh(params: {
  device: Pick<HostRecord, 'id' | 'vendor' | 'model' | 'deviceType' | 'sshEnabled' | 'ssh'>;
  /** Habilitacao explicita por equipamento (default false em qualquer duvida). */
  isEnabledForDevice: (hostId: string) => Promise<boolean>;
}): Promise<MplsSshDecision> {
  if (!hasMplsSshCredentials(params.device)) {
    return { allowed: false, reason: 'SSH_NOT_CONFIGURED' };
  }
  if (mplsSshPlatform(params.device) !== 'HUAWEI_VRP') {
    return { allowed: false, reason: 'PLATFORM_NOT_HUAWEI_VRP' };
  }
  const enabled = await params.isEnabledForDevice(params.device.id);
  if (!enabled) return { allowed: false, reason: 'NOT_ENABLED_FOR_DEVICE' };
  return { allowed: true, reason: 'ALLOWED' };
}

export interface MplsSshGovernorLimits {
  /** Sessoes CLI simultaneas em toda a instalacao (protege as VTY). */
  maxConcurrentSessions: number;
  /** Teto de sessoes na janela de uma hora, por processo. */
  sessionBudgetPerHour: number;
  /** Tempo maximo de uma leitura CLI antes de devolver "sem evidencia". */
  sessionTimeoutMs: number;
}

export const MPLS_SSH_GOVERNOR_DEFAULTS: MplsSshGovernorLimits = {
  maxConcurrentSessions: 2,
  sessionBudgetPerHour: 12,
  sessionTimeoutMs: 45_000,
};

export type MplsSshGovernorDenial = Exclude<MplsSshDenial, 'TIMEOUT'>;

const BUDGET_WINDOW_MS = 3_600_000;

/**
 * Motivo de recusa do orcamento (inclui timeout, que tambem nao e evidencia).
 * Recusa por concorrencia, orcamento ou timeout devolve `executed: false`.
 */
export type MplsSshDenial = 'CONCURRENCY' | 'BUDGET' | 'TIMEOUT';

/**
 * P6 (2a auditoria): fonte PERSISTENTE do orcamento. Com ela o limite vale
 * entre PROCESSOS (duas instancias durante a troca de release) e sobrevive a
 * restart — o contador em memoria sozinho zerava a protecao a cada deploy.
 */
export interface MplsSshLeaseAcquirer {
  acquireSshLease(
    hostId: string,
    limits: {
      maxConcurrentSessions: number;
      sessionBudgetPerHour: number;
      staleAfterMs: number;
    },
  ): Promise<{ ok: true; leaseId: string } | { ok: false; denial: 'CONCURRENCY' | 'BUDGET' }>;
  releaseSshLease(leaseId: string): Promise<void>;
}

export interface MplsSshRunOutcome<T> {
  value: T;
  /** `true` somente quando a leitura REALMENTE rodou. */
  executed: boolean;
}

export class MplsSshGovernor {
  private active = 0;
  private readonly starts: number[] = [];
  private readonly limits: MplsSshGovernorLimits;

  constructor(
    limits: Partial<MplsSshGovernorLimits> = {},
    private readonly now: () => number = () => Date.now(),
    private readonly leases?: MplsSshLeaseAcquirer,
  ) {
    this.limits = { ...MPLS_SSH_GOVERNOR_DEFAULTS, ...limits };
  }

  get timeoutMs(): number {
    return this.limits.sessionTimeoutMs;
  }

  get activeSessions(): number {
    return this.active;
  }

  get sessionsLastHour(): number {
    this.prune(this.now());
    return this.starts.length;
  }

  private prune(now: number): void {
    while (this.starts.length > 0) {
      const oldest = this.starts[0];
      if (oldest === undefined || now - oldest < BUDGET_WINDOW_MS) return;
      this.starts.shift();
    }
  }

  /** Reserva local (usada quando NAO existe fonte persistente). */
  tryAcquire(): MplsSshGovernorDenial | null {
    const now = this.now();
    this.prune(now);
    if (this.active >= this.limits.maxConcurrentSessions) return 'CONCURRENCY';
    if (this.starts.length >= this.limits.sessionBudgetPerHour) return 'BUDGET';
    this.active += 1;
    this.starts.push(now);
    return null;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  /**
   * Executa a leitura dentro do orcamento.
   *
   * `executed` diz se houve LEITURA DE VERDADE. Recusa por concorrencia,
   * orcamento ou timeout devolve `executed: false` — e quem chama NAO pode
   * tratar isso como evidencia (era o que rebaixava FOUND_L2VC para INCOMPLETE).
   */
  async run<T>(
    hostId: string,
    task: () => Promise<T>,
    onDenied: (denial: MplsSshDenial) => T,
  ): Promise<MplsSshRunOutcome<T>> {
    let leaseId: string | null = null;
    if (this.leases) {
      let acquired: Awaited<ReturnType<MplsSshLeaseAcquirer['acquireSshLease']>>;
      try {
        acquired = await this.leases.acquireSshLease(hostId, {
          maxConcurrentSessions: this.limits.maxConcurrentSessions,
          sessionBudgetPerHour: this.limits.sessionBudgetPerHour,
          staleAfterMs: this.limits.sessionTimeoutMs * 4,
        });
      } catch {
        // Banco indisponivel: fail-closed, nao abre sessao.
        return { value: onDenied('BUDGET'), executed: false };
      }
      if (!acquired.ok) return { value: onDenied(acquired.denial), executed: false };
      leaseId = acquired.leaseId;
    } else {
      const denial = this.tryAcquire();
      if (denial !== null) return { value: onDenied(denial), executed: false };
    }

    let settled = false;
    const running = task().then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    // A vaga volta quando a sessao realmente encerra (nunca antes).
    const releaseSlot = () => {
      if (leaseId) {
        void this.leases?.releaseSshLease(leaseId).catch(() => undefined);
      } else {
        this.release();
      }
    };
    running.then(releaseSlot, releaseSlot);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onDenied('TIMEOUT')), this.limits.sessionTimeoutMs);
    });
    try {
      const value = await Promise.race([running, timeout]);
      return { value, executed: settled };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}