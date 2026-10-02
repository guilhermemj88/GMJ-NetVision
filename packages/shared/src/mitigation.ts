// Tipos compartilhados da mitigacao DDoS (SIMULATION_ONLY).
//
// Codigos tecnicos em ingles (contrato entre API e UI); a traducao para
// portugues do Brasil vive na camada de apresentacao.

export type MitigationReadiness = 'READY' | 'NOT_READY';

export type MitigationRuntimeState =
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

export type MitigationPrefixStatus = 'SAFE' | 'WARNING' | 'EXCEEDED' | 'UNKNOWN';

/** Modo GLOBAL do motor: default fail-closed em SIMULATION_ONLY. */
export type MitigationMode = 'SIMULATION_ONLY' | 'AUTO';

/** Familia do alvo: IPv4 e IPv6 sao targets independentes. */
export type MitigationAddressFamily = 'IPV4' | 'IPV6';

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
  | 'POLICY_CHANGED'
  /** A policy IN e compartilhada por outros targets: a mitigacao atinge todos. */
  | 'SHARED_POLICY'
  /**
   * Exclusao administrativa: o target esta tecnicamente apto (readiness READY),
   * mas o operador marcou "nunca mitigar este peer". Bloqueia NOVO ACTIVATE;
   * NAO bloqueia REMOVE de uma mitigacao ja ativa.
   */
  | 'MITIGATION_EXCLUDED'
  /**
   * Exclusao PREVENTIVA do peer ("nunca mitigar este peer"): vale mesmo sem
   * profile para o peer. Bloqueia NOVO ACTIVATE; REMOVE segue permitido.
   */
  | 'PEER_MITIGATION_EXCLUDED';

/** Motivo da exclusao administrativa da mitigacao (por target/peer). */
export type MitigationExclusionReason = 'UPLINK' | 'TRANSIT' | 'IX' | 'BACKBONE' | 'MANUAL';

/** Outro target (interface + familia) que usa a mesma policy IN. */
export interface BgpMitigationSharedTargetDto {
  interfaceId: string | null;
  interfaceName: string | null;
  customer: string | null;
  peerAddress: string;
  addressFamily: MitigationAddressFamily;
  prefixCount: number | null;
  prefixStatus: MitigationPrefixStatus;
}

export type MitigationProfileMode = 'DISABLED' | 'ALERT_ONLY' | 'AUTO';

export type MitigationWorkerState =
  | 'STOPPED'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'READY'
  | 'RECONNECTING'
  | 'FAILED';

export type MitigationSimulationResult =
  | 'WOULD_MITIGATE'
  | 'WOULD_RECOVER'
  | 'NO_ACTION'
  | 'BLOCKED'
  | 'FAILED';

/** Linha de leitura do cliente DDoS (persistida ou candidata do discovery). */
export interface BgpMitigationProfileDto {
  /** Id persistido; candidatos sem policy usam um id sintetico `candidate:*`. */
  id: string;
  persisted: boolean;
  customer: string | null;
  deviceId: string;
  deviceName: string;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceDescription: string | null;
  /** BigInt sempre como string decimal. */
  detectedBandwidthBps: string | null;
  bandwidthOverrideBps: string | null;
  effectiveBandwidthBps: string | null;
  policyName: string | null;
  /** Familia do alvo (IPv4 e IPv6 sao targets distintos). */
  addressFamily: MitigationAddressFamily;
  /** A policy IN deste target e usada por outro target/interface. */
  sharedPolicy: boolean;
  /** Os OUTROS targets que usam a mesma policy IN. */
  sharedPolicyTargets: BgpMitigationSharedTargetDto[];
  /** Bloqueio preventivo da automacao futura (hoje: SHARED_POLICY). */
  autoBlockedReason: MitigationBlockReason | null;
  peerAddresses: string[];
  primaryPeerAddress: string | null;
  prefixCount: number | null;
  prefixLimit: number;
  prefixStatus: MitigationPrefixStatus;
  existingNodes: number[];
  mitigationNodes: number[];
  /** Nodes de DENY que ja sao o BOGONS (deny + if-match da prefix-list). */
  bogonNodes?: number[];
  /** Prefix-list do node de DENY. */
  bogonPrefixList?: string;
  /** Prefix-list do node que aplica a RT. */
  targetPrefixList?: string;
  /** Node BOGONS planejado (par). */
  plannedBogonNode?: number | null;
  /** Node de mitigacao planejado (par) = plannedNode. */
  plannedMitigationNode?: number | null;
  plannedNode: number | null;
  readiness: MitigationReadiness;
  blockedReason: MitigationBlockReason | null;
  /**
   * Ha snapshot de discovery NESTA sessao para este target. `false` = cache em
   * memoria vazio (pos-restart, antes da reidratacao): readiness/prefixos NAO
   * sao avaliacao real e o motor AUTO fica fail-closed (SNAPSHOT_UNAVAILABLE).
   */
  snapshotAvailable: boolean;
  /**
   * Exclusao administrativa ("nunca mitigar este peer"). Independente de
   * `readiness`: READY + excluded=true = apto tecnicamente, proibido de mitigar.
   */
  mitigationExcluded?: boolean;
  mitigationExclusionReason?: MitigationExclusionReason | null;
  mitigationExclusionNote?: string | null;
  runtimeState: MitigationRuntimeState | null;
  mode: MitigationProfileMode;
  enabled: boolean;
  mitigationRt: string;
  lastDiscoveryAt: string | null;
}

/** Decisão do motor AUTO exposta no health (sem segredos). */
export interface MitigationAutoDecisionDto {
  at: string;
  profileId: string;
  deviceId: string;
  customer: string | null;
  outcome: string;
  reason: string | null;
  trafficBps: string | null;
  thresholdBps: string | null;
  runtimeState: string | null;
  commandStatus: string | null;
  verified: boolean;
  detail: string | null;
}

