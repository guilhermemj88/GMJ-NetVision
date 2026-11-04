import { derivePreservedClauses, type PreservedClauses } from './mitigation-policy-clauses';
import {
  baselineRecordId,
  baselineRemovalIntent,
  baselineReleaseMarker,
  isBaselineRecordComplete,
  retainedBaseline,
  type MitigationBaselineRecord,
  type MitigationBaselineScope,
  type MitigationBaselineStore,
} from './mitigation-baseline-record';

/**
 * TEST-ONLY: `PreservedClauses` deterministico equivalente a um cliente cujo
 * node normal e `permit node 10 if-match ip-prefix <lista autorizada>` sem
 * atributos extras.
 *
 * Existe porque o executor REAL deriva esse objeto do equipamento e o builder
 * se recusa a gerar comandos sem ele. Executores FALSOS dos testes usam este
 * helper para espelhar exatamente esse contrato — nunca para afrouxar o
 * builder.
 */
export function testPreservedClauses(
  policyName: string,
  targetPrefixList: string,
  rt: string,
): PreservedClauses {
  const text = [
    `route-policy ${policyName} permit node 10`,
    ` if-match ip-prefix ${targetPrefixList}`,
  ].join('\n');
  return derivePreservedClauses(text, policyName, targetPrefixList, rt);
}

/**
 * Backend persistente simulado (B6): as linhas ficam em JSON, como no banco.
 * Instancias INDEPENDENTES de `FakeDurableBaselineStore` sobre o mesmo backend
 * representam processos diferentes lendo o mesmo PostgreSQL.
 */
export interface FakeDurableBackend {
  readonly rows: Map<string, string>;
}

export function createFakeDurableBackend(): FakeDurableBackend {
  return { rows: new Map<string, string>() };
}

export class FakeDurableBaselineStore implements MitigationBaselineStore {
  /** Persistente por contrato: sobrevive a descarte da instancia do executor. */
  readonly durable = true;

  constructor(private readonly backend: FakeDurableBackend) {}

  async save(record: MitigationBaselineRecord): Promise<void> {
    const old = this.backend.rows.get(baselineRecordId(record));
    if (old && (JSON.parse(old) as { version?: number }).version === 2)
      throw Error('MITIGATION_BASELINE_REMOVAL_PENDING');
    this.backend.rows.set(baselineRecordId(record), JSON.stringify(record));
  }

  async load(scope: MitigationBaselineScope): Promise<MitigationBaselineRecord | null> {
    const raw = this.backend.rows.get(baselineRecordId(scope));
    const value: unknown = raw === undefined ? null : JSON.parse(raw);
    return isBaselineRecordComplete(value as MitigationBaselineRecord)
      ? (value as MitigationBaselineRecord)
      : null;
  }

  async beginRemoval(scope: MitigationBaselineScope, requestId?: string): Promise<void> {
    const id = baselineRecordId(scope);
    const raw = this.backend.rows.get(id);
    this.backend.rows.set(
      id,
      JSON.stringify(baselineRemovalIntent(scope, raw ? JSON.parse(raw) : null, requestId)),
    );
  }

  async release(scope: MitigationBaselineScope): Promise<void> {
    const id = baselineRecordId(scope);
    const raw = this.backend.rows.get(id);
    this.backend.rows.set(
      id,
      JSON.stringify(
        baselineReleaseMarker(scope, retainedBaseline(raw ? JSON.parse(raw) : null) ?? undefined),
      ),
    );
  }
}

/** Store duravel pronto para harnesses que so precisam do contrato. */
export function testDurableBaselineStore(backend = createFakeDurableBackend()) {
  return new FakeDurableBaselineStore(backend);
}
