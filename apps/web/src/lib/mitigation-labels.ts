// Textos da mitigacao DDoS em portugues do Brasil.
//
// O dominio e a API falam ingles (codigos tecnicos); a traducao vive aqui, na
// apresentacao, para a UI nunca mostrar um codigo cru ao operador.

import type {
  MitigationBlockReason,
  MitigationExclusionReason,
  MitigationPrefixStatus,
  MitigationProfileMode,
  MitigationReadiness,
  MitigationRuntimeState,
  MitigationSimulationResult,
  MitigationWorkerState,
} from '@gmj/shared';

export const READINESS_LABEL: Record<MitigationReadiness, string> = {
  READY: 'APTO',
  NOT_READY: 'NÃO APTO',
};

export const RUNTIME_STATE_LABEL: Record<MitigationRuntimeState, string> = {
  DISABLED: 'DESATIVADO',
  ALERT_ONLY: 'SOMENTE ALERTA',
  NORMAL: 'NORMAL',
  TRIGGER_PENDING: 'AGUARDANDO GATILHO',
  MITIGATING: 'MITIGANDO',
  MITIGATED: 'MITIGADO',
  RECOVERY_PENDING: 'AGUARDANDO RECUPERAÇÃO',
  RECOVERING: 'RECUPERANDO',
  FAILED: 'FALHOU',
  RECONCILIATION_REQUIRED: 'REQUER REVALIDAÇÃO',
};

export const PREFIX_STATUS_LABEL: Record<MitigationPrefixStatus, string> = {
  SAFE: 'SEGURO',
  WARNING: 'ATENÇÃO',
  EXCEEDED: 'LIMITE EXCEDIDO',
  UNKNOWN: 'DESCONHECIDO',
};

export const BLOCK_REASON_LABEL: Record<MitigationBlockReason, string> = {
  NO_SAFE_TEMPORARY_NODE: 'Não existe node seguro disponível na route-policy',
  PREFIX_LIMIT_EXCEEDED: 'Quantidade de prefixos acima do limite de segurança',
  PREFIX_UNKNOWN: 'Não foi possível confirmar a quantidade de prefixos',
  BANDWIDTH_UNKNOWN: 'Banda contratada não identificada na descrição da interface',
  INTERFACE_AMBIGUOUS: 'Não foi possível identificar a interface do cliente com segurança',
  POLICY_NOT_FOUND: 'Política BGP de entrada não encontrada',
  PEER_NOT_FOUND: 'Nenhum peer BGP associado a esta política',
  SSH_DISCONNECTED: 'Sem sessão SSH ativa com o equipamento',
  READBACK_FAILED: 'Não foi possível validar a configuração atual do equipamento',
  POLICY_CHANGED: 'A política BGP mudou desde a última validação',
  SHARED_POLICY:
    'A política BGP de entrada é compartilhada com outros clientes: a mitigação atingiria todos',
  MITIGATION_EXCLUDED: 'Mitigação desativada administrativamente para este peer',
};

/** Motivos da exclusão administrativa ("nunca mitigar este peer"). */
export const EXCLUSION_REASON_LABEL: Record<MitigationExclusionReason, string> = {
  UPLINK: 'UPLINK',
  TRANSIT: 'TRANSIT',
  IX: 'IX',
  BACKBONE: 'BACKBONE',
  MANUAL: 'MANUAL',
};

export const EXCLUSION_REASON_OPTIONS: readonly MitigationExclusionReason[] = [
  'UPLINK',
  'TRANSIT',
  'IX',
  'BACKBONE',
  'MANUAL',
];

export function exclusionReasonLabel(value: MitigationExclusionReason | null | undefined): string {
  return safeLabel(EXCLUSION_REASON_LABEL, value);
}

export const WORKER_STATE_LABEL: Record<MitigationWorkerState, string> = {
  STOPPED: 'PARADO',
  DISCONNECTED: 'DESCONECTADO',
  CONNECTING: 'CONECTANDO',
  READY: 'CONECTADO',
  RECONNECTING: 'RECONECTANDO',
  FAILED: 'FALHOU',
};

export const PROFILE_MODE_LABEL: Record<MitigationProfileMode, string> = {
  DISABLED: 'DESATIVADO',
  ALERT_ONLY: 'SOMENTE ALERTA',
  AUTO: 'AUTOMÁTICO',
};

export const SIMULATION_RESULT_LABEL: Record<MitigationSimulationResult, string> = {
  WOULD_MITIGATE: 'MITIGAÇÃO SERIA ATIVADA',
  WOULD_RECOVER: 'RECUPERAÇÃO SERIA ATIVADA',
  NO_ACTION: 'NENHUMA AÇÃO SERIA NECESSÁRIA',
  BLOCKED: 'MITIGAÇÃO BLOQUEADA',
  FAILED: 'FALHA NA SIMULAÇÃO',
};

function safeLabel<T extends string>(map: Record<string, string>, key: T | null | undefined): string {
  if (!key) return '—';
  return map[key] ?? key;
}

export function readinessLabel(value: MitigationReadiness | null | undefined): string {
  return safeLabel(READINESS_LABEL, value);
}

export function runtimeStateLabel(value: MitigationRuntimeState | null | undefined): string {
  return safeLabel(RUNTIME_STATE_LABEL, value);
}

export function prefixStatusLabel(value: MitigationPrefixStatus | null | undefined): string {
  return safeLabel(PREFIX_STATUS_LABEL, value);
}

export function blockReasonLabel(value: MitigationBlockReason | null | undefined): string {
  return safeLabel(BLOCK_REASON_LABEL, value);
}

export function workerStateLabel(value: MitigationWorkerState | null | undefined): string {
  return safeLabel(WORKER_STATE_LABEL, value);
}

export function profileModeLabel(value: MitigationProfileMode | null | undefined): string {
  return safeLabel(PROFILE_MODE_LABEL, value);
}

export function simulationResultLabel(value: MitigationSimulationResult | null | undefined): string {
  return safeLabel(SIMULATION_RESULT_LABEL, value);
}

/** bps (string decimal) → "40 Gbps"; `null` → "—". Nunca inventa telemetria. */
export function formatBandwidthBps(bps: string | null | undefined): string {
  if (bps === null || bps === undefined || bps === '') return '—';
  const value = Number(bps);
  if (!Number.isFinite(value)) return '—';
  return formatGbps(value / 1_000_000_000);
}

export function formatGbps(gbps: number): string {
  if (!Number.isFinite(gbps)) return '—';
  if (gbps >= 100) return `${gbps.toFixed(0)} Gbps`;
  if (gbps >= 10) return `${gbps.toFixed(1)} Gbps`;
  return `${gbps.toFixed(2)} Gbps`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1).replace('.', ',')}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR');
}
