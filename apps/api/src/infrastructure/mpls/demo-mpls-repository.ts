import {
  EMPTY_MPLS_SUMMARY,
  type MplsHostOverview,
  type MplsPw,
  type MplsStateEvent,
  type MplsVsi,
} from '@gmj/shared';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';
import type { MplsRepository } from './mpls-repository';

const unavailable = (): MplsHostOverview => ({
  supported: false,
  discoveryState: 'UNKNOWN',
  capabilities: { vsi: false, ac: false, pw: false },
  source: 'SNMP',
  sources: [],
  ldpPeers: [],
  l2vcCircuits: [],
  conflicts: [],
  lastPollingAt: null,
  lastSuccessAt: null,
  lastErrorSafe: null,
  summary: { ...EMPTY_MPLS_SUMMARY },
  vsis: [],
});

export class DemoMplsRepository implements MplsRepository {
  async saveCollection(_hostId: string, _collection: HuaweiVplsCollection): Promise<void> {}
  async touchPolling(_hostId: string, _occurredAt: Date): Promise<void> {}
  async saveFailure(_hostId: string, _occurredAt: Date, _safeMessage: string): Promise<void> {}
  async getHostOverview(_hostId: string): Promise<MplsHostOverview> {
    return unavailable();
  }
  async listVsis(_hostId: string): Promise<MplsVsi[]> {
    return [];
  }
  async listPws(_hostId: string, _vsiId: string): Promise<MplsPw[] | null> {
    return [];
  }
  async listEvents(_hostId: string, _limit: number): Promise<MplsStateEvent[]> {
    return [];
  }

  /** Demo nunca habilita o fallback CLI: demonstracao nao abre SSH. */
  async isSshFallbackEnabled(_hostId: string): Promise<boolean> {
    return false;
  }

  /** P6 (demo): orcamento em memoria, mesmo contrato do repositorio real. */
  private demoLeases = new Map<string, { hostId: string; startedAt: number }>();

  async setSshFallbackEnabled(_hostId: string, _enabled: boolean): Promise<void> {
    // Demo nao persiste habilitacao: o fallback continua desligado.
  }

  async recordSshFallbackAudit(_entry: {
    hostId: string;
    actorId?: string | null;
    actorUsername?: string | null;
    previousValue: boolean;
    newValue: boolean;
    result: string;
    reason?: string;
  }): Promise<void> {
    // Demo nao persiste trilha: o modo demonstrativo nao altera o opt-in.
  }

  async acquireSshLease(
    hostId: string,
    limits: { maxConcurrentSessions: number; sessionBudgetPerHour: number; staleAfterMs: number },
  ): Promise<{ ok: true; leaseId: string } | { ok: false; denial: 'CONCURRENCY' | 'BUDGET' }> {
    const now = Date.now();
    for (const [id, lease] of this.demoLeases) {
      if (now - lease.startedAt > limits.staleAfterMs) this.demoLeases.delete(id);
    }
    if (this.demoLeases.size >= limits.maxConcurrentSessions) {
      return { ok: false, denial: 'CONCURRENCY' };
    }
    const leaseId = `demo-${now}-${Math.random().toString(36).slice(2, 8)}`;
    this.demoLeases.set(leaseId, { hostId, startedAt: now });
    return { ok: true, leaseId };
  }

  async releaseSshLease(leaseId: string): Promise<void> {
    this.demoLeases.delete(leaseId);
  }
}
