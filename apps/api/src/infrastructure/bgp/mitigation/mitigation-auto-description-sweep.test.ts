import { describe, expect, it } from 'vitest';
import {
  MitigationAutoDescriptionSweep,
  type AutoDescriptionSweepProfile,
} from './mitigation-auto-description-sweep';

// AUTO-ALL: sweep DESCRIPTION - idempotente, escreve SO mode, nunca runtime.

function profile(overrides: Partial<AutoDescriptionSweepProfile>): AutoDescriptionSweepProfile {
  return {
    id: 'p1',
    persisted: true,
    mode: 'ALERT_ONLY',
    autoModeExempt: false,
    autoState: 'READY',
    autoStateReason: null,
    ...overrides,
  };
}

function harness(profiles: AutoDescriptionSweepProfile[], enabled = true) {
  const writes: { id: string; mode: string }[] = [];
  const sweep = new MitigationAutoDescriptionSweep({
    enabled,
    listProfiles: async () => profiles,
    setMode: async (id, mode) => {
      writes.push({ id, mode });
      const target = profiles.find((item) => item.id === id);
      if (target) target.mode = mode;
    },
  });
  return { sweep, writes };
}

describe('MitigationAutoDescriptionSweep', () => {
  it('flag OFF => no-op total (nenhuma escrita)', async () => {
    const h = harness([profile({})], false);
    const result = await h.sweep.run();
    expect(result.enabled).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('READY promove ALERT_ONLY -> AUTO e e idempotente', async () => {
    const h = harness([profile({})]);
    const first = await h.sweep.run();
    expect(first.promoted).toEqual(['p1']);
    expect(h.writes).toEqual([{ id: 'p1', mode: 'AUTO' }]);

    const second = await h.sweep.run();
    expect(second.promoted).toHaveLength(0);
    expect(h.writes).toHaveLength(1);
  });

  it('OFF demove AUTO -> ALERT_ONLY (sem tocar mitigacao existente)', async () => {
    const h = harness([profile({ mode: 'AUTO', autoState: 'OFF' })]);
    const result = await h.sweep.run();
    expect(result.demoted).toEqual(['p1']);
    expect(h.writes).toEqual([{ id: 'p1', mode: 'ALERT_ONLY' }]);
  });

  it('EXEMPT devolve AUTO -> ALERT_ONLY (pin explicito)', async () => {
    const h = harness([profile({ mode: 'AUTO', autoState: 'EXEMPT', autoModeExempt: true })]);
    const result = await h.sweep.run();
    expect(result.demoted).toEqual(['p1']);
    expect(result.skippedExempt).toBe(1);
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
});
