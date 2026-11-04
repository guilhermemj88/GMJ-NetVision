import { describe, expect, it } from 'vitest';
import { AutoMitigationLifecycle, type LifecycleTarget, scopeKey } from './auto-lifecycle';
import { MemoryAutomationStore } from './automation-store';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';
import { createPilotHarness } from '../../testing/single-pilot-harness';

describe('F4: individual reconciliation views exist before the first tick', () => {
  for (const order of [
    [P.profileId, 'unknown', 'uncertain'],
    ['uncertain', 'unknown', P.profileId],
    ['unknown', P.profileId, 'uncertain'],
  ])
    it(`order ${order.join(',')} is stable across coordinator restart`, async () => {
      const h = await createPilotHarness();
      const store = new MemoryAutomationStore();
      const targets = new Map<string, LifecycleTarget>(
        order.map((id) => [
          id,
          {
            ...h.target,
            profileId: id,
            policyName: id === P.profileId ? P.policy : 'PL-' + id + '-IN',
          },
        ]),
      );
      const t = targets.get('uncertain')!;
      await store.transaction((tx) =>
        tx.put(scopeKey(t), 'scope', 'UNCERTAIN', {
          key: scopeKey(t),
          profileId: t.profileId,
          phase: 'UNCERTAIN',
          reason: 'HELD_FOR_OPERATOR',
        }),
      );
      const create = () =>
        new AutoMitigationLifecycle({
          store,
          config: () => ({ ...h.config, expansionEnabled: true, profiles: order }),
          target: async (id) => targets.get(id) ?? null,
          pilotTraffic: { sampleWithId: async () => null },
          execute: async () => {
            throw Error('NO_COMMAND_ALLOWED');
          },
          physical: async (target) => ({
            state: target.profileId === 'unknown' ? 'UNKNOWN' : 'NORMAL',
            bogon: null,
            mitigation: null,
            rt: null,
          }),
          now: h.now,
        });
      for (let restart = 0; restart < 2; restart++) {
        const lifecycle = create();
        await lifecycle.reconcile();
        expect(lifecycle.pilotStatus()).toEqual({ state: 'IDLE', reason: null });
        expect(lifecycle.expansionStatus()).toEqual({
          [P.profileId]: { state: 'IDLE', reason: null },
          unknown: { state: 'UNCERTAIN', reason: 'RESTART_PHYSICAL_STATE_UNPROVEN' },
          uncertain: { state: 'UNCERTAIN', reason: 'HELD_FOR_OPERATOR' },
        });
      }
    });
});
