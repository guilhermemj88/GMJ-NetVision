import type {
  MediaConfigSource,
  MediaDeliveryDirection,
  MediaDeliveryLogDto,
  MediaDeliveryLogRecord,
  MediaIntegrationDto,
  MediaIntegrationListDto,
  MediaIntegrationPurpose,
  MediaIntegrationRecord,
  MediaIntegrationRepository,
  MediaIntegrationType,
  MediaOperationalStatus,
  ResolvedMediaChannel,
} from './media-types';
import type { NetworkAlarmTestSelectionInput } from '@gmj/shared';
import { isChartableAlarmType, resolveNetworkAlarmTestSelection } from '@gmj/shared';
import type { AlarmChartSource } from './alarm-chart-snapshot';
import {
  generateIntegrationToken,
  safeDestination,
  secretsEqual,
  type MediaSecretBox,
} from './media-secret-box';
import type {
  MediaChannelPort,
  MediaDeliveryOutcome,
  N8nMediaTransport,
} from './n8n-media-transport';

export const N8N_INBOUND_ENDPOINT_PATH = '/api/integrations/n8n/mitigation-command';
export const MEDIA_LOG_RETENTION = 200;

export interface MediaEnvBootstrap {
  outboundUrl: string | null;
  outboundToken: string | null;
  inboundToken: string | null;
}

export interface MediaIntegrationServiceDeps {
  repository: MediaIntegrationRepository;
  secretBox: MediaSecretBox;
  repositoryKind: 'DATABASE' | 'MEMORY';
  /** A migration da Fase 9 esta aplicada? */
  migrationReady: () => Promise<boolean>;
  env: MediaEnvBootstrap;
  /**
   * Inventario READ-ONLY para o grafico do TESTAR ALARME: valida a interface de
   * referencia e informa as lanes conhecidas. Ausente em montagens de teste, o
   * caminho com grafico devolve erro seguro.
   */
  chartSource?: MediaChartSourcePort | undefined;
  now?: () => Date;
  logRetention?: number;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Leitura do inventario usada SO para montar o grafico de teste. */
export interface MediaChartSourcePort {
  resolveChartSource(interfaceId: string): Promise<AlarmChartSource | null>;
}

/** Porta do transporte de alarmes usada apenas pelo TESTAR ALARME (F9.5). */
export interface MediaAlarmTestPort {
  publishAlarmTest(
    input?: {
      profileId?: string | null;
      includeChart?: boolean;
      chartSource?: AlarmChartSource | null;
    } & NetworkAlarmTestSelectionInput,
  ): Promise<MediaDeliveryOutcome>;
}

export interface CreateMediaIntegrationInput {
  name: string;
  type?: MediaIntegrationType | undefined;
  purpose: MediaIntegrationPurpose;
  enabled?: boolean | undefined;
  outboundUrl?: string | null | undefined;
  outboundToken?: string | null | undefined;
  inboundEnabled?: boolean | undefined;
  /** Importa URL/token do ENV legado no momento da criacao. */
  importFromEnv?: boolean | undefined;
}

export interface UpdateMediaIntegrationInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  outboundUrl?: string | null | undefined;
  outboundToken?: string | null | undefined;
  inboundEnabled?: boolean | undefined;
  /** `true` limpa o token de saida salvo. */
  clearOutboundToken?: boolean | undefined;
}

/**
 * SERVICO da camada de midias.
 *
 * Concentra cadastro, resolucao de configuracao (banco > ENV), rotacao de
 * token, log operacional e o teste de webhook. Nenhum segredo em texto claro
 * cruza esta fronteira depois de salvo.
 */
export class MediaIntegrationService implements MediaChannelPort {
  private readonly now: () => Date;
  private readonly logRetention: number;
  private transport: N8nMediaTransport | null = null;
  private alarmTransport: MediaAlarmTestPort | null = null;

  constructor(private readonly deps: MediaIntegrationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logRetention = deps.logRetention ?? MEDIA_LOG_RETENTION;
  }

