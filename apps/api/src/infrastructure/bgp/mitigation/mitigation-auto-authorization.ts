import type { BandwidthSource, MitigationProfileMode } from './mitigation-types';

// AUTO-ALL: estado de AUTORIZACAO do modo AUTO derivado da DESCRIPTION.
//
// A regra do operador: perfil de cliente com banda VALIDA na DESCRIPTION,
// readiness/snapshot aprovados e sem exclusao administrativa opera em AUTO.
// A DESCRIPTION e o opt-in; as verificacoes tecnicas continuam obrigatorias.
//
// Distincao pedida pela operacao (backend e UI):
//  - AUTO DESEJADO  = autorizado pela DESCRIPTION (banda) e sem exclusao;
//  - AUTO PRONTO    = verificacoes tecnicas aprovadas (snapshot/readiness/nodes);
//  - AUTO EFETIVO   = modo AUTO + pronto (motor autorizado a executar);
//  - AUTO BLOQUEADO = desejado, mas algum bloqueio tecnico impede a atuacao;
//  - EXCECAO (pin)  = operador fixou ALERT_ONLY de forma explicita.
//
// Modulo PURO: nao escreve nada; usado pelo service (DTO) e pelo sweep.

export type MitigationAutoState =
  | 'DISABLED' // modo DISABLED: fora de qualquer promocao
  | 'EXEMPT' // excecao manual (autoModeExempt): mantem ALERT_ONLY
  | 'OFF' // sem autorizacao por DESCRIPTION (sem banda valida / excluido)
  | 'BLOCKED' // autorizado, porem bloqueio tecnico (snapshot/readiness/nodes)
  | 'READY' // autorizado e pronto; candidato a promocao automatica
  | 'EFFECTIVE'; // modo AUTO + pronto: motor autorizado

export interface MitigationAutoStateInput {
  mode: MitigationProfileMode;
  enabled: boolean;
  autoModeExempt: boolean;
  mitigationExcluded: boolean;
  bandwidthSource: BandwidthSource;
  effectiveBandwidthBps: bigint | null;
  snapshotAvailable: boolean;
  readiness: string;
  /** Node BOGONS planejado do par (sem par nao existe ativacao segura). */
  plannedBogonNode: number | null | undefined;
  /** Node de mitigacao (PREFIX8to24 + RT) planejado do par. */
  plannedMitigationNode: number | null | undefined;
}

export interface MitigationAutoStateView {
  autoDesired: boolean;
  autoReady: boolean;
  autoEffective: boolean;
  autoState: MitigationAutoState;
  /** Codigo do bloqueio quando `autoState=BLOCKED` (nunca texto livre). */
  autoStateReason: string | null;
}

export function computeAutoStateView(input: MitigationAutoStateInput): MitigationAutoStateView {
  const autoDesired =
    input.bandwidthSource === 'DESCRIPTION' &&
    input.effectiveBandwidthBps !== null &&
    input.effectiveBandwidthBps > 0n &&
    !input.mitigationExcluded;

  const autoReady =
    input.enabled &&
    input.snapshotAvailable &&
    input.readiness === 'READY' &&
    input.plannedBogonNode !== null &&
    input.plannedBogonNode !== undefined &&
    input.plannedMitigationNode !== null &&
    input.plannedMitigationNode !== undefined;

  if (input.mode === 'DISABLED') {
    return {
      autoDesired,
      autoReady,
      autoEffective: false,
      autoState: 'DISABLED',
      autoStateReason: null,
    };
  }
  if (input.autoModeExempt) {
    return {
      autoDesired,
      autoReady,
      autoEffective: false,
      autoState: 'EXEMPT',
      autoStateReason: null,
    };
  }
  if (!autoDesired) {
    return {
      autoDesired,
      autoReady,
      autoEffective: false,
      autoState: 'OFF',
      autoStateReason: null,
    };
  }
  if (!autoReady) {
    return {
      autoDesired,
      autoReady,
      autoEffective: false,
      autoState: 'BLOCKED',
      autoStateReason: autoBlockReason(input),
    };
  }
  const autoEffective = input.mode === 'AUTO';
  return {
    autoDesired,
    autoReady,
    autoEffective,
    autoState: autoEffective ? 'EFFECTIVE' : 'READY',
    autoStateReason: null,
  };
}

function autoBlockReason(input: MitigationAutoStateInput): string {
  if (!input.enabled) return 'PROFILE_DISABLED';
  if (!input.snapshotAvailable) return 'SNAPSHOT_UNAVAILABLE';
  if (input.readiness !== 'READY') return 'TARGET_NOT_READY';
  return 'NO_SAFE_TEMPORARY_NODE';
}
