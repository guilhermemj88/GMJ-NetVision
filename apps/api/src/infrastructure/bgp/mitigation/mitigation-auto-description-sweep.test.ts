import { describe, expect, it } from 'vitest';
import {
  MitigationAutoDescriptionSweep,
  type AutoDescriptionSweepProfile,
} from './mitigation-auto-description-sweep';

// AUTO-ALL: sweep DESCRIPTION - idempotente, escreve SO `mode` + proveniencia.
// Cobre: flag OFF, promocao, demote, excecao, bloqueio, familia IPv4-only e
// LOTES deterministas (rollout gradual interrompivel).

function profile(overrides: Partial<AutoDescriptionSweepProfile>): AutoDescriptionSweepProfile {
  return {
    id: 'p1',
    persisted: true,
    addressFamily: 'IPV4',
    policyName: 'PL-A-IN',
    interfaceName: 'Eth-Trunk1.1',
    mode: 'ALERT_ONLY',
    autoModeExempt: false,
    promotedBySweep: false,
    autoState: 'READY',
    autoStateReason: null,
    ...overrides,
  };
}

function harness(
  profiles: AutoDescriptionSweepProfile[],
  options: {
    enabled?: boolean;
    families?: readonly ('IPV4' | 'IPV6')[];
    batchSize?: number;
  } = {},
) {
  const writes: { id: string; mode: string }[] = [];
  const provenance: { id: string; value: boolean }[] = [];
  const sweep = new MitigationAutoDescriptionSweep({
    enabled: options.enabled ?? true,
    ...(options.families ? { families: options.families } : {}),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    listProfiles: async () => profiles,
    setMode: async (id, mode) => {
      writes.push({ id, mode });
      const target = profiles.find((item) => item.id === id);
      if (target) target.mode = mode;
    },
    setProvenance: async (id, value) => {
      provenance.push({ id, value });
      const target = profiles.find((item) => item.id === id);
      if (target) target.promotedBySweep = value;
    },
  });
  return { sweep, writes, provenance };
}

