import { describe, expect, it } from 'vitest';
import {
  buildNodeRestoreCommands,
  buildSnapshotAwareRemovalCommands,
  captureNodeSnapshots,
  extractPolicyNode,
  isSnapshotComplete,
  nodeMatchesSnapshot,
  planNodeOccupancy,
} from './mitigation-node-snapshot';

const POLICY = 'PL-AGLINK_IPv4-IN';
const NOW = '2026-11-01T12:00:00.000Z';

/** Configuracao de referencia: nodes 10 e 1000 (baseline) e mais nada. */
const BASELINE = [
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  '#',
  `route-policy ${POLICY} deny node 1000`,
  '#',
  'route-policy PL-OUTRA permit node 10',
  ' if-match ip-prefix OUTRA',
  '#',
].join('\n');

/** Outro cliente ocupando justamente o node 1 (caso B parcial). */
const NODE1_OCCUPIED = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix CLIENTE-BLOQUEADO',
  '#',
  BASELINE,
].join('\n');

/** Nodes 1 e 2 ocupados por configuracao alheia (caso B total). */
const BOTH_OCCUPIED = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix CLIENTE-BLOQUEADO',
  '#',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix OPERADOR',
  ' apply local-preference 900',
  ' apply extcommunity rt 268568:999 additive',
  '#',
  BASELINE,
].join('\n');

const pair = { bogonNode: 1, mitigationNode: 2 };
const plan = (readBack: string) =>
  planNodeOccupancy({ readBack, policyName: POLICY, pair, capturedAt: NOW });

describe('extractPolicyNode — leitura integral de um node', () => {
  it('devolve action e clausulas verbatim, ignorando outras policies', () => {
    expect(extractPolicyNode(BOTH_OCCUPIED, POLICY, 2)).toEqual({
      action: 'permit',
      clauses: [
        'if-match ip-prefix OPERADOR',
        'apply local-preference 900',
        'apply extcommunity rt 268568:999 additive',
      ],
    });
  });

  it('node deny sem clausulas e valido e nao captura o node seguinte', () => {
    expect(extractPolicyNode(BASELINE, POLICY, 1000)).toEqual({ action: 'deny', clauses: [] });
  });

  it('nao mistura policies homonimas de terceiros', () => {
    expect(extractPolicyNode(BASELINE, 'PL-OUTRA', 10)).toEqual({
      action: 'permit',
      clauses: ['if-match ip-prefix OUTRA'],
    });
  });

  it('devolve null para node inexistente', () => {
    expect(extractPolicyNode(BASELINE, POLICY, 1)).toBeNull();
  });
});

describe('CASO A — nodes 1 e 2 livres', () => {
  it('nao bloqueia e nao captura snapshot', () => {
    const result = plan(BASELINE);
    expect(result).toMatchObject({
      status: 'FREE_PAIR',
      bogon: 'FREE',
      mitigation: 'FREE',
      conflictingNodes: [],
      blocked: false,
      reason: 'NONE',
      snapshots: [],
    });
  });
});

