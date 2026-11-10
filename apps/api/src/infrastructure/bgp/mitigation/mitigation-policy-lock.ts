// EXCLUSAO MUTUA POR POLICY FISICA (deviceId + policyName).
//
// Serializa TODO o ciclo de uma operacao de mitigacao que pode alterar o
// equipamento e/ou o runtime do escopo:
//   aquisicao -> leitura fresca do runtime -> preflight fisico -> escrita
//   Huawei (quando autorizada) -> read-back -> persistencia/sincronizacao dos
//   runtimes -> liberacao.
//
// LIMITE CONHECIDO (documentado de proposito): esta implementacao e EM MEMORIA
// e protege apenas UMA instancia da API. Enquanto nao existir lock distribuido,
// a operacao deve manter UMA UNICA instancia escritora (hoje: o processo
// netvision-api; o worker de mitigacao e read-only por contrato). A interface
// PolicyScopeLock permite trocar por um lock distribuido (ex.: advisory lock no
// PostgreSQL) sem reescrever a logica de mitigacao.

export interface PolicyScopeKey {
  deviceId: string;
  policyName: string;
}

/**
 * POSSE do lock durante a operacao. Um lock com prazo (transacao no PostgreSQL) pode ser
 * perdido com a operacao ainda rodando: o chamador confere a posse imediatamente antes de
 * qualquer escrita (fencing) e dimensiona o trabalho pos-escrita ao tempo que resta.
 */
export interface PolicyScopeLease {
  /** ms de posse ainda garantida; `Infinity` quando o lock nao tem prazo. */
  remainingMs(): number;
  /** Lanca `PolicyScopeLostError` quando a posse nao pode mais ser provada. */
  assertHeld(): Promise<void>;
}

export class PolicyScopeLostError extends Error {
  readonly code = 'POLICY_LOCK_LOST';

  constructor(readonly scope: PolicyScopeKey) {
    super(
      `POLICY_LOCK_LOST: a posse do lock da policy ${scope.policyName} do equipamento ` +
        `${scope.deviceId} nao pode ser provada; nenhuma escrita foi iniciada`,
    );
    this.name = 'PolicyScopeLostError';
  }
}

/** Lease de um lock sem prazo (em memoria): posse valida enquanto a operacao roda. */
export const UNBOUNDED_POLICY_LEASE: PolicyScopeLease = Object.freeze({
  remainingMs: () => Number.POSITIVE_INFINITY,
  assertHeld: async () => undefined,
});

export interface PolicyScopeLock {
  /**
   * Executa `operation` com exclusividade no escopo. Espera no maximo
   * `timeoutMs` para adquirir; sem aquisicao lanca `PolicyScopeBusyError` e a
   * operacao NAO roda (nenhuma escrita acontece). O lock e sempre liberado em
   * `finally`, inclusive quando `operation` lanca.
   */
  run<T>(scope: PolicyScopeKey, operation: (lease: PolicyScopeLease) => Promise<T>): Promise<T>;
}

export class PolicyScopeBusyError extends Error {
  readonly code = 'POLICY_BUSY';

  constructor(
    readonly scope: PolicyScopeKey,
    readonly timeoutMs: number,
  ) {
    super(
      `policy ${scope.policyName} do equipamento ${scope.deviceId} esta ocupada ` +
        `por outra operacao (espera maxima de ${timeoutMs}ms)`,
    );
    this.name = 'PolicyScopeBusyError';
  }
}

export interface InMemoryPolicyScopeLockOptions {
  /** Tempo maximo de ESPERA na fila do escopo, em ms (default 30s). */
  timeoutMs?: number;
}

/**
 * Mutex/FIFO por escopo EM MEMORIA. Scopes diferentes (inclusive mesmo
 * policyName em deviceId diferente) rodam em paralelo. Nao ha aquisicao
 * aninhada: uma operacao adquire um unico lock; aninhar o MESMO escopo
 * resultaria em espera pela propria operacao e, portanto, em `POLICY_BUSY`.
 */
export class InMemoryPolicyScopeLock implements PolicyScopeLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(options: InMemoryPolicyScopeLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async run<T>(
    scope: PolicyScopeKey,
    operation: (lease: PolicyScopeLease) => Promise<T>,
  ): Promise<T> {
    const key = `${scope.deviceId}\u0000${scope.policyName}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Nossa "fila": o proximo espera por `mine`, que so resolve no release.
    const mine = previous.then(() => gate);
    this.tails.set(key, mine);

    try {
      await this.waitForTurn(
        previous.catch(() => undefined),
        scope,
      );
    } catch (error) {
      // Desistir da FILA nao libera o escopo: o detentor atual continua rodando. A cauda so some
      // quando ele termina; apaga-la aqui deixaria o proximo chamador entrar junto com ele.
      release();
      void mine.then(() => {
        if (this.tails.get(key) === mine) this.tails.delete(key);
      });
      throw error;
    }

    try {
      return await operation(UNBOUNDED_POLICY_LEASE);
    } finally {
      release();
      if (this.tails.get(key) === mine) this.tails.delete(key);
    }
  }

  private async waitForTurn(previous: Promise<void>, scope: PolicyScopeKey): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PolicyScopeBusyError(scope, this.timeoutMs)),
            this.timeoutMs,
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
