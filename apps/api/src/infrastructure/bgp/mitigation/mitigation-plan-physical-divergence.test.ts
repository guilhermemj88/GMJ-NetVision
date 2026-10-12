import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  assessPolicyPhysicalState,
  MitigationPolicyReconciler,
  PolicyReconcileStaleError,
} from './mitigation-policy-reconciler';

// F2 CORRIGIDO: o reconciler avalia a POLICY INTEIRA no read-back, nunca apenas
// a ausencia do par PLANEJADO. Um par fisico diferente do plano NAO vira NORMAL;
// estrutura multipla/parcial/suspeita vira RECONCILIATION_REQUIRED; e o APPLY
// (autorizado, local) propaga o par FISICO, reparando plano x equipamento.

const DEVICE_A = 'host-f1a';
const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const RT = '268568:660';
const PAIR_A = { bogonNode: 1, mitigationNode: 2 };
const PLAN_B = { bogonNode: 3, mitigationNode: 4 };
const LABELS = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const NOW = new Date('2026-10-12T15:00:00.000Z');

function device(): HostRecord {
  return {
    id: DEVICE_A,
    hostname: DEVICE_A,
    displayName: DEVICE_A,
    name: DEVICE_A,
    sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

function renderPolicy(
  pairs: Array<{ bogonNode: number; mitigationNode: number }>,
  rt = RT,
): string {
  const lines: string[] = [];
  for (const pair of pairs) {
    lines.push(
      `route-policy ${POLICY} deny node ${pair.bogonNode}`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node ${pair.mitigationNode}`,
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${rt} additive`,
    );
  }
  lines.push(`route-policy ${POLICY} permit node 10`);
  return lines.join('\n');
}

const READ_BACK_PAIR_1_2 = renderPolicy([PAIR_A]);
const READ_BACK_EMPTY = renderPolicy([]);
const READ_BACK_TWO_PAIRS = renderPolicy([PAIR_A, PLAN_B]);
const READ_BACK_PARTIAL = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 10`,
].join('\n');

const target = (pair: { bogonNode: number; mitigationNode: number } | null) => ({
  profileId: 'perfil-1',
  addressFamily: 'IPV4',
  mitigationRt: RT,
  pair,
  runtimeState: 'MITIGATED',
});

describe('F2: assess do reconciler olha a POLICY INTEIRA', () => {
  it('S) plano 3/4 com par FISICO 1/2 ativo => MITIGATED (nunca NORMAL)', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READ_BACK_PAIR_1_2,
      labels: LABELS,
      targets: [target(PLAN_B)],
    });

    expect(assessment.state).toBe('MITIGATED');
    expect(assessment.physical.pair).toEqual(PAIR_A);
    expect(assessment.physical.bogonNodes).toEqual([1]);
    expect(assessment.physical.mitigationNodes).toEqual([2]);
  });

  it('T) plano 3/4 com equipamento VAZIO => NORMAL (ausencia fisica comprovada)', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READ_BACK_EMPTY,
      labels: LABELS,
      targets: [target(PLAN_B)],
    });

    expect(assessment.state).toBe('NORMAL');
    expect(assessment.physical.pair).toBeNull();
    expect(assessment.physical.bogonNodes).toEqual([]);
    expect(assessment.physical.mitigationNodes).toEqual([]);
  });

  it('U) DOIS pares fisicos (1/2 + 3/4) => RECONCILIATION_REQUIRED', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READ_BACK_TWO_PAIRS,
      labels: LABELS,
      targets: [target(PLAN_B)],
    });

    expect(assessment.state).toBe('RECONCILIATION_REQUIRED');
    expect(assessment.physical.pair).toBeNull();
    expect(assessment.physical.bogonNodes).toEqual([1, 3]);
    expect(assessment.physical.mitigationNodes).toEqual([2, 4]);
    expect(assessment.detail).toContain('multipla');
  });

  it('L) estrutura PARCIAL (so o bogon) => RECONCILIATION_REQUIRED', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READ_BACK_PARTIAL,
      labels: LABELS,
      targets: [target(PAIR_A)],
    });

    expect(assessment.state).toBe('RECONCILIATION_REQUIRED');
  });

  it('O) node de mitigacao com RT DIFERENTE => RECONCILIATION_REQUIRED', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: renderPolicy([PAIR_A], '268568:999'),
      labels: LABELS,
      targets: [target(PAIR_A)],
    });

    expect(assessment.state).toBe('RECONCILIATION_REQUIRED');
    expect(assessment.detail).toContain('incompativel');
  });

  it('nodes NORMAIS (RT sem prefix-list de alvos) nao sao confundidos com mitigacao', () => {
    const readBack = [
      `route-policy ${POLICY} permit node 7`,
      ' apply extcommunity rt 268568:660 additive',
      `route-policy ${POLICY} permit node 10`,
    ].join('\n');
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack,
      labels: LABELS,
      targets: [target(PLAN_B)],
    });

    expect(assessment.state).toBe('NORMAL');
  });
});

describe('F2/V/W: preview, apply local e preview STALE', () => {
  async function harness(readBackRef: { current: string }) {
    const repository = new InMemoryMitigationRepository();
    const profileIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const profile = await repository.upsertProfile({
        deviceId: DEVICE_A,
        policyName: POLICY,
        interfaceId: `if-${index + 1}`,
        addressFamily: 'IPV4',
        detectedBandwidthBps: 10_000_000_000n,
        bandwidthSource: 'DESCRIPTION',
      });
      await repository.replaceProfilePeers(profile.id, [
        { peerId: `peer-${index}`, peerAddress: `10.200.201.${20 + index}`, primary: true },
      ]);
      await repository.upsertRuntime(profile.id, {
        state: 'MITIGATED',
        plannedBogonNode: PLAN_B.bogonNode,
        plannedMitigationNode: PLAN_B.mitigationNode,
        plannedNode: PLAN_B.mitigationNode,
      });
      profileIds.push(profile.id);
    }
    const reconciler = new MitigationPolicyReconciler({
      repository,
      hosts: { getHost: async () => device() },
      readPolicy: async () => readBackRef.current,
      labels: LABELS,
      now: () => NOW,
    });
    return { repository, reconciler, profileIds, scope: { deviceId: DEVICE_A, policyName: POLICY } };
  }

  it('preview expõe physical/proposedPair e o apply propaga o par FISICO 1/2', async () => {
    const readBack = { current: READ_BACK_PAIR_1_2 };
    const h = await harness(readBack);

    const preview = await h.reconciler.preview(h.scope);

    expect(preview.state).toBe('MITIGATED');
    expect(preview.physical.pair).toEqual(PAIR_A);
    expect(preview.targets[0]?.proposedPair).toEqual(PAIR_A);
    // O plano (3/4) difere do fisico (1/2): ha mudanca a aplicar.
    expect(preview.targets[0]?.change).toBe(true);

    const applied = await h.reconciler.applyLocal(h.scope, preview.previewId);
    expect(applied.state).toBe('MITIGATED');
    expect(applied.applied).toBe(2);

    for (const profileId of h.profileIds) {
      const runtime = await h.repository.getRuntime(profileId);
      expect(runtime?.state).toBe('MITIGATED');
      // Plano reparado para o par FISICO - a divergencia deixa de existir.
      expect(runtime?.plannedBogonNode).toBe(PAIR_A.bogonNode);
      expect(runtime?.plannedMitigationNode).toBe(PAIR_A.mitigationNode);
    }
  });

  it('V) mudanca FISICA depois do preview => stale (zero escrita local)', async () => {
    const readBack = { current: READ_BACK_PAIR_1_2 };
    const h = await harness(readBack);
    const preview = await h.reconciler.preview(h.scope);
    expect(preview.state).toBe('MITIGATED');

    // O equipamento mudou (par retirado fora do NetVision).
    readBack.current = READ_BACK_EMPTY;

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    for (const profileId of h.profileIds) {
      const runtime = await h.repository.getRuntime(profileId);
      expect(runtime?.state).toBe('MITIGATED');
      expect(runtime?.plannedBogonNode).toBe(PLAN_B.bogonNode);
    }
  });

  it('W) mudanca de RUNTIME depois do preview => stale (zero escrita local)', async () => {
    const readBack = { current: READ_BACK_PAIR_1_2 };
    const h = await harness(readBack);
    const preview = await h.reconciler.preview(h.scope);

    await h.repository.upsertRuntime(h.profileIds[1]!, { state: 'RECONCILIATION_REQUIRED' });

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    expect((await h.repository.getRuntime(h.profileIds[0]!))?.state).toBe('MITIGATED');
    expect((await h.repository.getRuntime(h.profileIds[1]!))?.state).toBe(
      'RECONCILIATION_REQUIRED',
    );
  });
});