describe('CASO B — node ocupado', () => {
  it('parcialmente ocupado: identifica o conflito e captura snapshot integral', () => {
    const result = plan(NODE1_OCCUPIED);
    expect(result).toMatchObject({
      status: 'PARTIALLY_OCCUPIED',
      bogon: 'OCCUPIED',
      mitigation: 'FREE',
      conflictingNodes: [1],
      blocked: true,
      reason: 'NODE_OCCUPIED_REPLACEMENT_NOT_AUTHORIZED',
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      policyName: POLICY,
      node: 1,
      action: 'deny',
      clauses: ['if-match ip-prefix CLIENTE-BLOQUEADO'],
      capturedAt: NOW,
    });
    expect(result.snapshots[0]!.readBackSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(isSnapshotComplete(result.snapshots[0]!)).toBe(true);
  });

  it('totalmente ocupado: dois snapshots e bloqueio', () => {
    const result = plan(BOTH_OCCUPIED);
    expect(result).toMatchObject({
      status: 'FULLY_OCCUPIED',
      bogon: 'OCCUPIED',
      mitigation: 'OCCUPIED',
      conflictingNodes: [1, 2],
      blocked: true,
    });
    expect(result.snapshots.map((s) => s.node)).toEqual([1, 2]);
    expect(result.snapshots.every(isSnapshotComplete)).toBe(true);
  });

  it('NUNCA trata ocupacao como livre — bloqueio mesmo com snapshot completo', () => {
    for (const readBack of [NODE1_OCCUPIED, BOTH_OCCUPIED]) {
      expect(plan(readBack).blocked).toBe(true);
    }
  });

  it('snapshot sem integridade nao e aceito', () => {
    const snapshot = plan(BOTH_OCCUPIED).snapshots[1]!;
    expect(isSnapshotComplete({ ...snapshot, readBackSha256: 'x' })).toBe(false);
    expect(isSnapshotComplete({ ...snapshot, clauses: ['lixo'] })).toBe(false);
    expect(() => buildNodeRestoreCommands({ ...snapshot, readBackSha256: '' })).toThrow(
      'MITIGATION_NODE_SNAPSHOT_INVALID',
    );
  });
});

describe('captureNodeSnapshots — nodes pedidos', () => {
  it('captura somente os nodes existentes entre os pedidos', () => {
    const snapshots = captureNodeSnapshots({
      readBack: NODE1_OCCUPIED,
      policyName: POLICY,
      nodes: [1, 2],
      capturedAt: NOW,
    });
    expect(snapshots.map((s) => s.node)).toEqual([1]);
  });

  it('hash de integridade e o do read-back completo', () => {
    const a = plan(BASELINE).snapshots;
    const b = plan(NODE1_OCCUPIED).snapshots;
    expect(a).toHaveLength(0);
    expect(b[0]!.readBackSha256).toHaveLength(64);
    expect(
      captureNodeSnapshots({
        readBack: BOTH_OCCUPIED,
        policyName: POLICY,
        nodes: [1, 2],
        capturedAt: NOW,
      }).every((s) => s.readBackSha256 === captureNodeSnapshots({
        readBack: BOTH_OCCUPIED,
        policyName: POLICY,
        nodes: [1],
        capturedAt: NOW,
      })[0]!.readBackSha256),
    ).toBe(true);
  });
});

describe('REMOVE — restauracao exata', () => {
  const snapshots = plan(BOTH_OCCUPIED).snapshots;

  it('node criado pela mitigacao: apenas `undo`', () => {
    expect(buildSnapshotAwareRemovalCommands(POLICY, pair, [])).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('node preexistente: `undo` + recriacao com TODAS as clausulas originais', () => {
    expect(buildSnapshotAwareRemovalCommands(POLICY, pair, snapshots)).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix CLIENTE-BLOQUEADO',
      `undo route-policy ${POLICY} node 2`,
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix OPERADOR',
      ' apply local-preference 900',
      ' apply extcommunity rt 268568:999 additive',
      'commit',
    ]);
  });

  it('restauracao reproduz o node original byte a byte (round-trip)', () => {
    const node1 = snapshots.find((s) => s.node === 1)!;
    const restored = [
      ...buildNodeRestoreCommands(node1),
      '#',
    ].join('\n');
    // Depois de restaurar, o node fisico volta a ser equivalente ao snapshot.
    expect(nodeMatchesSnapshot(restored, node1)).toBe(true);
    expect(extractPolicyNode(restored, POLICY, 1)).toEqual({
      action: 'deny',
      clauses: ['if-match ip-prefix CLIENTE-BLOQUEADO'],
    });
  });

  it('restauracao do node com varias clausulas preserva ordem e conteudo', () => {
    const node2 = snapshots.find((s) => s.node === 2)!;
    const restored = buildNodeRestoreCommands(node2).join('\n');
    expect(restored).toBe(
      [
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix OPERADOR',
        ' apply local-preference 900',
        ' apply extcommunity rt 268568:999 additive',
      ].join('\n'),
    );
    expect(nodeMatchesSnapshot(restored, node2)).toBe(true);
  });

  it('detecta divergencia fisica apos o REMOVE', () => {
    const node2 = snapshots.find((s) => s.node === 2)!;
    const diverged = buildNodeRestoreCommands(node2)
      .join('\n')
      .replace('local-preference 900', 'local-preference 100');
    expect(nodeMatchesSnapshot(diverged, node2)).toBe(false);
    // Node ausente tambem e divergencia (nunca "removido com sucesso").
    expect(nodeMatchesSnapshot(BASELINE, node2)).toBe(false);
  });

  it('snapshots de nodes que a mitigacao nao toca nao entram na retirada', () => {
    const commands = buildSnapshotAwareRemovalCommands(POLICY, pair, [
      { ...snapshots[0]!, node: 10 },
    ]);
    expect(commands.join('\n')).not.toMatch(/node 10\b/);
  });
});
