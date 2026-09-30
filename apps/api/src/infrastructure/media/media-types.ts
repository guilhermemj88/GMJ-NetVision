/**
 * Camada de MIDIAS (integracoes de notificacao) do NetVision.
 *
 * O dominio (mitigacao DDoS) continua falando apenas com `NotificationPublisher`.
 * Esta camada resolve, de forma generica e configuravel, ONDE e COM QUAL SEGREDO
 * um evento e entregue. Nada aqui conhece Telegram: o transporte externo segue
 * sendo responsabilidade do n8n.
 */

export const MEDIA_INTEGRATION_TYPES = ['WEBHOOK'] as const;
export type MediaIntegrationType = (typeof MEDIA_INTEGRATION_TYPES)[number];

export const MEDIA_INTEGRATION_PURPOSES = ['BGP_MITIGATION'] as const;
export type MediaIntegrationPurpose = (typeof MEDIA_INTEGRATION_PURPOSES)[number];

export const MEDIA_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;
export type MediaDeliveryDirection = (typeof MEDIA_DIRECTIONS)[number];

export const MEDIA_DELIVERY_STATUSES = ['SUCCESS', 'FAILED', 'SKIPPED'] as const;
export type MediaDeliveryStatus = (typeof MEDIA_DELIVERY_STATUSES)[number];

/** De onde a configuracao EFETIVA veio. A UI mostra isso explicitamente. */
export const MEDIA_CONFIG_SOURCES = ['DATABASE', 'ENV', 'MEMORY', 'NONE'] as const;
export type MediaConfigSource = (typeof MEDIA_CONFIG_SOURCES)[number];

/** Status operacional derivado (nunca inventa "ONLINE"). */
export type MediaOperationalStatus =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'NEVER_TESTED'
  | 'LAST_DELIVERY_OK'
  | 'LAST_DELIVERY_FAILED';

export interface MediaIntegrationRecord {
  id: string;
  name: string;
  type: MediaIntegrationType;
  purpose: MediaIntegrationPurpose;
  enabled: boolean;
  outboundUrl: string | null;
  /** AES-256-GCM (CredentialVault). Nunca sai da API. */
  outboundSecretEncrypted: Uint8Array | null;
  inboundEnabled: boolean;
  /** AES-256-GCM (CredentialVault). Nunca sai da API. */
  inboundSecretEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
  lastOutboundAttemptAt: Date | null;
  lastOutboundSuccessAt: Date | null;
  lastOutboundFailureAt: Date | null;
  lastOutboundStatusCode: number | null;
  lastOutboundLatencyMs: number | null;
  lastOutboundEvent: string | null;
  lastOutboundErrorSafe: string | null;
  lastInboundAt: Date | null;
  lastInboundAction: string | null;
  lastInboundStatus: string | null;
  lastInboundRequestId: string | null;
  lastInboundErrorSafe: string | null;
}

export interface MediaIntegrationCreateInput {
  name: string;
  type: MediaIntegrationType;
  purpose: MediaIntegrationPurpose;
  enabled: boolean;
  outboundUrl: string | null;
  outboundSecretEncrypted: Uint8Array | null;
  inboundEnabled: boolean;
  inboundSecretEncrypted: Uint8Array | null;
}

export interface MediaIntegrationUpdateInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  outboundUrl?: string | null | undefined;
  inboundEnabled?: boolean | undefined;
  /** `undefined` = nao mexe no segredo; `null` = limpa. */
  outboundSecretEncrypted?: Uint8Array | null | undefined;
  inboundSecretEncrypted?: Uint8Array | null | undefined;
}

export interface MediaOutboundPatch {
  lastOutboundAttemptAt?: Date;
  lastOutboundSuccessAt?: Date | null;
  lastOutboundFailureAt?: Date | null;
  lastOutboundStatusCode?: number | null;
  lastOutboundLatencyMs?: number | null;
  lastOutboundEvent?: string | null;
  lastOutboundErrorSafe?: string | null;
}

export interface MediaInboundPatch {
  lastInboundAt?: Date;
  lastInboundAction?: string | null;
  lastInboundStatus?: string | null;
  lastInboundRequestId?: string | null;
  lastInboundErrorSafe?: string | null;
}

