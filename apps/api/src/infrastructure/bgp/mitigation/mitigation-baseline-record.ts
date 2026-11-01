import { createHash } from 'node:crypto';
import { normalizeClause, policyNodes } from './mitigation-policy-clauses';

/**
 * FINGERPRINT DURAVEL dos nodes PERMANENTES da route-policy alvo.
 *
 * B5: `baselineNodesForRemoval` (heuristica pelo read-back do momento) nao
 * distingue um node original de um node criado/alterado por terceiros DEPOIS do
 * ACTIVATE. O registro abaixo e feito ANTES da primeira escrita, fica vinculado
 * a mitigacao (device + policy + par) e e comparado no REMOVE.
 *
 * Nao e um mecanismo de rollback: ele apenas DETECTA divergencia e bloqueia a
 * retirada ate reconciliacao. Nenhum node permanente e restaurado ou alterado.
 */

export interface MitigationBaselineNodeState {
  node: number;
  action: 'permit' | 'deny';
  /** Clausulas `if-match`/`apply`/`goto` normalizadas, na ordem do texto. */
  clauses: string[];
}

export interface MitigationBaselineRecord {
  version: 1;
  deviceId: string;
  policyName: string;
  bogonNode: number;
  mitigationNode: number;
  /** Nodes PERMANENTES (tudo o que nao e o par temporario), em ordem. */
  nodes: MitigationBaselineNodeState[];
  /** sha256 do read-back integral de onde o baseline foi extraido. */
  readBackSha256: string;
  capturedAt: string;
}

export interface MitigationBaselineScope {
  deviceId: string;
  policyName: string;
}

/**
 * Armazenamento do registro. `save` e chamado ANTES da primeira escrita e
 * `load` no preflight de REMOVE; ausencia de registro nunca e tratada como
 * "configuracao atual e a original".
 */
export interface MitigationBaselineStore {
  /**
   * `true` = armazenamento PERSISTENTE (sobrevive a restart do processo).
   *
   * Escrita real no Huawei exige `durable: true`: a memoria do processo nunca e
   * aceita como fallback, porque um restart perderia o registro e o REMOVE
   * passaria a operar sobre uma configuracao nao verificada.
   */
  readonly durable: boolean;
  save(record: MitigationBaselineRecord): Promise<void>;
  load(scope: MitigationBaselineScope): Promise<MitigationBaselineRecord | null>;
}

export function baselineRecordId(scope: MitigationBaselineScope): string {
  return `mitigation-baseline:${scope.deviceId}:${scope.policyName}`;
}

export interface CaptureBaselineInput extends MitigationBaselineScope {
  readBack: string;
  bogonNode: number;
  mitigationNode: number;
  capturedAt?: string;
}

/**
 * Captura o estado dos nodes PERMANENTES. Devolve `null` quando a policy nao
 * aparece no read-back (nada a registrar, ACTIVATE bloqueia em outro check).
 */
export function captureMitigationBaseline(
  input: CaptureBaselineInput,
): MitigationBaselineRecord | null {
  const nodes = policyNodes(input.readBack, input.policyName);
  if (nodes.length === 0) return null;
  return {
    version: 1,
    deviceId: input.deviceId,
    policyName: input.policyName,
    bogonNode: input.bogonNode,
    mitigationNode: input.mitigationNode,
    nodes: nodes
      .filter((entry) => entry.node !== input.bogonNode && entry.node !== input.mitigationNode)
      .map((entry) => ({
        node: entry.node,
        action: entry.action,
        clauses: entry.clauses.map(normalizeClause),
      })),
    readBackSha256: createHash('sha256').update(input.readBack, 'utf8').digest('hex'),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

/** Um registro so vale quando descreve integralmente o que foi lido. */
export function isBaselineRecordComplete(
  record: MitigationBaselineRecord | null | undefined,
): record is MitigationBaselineRecord {
  if (!record || record.version !== 1) return false;
  if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) return false;
  if (typeof record.policyName !== 'string' || record.policyName.length === 0) return false;
  if (!Number.isInteger(record.bogonNode) || !Number.isInteger(record.mitigationNode)) return false;
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) return false;
  if (typeof record.capturedAt !== 'string' || record.capturedAt.length === 0) return false;
  if (!/^[0-9a-f]{64}$/.test(record.readBackSha256)) return false;
  return record.nodes.every(
    (entry) =>
      Number.isInteger(entry.node) &&
      (entry.action === 'permit' || entry.action === 'deny') &&
      Array.isArray(entry.clauses) &&
      entry.clauses.every((clause) => typeof clause === 'string'),
  );
}

function sameClauses(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/**
 * Divergencias entre o estado registrado no ACTIVATE e o estado FISICO atual.
 * Lista vazia = nodes permanentes identicos (unico caso em que o REMOVE segue).
 */
export function baselineDriftReasons(record: MitigationBaselineRecord, readBack: string): string[] {
  const current = policyNodes(readBack, record.policyName);
  if (current.length === 0) {
    return [`policy ${record.policyName} nao reconhecida no read-back atual`];
  }
  const permanent = current.filter(
    (entry) => entry.node !== record.bogonNode && entry.node !== record.mitigationNode,
  );
  const currentByNode = new Map(permanent.map((entry) => [entry.node, entry]));
  const recordedByNode = new Map(record.nodes.map((entry) => [entry.node, entry]));
  const reasons: string[] = [];
  for (const saved of record.nodes) {
    if (!currentByNode.has(saved.node)) {
      reasons.push(`node permanente ${saved.node} registrado no ACTIVATE nao existe mais`);
    }
  }
  for (const now of permanent) {
    const saved = recordedByNode.get(now.node);
    if (!saved) {
      reasons.push(`node ${now.node} (${now.action}) nao existia no ACTIVATE`);
      continue;
    }
    if (saved.action !== now.action) {
      reasons.push(`node ${now.node} mudou de ${saved.action} para ${now.action} desde o ACTIVATE`);
      continue;
    }
    const currentClauses = now.clauses.map(normalizeClause);
    if (!sameClauses(saved.clauses, currentClauses)) {
      reasons.push(
        `node ${now.node} foi alterado desde o ACTIVATE: ` +
          `[${saved.clauses.join(' | ')}] -> [${currentClauses.join(' | ')}]`,
      );
    }
  }
  return reasons;
}

/** Store em memoria: testes e processos sem persistencia duravel. */
export class MemoryMitigationBaselineStore implements MitigationBaselineStore {
  /** Nunca persistente: recusado pela escrita real no Huawei (B6). */
  readonly durable = false;
  private readonly records = new Map<string, MitigationBaselineRecord>();
  async save(record: MitigationBaselineRecord): Promise<void> {
    this.records.set(baselineRecordId(record), structuredClone(record));
  }
  async load(scope: MitigationBaselineScope): Promise<MitigationBaselineRecord | null> {
    const found = this.records.get(baselineRecordId(scope));
    return found ? structuredClone(found) : null;
  }
}
