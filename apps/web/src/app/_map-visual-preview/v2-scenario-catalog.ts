/**
 * MAP-VISUAL-V2 — catálogo de cenários do laboratório (Fase C).
 *
 * A/B são mock sintético; C é a fixture de geometria real sanitizada. Este
 * módulo existe separado de `v2-scenarios.ts` para evitar import circular entre
 * a fixture e os helpers de cenário.
 */

import { SCENARIO_DENSE, SCENARIO_SIMPLE, type MockScenario } from './v2-scenarios';
import { SCENARIO_REAL } from './v2-fixture-real';

export const ALL_SCENARIOS: readonly MockScenario[] = [
  SCENARIO_SIMPLE,
  SCENARIO_DENSE,
  SCENARIO_REAL,
];

export function scenarioById(id: MockScenario['id']): MockScenario {
  const found = ALL_SCENARIOS.find((scenario) => scenario.id === id);
  return found ?? SCENARIO_SIMPLE;
}

export { SCENARIO_DENSE, SCENARIO_REAL, SCENARIO_SIMPLE };