describe('MitigationAutoDescriptionSweep', () => {
  it('flag OFF => no-op total (nenhuma escrita)', async () => {
    const h = harness([profile({})], { enabled: false });
    const result = await h.sweep.run();
    expect(result.enabled).toBe(false);
    expect(h.writes).toHaveLength(0);
    expect(h.provenance).toHaveLength(0);
  });

  it('READY promove ALERT_ONLY -> AUTO com proveniencia e e idempotente', async () => {
    const h = harness([profile({})]);
    const first = await h.sweep.run();
    expect(first.promoted).toEqual(['p1']);
    expect(h.writes).toEqual([{ id: 'p1', mode: 'AUTO' }]);
    expect(h.provenance).toEqual([{ id: 'p1', value: true }]);
    expect(first.promotedTotal).toBe(1);

    const second = await h.sweep.run();
    expect(second.promoted).toHaveLength(0);
    expect(second.promotedTotalBefore).toBe(1);
    expect(h.writes).toHaveLength(1);
  });

  it('OFF demove AUTO -> ALERT_ONLY e LIMPA a proveniencia', async () => {
    const h = harness([profile({ mode: 'AUTO', autoState: 'OFF', promotedBySweep: true })]);
    const result = await h.sweep.run();
    expect(result.demoted).toEqual(['p1']);
    expect(h.writes).toEqual([{ id: 'p1', mode: 'ALERT_ONLY' }]);
    expect(h.provenance).toEqual([{ id: 'p1', value: false }]);
    expect(result.promotedTotal).toBe(0);
  });

  it('EXEMPT devolve AUTO -> ALERT_ONLY (pin explicito) e limpa proveniencia', async () => {
    const h = harness([
      profile({ mode: 'AUTO', autoState: 'EXEMPT', autoModeExempt: true, promotedBySweep: true }),
    ]);
    const result = await h.sweep.run();
    expect(result.demoted).toEqual(['p1']);
    expect(result.skippedExempt).toBe(1);
    expect(h.provenance).toEqual([{ id: 'p1', value: false }]);
  });

  it('BLOCKED nao altera modo e reporta o motivo', async () => {
    const h = harness([
      profile({ id: 'p-blocked', autoState: 'BLOCKED', autoStateReason: 'SNAPSHOT_UNAVAILABLE' }),
    ]);
    const result = await h.sweep.run();
    expect(result.blocked).toEqual([
      { profileId: 'p-blocked', reason: 'SNAPSHOT_UNAVAILABLE' },
    ]);
    expect(h.writes).toHaveLength(0);
    expect(h.provenance).toHaveLength(0);
  });

  it('DISABLED e intocado; perfil nao persistido e ignorado', async () => {
    const h = harness([
      profile({ id: 'p-disabled', mode: 'DISABLED', autoState: 'DISABLED' }),
      profile({ id: 'candidate:x', persisted: false, autoState: 'READY' }),
    ]);
    const result = await h.sweep.run();
    expect(result.skippedDisabled).toBe(1);
    expect(result.evaluated).toBe(1);
    expect(h.writes).toHaveLength(0);
  });

  it('FAMILIA: IPv6 fica fora da promocao no default IPv4-only', async () => {
    const h = harness([
      profile({ id: 'p-v4' }),
      profile({ id: 'p-v6', addressFamily: 'IPV6' }),
    ]);
    const result = await h.sweep.run();
    expect(result.promoted).toEqual(['p-v4']);
    expect(result.skippedFamily).toBe(1);
    expect(h.writes).toEqual([{ id: 'p-v4', mode: 'AUTO' }]);

    // Nem sequer demove AUTO de familia fora da fase (modo preservado).
    const second = harness([
      profile({ id: 'p-v6-auto', addressFamily: 'IPV6', mode: 'AUTO', autoState: 'OFF' }),
    ]);
    const offResult = await second.sweep.run();
    expect(offResult.demoted).toEqual([]);
    expect(offResult.skippedFamily).toBe(1);
    expect(second.writes).toHaveLength(0);
  });

  it('FAMILIA: habilitando IPV4,IPV6 o IPv6 volta a ser promovido', async () => {
    const h = harness([profile({ id: 'p-v6', addressFamily: 'IPV6' })], {
      families: ['IPV4', 'IPV6'],
    });
    const result = await h.sweep.run();
    expect(result.promoted).toEqual(['p-v6']);
    expect(result.skippedFamily).toBe(0);
  });

  it('LOTES: batchSize=1 promove UM por execucao em ordem DETERMINISTICA', async () => {
    const h = harness(
      [
        profile({ id: 'p-b', policyName: 'PL-B-IN', interfaceName: 'Eth-Trunk1.2' }),
        profile({ id: 'p-a', policyName: 'PL-A-IN', interfaceName: 'Eth-Trunk1.9' }),
        profile({ id: 'p-c', policyName: 'PL-C-IN', interfaceName: 'Eth-Trunk1.1' }),
      ],
      { batchSize: 1 },
    );

    const first = await h.sweep.run();
    expect(first.promoted).toEqual(['p-a']); // PL-A antes de PL-B/PL-C
    expect(first.heldByBatch).toBe(2);
    expect(first.promotedTotal).toBe(1);

    const second = await h.sweep.run();
    expect(second.promoted).toEqual(['p-b']);
    expect(second.heldByBatch).toBe(1);

    const third = await h.sweep.run();
    expect(third.promoted).toEqual(['p-c']);
    expect(third.heldByBatch).toBe(0);
    expect(third.promotedTotal).toBe(3);

    const fourth = await h.sweep.run();
    expect(fourth.promoted).toEqual([]);
    expect(fourth.promotedTotalBefore).toBe(3);
  });

  it('LOTES: batchSize=0 = sem limite (graduacao e protecao, nao exigencia)', async () => {
    const h = harness(
      [profile({ id: 'p-1' }), profile({ id: 'p-2' }), profile({ id: 'p-3' })],
      { batchSize: 0 },
    );
    const result = await h.sweep.run();
    expect(result.promoted).toEqual(['p-1', 'p-2', 'p-3']);
    expect(result.heldByBatch).toBe(0);
  });

  it('LOTES: interromper = desligar a flag (nada e promovido nem revertido)', async () => {
    const profiles = [
      profile({ id: 'p-1', mode: 'AUTO', promotedBySweep: true }),
      profile({ id: 'p-2' }),
    ];
    const h = harness(profiles, { enabled: false, batchSize: 1 });
    const stopped = await h.sweep.run();
    expect(stopped.enabled).toBe(false);
    expect(stopped.promoted).toEqual([]);
    expect(profiles[0]!.mode).toBe('AUTO'); // promovido anterior continua AUTO
    expect(profiles[1]!.mode).toBe('ALERT_ONLY'); // proximo lote nao parte
  });
});
