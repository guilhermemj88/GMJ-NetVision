import { derivePreservedClauses, type PreservedClauses } from './mitigation-policy-clauses';
import type { MitigationNode2Contract } from './mitigation-node2-contract';
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
 * TEST-ONLY: contrato do node 2 (clone estreito do node permanente do cliente) para fakes
 * de executor/preflight. O executor REAL deriva o mesmo objeto do equipamento.
 */
export function testMitigationContract(
  policyName: string,
  prefixList = 'PREFIX8to24',
  localPreference = 1100,
  baselineNode = 10,
): MitigationNode2Contract {
  return {
    version: 1,
    policyName,
    baselineNode,
    prefixList,
    localPreference,
    rt: '268568:660',
    rtMode: 'REPLACE',
    baselineRt: '268568:140',
    baselineRtAdditive: true,
    prefixListEntries: [],
  };
}

/** TEST-ONLY: node permanente do cliente elegivel ao contrato (config VRP). */
export function testPermanentClientNode(
  policyName: string,
  options: {
    node?: number;
    prefixList?: string;
    localPreference?: number;
    additive?: boolean;
  } = {},
): string[] {
  return [
    `route-policy ${policyName} permit node ${options.node ?? 10}`,
    ` if-match ip-prefix ${options.prefixList ?? 'PREFIX8to24'}`,
    ` apply local-preference ${options.localPreference ?? 1100}`,
    ` apply extcommunity rt 268568:140${options.additive === false ? '' : ' additive'}`,
  ];
}

/** TEST-ONLY: nodes 1 e 2 do contrato (config VRP) para a lista/LP do cliente. */
export function testMitigationPairNodes(
  policyName: string,
  options: { prefixList?: string; localPreference?: number } = {},
): string[] {
  return [
    `route-policy ${policyName} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${policyName} permit node 2`,
    ` if-match ip-prefix ${options.prefixList ?? 'PREFIX8to24'}`,
    ` apply local-preference ${options.localPreference ?? 1100}`,
    ' apply extcommunity rt 268568:660',
  ];
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

/**
 * TEST-ONLY: porta de verificacao fisica de um executor FALSO (fakes de `live`). Devolve PASS
 * sem evidencia - serve aos testes que nao tratam de verificacao fisica. O executor REAL nunca
 * usa isto: ele exige `readMitigationDisplays` e prova o efeito com `display`.
 */
export const testLivePhysicalPort = {
  captureMitigationEvidence: async () => null,
  verifyMitigationPhysical: async (
    _device: unknown,
    input: { customerPeers: readonly string[] },
  ) => ({
    outcome: 'PASS' as const,
    summary: 'verificacao fisica PASS (executor falso de teste)',
    checks: [],
    attempts: 1,
    elapsedMs: 0,
    mitigationPeer: null,
    eligiblePrefixes: [],
    customerPeers: [...input.customerPeers],
  }),
};