  /** Ligacao tardia: o transporte depende deste servico para resolver canais. */
  attachTransport(transport: N8nMediaTransport): void {
    this.transport = transport;
  }

  /**
   * Ligacao tardia do transporte de ALARMES, usado apenas pelo TESTAR ALARME.
   * Mantem a serializacao canonica do alarme (nao existe payload paralelo).
   */
  attachAlarmTransport(transport: MediaAlarmTestPort): void {
    this.alarmTransport = transport;
  }

  // ---- leitura / cadastro -------------------------------------------------

  async overview(purpose: MediaIntegrationPurpose = 'BGP_MITIGATION'): Promise<MediaIntegrationListDto> {
    const migrationReady = await this.isMigrationReady();
    const integration = await this.read(() => this.deps.repository.findByPurpose(purpose), null);
    const channel = await this.resolveOutbound(purpose);
    return {
      repositoryKind: this.deps.repositoryKind,
      migrationReady,
      resolvedPurpose: channel.enabled ? channel.resolvedPurpose ?? purpose : null,
      legacyEnv: {
        outboundUrlConfigured: Boolean(this.deps.env.outboundUrl),
        outboundTokenConfigured: Boolean(this.deps.env.outboundToken),
        inboundTokenConfigured: Boolean(this.deps.env.inboundToken),
        inboundEndpointPath: N8N_INBOUND_ENDPOINT_PATH,
      },
      integration: integration ? await this.toDto(integration) : null,
    };
  }

  async get(id: string): Promise<MediaIntegrationDto | null> {
    const integration = await this.read(() => this.deps.repository.get(id), null);
    return integration ? await this.toDto(integration) : null;
  }

  async create(input: CreateMediaIntegrationInput): Promise<MediaIntegrationDto> {
    this.assertSecretsAvailable(input.outboundToken ?? null);
    const imported = input.importFromEnv
      ? { url: this.deps.env.outboundUrl, token: this.deps.env.outboundToken }
      : { url: null, token: null };
    const outboundUrl = input.outboundUrl === undefined ? imported.url : input.outboundUrl;
    const outboundToken =
      input.outboundToken === undefined || input.outboundToken === null
        ? input.importFromEnv
          ? imported.token
          : null
        : input.outboundToken;

    const existing = await this.read(
      () => this.deps.repository.findByPurpose(input.purpose),
      null,
    );
    const payload = {
      name: input.name,
      type: input.type ?? ('WEBHOOK' as MediaIntegrationType),
      purpose: input.purpose,
      enabled: input.enabled ?? true,
      outboundUrl: outboundUrl ?? null,
      outboundSecretEncrypted: outboundToken ? this.deps.secretBox.encrypt(outboundToken) : null,
      inboundEnabled: input.inboundEnabled ?? false,
      inboundSecretEncrypted: null,
    };

    const record = existing
      ? await this.deps.repository.update(existing.id, {
          name: payload.name,
          enabled: payload.enabled,
          outboundUrl: payload.outboundUrl,
          outboundSecretEncrypted:
            outboundToken === null ? undefined : payload.outboundSecretEncrypted,
          inboundEnabled: payload.inboundEnabled,
        })
      : await this.deps.repository.create(payload);
    return await this.toDto(record);
  }

