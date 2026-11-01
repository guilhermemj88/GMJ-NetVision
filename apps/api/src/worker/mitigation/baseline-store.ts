import type {
  MitigationBaselineRecord,
  MitigationBaselineScope,
  MitigationBaselineStore,
} from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';
import { baselineRecordId } from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';
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
      await tx.put(baselineRecordId(record), 'mitigation-baseline', 'ACTIVE', record);
    });
  }

  async load(scope: MitigationBaselineScope): Promise<MitigationBaselineRecord | null> {
    return this.store.transaction(async (tx) =>
      tx.get<MitigationBaselineRecord>(baselineRecordId(scope)),
    );
  }
}