export interface MediaDeliveryLogInput {
  mediaIntegrationId: string | null;
  direction: MediaDeliveryDirection;
  event: string | null;
  action: string | null;
  profileId: string | null;
  requestId: string | null;
  status: MediaDeliveryStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  idempotent: boolean | null;
  safeError: string | null;
  /** Apenas origem (scheme://host). Nunca query string. */
  destination: string | null;
  createdAt?: Date;
}

export interface MediaDeliveryLogRecord extends MediaDeliveryLogInput {
  id: string;
  createdAt: Date;
}

export interface MediaDeliveryLogFilter {
  mediaIntegrationId?: string | undefined;
  direction?: MediaDeliveryDirection | undefined;
  limit?: number | undefined;
}

/**
 * Persistencia da camada de midias. O worker/rotas NUNCA falam com o Prisma
 * direto: dependem desta porta.
 */
export interface MediaIntegrationRepository {
  list(): Promise<MediaIntegrationRecord[]>;
  get(id: string): Promise<MediaIntegrationRecord | null>;
  findByPurpose(purpose: MediaIntegrationPurpose): Promise<MediaIntegrationRecord | null>;
  create(input: MediaIntegrationCreateInput): Promise<MediaIntegrationRecord>;
  update(id: string, input: MediaIntegrationUpdateInput): Promise<MediaIntegrationRecord>;
  recordOutbound(id: string, patch: MediaOutboundPatch): Promise<void>;
  recordInbound(id: string, patch: MediaInboundPatch): Promise<void>;
  createLog(input: MediaDeliveryLogInput): Promise<MediaDeliveryLogRecord>;
  listLogs(filter?: MediaDeliveryLogFilter): Promise<MediaDeliveryLogRecord[]>;
  /** Retencao simples: mantem apenas os `keep` logs mais recentes. */
  trimLogs(keep: number): Promise<number>;
  delete(id: string): Promise<void>;
}

/** Configuracao EFETIVA de um canal, ja resolvida (banco > ENV). */
export interface ResolvedMediaChannel {
  integrationId: string | null;
  source: MediaConfigSource;
  enabled: boolean;
  url: string | null;
  token: string | null;
}

/**
 * Payload de exibicao da API. NUNCA carrega segredo: apenas o booleano
 * "configurado" e os metadados operacionais seguros.
 */
export interface MediaIntegrationDto {
  id: string;
  name: string;
  type: MediaIntegrationType;
  purpose: MediaIntegrationPurpose;
  enabled: boolean;
  configSource: MediaConfigSource;
  status: MediaOperationalStatus;
  outboundConfigured: boolean;
  outboundUrl: string | null;
  outboundTokenConfigured: boolean;
  inboundEnabled: boolean;
  inboundConfigured: boolean;
  inboundTokenConfigured: boolean;
  /** Caminho do endpoint de entrada (sem host, sem token). */
  inboundEndpointPath: string;
  lastOutboundAttemptAt: string | null;
  lastOutboundSuccessAt: string | null;
  lastOutboundFailureAt: string | null;
  lastOutboundStatusCode: number | null;
  lastOutboundLatencyMs: number | null;
  lastOutboundEvent: string | null;
  lastOutboundErrorSafe: string | null;
  lastInboundAt: string | null;
  lastInboundAction: string | null;
  lastInboundStatus: string | null;
  lastInboundRequestId: string | null;
  lastInboundErrorSafe: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaDeliveryLogDto {
  id: string;
  direction: MediaDeliveryDirection;
  event: string | null;
  action: string | null;
  profileId: string | null;
  requestId: string | null;
  status: MediaDeliveryStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  idempotent: boolean | null;
  safeError: string | null;
  destination: string | null;
  createdAt: string;
}

export interface MediaIntegrationListDto {
  repositoryKind: 'DATABASE' | 'MEMORY';
  /** A migration da camada de midias esta aplicada? */
  migrationReady: boolean;
  legacyEnv: {
    outboundUrlConfigured: boolean;
    outboundTokenConfigured: boolean;
    inboundTokenConfigured: boolean;
    inboundEndpointPath: string;
  };
  integration: MediaIntegrationDto | null;
}
