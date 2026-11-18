import type { MplsHostOverview, MplsPw, MplsStateEvent, MplsVsi } from '@gmj/shared';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';

export interface MplsRepository {
  saveCollection(hostId: string, collection: HuaweiVplsCollection): Promise<void>;
  /**
   * Avanca apenas o carimbo do polling. Usado na rodada em que a CLI ainda esta
   * no intervalo de cadencia: sem evidencia nova, nada de estado e sobrescrito.
   */
  touchPolling(hostId: string, occurredAt: Date): Promise<void>;
  saveFailure(hostId: string, occurredAt: Date, safeMessage: string): Promise<void>;
  getHostOverview(hostId: string): Promise<MplsHostOverview>;
  listVsis(hostId: string): Promise<MplsVsi[]>;
  listPws(hostId: string, vsiId: string): Promise<MplsPw[] | null>;
  listEvents(hostId: string, limit: number): Promise<MplsStateEvent[]>;
  /**
   * A1: habilitacao EXPLICITA do fallback CLI (SSH) para este equipamento.
   * Ausente ou `false` mantem o fallback desligado (fail-closed).
   */
  isSshFallbackEnabled?(hostId: string): Promise<boolean>;
  /** P6: caminho administrativo (sem UPDATE SQL manual). */
  setSshFallbackEnabled?(hostId: string, enabled: boolean): Promise<void>;
  /**
   * P6: orcamento de sessoes SSH COMPARTILHADO entre processos. Sem estes
   * metodos o polling usa um contador local (nao sobrevive a restart nem a
   * troca de release) — por isso o repositorio real implementa.
   */
  acquireSshLease?(
    hostId: string,
    limits: { maxConcurrentSessions: number; sessionBudgetPerHour: number; staleAfterMs: number },
  ): Promise<{ ok: true; leaseId: string } | { ok: false; denial: 'CONCURRENCY' | 'BUDGET' }>;
  releaseSshLease?(leaseId: string): Promise<void>;
  /**
   * A1-e: trilha auditavel do opt-in. Toda tentativa (autorizada ou negada)
   * entra aqui. Sem o metodo, a rota recusa a alteracao — auditar nao e
   * opcional.
   */
  recordSshFallbackAudit?(entry: {
    hostId: string;
    actorId?: string | null;
    actorUsername?: string | null;
    previousValue: boolean;
    newValue: boolean;
    result: string;
    reason?: string;
  }): Promise<void>;
  disconnect?(): Promise<void>;
}
