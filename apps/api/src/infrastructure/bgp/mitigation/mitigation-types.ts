/**
 * Tipos do motor de mitigação DDoS de clientes BGP.
 *
 * A primeira versão roda SEMPRE em `SIMULATION_ONLY`: nenhum comando é enviado
 * ao Huawei. Os estados de execução real (MITIGATING/MITIGATED/RECOVERING)
 * existem para o mesmo código ser usado pelo worker no futuro, mas nesta entrega
 * só são alcançados pelo caminho de SIMULAÇÃO (que reutiliza a mesma máquina de
 * estados e o mesmo planner, trocando apenas o executor).
 */

export const MITIGATION_MODES = ['SIMULATION_ONLY'] as const;
export type MitigationMode = (typeof MITIGATION_MODES)[number];

/** Modo de um perfil/cliente — controla o que o operador permite por cliente. */
export type MitigationProfileMode = 'DISABLED' | 'ALERT_ONLY' | 'AUTO';

export type MitigationState =
  | 'DISABLED'
  | 'ALERT_ONLY'
  | 'NORMAL'
  | 'TRIGGER_PENDING'
  | 'MITIGATING'
  | 'MITIGATED'
  | 'RECOVERY_PENDING'
  | 'RECOVERING'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

export type BandwidthSource = 'DESCRIPTION' | 'MANUAL' | 'UNKNOWN';

export type PrefixStatus = 'SAFE' | 'WARNING' | 'EXCEEDED' | 'UNKNOWN';

export type SimulationResult =
  | 'WOULD_MITIGATE'
  | 'WOULD_RECOVER'
  | 'NO_ACTION'
  | 'BLOCKED'
  | 'FAILED';

export type MitigationBlockReason =
  | 'NO_SAFE_TEMPORARY_NODE'
  | 'PREFIX_LIMIT_EXCEEDED'
  | 'PREFIX_UNKNOWN'
  | 'BANDWIDTH_UNKNOWN'
  | 'INTERFACE_AMBIGUOUS'
  | 'POLICY_NOT_FOUND'
  | 'PEER_NOT_FOUND'
  | 'SSH_DISCONNECTED'
  | 'READBACK_FAILED'
  | 'POLICY_CHANGED';

export type MitigationEngineState = 'DISABLED' | 'ONLINE' | 'RECONCILING' | 'FAILED';

export type MitigationSshState = 'DISCONNECTED' | 'CONNECTING' | 'READY';