/** Estado do runtime do motor AUTO no processo da API. */
export interface MitigationAutoRuntimeDto {
  state: 'OFF' | 'RUNNING' | 'STOPPED';
  evaluationIntervalMs: number;
  startedAt: string | null;
  lastTickAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastError: string | null;
  lastDecision: MitigationAutoDecisionDto | null;
  /** Decisao mais recente de cada profile avaliado (dry run). */
  decisions?: MitigationAutoDecisionDto[];
  lastAutoActivateAt: string | null;
  lastAutoActivateProfileId: string | null;
}

export interface BgpMitigationHealthDto {
  mode: MitigationMode;
  worker: { state: MitigationWorkerState };
  migrationReady: boolean;
  databaseReady: boolean;
  repository: 'DATABASE' | 'MEMORY';
  lastDiscoveryAt: string | null;
  mitigationRt: string;
  prefixLimit: number;
  /** Camada de execução efetiva (fail-closed). */
  executor?: 'MOCK' | 'HUAWEI';
  liveWriteEnabled?: boolean;
  allowedDeviceCount?: number;
  /** Reidratação dos snapshots de discovery após restart (PENDING/RUNNING/READY/DEGRADED). */
  snapshotHydration?: {
    state: 'PENDING' | 'RUNNING' | 'READY' | 'DEGRADED';
    startedAt: string | null;
    completedAt: string | null;
    devicesTotal: number;
    devicesSucceeded: number;
    devicesFailed: number;
    lastError: string | null;
  } | null;
  /** Estado do motor AUTO (ausente quando nunca avaliado). */
  autoEngine?: MitigationAutoRuntimeDto | null;
  profiles?: { total: number; auto: number; alertOnly: number; disabled: number };
}

export interface BgpMitigationDiscoveryDeviceDto {
  deviceId: string;
  deviceName: string;
  scannedPeers: number;
  candidateInterfaces: number;
  ignoredNoBandwidth: number;
  createdProfiles: number;
  updatedProfiles: number;
  blockedProfiles: number;
  outOfScopeProfiles: string[];
  ambiguousPeers: string[];
  warnings: string[];
}

export interface BgpMitigationDiscoveryTotalsDto {
  devices: number;
  scannedPeers: number;
  candidateInterfaces: number;
  ignoredNoBandwidth: number;
  createdProfiles: number;
  updatedProfiles: number;
  blockedProfiles: number;
}

export interface BgpMitigationDiscoveryResponseDto {
  results: BgpMitigationDiscoveryDeviceDto[];
  totals: BgpMitigationDiscoveryTotalsDto;
  /** Todas as linhas (persistidas e candidatas) para a tabela da UI. */
  profiles: BgpMitigationProfileDto[];
  warnings: string[];
  discoveredAt: string;
  /** Espelho do unico device, quando a descoberta foi de um so equipamento. */
  deviceId: string | null;
  scannedPeers: number;
  candidateInterfaces: number;
  ignoredNoBandwidth: number;
  createdProfiles: number;
  updatedProfiles: number;
  blockedProfiles: number;
  outOfScopeProfiles: string[];
  ambiguousPeers: string[];
}

export interface BgpMitigationPatchInput {
  /** Aceita apenas override administrativo. BigInt como string decimal. */
  bandwidthOverrideBps?: string | null;
  enabled?: boolean;
  mode?: MitigationProfileMode;
}

export interface BgpMitigationSimulateInput {
  simulatedTrafficBps: string;
  samples: number;
  simulatedPrefixCount?: number | null;
}

export interface BgpMitigationSimulationDto {
  id: string | null;
  persisted: boolean;
  profileId: string;
  customer: string | null;
  deviceName: string;
  interfaceName: string | null;
  policyName: string;
  result: MitigationSimulationResult;
  blockedReason: MitigationBlockReason | null;
  simulatedTrafficBps: string;
  effectiveBandwidthBps: string | null;
  utilizationPercent: number | null;
  thresholdBps: string | null;
  thresholdPercent: number;
  recoveryThresholdBps: string | null;
  recoveryPercent: number;
  samples: number;
  requiredSamples: number;
  prefixCount: number | null;
  prefixLimit: number;
  prefixStatus: MitigationPrefixStatus;
  plannedNode: number | null;
  /** Par planejado do node de mitigacao. */
  plannedBogonNode?: number | null;
  plannedMitigationNode?: number | null;
  bogonPrefixList?: string;
  targetPrefixList?: string;
  mitigationRt: string;
  affectedPeers: string[];
  /** Todos os peers que a policy afeta de fato (inclui os de outros targets). */
  affectedPolicyPeers: string[];
  affectedPolicyPeerCount: number;
  sharedPolicy: boolean;
  sharedPolicyTargets: BgpMitigationSharedTargetDto[];
  primaryPeerAddress: string | null;
  /** Apenas texto; a UI nunca ganha endpoint para executar isto. */
  commandPreview: string[];
  createdAt: string;
}

export interface BgpMitigationSimulationRowDto {
  id: string;
  profileId: string;
  policyName: string | null;
  result: MitigationSimulationResult;
  simulatedTrafficBps: string | null;
  simulatedUtilizationPercent: number | null;
  plannedNode: number | null;
  createdAt: string;
}

export interface BgpMitigationEventDto {
  id: string;
  profileId: string;
  simulationId: string | null;
  type: string;
  previousState: string | null;
  newState: string | null;
  trafficBps: string | null;
  thresholdBps: string | null;
  plannedNode: number | null;
  policyName: string | null;
  success: boolean;
  verified: boolean;
  safeError: string | null;
  createdAt: string;
}