  async update(id: string, input: UpdateMediaIntegrationInput): Promise<MediaIntegrationDto> {
    this.assertSecretsAvailable(input.outboundToken ?? null);
    const record = await this.deps.repository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.outboundUrl === undefined ? {} : { outboundUrl: input.outboundUrl ?? null }),
      ...(input.inboundEnabled === undefined ? {} : { inboundEnabled: input.inboundEnabled }),
      ...(input.outboundToken === undefined || input.outboundToken === null
        ? {}
        : { outboundSecretEncrypted: this.deps.secretBox.encrypt(input.outboundToken) }),
      ...(input.clearOutboundToken ? { outboundSecretEncrypted: null } : {}),
    });
    return await this.toDto(record);
  }

  /** SALVAR TOKEN (outbound): substitui o anterior; nunca reexibe. */
  async setOutboundToken(id: string, token: string): Promise<MediaIntegrationDto> {
    this.assertSecretsAvailable(token);
    const record = await this.deps.repository.update(id, {
      outboundSecretEncrypted: this.deps.secretBox.encrypt(token),
    });
    return await this.toDto(record);
  }

  /**
   * GERAR NOVO TOKEN (inbound). O valor em texto claro sai UMA unica vez,
   * neste retorno. Depois disso a API so informa `inboundTokenConfigured`.
   */
  async rotateInboundToken(id: string): Promise<{ token: string; integration: MediaIntegrationDto }> {
    this.assertSecretsAvailable('token');
    const token = generateIntegrationToken();
    const record = await this.deps.repository.update(id, {
      inboundEnabled: true,
      inboundSecretEncrypted: this.deps.secretBox.encrypt(token),
    });
    return { token, integration: await this.toDto(record) };
  }

  async enableInbound(id: string, enabled: boolean): Promise<MediaIntegrationDto> {
    const record = await this.deps.repository.update(id, { inboundEnabled: enabled });
    return await this.toDto(record);
  }

  // ---- resolucao de configuracao (banco > ENV da mitigacao) ---------------

  /**
   * Resolve o canal OUTBOUND do purpose pedido.
   *
   * F9.5: NADA de fallback cruzado. `NETWORK_ALARMS` resolve SOMENTE a
   * integracao `NETWORK_ALARMS`; `BGP_MITIGATION` resolve SOMENTE a integracao
   * `BGP_MITIGATION` e, sem ela, o ENV legado da mitigacao. O ENV legado e
   * exclusivo da mitigacao: alarmes nunca caem nele.
   */
  async resolveOutbound(
    purpose: MediaIntegrationPurpose = 'BGP_MITIGATION',
  ): Promise<ResolvedMediaChannel> {
    const integration = await this.read(() => this.deps.repository.findByPurpose(purpose), null);
    const source = await this.sourceLabel();
    if (integration && integration.enabled && integration.outboundUrl) {
      return {
        integrationId: integration.id,
        source,
        enabled: true,
        url: integration.outboundUrl,
        token: this.deps.secretBox.decrypt(integration.outboundSecretEncrypted),
        resolvedPurpose: purpose,
      };
    }
    const envOutboundUrl = purpose === 'BGP_MITIGATION' ? this.deps.env.outboundUrl : null;
    if (envOutboundUrl) {
      return {
        integrationId: integration?.id ?? null,
        source: 'ENV',
        enabled: true,
        url: envOutboundUrl,
        token: this.deps.env.outboundToken,
        resolvedPurpose: purpose,
      };
    }
    return {
      integrationId: integration?.id ?? null,
      source: integration ? source : 'NONE',
      enabled: false,
      url: null,
      token: null,
      resolvedPurpose: purpose,
    };
  }

  /**
   * Token esperado no INBOUND: o persistido (quando existe e o inbound esta
   * ligado) vence o ENV legado.
   */
  async resolveInboundToken(): Promise<{
    token: string | null;
    source: MediaConfigSource;
    integrationId: string | null;
  }> {
    const integration = await this.read(
      () => this.deps.repository.findByPurpose('BGP_MITIGATION'),
      null,
    );
    const persisted = integration?.inboundEnabled
      ? this.deps.secretBox.decrypt(integration.inboundSecretEncrypted)
      : null;
    if (persisted) {
      return {
        token: persisted,
        source: await this.sourceLabel(),
        integrationId: integration?.id ?? null,
      };
    }
    if (this.deps.env.inboundToken) {
      return { token: this.deps.env.inboundToken, source: 'ENV', integrationId: integration?.id ?? null };
    }
    return { token: null, source: 'NONE', integrationId: integration?.id ?? null };
  }

  /** Validacao do bearer recebido: tempo constante, sem vazar o secret. */
  async validatesInboundToken(candidate: string): Promise<{ valid: boolean; integrationId: string | null }> {
    const { token, integrationId } = await this.resolveInboundToken();
    if (!token) return { valid: false, integrationId };
    return { valid: secretsEqual(candidate, token), integrationId };
  }

  // ---- log operacional ----------------------------------------------------

  async recordOutboundAttempt(input: {
    integrationId: string | null;
    event: string;
    profileId: string | null;
    requestId: string | null;
    destination: string | null;
  }): Promise<void> {
    const at = this.now();
    if (input.integrationId) {
      await this.read(
        () =>
          this.deps.repository.recordOutbound(input.integrationId as string, {
            lastOutboundAttemptAt: at,
            lastOutboundEvent: input.event,
          }),
        undefined,
      );
    }
  }

  async recordOutboundDelivery(input: {
    integrationId: string | null;
    event: string;
    profileId: string | null;
    requestId: string | null;
    destination: string | null;
    ok: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    safeError: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.read(
      () =>
        this.deps.repository.createLog({
          mediaIntegrationId: input.integrationId,
          direction: 'OUTBOUND',
          event: input.event,
          action: null,
          profileId: input.profileId,
          requestId: input.requestId,
          status: input.ok ? 'SUCCESS' : input.safeError === 'Webhook não configurado' ? 'SKIPPED' : 'FAILED',
          httpStatus: input.httpStatus,
          latencyMs: input.latencyMs,
          idempotent: null,
          safeError: input.safeError,
          destination: input.destination,
          createdAt: at,
        }),
      null,
    );
    if (input.integrationId) {
      await this.read(
        () =>
          this.deps.repository.recordOutbound(input.integrationId as string, {
            lastOutboundAttemptAt: at,
            lastOutboundEvent: input.event,
            lastOutboundStatusCode: input.httpStatus,
            lastOutboundLatencyMs: input.latencyMs,
            lastOutboundErrorSafe: input.safeError,
            lastOutboundSuccessAt: input.ok ? at : null,
            lastOutboundFailureAt: input.ok ? null : at,
          }),
        undefined,
      );
    }
    await this.trimLogs();
  }

  async recordInboundDelivery(input: {
    integrationId: string | null;
    requestId: string | null;
    action: string | null;
    profileId: string | null;
    status: string;
    httpStatus: number;
    ok: boolean;
    idempotent: boolean | null;
    safeError: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.read(
      () =>
        this.deps.repository.createLog({
          mediaIntegrationId: input.integrationId,
          direction: 'INBOUND',
          event: null,
          action: input.action,
          profileId: input.profileId,
          requestId: input.requestId,
          status: input.ok ? 'SUCCESS' : 'FAILED',
          httpStatus: input.httpStatus,
          latencyMs: null,
          idempotent: input.idempotent,
          safeError: input.safeError,
          destination: null,
          createdAt: at,
        }),
      null,
    );
    if (input.integrationId) {
      await this.read(
        () =>
          this.deps.repository.recordInbound(input.integrationId as string, {
            lastInboundAt: at,
            lastInboundAction: input.action,
            lastInboundStatus: input.status,
            lastInboundRequestId: input.requestId,
            lastInboundErrorSafe: input.safeError,
          }),
        undefined,
      );
    }
    await this.trimLogs();
  }

  async listLogs(
    filter: {
      mediaIntegrationId?: string | undefined;
      direction?: MediaDeliveryDirection | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<MediaDeliveryLogDto[]> {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const logs = await this.read(
      () =>
        this.deps.repository.listLogs({
          mediaIntegrationId: filter.mediaIntegrationId,
          direction: filter.direction,
          limit,
        }),
      [] as MediaDeliveryLogRecord[],
    );
    return logs.map((log) => ({
      id: log.id,
      direction: log.direction,
      event: log.event,
      action: log.action,
      profileId: log.profileId,
      requestId: log.requestId,
      status: log.status,
      httpStatus: log.httpStatus,
      latencyMs: log.latencyMs,
      idempotent: log.idempotent,
      safeError: log.safeError,
      destination: log.destination,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  // ---- teste de webhook ---------------------------------------------------

  /** TESTAR WEBHOOK da mitigacao: payload MITIGATION_TEST, canal BGP_MITIGATION. */
  async testWebhook(id?: string): Promise<MediaDeliveryOutcome & { checkedAt: string }> {
    const transport = this.transport;
    if (!transport) {
      return {
        ok: false,
        skipped: true,
        httpStatus: null,
        latencyMs: null,
        safeError: 'Transporte de mídia indisponível',
        event: 'MITIGATION_TEST',
        checkedAt: this.now().toISOString(),
      };
    }
    const integration = id
      ? await this.read(() => this.deps.repository.get(id), null)
      : await this.read(() => this.deps.repository.findByPurpose('BGP_MITIGATION'), null);
    const outcome = await transport.publishTest({ profileId: integration?.id ?? null });
    return { ...outcome, checkedAt: this.now().toISOString() };
  }

  /**
   * TESTAR ALARME (F9.5.1): mesma serializacao e mesmo transporte dos alarmes
   * reais, porem SO pelo canal NETWORK_ALARMS e com `test: true` no payload. O
   * tipo/evento/severidade vem do simulador da aba de alarmes; sem selecao vale
   * o default (INTERFACE_DOWN / OPENED / severidade do tipo). Nao cria Alarm,
   * nao cria OperationalOccurrence e nao mexe na mitigacao.
   *
   * Com grafico: `chartInterfaceId` e OBRIGATORIO para tipos que tem serie
   * historica e precisa existir no inventario. A interface entra apenas como
   * fonte READ-ONLY do historico do PNG — o texto do teste continua sintetico.
   * Referencia ausente/invalida devolve erro seguro e NADA e enviado.
   */
  async testAlarmWebhook(
    id: string,
    selection?: NetworkAlarmTestSelectionInput | null,
    options: { includeChart?: boolean; chartInterfaceId?: string | null } = {},
  ): Promise<MediaDeliveryOutcome & { checkedAt: string }> {
    const checkedAt = this.now().toISOString();
    const integration = await this.read(() => this.deps.repository.get(id), null);
    if (!integration || integration.purpose !== 'NETWORK_ALARMS') {
      return {
        ok: false,
        skipped: true,
        httpStatus: null,
        latencyMs: null,
        safeError: 'Integração de alarmes de rede não encontrada',
        event: 'NETWORK_ALARM_TEST',
        checkedAt,
      };
    }
    const transport = this.alarmTransport;
    if (!transport) {
      return {
        ok: false,
        skipped: true,
        httpStatus: null,
        latencyMs: null,
        safeError: 'Transporte de alarmes indisponível',
        event: 'NETWORK_ALARM_TEST',
        checkedAt,
      };
    }
    const selectionResolved = resolveNetworkAlarmTestSelection(selection);
    const includeChart = options.includeChart ?? false;
    // Default OFF: ligar o grafico so acontece quando o operador escolhe.
    let chartSource: AlarmChartSource | null = null;
    if (includeChart && isChartableAlarmType(selectionResolved.type)) {
      const reference = (options.chartInterfaceId ?? '').trim();
      chartSource = reference ? await this.resolveChartSource(reference) : null;
      if (!chartSource) {
        return {
          ok: false,
          skipped: true,
          httpStatus: null,
          latencyMs: null,
          safeError: 'Selecione uma interface válida para gerar o gráfico de teste.',
          event: 'NETWORK_ALARM_TEST',
          checkedAt,
        };
      }
    }
    const outcome = await transport.publishAlarmTest({
      profileId: integration.id,
      ...selectionResolved,
      includeChart,
      chartSource,
    });
    return { ...outcome, checkedAt };
  }

  // ---- helpers ------------------------------------------------------------

  /** Interface real do historico do grafico de teste (read-only, nunca lanca). */
  private async resolveChartSource(interfaceId: string): Promise<AlarmChartSource | null> {
    const port = this.deps.chartSource;
    if (!port) return null;
    try {
      return await port.resolveChartSource(interfaceId);
    } catch {
      return null;
    }
  }

  private async isMigrationReady(): Promise<boolean> {
    if (this.deps.repositoryKind === 'MEMORY') return false;
    try {
      return await this.deps.migrationReady();
    } catch {
      return false;
    }
  }

  private async sourceLabel(): Promise<MediaConfigSource> {
    if (this.deps.repositoryKind === 'MEMORY') return 'MEMORY';
    return (await this.isMigrationReady()) ? 'DATABASE' : 'MEMORY';
  }

  private async toDto(record: MediaIntegrationRecord): Promise<MediaIntegrationDto> {
    const configSource: MediaConfigSource = await this.sourceLabel();
    const outboundConfigured = Boolean(record.outboundUrl);
    const outboundTokenConfigured = Boolean(record.outboundSecretEncrypted);
    const inboundTokenConfigured = Boolean(record.inboundSecretEncrypted);
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      purpose: record.purpose,
      enabled: record.enabled,
      configSource,
      status: statusOf({
        record,
        outboundConfigured,
        envConfigured: Boolean(this.deps.env.outboundUrl),
      }),
      outboundConfigured,
      outboundUrl: record.outboundUrl,
      outboundTokenConfigured,
      inboundEnabled: record.inboundEnabled,
      inboundConfigured: record.inboundEnabled && inboundTokenConfigured,
      inboundTokenConfigured,
      inboundEndpointPath: N8N_INBOUND_ENDPOINT_PATH,
      lastOutboundAttemptAt: iso(record.lastOutboundAttemptAt),
      lastOutboundSuccessAt: iso(record.lastOutboundSuccessAt),
      lastOutboundFailureAt: iso(record.lastOutboundFailureAt),
      lastOutboundStatusCode: record.lastOutboundStatusCode,
      lastOutboundLatencyMs: record.lastOutboundLatencyMs,
      lastOutboundEvent: record.lastOutboundEvent,
      lastOutboundErrorSafe: record.lastOutboundErrorSafe,
      lastInboundAt: iso(record.lastInboundAt),
      lastInboundAction: record.lastInboundAction,
      lastInboundStatus: record.lastInboundStatus,
      lastInboundRequestId: record.lastInboundRequestId,
      lastInboundErrorSafe: record.lastInboundErrorSafe,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private assertSecretsAvailable(token: string | null): void {
    if (token && !this.deps.secretBox.available) {
      throw new MediaSecretUnavailableError();
    }
  }

  private async trimLogs(): Promise<void> {
    await this.read(() => this.deps.repository.trimLogs(this.logRetention), 0);
  }

  private async read<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.deps.logger?.('falha na camada de mídias', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}

export class MediaSecretUnavailableError extends Error {
  constructor() {
    super('CREDENTIAL_ENCRYPTION_KEY não configurada: não é possível guardar segredos');
    this.name = 'MediaSecretUnavailableError';
  }
}

/** Status operacional derivado do ultimo envio — nunca inventa "ONLINE". */
export function statusOf(input: {
  record: Pick<
    MediaIntegrationRecord,
    'enabled' | 'lastOutboundAttemptAt' | 'lastOutboundStatusCode' | 'lastOutboundErrorSafe'
  >;
  outboundConfigured: boolean;
  envConfigured: boolean;
}): MediaOperationalStatus {
  const { record } = input;
  if (!record.enabled) return 'DISABLED';
  if (!input.outboundConfigured && !input.envConfigured) return 'NOT_CONFIGURED';
  if (!record.lastOutboundAttemptAt) return 'NEVER_TESTED';
  const status = record.lastOutboundStatusCode;
  if (status !== null && status >= 200 && status < 300) return 'LAST_DELIVERY_OK';
  if (record.lastOutboundErrorSafe === 'Webhook não configurado') return 'NOT_CONFIGURED';
  return 'LAST_DELIVERY_FAILED';
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export { safeDestination };
