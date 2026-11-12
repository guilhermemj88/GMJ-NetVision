import type { PrismaClient } from '../../../generated/prisma/index.js';
import {
  PolicyScopeBusyError,
  AUTO_TICK_LOCK_TIMEOUT_MS,
  PolicyScopeLostError,
  type PolicyScopeKey,
  type PolicyScopeLease,
  type PolicyScopeLock,
} from './mitigation-policy-lock';

/**
 * Cross-process exclusion for API ticks and the canonical UI/n8n/AUTO policy executor.
 *
 * The lock is a transaction-scoped advisory lock: it lives exactly as long as the interactive
 * transaction, which Prisma closes after `timeoutMs` EVEN IF the operation is still running.
 * The lease handed to the operation exposes that deadline and a liveness probe, so a write is
 * never started (and a long verification is never extended) past the ownership of the lock.
 */
export class PrismaPolicyScopeLock implements PolicyScopeLock {
  constructor(
    private readonly db: PrismaClient,
    private readonly timeoutMs = AUTO_TICK_LOCK_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}
  async run<T>(
    scope: PolicyScopeKey,
    operation: (lease: PolicyScopeLease) => Promise<T>,
  ): Promise<T> {
    // A transacao do lock nao grava dados: se a operacao CONCLUIU e apenas o fechamento da
    // transacao falhou (prazo expirado na cauda), o resultado ja persistido pela operacao e
    // o verdadeiro. Relancar aqui produziria um "erro" depois de um resultado registrado.
    let completed: { value: T } | null = null;
    try {
      return await this.runLocked(scope, async (lease) => {
        const value = await operation(lease);
        completed = { value };
        return value;
      });
    } catch (error) {
      const done = completed as { value: T } | null;
      if (done) return done.value;
      throw error;
    }
  }

  private runLocked<T>(
    scope: PolicyScopeKey,
    operation: (lease: PolicyScopeLease) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        const key = JSON.stringify(['netvision-mitigation', scope.deviceId, scope.policyName]);
        const rows = await tx.$queryRaw<
          Array<{ acquired: boolean }>
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`;
        if (!rows[0]?.acquired) throw new PolicyScopeBusyError(scope, 0);
        const acquiredAt = this.now();
        const remainingMs = () => this.timeoutMs - (this.now() - acquiredAt);
        const lease: PolicyScopeLease = {
          remainingMs,
          assertHeld: async () => {
            if (remainingMs() <= 0) throw new PolicyScopeLostError(scope);
            try {
              // The transaction (and with it the advisory lock) must still be open.
              await tx.$queryRaw`SELECT 1`;
            } catch {
              throw new PolicyScopeLostError(scope);
            }
          },
        };
        return operation(lease);
      },
      { timeout: this.timeoutMs, maxWait: 1000 },
    );
  }
}
