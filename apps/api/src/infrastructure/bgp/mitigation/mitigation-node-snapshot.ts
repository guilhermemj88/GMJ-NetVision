import { createHash } from 'node:crypto';

/**
 * Ocupacao dos DOIS nodes temporarios da mitigacao.
 *
 * Contrato definitivo: o NetVision NUNCA modifica nodes existentes da
 * route-policy do cliente. Quando um dos nodes que a mitigacao pretende usar ja
 * existe, o ACTIVATE:
 *
 *  1. le integralmente a configuracao original do node;
 *  2. persiste/valida um snapshot completo (action + if-match + apply + goto);
 *  3. identifica qual node existia e qual estava livre;
 *  4. BLOQUEIA quando a substituicao nao pode ser garantidamente segura.
 *
 * O snapshot so existe para o caso ocupado; o registro operacional de
 * ACTIVATE/REMOVE continua obrigatorio em todos os casos.
 */

export interface MitigationNodeSnapshot {
  policyName: string;
  node: number;
  action: 'permit' | 'deny';
  /** Clausulas verbatim do node (if-match / apply / goto), na ordem original. */
  clauses: string[];
  capturedAt: string;
  /** sha256 do read-back integral de onde o node foi extraido (integridade). */
  readBackSha256: string;
}

export type NodeAvailability = 'FREE' | 'OCCUPIED';

export type NodeOccupancyStatus = 'FREE_PAIR' | 'PARTIALLY_OCCUPIED' | 'FULLY_OCCUPIED';

export type NodeOccupancyBlockReason =
  | 'NONE'
  | 'NODE_OCCUPIED_REPLACEMENT_NOT_AUTHORIZED'
  | 'NODE_SNAPSHOT_INCOMPLETE';

export interface NodeOccupancyPlan {
  policyName: string;
  bogon: NodeAvailability;
  mitigation: NodeAvailability;
  status: NodeOccupancyStatus;
  /** Nodes que a mitigacao queria usar e ja existem. */
  conflictingNodes: number[];
  snapshots: MitigationNodeSnapshot[];
  blocked: boolean;
  reason: NodeOccupancyBlockReason;
}

export interface CaptureInput {
  /** Texto integral de `display current-configuration configuration route-policy`. */
  readBack: string;
  policyName: string;
  nodes: readonly number[];
  capturedAt: string;
}

export interface OccupancyInput {
  readBack: string;
  policyName: string;
  pair: { bogonNode: number; mitigationNode: number };
  capturedAt: string;
}

/** `route-policy PL-X permit node 10` (formato de configuracao). */
const POLICY_NODE_HEADER = /^route-policy[ \t]+(\S+)[ \t]+(permit|deny)[ \t]+node[ \t]+(\d+)[ \t]*$/i;
/** Clausulas relevantes dentro de um node. */
const NODE_CLAUSE = /^(if-match|apply|goto)\b/i;

