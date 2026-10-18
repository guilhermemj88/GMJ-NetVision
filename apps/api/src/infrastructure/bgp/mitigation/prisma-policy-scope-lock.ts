import type { PrismaClient } from '../../../generated/prisma/index.js';
import {
  PolicyScopeBusyError,
  type PolicyScopeKey,
  type PolicyScopeLock,
} from './mitigation-policy-lock';

/** Cross-process exclusion for API ticks and the canonical UI/n8n/AUTO policy executor. */
export class PrismaPolicyScopeLock implements PolicyScopeLock {
  constructor(
    private readonly db: PrismaClient,
    private readonly timeoutMs = 180_000,
  ) {}
  async run<T>(scope: PolicyScopeKey, operation: () => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        const key = JSON.stringify(['netvision-mitigation', scope.deviceId, scope.policyName]);
        const rows = await tx.$queryRaw<
          Array<{ acquired: boolean }>
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`;
        if (!rows[0]?.acquired) throw new PolicyScopeBusyError(scope, 0);
        return operation();
      },
      { timeout: this.timeoutMs, maxWait: 1000 },
    );
  }
}
