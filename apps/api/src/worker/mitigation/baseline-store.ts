import type {
  MitigationBaselineRecord,
  MitigationBaselineScope,
  MitigationBaselineStore,
} from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';
import {
  baselineRecordId,
  baselineReleaseMarker,
  baselineRemovalIntent,
  retainedBaseline,
  isBaselineRecordComplete,
} from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';
import type { AutomationStore } from './automation-store';

/**
 * Registro DURAVEL do baseline de mitigacao sobre `MitigationAutomationRecord`
 * (id/kind/status/payload Json) — o mesmo store ja usado pelo outbox. Nao cria
 * schema novo nem migration: o payload e o proprio registro.
 */
export class AutomationMitigationBaselineStore implements MitigationBaselineStore {
  /**
   * Persistente: o payload vive em `MitigationAutomationRecord` (PostgreSQL) e
   * sobrevive a restart — unico tipo aceito pela escrita real (B6).
   */
  readonly durable = true;

  constructor(private readonly store: AutomationStore) {}

  async save(record: MitigationBaselineRecord): Promise<void> {
    await this.store.transaction(async (tx) => {
      const old = await tx.get<{ version?: number }>(baselineRecordId(record));
      if (old?.version === 2) throw Error('MITIGATION_BASELINE_REMOVAL_PENDING');
      await tx.put(baselineRecordId(record), 'mitigation-baseline', 'ACTIVE', record);
    });
  }

  async beginRemoval(scope: MitigationBaselineScope, requestId?: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const id = baselineRecordId(scope);
      const old = await tx.get(id);
      await tx.put(
        id,
        'mitigation-baseline',
        'REMOVING',
        baselineRemovalIntent(scope, old, requestId),
      );
    });
  }

  async load(scope: MitigationBaselineScope): Promise<MitigationBaselineRecord | null> {
    return this.store.transaction(async (tx) => {
      const found = await tx.get<MitigationBaselineRecord>(baselineRecordId(scope));
      return isBaselineRecordComplete(found) ? found : null;
    });
  }

  /**
   * Sobrescreve o registro com o marcador de retirada (mesma chave, mesmo kind).
   * O status fica `RELEASED` para auditoria; `load` passa a devolver `null`
   * porque o marcador nao descreve nodes.
   */
  async release(scope: MitigationBaselineScope): Promise<void> {
    await this.store.transaction(async (tx) => {
      const old = await tx.get(baselineRecordId(scope));
      await tx.put(
        baselineRecordId(scope),
        'mitigation-baseline',
        'RELEASED',
        baselineReleaseMarker(scope, retainedBaseline(old) ?? undefined),
      );
    });
  }
}