function normalizeClause(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Extrai action + clausulas de UM node do texto de configuracao.
 *
 * Somente o formato de configuracao (`route-policy X permit node N`) e aceito:
 * e o formato do snapshot duravel. O formato de `display route-policy` serve ao
 * read-back pos-commit, nao ao snapshot.
 */
export function extractPolicyNode(
  readBack: string,
  policyName: string,
  node: number,
): { action: 'permit' | 'deny'; clauses: string[] } | null {
  let current: { action: 'permit' | 'deny'; clauses: string[] } | null = null;
  let found: { action: 'permit' | 'deny'; clauses: string[] } | null = null;
  const closeBlock = (): void => {
    if (current && found === null) found = current;
    current = null;
  };
  for (const raw of readBack.split(/\r?\n/)) {
    const header = POLICY_NODE_HEADER.exec(raw.trim());
    if (header) {
      closeBlock();
      current =
        header[1] === policyName && Number(header[3]) === node
          ? { action: header[2]!.toLowerCase() as 'permit' | 'deny', clauses: [] }
          : null;
      continue;
    }
    // Linha nao indentada encerra o corpo do node.
    if (raw.trim().length > 0 && !/^[ \t]/.test(raw)) {
      closeBlock();
      continue;
    }
    if (current && NODE_CLAUSE.test(raw.trim())) current.clauses.push(normalizeClause(raw));
  }
  closeBlock();
  return found;
}

/** Um snapshot e valido quando descreve fielmente um node (nunca parcial). */
export function isSnapshotComplete(snapshot: MitigationNodeSnapshot): boolean {
  return (
    typeof snapshot.policyName === 'string' &&
    snapshot.policyName.length > 0 &&
    Number.isInteger(snapshot.node) &&
    snapshot.node > 0 &&
    (snapshot.action === 'permit' || snapshot.action === 'deny') &&
    Array.isArray(snapshot.clauses) &&
    snapshot.clauses.every((clause) => typeof clause === 'string' && NODE_CLAUSE.test(clause)) &&
    typeof snapshot.capturedAt === 'string' &&
    snapshot.capturedAt.length > 0 &&
    /^[0-9a-f]{64}$/.test(snapshot.readBackSha256)
  );
}

/** Captura integral dos nodes PEDIDOS; nodes livres simplesmente nao entram. */
export function captureNodeSnapshots(input: CaptureInput): MitigationNodeSnapshot[] {
  const readBackSha256 = createHash('sha256').update(input.readBack, 'utf8').digest('hex');
  const snapshots: MitigationNodeSnapshot[] = [];
  for (const node of input.nodes) {
    const parsed = extractPolicyNode(input.readBack, input.policyName, node);
    if (!parsed) continue;
    snapshots.push({
      policyName: input.policyName,
      node,
      action: parsed.action,
      clauses: [...parsed.clauses],
      capturedAt: input.capturedAt,
      readBackSha256,
    });
  }
  return snapshots;
}

/**
 * Classifica a ocupacao do par e decide se o ACTIVATE pode seguir.
 *
 * Fail-closed: qualquer node ocupado bloqueia. Nao existe hoje procedimento de
 * substituicao autorizado, entao `blocked` permanece true mesmo com snapshot
 * completo — o snapshot existe para (a) informar o conflito e (b) permitir a
 * restauracao exata caso uma substituicao venha a ser autorizada.
 */
export function planNodeOccupancy(input: OccupancyInput): NodeOccupancyPlan {
  const bogonOccupied = extractPolicyNode(input.readBack, input.policyName, input.pair.bogonNode);
  const mitigationOccupied = extractPolicyNode(
    input.readBack,
    input.policyName,
    input.pair.mitigationNode,
  );
  const conflictingNodes = [
    ...(bogonOccupied ? [input.pair.bogonNode] : []),
    ...(mitigationOccupied ? [input.pair.mitigationNode] : []),
  ];
  const snapshots = captureNodeSnapshots({
    readBack: input.readBack,
    policyName: input.policyName,
    nodes: conflictingNodes,
    capturedAt: input.capturedAt,
  });
  const status: NodeOccupancyStatus =
    conflictingNodes.length === 0
      ? 'FREE_PAIR'
      : conflictingNodes.length === 1
        ? 'PARTIALLY_OCCUPIED'
        : 'FULLY_OCCUPIED';
  const snapshotComplete =
    snapshots.length === conflictingNodes.length && snapshots.every(isSnapshotComplete);
  const reason: NodeOccupancyBlockReason =
    conflictingNodes.length === 0
      ? 'NONE'
      : !snapshotComplete
        ? 'NODE_SNAPSHOT_INCOMPLETE'
        : 'NODE_OCCUPIED_REPLACEMENT_NOT_AUTHORIZED';
  return {
    policyName: input.policyName,
    bogon: bogonOccupied ? 'OCCUPIED' : 'FREE',
    mitigation: mitigationOccupied ? 'OCCUPIED' : 'FREE',
    status,
    conflictingNodes,
    snapshots,
    blocked: conflictingNodes.length > 0,
    reason,
  };
}

function restorePath(snapshot: MitigationNodeSnapshot): string[] {
  return [
    `route-policy ${snapshot.policyName} ${snapshot.action} node ${snapshot.node}`,
    ...snapshot.clauses.map((clause) => ` ${clause}`),
  ];
}

/** Recria o node EXATAMENTE como no snapshot (usado so no caso substituido). */
export function buildNodeRestoreCommands(snapshot: MitigationNodeSnapshot): string[] {
  if (!isSnapshotComplete(snapshot)) {
    throw new Error('MITIGATION_NODE_SNAPSHOT_INVALID: snapshot incompleto nao restaura node');
  }
  return restorePath(snapshot);
}

/**
 * Comandos de REMOVE.
 *
 *  - node criado pela mitigacao (sem snapshot) -> `undo`;
 *  - node que JA existia (com snapshot)       -> `undo` + recriacao exata.
 *
 * Nenhum outro node e tocado.
 */
export function buildSnapshotAwareRemovalCommands(
  policyName: string,
  pair: { bogonNode: number; mitigationNode: number },
  snapshots: readonly MitigationNodeSnapshot[] = [],
): string[] {
  const after = (node: number): string[] => {
    const snapshot = snapshots.find((entry) => entry.node === node);
    return snapshot ? restorePath(snapshot) : [];
  };
  return [
    'system-view',
    `undo route-policy ${policyName} node ${pair.bogonNode}`,
    ...after(pair.bogonNode),
    `undo route-policy ${policyName} node ${pair.mitigationNode}`,
    ...after(pair.mitigationNode),
    'commit',
  ];
}

/** O estado fisico do node ainda bate com o snapshot? (reconciliacao) */
export function nodeMatchesSnapshot(readBack: string, snapshot: MitigationNodeSnapshot): boolean {
  const parsed = extractPolicyNode(readBack, snapshot.policyName, snapshot.node);
  if (!parsed) return false;
  return (
    parsed.action === snapshot.action &&
    JSON.stringify([...parsed.clauses].sort()) === JSON.stringify([...snapshot.clauses].sort())
  );
}
