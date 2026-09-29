import type { MitigationState, SimulationResult } from './mitigation-types';

export interface MitigationHysteresisConfig {
  triggerSamples: number;
  recoverySamples: number;
}

export interface TrafficDecision {
  state: MitigationState;
  result: SimulationResult;
}

/**
 * Núcleo da máquina de estados, usado tanto pelo worker quanto pela simulação.
 *
 * A mesma regra vale nos dois caminhos: `triggerSamples` amostras consecutivas
 * acima do threshold disparam a mitigação; `recoverySamples` amostras
 * consecutivas abaixo do recovery removem a mitigação. Não há lógica paralela
 * "simplificada" para a simulação.
 */
export function evaluateTraffic(input: {
  currentlyMitigated: boolean;
  consecutiveOverThreshold: number;
  consecutiveBelowRecovery: number;
  hysteresis: MitigationHysteresisConfig;
}): TrafficDecision {
  const { currentlyMitigated, consecutiveOverThreshold, consecutiveBelowRecovery, hysteresis } = input;

  if (currentlyMitigated) {
    if (consecutiveBelowRecovery >= hysteresis.recoverySamples) {
      return { state: 'RECOVERING', result: 'WOULD_RECOVER' };
    }
    if (consecutiveBelowRecovery > 0) {
      return { state: 'RECOVERY_PENDING', result: 'NO_ACTION' };
    }
    return { state: 'MITIGATED', result: 'NO_ACTION' };
  }

  if (consecutiveOverThreshold >= hysteresis.triggerSamples) {
    return { state: 'MITIGATING', result: 'WOULD_MITIGATE' };
  }
  if (consecutiveOverThreshold > 0) {
    return { state: 'TRIGGER_PENDING', result: 'NO_ACTION' };
  }
  return { state: 'NORMAL', result: 'NO_ACTION' };
}
