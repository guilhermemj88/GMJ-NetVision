import { describe, expect, it } from 'vitest';
import { computeAutoStateView } from './mitigation-auto-authorization';

// AUTO-ALL: estados AUTO desejado/pronto/efetivo/bloqueado/excecao.

const BASE = {
  mode: 'ALERT_ONLY' as const,
  enabled: true,
  autoModeExempt: false,
  mitigationExcluded: false,
  bandwidthSource: 'DESCRIPTION' as const,
  effectiveBandwidthBps: 10_000_000_000n,
  snapshotAvailable: true,
  readiness: 'READY',
  plannedBogonNode: 1,
  plannedMitigationNode: 2,
};

describe('computeAutoStateView', () => {
  it('DESCRIPTION + pronto => READY (candidato); com mode AUTO => EFFECTIVE', () => {
    expect(computeAutoStateView(BASE).autoState).toBe('READY');
    const effective = computeAutoStateView({ ...BASE, mode: 'AUTO' });
    expect(effective.autoState).toBe('EFFECTIVE');
    expect(effective.autoEffective).toBe(true);
  });

  it('sem banda valida (UNKNOWN/nula/0) => OFF e nunca desejado', () => {
    for (const input of [
      { bandwidthSource: 'UNKNOWN' as const, effectiveBandwidthBps: 10_000_000_000n },
      { bandwidthSource: 'MANUAL' as const, effectiveBandwidthBps: 10_000_000_000n },
      { bandwidthSource: 'DESCRIPTION' as const, effectiveBandwidthBps: null },
      { bandwidthSource: 'DESCRIPTION' as const, effectiveBandwidthBps: 0n },
    ]) {
      const view = computeAutoStateView({ ...BASE, ...input });
      const label = `${input.bandwidthSource}/${input.effectiveBandwidthBps ?? 'null'}`;
      expect(view.autoDesired, label).toBe(false);
      expect(view.autoState).toBe('OFF');
    }
  });

  it('exclusao administrativa => OFF (nunca AUTO)', () => {
    const view = computeAutoStateView({ ...BASE, mitigationExcluded: true });
    expect(view.autoDesired).toBe(false);
    expect(view.autoState).toBe('OFF');
  });

  it('desejado mas sem snapshot/readiness/nodes => BLOCKED com motivo', () => {
    const noSnapshot = computeAutoStateView({ ...BASE, snapshotAvailable: false });
    expect(noSnapshot.autoState).toBe('BLOCKED');
    expect(noSnapshot.autoStateReason).toBe('SNAPSHOT_UNAVAILABLE');

    const notReady = computeAutoStateView({ ...BASE, readiness: 'NOT_READY' });
    expect(notReady.autoStateReason).toBe('TARGET_NOT_READY');

    const noNodes = computeAutoStateView({ ...BASE, plannedBogonNode: null });
    expect(noNodes.autoStateReason).toBe('NO_SAFE_TEMPORARY_NODE');

    const disabled = computeAutoStateView({ ...BASE, enabled: false });
    expect(disabled.autoStateReason).toBe('PROFILE_DISABLED');
  });

  it('excecao manual tem precedencia (EXEMPT) e nao e efetiva nem bloqueada', () => {
    const view = computeAutoStateView({ ...BASE, autoModeExempt: true, mode: 'AUTO' });
    expect(view.autoState).toBe('EXEMPT');
    expect(view.autoEffective).toBe(false);
  });

  it('DISABLED tem precedencia sobre tudo', () => {
    const view = computeAutoStateView({ ...BASE, mode: 'DISABLED', autoModeExempt: true });
    expect(view.autoState).toBe('DISABLED');
  });
});
