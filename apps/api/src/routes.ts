import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { singleEndedMonitoredSide } from '@gmj/shared';
import type {
  AuthUser,
  CreateHostInput,
  CreateLinkInput,
  Device,
  HistoryPeriod,
  HostRecord,
  LldpApplySelection,
  NetworkMap,
  PppTotalWidgetSettings,
  PublicMapView,
  PublicView,
  PublicViewResponse,
  PublicViewType,
  UpdateMapInput,
  UpdateUserInput,
} from '@gmj/shared';
import type {
  LldpSnmpTargetProvider,
  LldpSshSessionFactory,
  TopologyDiscoveryAdapter,
  TopologyPreviewStore,
} from './domain/ports';
import { CredentialVault } from './application/credential-vault';
import { DiscoveryService } from './application/discovery-service';
import { AuthService, randomToken, UserAlreadyExistsError } from './application/auth-service';
import { TopologyApplyService } from './application/topology-apply-service';
import { TopologyPreviewService } from './application/topology-preview-service';
import { config } from './config';
import { registerHostRoutes } from './host-routes';
import { registerMplsRoutes } from './mpls-routes';
import { registerVsiDiagnosticRoutes } from './vsi-diagnostic-routes';
import { VsiDiagnosticService } from './infrastructure/mpls/vsi-diagnostic-service';
import { VsiDiagnosticApprovalStore } from './infrastructure/mpls/vsi-diagnostic-approval';
import { InventoryVsiDiagnosticRunner } from './infrastructure/mpls/vsi-diagnostic-ssh';
import { registerBgpRoutes } from './bgp-routes';
import { registerPhysicalRoutes } from './physical-routes';

/**
 * True only for "the table/column does not exist yet" errors, i.e. a pending
 * Prisma migration. Everything else must surface as a real error.
 */
function isPendingMigrationError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === 'P2021' || code === 'P2022') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist in the current database|relation .* does not exist|column .* does not exist/i.test(
    message,
  );
}
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PrismaPhysicalRepository } from './infrastructure/physical/prisma-physical-repository';
import { PhysicalService } from './infrastructure/physical/physical-service';
import { PhysicalCatalogError } from './infrastructure/physical/physical-catalog-yaml';
import { DemoMetricAdapter } from './infrastructure/metrics/demo-adapter';
import { ZabbixAdapter } from './infrastructure/metrics/zabbix-adapter';
import { DemoAuthRepository } from './infrastructure/persistence/demo-auth-repository';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import { DemoMapRepository } from './infrastructure/persistence/demo-map-repository';
import { DemoPublicViewRepository } from './infrastructure/persistence/demo-public-view-repository';
import { InMemoryTopologyPreviewStore } from './infrastructure/persistence/in-memory-topology-preview-store';
import { PrismaAuthRepository } from './infrastructure/persistence/prisma-auth-repository';
import { PrismaMapRepository } from './infrastructure/persistence/prisma-map-repository';
import { PrismaPublicViewRepository } from './infrastructure/persistence/prisma-public-view-repository';
import { PrismaTopologyPreviewStore } from './infrastructure/persistence/prisma-topology-preview-store';
import { createPrismaHostRepository } from './infrastructure/persistence/prisma-host-repository';
import { disconnectPrismaClient, prismaClient } from './infrastructure/persistence/prisma-client';
import { PrismaClient } from './generated/prisma/index.js';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { PublicViewRecord } from './infrastructure/persistence/public-view-repository';
import { SnmpClientImpl } from './infrastructure/snmp/snmp-client-impl';
import { SnmpPoller } from './infrastructure/snmp/snmp-poller';
import { FastTrafficPoller, fastPollerConfig } from './infrastructure/snmp/fast-traffic-poller';
import { FastSnmpReader } from './infrastructure/snmp/fast-snmp-reader';
import { PrismaFastTrafficStore } from './infrastructure/snmp/prisma-fast-traffic-store';
import { listFastTrafficTargets } from './infrastructure/snmp/fast-traffic-targets';
import { PriorityTrafficSource } from './worker/mitigation/fast-traffic-source';
import {
  isFastRoutedProfile,
  matchesAutoEvidence,
  samplingWindowForProfile,
} from './worker/mitigation/mitigation-sampling-policy';
import { SnmpService } from './infrastructure/snmp/snmp-service';
import { DemoMplsRepository } from './infrastructure/mpls/demo-mpls-repository';
import { DemoAlarmRepository } from './infrastructure/alarms/demo-alarm-repository';
import { DemoAlarmRuleRepository } from './infrastructure/alarms/demo-alarm-rule-repository';
import { DemoAlarmSuppressionRepository } from './infrastructure/alarms/demo-alarm-suppression-repository';
import { PrismaAlarmRepository } from './infrastructure/alarms/prisma-alarm-repository';
import { PrismaAlarmRuleRepository } from './infrastructure/alarms/prisma-alarm-rule-repository';
import { PrismaAlarmSuppressionRepository } from './infrastructure/alarms/prisma-alarm-suppression-repository';
import { AlarmService } from './application/alarm-service';
import { AlarmEngine } from './application/alarm-engine';
import { AlarmSuppressionService } from './application/alarm-suppression-service';
import {
  AlarmNotificationService,
  type AlarmNotifier,
} from './application/alarm-notification-service';
import { N8nAlarmTransport } from './infrastructure/alarms/n8n-alarm-transport';
import { createAlarmChartSnapshot } from './infrastructure/media/alarm-chart-snapshot';
import { registerSnapshotRoutes } from './infrastructure/media/snapshot-routes';
import { OperationalOccurrenceService } from './application/operational-occurrence-service';
import { AlertCenterService } from './application/alert-center-service';
import { registerAlertCenterRoutes } from './alert-center-routes';
import { DemoAlertCenterRepository } from './infrastructure/alarms/demo-alert-center-repository';
import { PrismaAlertCenterRepository } from './infrastructure/alarms/prisma-alert-center-repository';
import { registerOperationalOccurrenceRoutes } from './operational-occurrence-routes';
import { DemoOperationalOccurrenceRepository } from './infrastructure/alarms/demo-operational-occurrence-repository';
import { PrismaOperationalOccurrenceRepository } from './infrastructure/alarms/prisma-operational-occurrence-repository';
import { registerAlarmRoutes } from './alarm-routes';
import { HuaweiVplsSnmpCollector } from './infrastructure/mpls/huawei-vpls-snmp';
import { MplsPollingService } from './infrastructure/mpls/mpls-polling-service';
import { PrismaMplsRepository } from './infrastructure/mpls/prisma-mpls-repository';
import { PppPollingService } from './infrastructure/ppp/ppp-polling-service';
import { PrismaPppRepository } from './infrastructure/ppp/prisma-ppp-repository';
import { BgpPollingService } from './infrastructure/bgp/bgp-polling-service';
import { BgpDiscoveryService } from './infrastructure/bgp/bgp-discovery-service';
import { BgpAdminService } from './infrastructure/bgp/bgp-admin-service';
import { BgpAdvertisedRoutesService } from './infrastructure/bgp/bgp-advertised-routes-service';
import { InMemoryBgpAdminAuditRepository } from './infrastructure/bgp/bgp-admin-audit';
import { PrismaBgpAdminAuditRepository } from './infrastructure/bgp/prisma-bgp-admin-audit-repository';
import { HuaweiBgpSshService } from './infrastructure/bgp/huawei-bgp-ssh';
import { DemoBgpRepository } from './infrastructure/bgp/demo-bgp-repository';
import { HuaweiBgpSnmpCollector } from './infrastructure/bgp/huawei-bgp-snmp';
import { PrismaBgpRepository } from './infrastructure/bgp/prisma-bgp-repository';
import { InMemoryMitigationRepository } from './infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { PrismaMitigationRepository } from './infrastructure/bgp/mitigation/prisma-mitigation-repository';
import { BgpMitigationDiscoveryService } from './infrastructure/bgp/mitigation/mitigation-discovery-service';
import { SnmpInterfaceMetadataRefresher } from './infrastructure/snmp/snmp-interface-metadata-refresher';
import { HuaweiBgpMitigationConfigSource } from './infrastructure/bgp/mitigation/mitigation-config-source';
import { BgpMitigationService } from './infrastructure/bgp/mitigation/mitigation-service';
import {
  RoutingMitigationRepository,
  createCachedSchemaCheck,
} from './infrastructure/bgp/mitigation/mitigation-repository-router';
import {
  AlwaysReadyMitigationPeerExclusionSchemaProbe,
  AlwaysReadyMitigationSchemaProbe,
  PrismaMitigationPeerExclusionSchemaProbe,
  PrismaMitigationSchemaProbe,
} from './infrastructure/bgp/mitigation/mitigation-schema-probe';
import { registerMitigationRoutes } from './mitigation-routes';
import { diagnoseMitigationTelemetry } from './infrastructure/bgp/mitigation/mitigation-telemetry';
import { PrismaMitigationTelemetryReader } from './infrastructure/bgp/mitigation/prisma-mitigation-telemetry-reader';
import {
  sharedPolicyAutomationBlocked,
  sharedPolicyScopes,
} from './infrastructure/bgp/mitigation/mitigation-shared-policy';
import { MitigationDirectionReview } from './infrastructure/bgp/mitigation/mitigation-direction-review';
import { PrismaDirectionReviewStore } from './infrastructure/bgp/mitigation/prisma-direction-review-store';
import { registerN8nRoutes } from './n8n-routes';
import { MitigationCommandService } from './infrastructure/bgp/mitigation/mitigation-command-service';
import type { MitigationAutoEvidence } from './infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from './infrastructure/bgp/mitigation/mitigation-executor';
import { mitigationConfigFromEnv } from './infrastructure/bgp/mitigation/mitigation-config';
import { mitigationExecutionConfigFromEnv } from './infrastructure/bgp/mitigation/mitigation-execution-config';
import { HuaweiMitigationExecutor } from './infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { MitigationPolicyReconciler } from './infrastructure/bgp/mitigation/mitigation-policy-reconciler';
import { PrismaInterfaceTrafficReader } from './infrastructure/bgp/mitigation/prisma-interface-traffic-reader';
import { MitigationAutoEngine } from './worker/mitigation/mitigation-auto-engine';
import { resolveDetectionAlertPolicy } from './worker/mitigation/mitigation-detection-alert-policy';
import { createDetectionAlertPublisher } from './application/mitigation-detection-alert';
import {
  fastBridgeConfig,
  FastObservationSource,
  FastBridgeRoutingSource,
  fastProfileRevision,
  fastRoutingActive,
  type FastBridgeProfile,
} from './worker/mitigation/fast-observation-bridge';
import {
  PrismaFastBridgeReader,
  readObserverHealth,
} from './infrastructure/snmp/prisma-fast-bridge-reader';
import {
  PrismaFastShadowRuntime,
  recordFastBridgeDecisions,
} from './infrastructure/bgp/mitigation/prisma-fast-shadow-runtime';
import { PrismaPolicyScopeLock } from './infrastructure/bgp/mitigation/prisma-policy-scope-lock';
import { MitigationAutoRuntime } from './worker/mitigation/mitigation-auto-runtime';
import { buildAutoShadowReport } from './worker/mitigation/mitigation-auto-shadow';
import { InterfaceTrafficSource } from './worker/mitigation/mitigation-traffic-source';
import {
  MitigationAutoDescriptionSweep,
  parseSweepBatchSize,
} from './infrastructure/bgp/mitigation/mitigation-auto-description-sweep';
import type { MitigationState } from './infrastructure/bgp/mitigation/mitigation-types';
import { InMemoryMediaRepository } from './infrastructure/media/in-memory-media-repository';
import { PrismaMediaRepository } from './infrastructure/media/prisma-media-repository';
import {
  AlwaysReadyMediaSchemaProbe,
  PrismaMediaSchemaProbe,
} from './infrastructure/media/media-schema-probe';
import { RoutingMediaRepository } from './infrastructure/media/media-repository-router';
import { createMediaSecretBox } from './infrastructure/media/media-secret-box';
import { MediaIntegrationService } from './infrastructure/media/media-integration-service';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from './infrastructure/media/n8n-media-transport';
import { registerMediaRoutes } from './media-routes';
import { SshClientImpl } from './infrastructure/ssh/ssh-client-impl';
import { SshInterfaceService } from './infrastructure/ssh/ssh-interface-service';
import { OpticalThresholdService } from './infrastructure/ssh/optical-threshold-service';
import { DemoTopologyAdapter } from './infrastructure/topology/demo-topology-adapter';
import { HuaweiVrpDriver } from './infrastructure/topology/huawei-vrp-driver';
import { LldpSnmpDiscoveryAdapter } from './infrastructure/topology/lldp-snmp-adapter';
import { LldpSshDiscoveryAdapter } from './infrastructure/topology/lldp-ssh-adapter';
import { InMemoryPolicyScopeLock } from './infrastructure/bgp/mitigation/mitigation-policy-lock';

const mapIdParams = z.object({ mapId: z.string().min(1) });
const nodeParams = z.object({ mapId: z.string().min(1), nodeId: z.string().min(1) });
const widgetParams = z.object({ mapId: z.string().min(1), widgetId: z.string().min(1) });
const deviceParams = z.object({ mapId: z.string().min(1), deviceId: z.string().min(1) });
const linkParams = z.object({ mapId: z.string().min(1), linkId: z.string().min(1) });
const positionSchema = z.object({
  nodeId: z.string().min(1),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  positionSource: z.enum(['AUTO', 'MANUAL']).optional(),
  locked: z.boolean().optional(),
});
const linkSchema = z.object({
  sourceDeviceId: z.string().min(1).nullable().optional(),
  sourceInterfaceId: z.string().min(1).nullable().optional(),
  targetDeviceId: z.string().min(1).nullable().optional(),
  targetInterfaceId: z.string().min(1).nullable().optional(),
  sourceNodeId: z.string().min(1).nullable().optional(),
  targetNodeId: z.string().min(1).nullable().optional(),
  capacityBps: z.number().positive(),
  autoCapacityBps: z.number().positive(),
  capacitySource: z.enum(['AUTO', 'MANUAL']),
  trafficMode: z.enum(['BIDIRECTIONAL', 'SINGLE_ENDED']).optional(),
  customColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  trafficColorAToB: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  trafficColorBToA: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  inlineLabelPositionAToB: z.number().min(0.1).max(0.9).nullable().optional(),
  inlineLabelPositionBToA: z.number().min(0.1).max(0.9).nullable().optional(),
  animationEnabled: z.boolean().nullable().optional(),
  label: z.string().max(80),
  metricSource: z.enum(['DEMO', 'ZABBIX']),
  visualStyle: z.enum(['FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL']).nullable(),
  metricDisplay: z.enum(['THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE']).nullable(),
  aggregationMode: z.enum(['NONE', 'SUM']).optional(),
  linkLayoutMode: z.enum(['AUTO', 'MANUAL']).optional(),
  sourceHandleSide: z.enum(['AUTO', 'TOP', 'RIGHT', 'BOTTOM', 'LEFT']).optional(),
  targetHandleSide: z.enum(['AUTO', 'TOP', 'RIGHT', 'BOTTOM', 'LEFT']).optional(),
  metricSources: z
    .array(
      z.object({
        interfaceId: z.string().min(1),
        side: z.enum(['SOURCE', 'TARGET']),
      }),
    )
    .optional(),
  visualPaths: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        label: z.string().max(80).nullable(),
        customColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable(),
        curvature: z.number().finite(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
});
const genericNodeSchema = z.object({
  type: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
});
// Only the editable surface of a conceptual node: identity, deviceId, nodeKind
// and position stay owned by their own flows.
const conceptualNodeSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  genericType: z.string().min(1).max(40).optional(),
  locked: z.boolean().optional(),
});
const loginSchema = z.object({
  usernameOrEmail: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});
const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      'Usuário deve conter apenas letras, números, pontos, traços e underscores',
    ),
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  password: z.string().min(6).max(1024),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
});
const updateUserSchema = z.object({
  email: z.string().email().max(255).optional(),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(6).max(1024).optional(),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(6).max(1024),
});
const publicViewSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['MAP', 'NOC']),
  mapId: z.string().min(1).nullable().optional(),
  playlistId: z.string().min(1).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});
const publicViewPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});
const mapSettingsSchema = z.object({
  nodeDisplayMode: z.enum(['ICON_2D', 'ICON_3D', 'CARD']).optional(),
  linkDisplayStyle: z.enum(['FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL']).optional(),
  linkMetricDisplay: z.enum(['THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE']).optional(),
  trafficLabelMode: z.enum(['CARD', 'INLINE', 'HIDDEN']).optional(),
  filters: z
    .object({
      showTraffic: z.boolean().optional(),
      showUtilization: z.boolean().optional(),
      showLabels: z.boolean().optional(),
      showOffline: z.boolean().optional(),
      showInterfaces: z.boolean().optional(),
      showTrafficAnimation: z.boolean().optional(),
    })
    .optional(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }).optional(),
  nodeScale: z.number().min(50).max(200).optional(),
  linkScale: z.number().min(50).max(200).optional(),
  labelScale: z.number().min(50).max(200).optional(),
});
const createMapSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  mode: z.enum(['MANUAL', 'AUTO', 'HYBRID']).default('HYBRID'),
  sourceMapId: z.string().nullable().default(null),
});
const updateMapSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  mode: z.enum(['MANUAL', 'AUTO', 'HYBRID']).optional(),
  isDefault: z.boolean().optional(),
  settings: mapSettingsSchema.optional(),
});
const nodePppSchema = z.object({
  pppDisplayMode: z.enum(['AUTO', 'SHOW', 'HIDE']).optional(),
  pppPosition: z.enum(['TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER']).optional(),
  pppColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  pppFontSize: z.number().int().min(8).max(32).optional(),
});
const pppTotalSettingsSchema = z.object({
  mode: z.enum(['AUTO', 'MANUAL']).optional(),
  selectedHostIds: z.array(z.string().min(1)).optional(),
  title: z.string().min(1).max(80).optional(),
  fontColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  fontSize: z.number().int().min(10).max(64).optional(),
  backgroundColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  backgroundOpacity: z.number().int().min(0).max(100).optional(),
  showHostCount: z.boolean().optional(),
  showFreshness: z.boolean().optional(),
});
const upsertWidgetSchema = z.object({
  type: z.enum(['PPP_TOTAL']),
  positionX: z.number().finite().optional(),
  positionY: z.number().finite().optional(),
  enabled: z.boolean().optional(),
  settings: pppTotalSettingsSchema.optional(),
});
const updateWidgetSchema = z.object({
  positionX: z.number().finite().optional(),
  positionY: z.number().finite().optional(),
  enabled: z.boolean().optional(),
  settings: pppTotalSettingsSchema.optional(),
});

type PppSettingsBody = z.infer<typeof pppTotalSettingsSchema>;

function pppSettingsInput(settings: PppSettingsBody): Partial<PppTotalWidgetSettings> {
  return {
    ...(settings.mode === undefined ? {} : { mode: settings.mode }),
    ...(settings.selectedHostIds === undefined
      ? {}
      : { selectedHostIds: settings.selectedHostIds }),
    ...(settings.title === undefined ? {} : { title: settings.title }),
    ...(settings.fontColor === undefined ? {} : { fontColor: settings.fontColor }),
    ...(settings.fontSize === undefined ? {} : { fontSize: settings.fontSize }),
    ...(settings.backgroundColor === undefined
      ? {}
      : { backgroundColor: settings.backgroundColor }),
    ...(settings.backgroundOpacity === undefined
      ? {}
      : { backgroundOpacity: settings.backgroundOpacity }),
    ...(settings.showHostCount === undefined ? {} : { showHostCount: settings.showHostCount }),
    ...(settings.showFreshness === undefined ? {} : { showFreshness: settings.showFreshness }),
  };
}
const deviceSchema = z.object({
  name: z.string().min(1).max(80),
  hostname: z.string().min(1).max(255),
  ip: z.string().min(1).max(45),
  vendor: z.string().max(80),
  model: z.string().max(80),
  site: z.string().max(80),
  deviceType: z.enum([
    'core',
    'router',
    'switch',
    'aggregation',
    'edge',
    'olt',
    'firewall',
    'server',
    'internet',
    'ix',
    'customers',
    'generic',
  ]),
  position: z.object({ x: z.number(), y: z.number() }),
});

interface RouteRegistrationOptions {
  credentialEncryptionKey?: string | null;
  requireAuth?: boolean;
}

/** ENV numerica opcional: ausente/vazia vira `undefined` (usa default). */
function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function buildTopologyAdapters(hosts: HostRepository): TopologyDiscoveryAdapter[] {
  if (config.DEMO_MODE) return [new DemoTopologyAdapter()];

  const snmpClient = new SnmpClientImpl(3000, 1);
  const snmpTargetProvider: LldpSnmpTargetProvider = {
    async resolve(device) {
      const host = device as HostRecord;
      if (!host.snmpEnabled || !host.snmp?.host || !host.snmp.port) {
        throw new Error('SNMP não está habilitado para este host');
      }
      const credentials = await hosts.getDecryptedSnmpCredentials(host.id);
      const community = credentials?.community;
      if (!community) throw new Error('SNMP credential not configured');
      return { host: host.snmp.host, port: host.snmp.port, community };
    },
  };

  const sshSessionFactory: LldpSshSessionFactory = {
    async open(device) {
      const host = device as HostRecord;
      if (!host.sshEnabled || !host.ssh?.host || !host.ssh.username) {
        throw new Error('SSH não está habilitado para este host');
      }
      const credentials = await hosts.getDecryptedSshCredentials(host.id);
      if (!credentials?.password) throw new Error('SSH credential not configured');
      const client = new SshClientImpl({
        port: host.ssh.port,
        username: host.ssh.username,
        password: credentials.password,
        contextCommand: host.ssh.contextCommand ?? null,
      });
      return { client, host: host.ssh.host };
    },
  };

  return [
    new LldpSnmpDiscoveryAdapter(snmpClient, snmpTargetProvider),
    new LldpSshDiscoveryAdapter([new HuaweiVrpDriver()], sshSessionFactory),
  ];
}

export function registerRoutes(app: FastifyInstance, options: RouteRegistrationOptions = {}): void {
  const credentialEncryptionKey =
    options.credentialEncryptionKey === undefined
      ? config.CREDENTIAL_ENCRYPTION_KEY
      : options.credentialEncryptionKey;
  const vault = credentialEncryptionKey ? new CredentialVault(credentialEncryptionKey) : null;

  const legacyMaps = new DemoMapRepository(vault);
  const hosts = config.DEMO_MODE
    ? new DemoHostRepositoryAdapter(legacyMaps)
    : createPrismaHostRepository(vault);
  const productionMaps = config.DEMO_MODE ? null : new PrismaMapRepository(hosts);
  const maps = productionMaps ?? legacyMaps;
  const authRepository = config.DEMO_MODE ? new DemoAuthRepository() : new PrismaAuthRepository();
  const auth = new AuthService(authRepository, config.SESSION_TTL_DAYS);
  const publicViewRepository = config.DEMO_MODE
    ? new DemoPublicViewRepository()
    : new PrismaPublicViewRepository();
  const metrics = new DemoMetricAdapter();
  const discovery = new DiscoveryService([new DemoTopologyAdapter()]);
  const ssh = new SshInterfaceService(hosts);
  const mplsRepository = config.DEMO_MODE
    ? new DemoMplsRepository()
    : new PrismaMplsRepository(prismaClient);
  const mplsPolling = new MplsPollingService(
    new HuaweiVplsSnmpCollector(new SnmpClientImpl(3000, 1)),
    mplsRepository,
  );
  const pppRepository = config.DEMO_MODE ? null : new PrismaPppRepository(prismaClient);
  const pppPolling = pppRepository
    ? new PppPollingService(new SnmpClientImpl(3000, 1), pppRepository)
    : undefined;
  const bgpRepository = config.DEMO_MODE
    ? new DemoBgpRepository()
    : new PrismaBgpRepository(prismaClient);
  const bgpPolling = new BgpPollingService(
    new HuaweiBgpSnmpCollector(new SnmpClientImpl(3000, 1)),
    bgpRepository,
  );
  const bgpDiscovery = new BgpDiscoveryService(new HuaweiBgpSshService(hosts), bgpRepository);
  const bgpAudit = config.DEMO_MODE
    ? new InMemoryBgpAdminAuditRepository()
    : new PrismaBgpAdminAuditRepository(prismaClient);
  const bgpAdmin = new BgpAdminService({
    bgp: bgpRepository,
    hosts,
    ssh: new HuaweiBgpSshService(hosts),
    audit: bgpAudit,
  });
  const bgpAdvertisedRoutes = new BgpAdvertisedRoutesService({
    bgp: bgpRepository,
    hosts,
    ssh: new HuaweiBgpSshService(hosts),
  });
  // Mitigacao DDoS: SIMULATION_ONLY. Em DEMO_MODE o repositorio e em memoria;
  // em producao o Prisma fica pronto, mas a leitura tolera schema ausente
  // (a migration ainda nao foi aplicada).
  // Mitigacao DDoS: o Postgres entra quando a migration existir. Enquanto ela
  // nao for aplicada, o espelho em memoria mantem o discovery utilizavel -
  // sem isso, o upsert do profile morreria com "relation does not exist" e a
  // descoberta inteira se perderia.
  const mitigationMemoryRepository = new InMemoryMitigationRepository();
  const mitigationSchemaProbe = config.DEMO_MODE
    ? new AlwaysReadyMitigationSchemaProbe()
    : new PrismaMitigationSchemaProbe(prismaClient);
  const mitigationSchemaReady = createCachedSchemaCheck(() => mitigationSchemaProbe.probe());
  // A exclusao PREVENTIVA por peer nasce em migration propria: enquanto a tabela
  // nao existir, apenas essas tres chamadas caem para o espelho em memoria.
  const mitigationPeerExclusionProbe = config.DEMO_MODE
    ? new AlwaysReadyMitigationPeerExclusionSchemaProbe()
    : new PrismaMitigationPeerExclusionSchemaProbe(prismaClient);
  const mitigationPeerExclusionReady = createCachedSchemaCheck(async () => ({
    databaseReady: true,
    migrationReady: await mitigationPeerExclusionProbe.probe(),
  }));
  const mitigationPrismaRepository = config.DEMO_MODE
    ? null
    : new PrismaMitigationRepository(prismaClient);
  const mitigationRepository =
    config.DEMO_MODE || mitigationPrismaRepository === null
      ? mitigationMemoryRepository
      : new RoutingMitigationRepository(
          mitigationPrismaRepository,
          mitigationMemoryRepository,
          mitigationSchemaReady,
          mitigationPeerExclusionReady,
        );
  // Uma unica sessao/credencial SSH para discovery E escrita manual.
  const mitigationSshMetrics: Array<
    import('./infrastructure/ssh/ssh-client-impl').SshExecutionMetrics & { at: string }
  > = [];
  const mitigationSsh = new HuaweiBgpSshService(
    hosts,
    (options) =>
      new SshClientImpl({
        ...options,
        metrics: (metrics) => {
          mitigationSshMetrics.push({ at: new Date().toISOString(), ...metrics });
          if (mitigationSshMetrics.length > 128) mitigationSshMetrics.shift();
        },
      }),
  );
  // Runtime do motor AUTO (atribuído depois das dependências canônicas).
  let autoRuntimeRef: MitigationAutoRuntime | null = null;
  let revalidateAutoEvidence:
    ((profileId: string, evidence?: MitigationAutoEvidence) => Promise<boolean>) | null = null;
  const mitigationService = new BgpMitigationService({
    repository: mitigationRepository,
    discovery: new BgpMitigationDiscoveryService({
      bgpDiscovery,
      configSource: new HuaweiBgpMitigationConfigSource(mitigationSsh),
      repository: mitigationRepository,
    }),
    hosts,
    // Reusa a correlacao peer->interface ja gravada pelo discovery BGP,
    // evitando um SSH por peer (F1A tem 107 peers).
    persistedPeers: {
      listForDevice: (deviceId) =>
        bgpRepository.listDashboardPeers({ scope: 'all', state: 'all', deviceId }),
    },
    // Clique MANUAL (DESCOBRIR CLIENTES): renova metadata das interfaces
    // (SNMP IF-MIB + display interface description) antes de classificar.
    // O SnmpService nasce depois; o closure so resolve na requisicao.
    interfaceMetadataRefresher: {
      refresh: (device) => new SnmpInterfaceMetadataRefresher(snmp).refresh(device),
    },
    schemaProbe: mitigationSchemaProbe,
    repositoryKind: config.DEMO_MODE ? 'MEMORY' : 'DATABASE',
    peerExclusionSchemaReady: mitigationPeerExclusionReady,
    execution: mitigationExecutionConfigFromEnv(),
    autoStatus: () => autoRuntimeRef?.getStatus() ?? null,
  });
  const physicalRepository = config.DEMO_MODE
    ? new DemoPhysicalRepository(hosts)
    : new PrismaPhysicalRepository(prismaClient);
  const physicalService = new PhysicalService(physicalRepository);
  const alarmRepository = config.DEMO_MODE
    ? new DemoAlarmRepository()
    : new PrismaAlarmRepository(prismaClient);
  const alarmRuleRepository = config.DEMO_MODE
    ? new DemoAlarmRuleRepository()
    : new PrismaAlarmRuleRepository(prismaClient);
  const alarmSuppressionRepository = config.DEMO_MODE
    ? new DemoAlarmSuppressionRepository()
    : new PrismaAlarmSuppressionRepository(prismaClient);
  const alarmSuppressions = new AlarmSuppressionService(
    alarmRepository,
    alarmSuppressionRepository,
  );
  const operationalOccurrenceRepository = config.DEMO_MODE
    ? new DemoOperationalOccurrenceRepository()
    : new PrismaOperationalOccurrenceRepository(prismaClient);
  const operationalOccurrences = new OperationalOccurrenceService(operationalOccurrenceRepository);
  const alertCenterRepository = config.DEMO_MODE
    ? new DemoAlertCenterRepository(
        alarmRepository,
        operationalOccurrenceRepository,
        alarmSuppressionRepository,
      )
    : new PrismaAlertCenterRepository(prismaClient);
  const alertCenter = new AlertCenterService(alertCenterRepository);
  const alarms = new AlarmService(alarmRepository, alarmSuppressionRepository);
  // Holder da notificacao de midia: definido junto ao motor e ligado depois
  // que a camada de midias (que depende do vault) estiver pronta.
  const alarmMediaHolder: { notifier: AlarmNotifier | null } = { notifier: null };
  const alarmEngine = new AlarmEngine({
    hosts,
    alarms: alarmRepository,
    rules: alarmRuleRepository,
    suppressions: alarmSuppressionRepository,
    // A camada de midias e construida depois deste motor; o holder mantem a
    // ligacao explicita sem inverter a ordem de criacao.
    notifier: {
      notifyOpened: (alarm, options) =>
        alarmMediaHolder.notifier?.notifyOpened(alarm, options) ?? Promise.resolve(),
      notifyEscalated: (alarm, options) =>
        alarmMediaHolder.notifier?.notifyEscalated(alarm, options) ?? Promise.resolve(),
      notifyResolved: (alarm, options) =>
        alarmMediaHolder.notifier?.notifyResolved(alarm, options) ?? Promise.resolve(),
    },
  });
  const opticalThresholds = new OpticalThresholdService(hosts, {
    refreshHours: config.OPTICAL_THRESHOLD_REFRESH_HOURS,
    failureCooldownMs: config.OPTICAL_THRESHOLD_FAILURE_COOLDOWN_MINUTES * 60_000,
  });
  const snmp = new SnmpService(
    hosts,
    ssh,
    config.OPTICAL_POLL_INTERVAL_SECONDS * 1000,
    mplsPolling,
    pppPolling,
    alarms,
    bgpPolling,
    alarmEngine,
    opticalThresholds,
    operationalOccurrences,
  );
  const poller = new SnmpPoller(hosts, snmp, config.SNMP_POLL_INTERVAL_SECONDS * 1000);
  const zabbix =
    config.ZABBIX_URL && config.ZABBIX_TOKEN
      ? new ZabbixAdapter(config.ZABBIX_URL, config.ZABBIX_TOKEN, config.ZABBIX_AUTH_MODE)
      : null;

  const topologyAdapters = buildTopologyAdapters(hosts);
  const topologyPreviewStore: TopologyPreviewStore = config.DEMO_MODE
    ? new InMemoryTopologyPreviewStore()
    : new PrismaTopologyPreviewStore();
  const topologyPreview = new TopologyPreviewService(
    topologyAdapters,
    hosts,
    maps,
    topologyPreviewStore,
  );
  const topologyApply = new TopologyApplyService(maps, hosts);

  registerHostRoutes(app, { legacyMaps, mapMembership: maps, hosts, discovery, snmp, ssh, zabbix });
  registerMplsRoutes(app, { hosts, mpls: mplsRepository });
  const vsiApprovals = new VsiDiagnosticApprovalStore();
  const vsiDiagnostics = new VsiDiagnosticService(
    hosts,
    mplsRepository,
    new InventoryVsiDiagnosticRunner(hosts),
    (event) => app.log.info(event, 'vsi-diagnostic: comando somente leitura'),
    (hostId, vsiId, approvalId) => {
      vsiApprovals.consume(approvalId, hostId, vsiId);
    },
  );
  registerVsiDiagnosticRoutes(
    app,
    vsiDiagnostics,
    (request) => auth.userForToken(request.cookies.netvision_session),
    vsiApprovals,
  );
  app.addHook('onClose', () => vsiDiagnostics.close());
  registerAlarmRoutes(app, {
    alarms: alarmRepository,
    rules: alarmRuleRepository,
    // Contrato `InterfaceOccurrence[]` preservado (F8), agora servido pelo
    // modelo persistente de ocorrencias (F9.2).
    occurrences: (windowMinutes, limit) =>
      operationalOccurrences.listInterfaceOccurrences(windowMinutes, limit),
    suppressions: alarmSuppressions,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });
  registerOperationalOccurrenceRoutes(app, {
    occurrences: operationalOccurrences,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });
  registerAlertCenterRoutes(app, {
    alertCenter,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });
  registerBgpRoutes(app, {
    bgp: bgpRepository,
    hosts,
    discovery: bgpDiscovery,
    admin: bgpAdmin,
    advertisedRoutes: bgpAdvertisedRoutes,
    peerExclusions: mitigationRepository,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });
  // ---- Camada de MIDIAS (Fase 9): n8n configuravel pela UI --------------
  // A migration desta fase pode nao estar aplicada: o roteador cai para o
  // espelho em memoria e a UI avisa que a configuracao e temporaria.
  const mediaMemoryRepository = new InMemoryMediaRepository();
  const mediaSchemaProbe = config.DEMO_MODE
    ? new AlwaysReadyMediaSchemaProbe()
    : new PrismaMediaSchemaProbe(prismaClient);
  const mediaSchemaReady = createCachedSchemaCheck(() => mediaSchemaProbe.probe());
  const mediaPrismaRepository = config.DEMO_MODE ? null : new PrismaMediaRepository(prismaClient);
  const mediaRepository =
    config.DEMO_MODE || mediaPrismaRepository === null
      ? mediaMemoryRepository
      : new RoutingMediaRepository(mediaPrismaRepository, mediaMemoryRepository, mediaSchemaReady);
  const mediaService = new MediaIntegrationService({
    repository: mediaRepository,
    secretBox: createMediaSecretBox(vault),
    repositoryKind: config.DEMO_MODE ? 'MEMORY' : 'DATABASE',
    migrationReady: mediaSchemaReady,
    env: {
      outboundUrl: process.env.MITIGATION_N8N_WEBHOOK_URL?.trim() || null,
      outboundToken: process.env.MITIGATION_N8N_WEBHOOK_TOKEN?.trim() || null,
      inboundToken: process.env.NETVISION_N8N_COMMAND_TOKEN?.trim() || null,
    },
    logger: (message, meta) => app.log.warn(meta ?? {}, message),
  });
  const webhookSender = createFetchWebhookSender();
  const mediaTransport = new N8nMediaTransport({
    media: mediaService,
    send: webhookSender,
  });
  // Ligacao tardia: o transporte resolve URL/token pela camada de midias.
  mediaService.attachTransport(mediaTransport);

  // Alarmes de rede usam o MESMO sender HTTP e o MESMO log operacional da
  // camada de midias, porem com canal PROPRIO: `resolveOutbound('NETWORK_ALARMS')`
  // nunca cai no canal nem no ENV da mitigacao (F9.5).
  if (alarmMediaHolder.notifier) {
    throw new Error('notifier de alarmes ja inicializado');
  }
  const alarmChartSnapshot = createAlarmChartSnapshot({
    rendererUrl: config.SNAPSHOT_RENDERER_URL,
    signingKey: config.SNAPSHOT_SIGNING_KEY,
    webInternalUrl: config.SNAPSHOT_WEB_INTERNAL_URL,
    apiPublicUrl: config.SNAPSHOT_PUBLIC_API_URL,
    cacheDir: config.SNAPSHOT_CACHE_DIR,
    ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
    cacheKeepHours: config.SNAPSHOT_CACHE_KEEP_HOURS,
  });
  const alarmTransport = new N8nAlarmTransport({
    media: mediaService,
    send: webhookSender,
    chartSnapshot: alarmChartSnapshot,
  });
  // O TESTAR ALARME reusa este transporte (serializer canonico, sem payload paralelo).
  mediaService.attachAlarmTransport(alarmTransport);
  alarmMediaHolder.notifier = new AlarmNotificationService({
    alarms: alarmRepository,
    transport: alarmTransport,
  });

  // Configuracao explicita de EXECUCAO (fail-closed): MOCK por padrao; o
  // executor Huawei so entra quando `MITIGATION_EXECUTOR=HUAWEI`. A escrita real
  // continua exigindo `MITIGATION_LIVE_WRITE_ENABLED=true` E device na allowlist.
  const mitigationEngineConfig = mitigationConfigFromEnv();
  const mitigationExecutionConfig = mitigationExecutionConfigFromEnv();
  const mitigationLabels = {
    bogonPrefixList: mitigationEngineConfig.bogonPrefixList,
    targetPrefixList: mitigationEngineConfig.targetPrefixList,
  };
  const mitigationExecutor = new MockMitigationExecutor();
  const mitigationLiveExecutor = new HuaweiMitigationExecutor({
    ssh: mitigationSsh,
    config: mitigationExecutionConfig,
    rt: mitigationEngineConfig.mitigationRt,
    labels: mitigationLabels,
  });
  // F4: MESMA exclusao mutua para UI, n8n, AUTO e APPLY LOCAL do reconciler.
  const mitigationScopeLock = config.DEMO_MODE
    ? new InMemoryPolicyScopeLock()
    : new PrismaPolicyScopeLock(prismaClient);
  // Ligacao tardia: o servico de comandos e criado ANTES do motor AUTO.
  const autoEngineRef: { current: { forgetProfiles(ids: readonly string[]): void } | null } = {
    current: null,
  };
  // KILL SWITCH GLOBAL da execucao automatica. Lido UMA vez no boot (como todo
  // o ENV deste processo): mudar a flag exige restart da API para valer.
  // Desligado, NENHUMA escrita automatica acontece (motor + command service),
  // qualquer que seja a origem do AUTO. Comandos manuais nao sao afetados.
  const autoExecutionEnabled = /^(1|true|yes|on)$/i.test(
    process.env.MITIGATION_AUTO_EXECUTION_ENABLED?.trim() ?? '',
  );

  const mitigationCommands = new MitigationCommandService({
    autoEvidence: (id, evidence) =>
      revalidateAutoEvidence?.(id, evidence) ?? Promise.resolve(false),
    repository: mitigationRepository,
    hosts,
    executor: mitigationExecutor,
    labels: mitigationLabels,
    // OUTBOUND: o dominio publica; a camada de midias decide o transporte.
    notifications: mediaTransport,
    ...(mitigationExecutionConfig.executor === 'HUAWEI' ? { live: mitigationLiveExecutor } : {}),
    // Snapshot do discovery: o preflight compara existingNodes e aborta sem ele.
    expectedNodes: async (profileId) =>
      mitigationService.discoverySnapshot(profileId)?.existingNodes ?? null,
    scopeLock: mitigationScopeLock,
    // Kill switch reconsultado pelo command service imediatamente antes de
    // qualquer escrita de origem AUTO (fail-closed se ausente/erro).
    autoExecutionEnabled: () => autoExecutionEnabled,
    // Retirada manual do escopo fisico: o AUTO perde a sequencia anterior.
    onScopeRemoved: (scope) => autoEngineRef.current?.forgetProfiles(scope.profileIds),
  });

  // ---- S5: DETECCAO separada da AUTORIZACAO de escrita ----------------------
  // Com `MITIGATION_AUTO_EXECUTION_ENABLED=0` o motor deixa de escrever, mas o
  // ataque continua sendo OBSERVADO e precisa gerar alerta. O motor emite UMA
  // vez por EPISODIO (ver `detectionAlertPolicy`); aqui o evento vira payload.
  //
  // Politica de repeticao e EXPLICITA por ENV (sem default ligado):
  //   MITIGATION_AUTO_DETECTION_EPISODE_IDLE_SECONDS (default 120)
  //   MITIGATION_AUTO_DETECTION_REPEAT_SECONDS        (sem valor = sem lembrete)
  const detectionPolicyResolved = resolveDetectionAlertPolicy({
    episodeIdleSeconds: parseOptionalNumber(process.env.MITIGATION_AUTO_DETECTION_EPISODE_IDLE_SECONDS),
    repeatSeconds: parseOptionalNumber(process.env.MITIGATION_AUTO_DETECTION_REPEAT_SECONDS),
    alertIntervalSeconds: parseOptionalNumber(process.env.MITIGATION_AUTO_DETECTION_INTERVAL_SECONDS),
    maxDeliveryAttempts: parseOptionalNumber(process.env.MITIGATION_AUTO_DETECTION_MAX_ATTEMPTS),
  });
  for (const rejected of detectionPolicyResolved.rejected) {
    app.log.warn(
      { env: rejected },
      'valor de ENV de alerta de deteccao recusado (fora da faixa segura); usando default',
    );
  }
  const detectionAlertPolicy = detectionPolicyResolved.policy;

  // Handler do alerta de deteccao: modulo testavel em application/.
  const publishBlockedDetection = createDetectionAlertPublisher({
    hosts,
    transport: mediaTransport,
  });

  // ---- Motor AUTO real: mesmo caminho canônico do ACTIVATE (UI/n8n) --------
  // Default OFF: só liga com MITIGATION_MODE=AUTO. Sem LIVE_WRITE/allowlist ele
  // apenas registra WOULD_ACTIVATE (zero escrita).
  // Direção EXPLÍCITA por profile (fail-closed): "profileId:rx,profileId:tx".
  // Sem entrada para o profile, a telemetria é tratada como indisponível.
  const autoDirections: Record<string, 'rx' | 'tx'> = {};
  for (const entry of (process.env.MITIGATION_AUTO_TRAFFIC_DIRECTIONS ?? '').split(',')) {
    const [profileId, direction] = entry.split(':').map((part) => part.trim());
    if (profileId && (direction === 'rx' || direction === 'tx')) {
      autoDirections[profileId] = direction;
    }
  }
  const autoMaxAgeRaw = Number(process.env.MITIGATION_AUTO_TRAFFIC_MAX_AGE_SECONDS ?? '');
  const autoMaxAgeMs =
    (Number.isFinite(autoMaxAgeRaw) && autoMaxAgeRaw > 0 ? autoMaxAgeRaw : 120) * 1000;

  // ---- AUTO-ALL-PREP-1: direcao POR PERFIL (persistida) + gates de config ---
  // A direcao gravada no perfil vence o ENV legado. Sem nenhum dos dois a
  // direcao continua INDEFINIDA: a telemetria e tratada como indisponivel
  // (fail-closed) e nunca existe default implicito do tipo "tx para todos".
  const resolvedDirections = new Map<
    string,
    { direction: 'rx' | 'tx'; source: 'PROFILE' | 'ENV' | 'INTERFACE' }
  >();
  /**
   * Precedencia (espelha `resolveTelemetryDirection`):
   * override do perfil > ENV legado > direcao herdada da interface > indefinida.
   * Sem nenhuma das tres, a telemetria fica indisponivel (fail-closed): nunca
   * existe direcao implicita por volume de trafego.
   */
  const resolveAutoDirection = (
    profileId: string,
    stored: 'RX' | 'TX' | null | undefined,
    interfaceStored: 'RX' | 'TX' | null | undefined,
  ): { direction: 'rx' | 'tx'; source: 'PROFILE' | 'ENV' | 'INTERFACE' } | null => {
    if (stored === 'RX') return { direction: 'rx', source: 'PROFILE' };
    if (stored === 'TX') return { direction: 'tx', source: 'PROFILE' };
    const envDirection = autoDirections[profileId];
    if (envDirection) return { direction: envDirection, source: 'ENV' };
    if (interfaceStored === 'RX') return { direction: 'rx', source: 'INTERFACE' };
    if (interfaceStored === 'TX') return { direction: 'tx', source: 'INTERFACE' };
    return null;
  };
  // Guarda OPCIONAL para automacao em policy compartilhada. Desligada por
  // padrao: preserva exatamente o comportamento do AUTO atual (BHNET-CEASA,
  // que compartilha a policy com outro cliente). Ligada, exige allowlist.
  const sharedPolicyGuardEnabled = /^(1|true|yes|on)$/i.test(
    process.env.MITIGATION_AUTO_SHARED_POLICY_GUARD?.trim() ?? '',
  );
  const sharedPolicyAllowedProfileIds = (process.env.MITIGATION_AUTO_SHARED_POLICY_ALLOWED ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // Pares IPv4/IPv6 do MESMO escopo aprovados explicitamente para AUTO
  // simultaneo (`idA:idB,idC:idD`). Ausente = nenhum par aprovado.
  const approvedFamilyPairs: [string, string][] = [];
  for (const entry of (process.env.MITIGATION_AUTO_FAMILY_PAIRS_ALLOWED ?? '').split(',')) {
    const [a, b] = entry.split(':').map((part) => part.trim());
    if (a && b && a !== b) approvedFamilyPairs.push([a, b]);
  }

  // ---- AUTO-ALL: AUTO por DESCRIPTION (sweep) + DUAL RX/TX -----------------
  // As DUAS nascem OFF: sem as flags o motor e o sweep publicados ficam byte a
  // byte no comportamento atual (BHNET intacta).
  const autoDescriptionEnabled = /^(1|true|yes|on)$/i.test(
    process.env.MITIGATION_AUTO_DESCRIPTION_ENABLED?.trim() ?? '',
  );
  const autoDualDirectionsEnabled = /^(1|true|yes|on)$/i.test(
    process.env.MITIGATION_AUTO_DUAL_DIRECTIONS?.trim() ?? '',
  );
  // FAMILIA: fase IPv4-only por padrao. IPv6 so entra na promocao automatica
  // com MITIGATION_AUTO_DESCRIPTION_FAMILIES=IPV4,IPV6 (apos validar a acao).
  const configuredFamilies = (process.env.MITIGATION_AUTO_DESCRIPTION_FAMILIES ?? '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part): part is 'IPV4' | 'IPV6' => part === 'IPV4' || part === 'IPV6');
  const autoDescriptionFamilies: readonly ('IPV4' | 'IPV6')[] =
    configuredFamilies.length > 0 ? configuredFamilies : ['IPV4'];
  // LOTES: BATCH_SIZE controla o RITMO, nunca o total autorizado. O sweep roda
  // no boot (pos-reidratacao) e a cada 300 s (5 min): com 15 IPv4 elegiveis,
  // `1` promove ~1 por ciclo (todos em ~70 min, 14 ciclos apos o boot), `5`
  // promove 5 por ciclo (todos em ~10 min) e `unlimited` promove todos no
  // primeiro ciclo. Perfis descobertos depois entram no ciclo seguinte.
  // Semantica UNAMBIGUA:
  // ausente/invalido = 5 (fail-safe); `0` = SEGURA (hold); 1..N = lote;
  // `unlimited` = sem limite. A graduacao e protecao de IMPLANTACAO; para
  // interromper de vez use MITIGATION_AUTO_DESCRIPTION_ENABLED=0.
  const autoDescriptionBatchSize = parseSweepBatchSize(
    process.env.MITIGATION_AUTO_DESCRIPTION_BATCH_SIZE,
  );
  const diagnosticReader = new PrismaMitigationTelemetryReader(prismaClient);
  const telemetryReport = async () =>
    diagnoseMitigationTelemetry(await mitigationService.listProfiles(), {
      readInterface: (id) => diagnosticReader.readInterface(id),
      envDirections: autoDirections,
      maxAgeMs: autoMaxAgeMs,
      authorization: (p, scope) => {
        const blocks: string[] = [];
        if (!p.enabled || p.mode === 'DISABLED') blocks.push('PROFILE_DISABLED');
        if (p.mode !== 'AUTO') blocks.push('PROFILE_MODE_NOT_AUTO');
        if (!autoExecutionEnabled) blocks.push('AUTO_EXECUTION_DISABLED');
        if (p.mitigationExcluded) blocks.push('MITIGATION_EXCLUDED');
        if (mitigationEngineConfig.mode !== 'AUTO') blocks.push('GLOBAL_MODE_SIMULATION_ONLY');
        if (mitigationExecutionConfig.executor !== 'HUAWEI') blocks.push('EXECUTOR_NOT_HUAWEI');
        if (!mitigationExecutionConfig.liveWriteEnabled) blocks.push('LIVE_WRITE_DISABLED');
        if (!mitigationExecutionConfig.allowedDeviceIds.includes(p.deviceId))
          blocks.push('DEVICE_NOT_ALLOWED');
        if (!p.snapshotAvailable) blocks.push('SNAPSHOT_UNAVAILABLE');
        if (p.readiness !== 'READY') blocks.push('TARGET_NOT_READY');
        if (p.prefixStatus === 'UNKNOWN' || p.prefixStatus === 'EXCEEDED')
          blocks.push('PREFIX_NOT_SAFE');
        if (p.blockedReason) blocks.push(p.blockedReason);
        if (
          sharedPolicyGuardEnabled &&
          sharedPolicyAutomationBlocked(p, scope ?? null) &&
          !sharedPolicyAllowedProfileIds.includes(p.id)
        )
          blocks.push('SHARED_POLICY_UNRESOLVED');
        const runtime = autoRuntimeRef?.getStatus();
        if (runtime?.state !== 'RUNNING' || runtime.lastError) blocks.push('ENGINE_NOT_READY');
        // A diagnostic never grants authorization beyond the latest real engine evaluation.
        const decision = runtime?.decisions.find((d) => d.profileId === p.id);
        if (!decision || Date.now() - new Date(decision.at).getTime() > 30_000)
          blocks.push('ENGINE_EVALUATION_UNAVAILABLE');
        else if (decision.outcome === 'BLOCKED' || decision.outcome === 'FAILED')
          blocks.push(decision.reason ?? 'ENGINE_BLOCKED');
        return blocks;
      },
    });
  const directionReview = new MitigationDirectionReview({
    store: new PrismaDirectionReviewStore(prismaClient),
    telemetry: telemetryReport,
    envDirections: autoDirections,
  });

  const fastConfig = fastPollerConfig();
  const bridgeConfig = fastBridgeConfig();
  const observationUrl = process.env.MITIGATION_FAST_OBSERVATION_DATABASE_URL;
  if (
    bridgeConfig.mode !== 'OFF' &&
    (!observationUrl ||
      new URL(observationUrl).pathname ===
        new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname)
  )
    throw new Error('Separate read-only observation database URL required');
  const observationDb =
    bridgeConfig.mode === 'OFF'
      ? null
      : new PrismaClient({ datasources: { db: { url: observationUrl! } } });
  const bridgeProfiles = new Map<string, FastBridgeProfile>();
  const bridgeReader = observationDb
    ? new PrismaFastBridgeReader(prismaClient, observationDb, () =>
        readObserverHealth(
          process.env.MITIGATION_FAST_OBSERVER_HEALTH_URL ?? 'http://127.0.0.1:3355/health',
        ),
      )
    : {
        snapshot: async () => {
          throw new Error('Bridge disabled');
        },
      };
  const bridgeSource = new FastObservationSource({
    config: bridgeConfig,
    reader: bridgeReader,
    profile: (id) => bridgeProfiles.get(id) ?? null,
  });
  const fastStore = new PrismaFastTrafficStore(prismaClient);
  const fastPoller = new FastTrafficPoller({
    config: fastConfig,
    listTargets: () =>
      listFastTrafficTargets({
        profileIds: fastConfig.profileIds,
        telemetryProfileIds: fastConfig.telemetryProfileIds,
        allowedDeviceIds: mitigationExecutionConfig.allowedDeviceIds,
        listProfiles: () => mitigationRepository.listProfiles(),
        hosts,
        direction: (p) =>
          resolveAutoDirection(p.id, p.autoTrafficDirection, p.interfaceTrafficDirection)
            ?.direction ?? null,
      }),
    reader: new FastSnmpReader(hosts, new SnmpClientImpl(fastConfig.timeoutMs, fastConfig.retries)),
    store: fastStore,
    logger: (message, meta) => app.log.info(meta, message),
  });
  const legacyTraffic = new InterfaceTrafficSource(new PrismaInterfaceTrafficReader(prismaClient), {
    directionByProfile: autoDirections,
    resolveDirection: (target) => resolvedDirections.get(target.profileId)?.direction ?? null,
    maxAgeMs: autoMaxAgeMs,
  });
  const priorityTraffic = new PriorityTrafficSource({
    config: fastConfig,
    store: fastStore,
    legacy: legacyTraffic,
    direction: (id) => resolvedDirections.get(id)?.direction ?? null,
    available: (id) => fastPoller.isAvailable(id),
  });
  const effectiveTraffic = new FastBridgeRoutingSource(bridgeConfig, bridgeSource, priorityTraffic);
  const samplingForProfile = (profileId: string) =>
    samplingWindowForProfile(profileId, {
      legacyMaxAgeMs: autoMaxAgeMs,
      bridge: bridgeConfig,
      embedded: fastConfig,
    });
  revalidateAutoEvidence = async (id, evidence) => {
    if (!evidence) return false;
    const profile = await mitigationRepository.getProfile(id);
    if (!profile || !profile.enabled || profile.mode !== 'AUTO' || profile.mitigationExcluded)
      return false;
    // Kill switch global: vale para toda origem AUTO, nao so para o promovido.
    if (!autoExecutionEnabled) return false;
    if (profile.autoModeExempt) return false;
    const currentPeers = await mitigationRepository.listProfilePeers(id);
    if (
      (
        await mitigationRepository.listPeerExclusions({
          deviceId: profile.deviceId,
          peerAddresses: currentPeers.map((p) => p.peerAddress),
        })
      ).length > 0
    )
      return false;
    const direction = resolveAutoDirection(
      id,
      profile.autoTrafficDirection,
      profile.interfaceTrafficDirection,
    )?.direction;
    if (!direction || direction !== resolvedDirections.get(id)?.direction) return false;
    if (bridgeConfig.mode === 'ENFORCE' && bridgeConfig.enforceProfileIds.includes(id)) {
      if (
        direction !== 'tx' ||
        bridgeProfiles.get(id)?.revision !== fastProfileRevision({ profile, direction })
      )
        return false;
    }
    const bandwidthBps = profile.bandwidthOverrideBps ?? profile.detectedBandwidthBps;
    if (!bandwidthBps) return false;
    const sample = await effectiveTraffic.sampleWithId({
      profileId: id,
      deviceId: profile.deviceId,
      interfaceId: profile.interfaceId,
      bandwidthBps,
    });
    if (!matchesAutoEvidence(sample, evidence, samplingForProfile(id), Date.now()))
      return false;
    return sample.bps > (bandwidthBps * BigInt(profile.triggerPercent)) / 100n;
  };
  const autoTargets = {
    list: async (profileIds?: readonly string[]) => {
      if (bridgeConfig.mode !== 'OFF')
        await prismaClient.$queryRaw`SELECT 1 FROM "BgpMitigationProfile" LIMIT 1`;
      const [dtos, records] = await Promise.all([
        mitigationService.listProfiles(profileIds),
        mitigationRepository.listProfiles(),
      ]);
      const byId = new Map(records.map((record) => [record.id, record]));
      const sharedScopes = sharedPolicyScopes(dtos);
      return dtos
        .filter((dto) => dto.persisted)
        .map((dto) => {
          const record = byId.get(dto.id);
          // Direcao efetiva resolvida NO INICIO DO TICK: e a mesma fonte
          // consumida pela telemetria logo abaixo (sem segunda leitura).
          const resolved = resolveAutoDirection(
            dto.id,
            record?.autoTrafficDirection ?? null,
            record?.interfaceTrafficDirection ?? null,
          );
          if (resolved) resolvedDirections.set(dto.id, resolved);
          else resolvedDirections.delete(dto.id);
          const revision = fastProfileRevision({
            profile: record,
            direction: resolved?.direction ?? null,
          });
          bridgeProfiles.set(dto.id, {
            profileId: dto.id,
            deviceId: dto.deviceId,
            interfaceId: dto.interfaceId,
            direction: resolved?.direction ?? null,
            revision,
          });
          return {
            ...(bridgeConfig.profileIds.includes(dto.id) ? { configurationKey: revision } : {}),
            ...(bridgeConfig.mode === 'ENFORCE' && bridgeConfig.enforceProfileIds.includes(dto.id)
              ? { activationDirection: 'tx' as const }
              : {}),
            profileId: dto.id,
            deviceId: dto.deviceId,
            policyName: dto.policyName,
            interfaceId: dto.interfaceId,
            customer: dto.customer,
            mode: dto.mode,
            addressFamily: dto.addressFamily,
            direction: resolved?.direction ?? null,
            directionSource: resolved?.source ?? null,
            // AUTO-ALL: proveniencia decide se o controle de execucao pausa
            // NOVAS ativacoes deste perfil (AUTO manual nunca e pausado).
            autoPromotedBySweep: dto.autoPromotedBySweep === true,
            sharedPolicyAutomationBlocked: sharedPolicyAutomationBlocked(
              dto,
              sharedScopes.get(dto.id) ?? null,
            ),
            readiness: dto.readiness,
            snapshotAvailable: dto.snapshotAvailable,
            prefixStatus: dto.prefixStatus,
            blockedReason: dto.blockedReason,
            mitigationExcluded: dto.mitigationExcluded === true,
            runtimeState: (dto.runtimeState as MitigationState | null) ?? null,
            effectiveBandwidthBps:
              record?.bandwidthOverrideBps ?? record?.detectedBandwidthBps ?? null,
            bogonNode: dto.plannedBogonNode ?? null,
            mitigationNode: dto.plannedMitigationNode ?? null,
            sharedPolicy: dto.sharedPolicy,
            peerAddresses: dto.peerAddresses,
            triggerPercent: record?.triggerPercent ?? mitigationEngineConfig.triggerPercent,
            recoveryPercent: record?.recoveryPercent ?? mitigationEngineConfig.recoveryPercent,
            triggerSamples: record?.triggerSamples ?? mitigationEngineConfig.triggerSamples,
            recoverySamples: record?.recoverySamples ?? mitigationEngineConfig.recoverySamples,
          };
        });
    },
  };
  const mitigationAutoEngine = new MitigationAutoEngine({
    sampling: (target) => samplingForProfile(target.profileId),
    evaluationScope: 'OPERATIONAL',
    // Somente a fonte FAST exige leitura de runtime; LEGACY mantem a tolerancia
    // publicada (o bridge em SHADOW nao adiciona dependencia ao motor legado).
    requireRuntimeRead: (target) =>
      isFastRoutedProfile(target.profileId, { bridge: bridgeConfig, embedded: fastConfig }),
    evaluationConcurrency: fastConfig.mode === 'OFF' && bridgeConfig.mode === 'OFF' ? 1 : 2,
    globalMode: mitigationEngineConfig.mode,
    execution: {
      executor: mitigationExecutionConfig.executor,
      liveWrite: mitigationExecutionConfig.liveWriteEnabled,
      allowedDeviceIds: mitigationExecutionConfig.allowedDeviceIds,
    },
    targets: autoTargets,
    traffic: effectiveTraffic,
    exclusions: {
      listPeerExclusions: (filter) => mitigationRepository.listPeerExclusions(filter),
    },
    runtime: {
      get: (profileId) => mitigationRepository.getRuntime(profileId),
      save: async (profileId, patch) => {
        await mitigationRepository.upsertRuntime(profileId, patch);
      },
    },
    // Origem declarada pela fiacao (nunca pelo HTTP): o command service aplica
    // o kill switch a todo comando que sai do motor.
    commands: { execute: (input) => mitigationCommands.execute({ ...input, origin: 'AUTO' }) },
    sharedPolicyGuard: {
      enabled: sharedPolicyGuardEnabled,
      allowedProfileIds: sharedPolicyAllowedProfileIds,
    },
    approvedFamilyPairs,
    dualDirections: { enabled: autoDualDirectionsEnabled },
    // Controle de EXECUCAO (distinto da autorizacao por DESCRIPTION).
    executionControl: {
      enabled: autoExecutionEnabled,
      allowedProfileIds: (process.env.MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
      legacyExemptProfileIds: (process.env.MITIGATION_AUTO_EXECUTION_LEGACY_PROFILE_IDS ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    },
    // Decisao normal repetida NAO vira linha INFO: transicoes de estado/motivo,
    // operacoes reais e falhas continuam no INFO; o detalhe por tick fica no
    // DEBUG e as decisoes suprimidas saem no resumo periodico.
    logger: (message, meta) => app.log.info(meta ?? {}, message),
    debugLogger: (message, meta) => app.log.debug(meta ?? {}, message),
    // S5: alerta de deteccao bloqueada (uma vez por EPISODIO, best effort).
    onBlockedActivation: publishBlockedDetection,
    detectionAlertPolicy,
  });
  autoEngineRef.current = mitigationAutoEngine;
  const autoTickLock = new PrismaPolicyScopeLock(prismaClient);
  autoRuntimeRef = new MitigationAutoRuntime({
    engine: {
      tick: async () => {
        const tick = async () => {
          const decisions = await mitigationAutoEngine.tick();
          if (bridgeConfig.mode === 'ENFORCE')
            await recordFastBridgeDecisions(
              prismaClient,
              'ENFORCE',
              decisions.filter((d) => bridgeConfig.enforceProfileIds.includes(d.profileId)),
              bridgeSource,
            );
          return decisions;
        };
        return config.DEMO_MODE
          ? tick()
          : autoTickLock.run(
              { deviceId: 'NETVISION', policyName: 'AUTO_ENGINE_SINGLE_WRITER' },
              tick,
            );
      },
    },
    intervalMs: Math.max(1000, mitigationEngineConfig.checkIntervalSeconds * 1000),
    logger: (message, meta) => app.log.info(meta ?? {}, message),
  });
  const shadowEngine = new MitigationAutoEngine({
    // O shadow consome EXCLUSIVAMENTE a fonte FAST: janela FAST e escopo
    // hipotético (nunca avalia gates de escrita nem o runtime operacional).
    sampling: { maxAgeMs: bridgeConfig.maxAgeMs, maxGapMs: bridgeConfig.maxGapMs },
    evaluationScope: 'SHADOW',
    globalMode: 'SIMULATION_ONLY',
    execution: { executor: 'MOCK', liveWrite: false, allowedDeviceIds: [] },
    requireRuntimeRead: false,
    targets: {
      list: async () =>
        (await autoTargets.list(bridgeConfig.profileIds)).filter(
          (t) =>
            bridgeConfig.profileIds.includes(t.profileId) &&
            // Perfis com semântica de ENFORCE e perfis ROTEADOS para FAST saem do
            // motor de shadow: os primeiros já são avaliados pelo motor real; os
            // segundos passam a ser avaliados por ele com a MESMA fonte FAST
            // (e continuam sem escrever enquanto o HOLD estiver ativo).
            !(
              bridgeConfig.mode === 'ENFORCE' &&
              bridgeConfig.enforceProfileIds.includes(t.profileId)
            ) &&
            !fastRoutingActive(bridgeConfig, t.profileId),
        ),
    },
    traffic: bridgeSource,
    runtime: new PrismaFastShadowRuntime(prismaClient, mitigationRepository),
    exclusions: { listPeerExclusions: (filter) => mitigationRepository.listPeerExclusions(filter) },
    commands: {
      execute: async () => {
        throw new Error('SHADOW_HAS_NO_EXECUTOR');
      },
    },
    executionControl: { enabled: autoExecutionEnabled },
    sharedPolicyGuard: {
      enabled: sharedPolicyGuardEnabled,
      allowedProfileIds: sharedPolicyAllowedProfileIds,
    },
    approvedFamilyPairs,
    dualDirections: { enabled: autoDualDirectionsEnabled },
    evaluationConcurrency: 2,
  });
  const shadowRuntime = new MitigationAutoRuntime({
    intervalMs: Math.max(1000, mitigationEngineConfig.checkIntervalSeconds * 1000),
    engine: {
      tick: async () => {
        const decisions = await shadowEngine.tick();
        await recordFastBridgeDecisions(prismaClient, 'SHADOW', decisions, bridgeSource);
        return decisions;
      },
    },
  });
  app.get('/api/bgp/mitigation/fast-bridge', async () => ({
    generatedAt: new Date().toISOString(),
    mode: bridgeConfig.mode,
    fallback: 'FAIL_CLOSED_NO_LEGACY_FALLBACK',
    source: 'EXTERNAL_OBSERVER_DATABASE',
    executionAvailable: bridgeConfig.mode === 'ENFORCE',
    shadowExecutionAvailable: false,
    profileIds: bridgeConfig.profileIds,
    enforceProfileIds: bridgeConfig.mode === 'ENFORCE' ? bridgeConfig.enforceProfileIds : [],
    samples: bridgeSource.status(),
    shadow: shadowRuntime.getStatus(),
    engine: autoRuntimeRef?.getStatus() ?? null,
    decisions: [
      ...shadowEngine.getDecisions(),
      ...mitigationAutoEngine
        .getDecisions()
        .filter(
          (d) =>
            bridgeConfig.mode === 'ENFORCE' && bridgeConfig.enforceProfileIds.includes(d.profileId),
        ),
    ],
    inFlightProfileIds: bridgeConfig.profileIds.filter(id => mitigationAutoEngine.isBusy(id)),
    responseBudgetMs: 60_000,
    sshMetrics: mitigationSshMetrics,
  }));
  if (!config.DEMO_MODE && bridgeConfig.mode !== 'OFF') shadowRuntime.start();
  app.get('/api/bgp/mitigation/fast-poller', async () => ({
    ...fastPoller.status(),
    profiles: fastConfig.profileIds.map((profileId) => {
      const decision =
        mitigationAutoEngine.getDecisions().find((d) => d.profileId === profileId) ?? null;
      const phase = mitigationAutoEngine.isBusy(profileId)
        ? 'MITIGATING'
        : decision?.outcome === 'ACTIVATED' || decision?.runtimeState === 'MITIGATED'
          ? 'COOLDOWN'
          : decision && decision.samplesOver >= decision.requiredSamples
            ? 'CONFIRMED_ATTACK'
            : decision && decision.samplesOver > 0
              ? 'SUSPECTED_ATTACK'
              : 'NORMAL';
      return {
        profileId,
        phase,
        decision,
        history: mitigationAutoEngine.getDecisionHistory(profileId),
      };
    }),
    engine: autoRuntimeRef?.getStatus() ?? null,
    responseBudgetMs: 60_000,
    // Unmet deadlines remain visible while a command or engine tick is still in flight.
    pendingDeadlineViolations: mitigationAutoEngine
      .getDecisions()
      .filter(
        (d) =>
          d.firstAbnormalAt &&
          d.outcome !== 'ACTIVATED' &&
          Date.now() - new Date(d.firstAbnormalAt).getTime() > 60_000,
      )
      .map((d) => d.profileId),
  }));
  if (!config.DEMO_MODE) fastPoller.start();
  // ---- AUTO-ALL: AUTO derivado da DESCRIPTION ------------------------------
  // Sweep idempotente que escreve SOMENTE `mode` + a PROVENIENCIA do AUTO.
  // Nunca toca runtime, mitigacao, Huawei, exclusoes administrativas ou direcao.
  // Com a flag OFF e no-op. A retirada de autorizacao NUNCA remove mitigacao: o
  // REMOVE permanece 100% manual. A promocao e GRADUAL (lotes) e a ordem e
  // deterministica; `batchSize=0` desliga o fatiamento (protecao de implantacao).
  const autoDescriptionSweep = new MitigationAutoDescriptionSweep({
    enabled: autoDescriptionEnabled,
    families: autoDescriptionFamilies,
    batchSize: autoDescriptionBatchSize,
    // PILOTO DIRECIONADO (opcional): vazio = todos os elegiveis (comportamento
    // anterior). Com ids, o sweep promove SOMENTE esses perfis.
    allowedProfileIds: (process.env.MITIGATION_AUTO_DESCRIPTION_ALLOWED_PROFILE_IDS ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    listProfiles: async () =>
      (await mitigationService.listProfiles()).map((dto) => ({
        id: dto.id,
        persisted: dto.persisted,
        addressFamily: dto.addressFamily,
        policyName: dto.policyName,
        interfaceName: dto.interfaceName,
        mode: dto.mode,
        autoModeExempt: dto.autoModeExempt === true,
        promotedBySweep: dto.autoPromotedBySweep === true,
        autoState: dto.autoState ?? 'OFF',
        autoStateReason: dto.autoStateReason ?? null,
      })),
    setMode: (id, mode) => mitigationRepository.setProfileMode(id, mode),
    setProvenance: (id, promoted) =>
      mitigationRepository.setProfileAutoPromotedBySweep(id, promoted),
    logger: (message, meta) => app.log.info(meta ?? {}, message),
  });
  const runAutoDescriptionSweep = async (): Promise<void> => {
    try {
      const summary = await autoDescriptionSweep.run();
      if (!summary.enabled) return;
      app.log.info(
        {
          evaluated: summary.evaluated,
          promoted: summary.promoted.length,
          demoted: summary.demoted.length,
          blocked: summary.blocked.length,
          skippedExempt: summary.skippedExempt,
          skippedDisabled: summary.skippedDisabled,
          skippedFamily: summary.skippedFamily,
          heldByBatch: summary.heldByBatch,
          held: summary.held,
          skippedConcurrent: summary.skippedConcurrent,
          promotedTotal: summary.promotedTotal,
          families: autoDescriptionFamilies,
          batchSize: summary.batchSize,
          executionEnabled: autoExecutionEnabled,
        },
        'auto: sweep de autorizacao por DESCRIPTION',
      );
    } catch (error) {
      app.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'auto: falha no sweep de autorizacao por DESCRIPTION',
      );
    }
  };
  const autoDescriptionSweepTimer = setInterval(() => void runAutoDescriptionSweep(), 300_000);
  autoDescriptionSweepTimer.unref();
  if (mitigationEngineConfig.mode === 'AUTO') {
    autoRuntimeRef.start();
    app.log.warn(
      {
        executor: mitigationExecutionConfig.executor,
        liveWrite: mitigationExecutionConfig.liveWriteEnabled,
        directions: Object.keys(autoDirections).length,
      },
      'motor AUTO habilitado (fail-closed por gates)',
    );
  }
  app.addHook('onClose', async () => {
    await fastPoller.stop();
    autoRuntimeRef?.stop();
    shadowRuntime.stop();
    await observationDb?.$disconnect();
    clearInterval(autoDescriptionSweepTimer);
  });
  registerN8nRoutes(app, {
    commands: mitigationCommands,
    // ENV legado continua valendo como fallback.
    commandToken: process.env.NETVISION_N8N_COMMAND_TOKEN?.trim() || null,
    // Token persistido na tela de MIDIAS vence o ENV quando existir.
    resolveCommandToken: async () => (await mediaService.resolveInboundToken()).token,
    onCommandResult: async (log) => {
      // Anexa o comando recebido a integracao persistida (quando existir), para
      // a tela de MIDIAS mostrar "ultimo comando recebido".
      const inbound = await mediaService.resolveInboundToken();
      return mediaService.recordInboundDelivery({
        integrationId: inbound.integrationId,
        requestId: log.requestId,
        action: log.action,
        profileId: log.profileId,
        status: log.status,
        httpStatus: log.httpStatus,
        ok: log.ok,
        idempotent: log.idempotent,
        safeError: log.safeError,
      });
    },
  });
  // Reconciliacao por policy fisica: leitura SEMPRE pelo mesmo executor
  // read-only do comando (display route-policy); o apply grava apenas runtime.
  const mitigationReconciler = new MitigationPolicyReconciler({
    repository: mitigationRepository,
    hosts,
    readPolicy: (device, policyName) => mitigationLiveExecutor.readRoutePolicy(device, policyName),
    labels: mitigationLabels,
    lock: mitigationScopeLock,
  });

  registerMitigationRoutes(app, {
    service: mitigationService,
    telemetry: telemetryReport,
    directionReview,
    // mesma instancia do n8n: UI e n8n passam pelo MESMO servico
    commands: mitigationCommands,
    // identidade do peer para a exclusao preventiva (sem profile)
    peers: bgpRepository,
    reconciler: mitigationReconciler,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
    // Relatorio de SOMBRA do AUTO (somente leitura): decisoes por perfil +
    // direcao efetiva, sem qualquer escrita no equipamento.
    autoShadow: async () => {
      const [profiles, status] = await Promise.all([
        mitigationService.listProfiles(),
        Promise.resolve(autoRuntimeRef?.getStatus() ?? null),
      ]);
      return buildAutoShadowReport({
        generatedAt: new Date().toISOString(),
        profiles,
        runtime: status,
      });
    },
    autoEnablement: {
      sharedPolicyGuardEnabled,
      sharedPolicyAllowedProfileIds,
      envDirections: autoDirections,
      approvedFamilyPairs,
    },
  });
  registerMediaRoutes(app, {
    media: mediaService,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });
  registerSnapshotRoutes(app, {
    getInterfaceHistory: (interfaceId, period) => hosts.getInterfaceHistory(interfaceId, period),
    getInterfaceOpticalHistory: (interfaceId, period) =>
      hosts.getInterfaceOpticalHistory(interfaceId, period),
    signingKey: config.SNAPSHOT_SIGNING_KEY ?? null,
    cacheDir: config.SNAPSHOT_CACHE_DIR,
    ttlSeconds: config.SNAPSHOT_TTL_SECONDS,
  });
  registerPhysicalRoutes(app, {
    repository: physicalRepository,
    service: physicalService,
    enforcePermissions: options.requireAuth ?? !config.DEMO_MODE,
    currentUser: (request) => auth.userForToken(request.cookies.netvision_session),
  });

  app.addHook('onReady', async () => {
    // Idempotent SYSTEM catalog bootstrap (matched by catalogKey).
    //
    // Only a genuinely missing schema (migration not applied yet) is downgraded
    // to a warning. A broken `physical-catalog-v1.yaml`, a duplicate catalogKey
    // or any other programming error is logged as an error instead of being
    // hidden behind the "migration pending" message.
    try {
      const bootstrap = await physicalService.bootstrapCatalog();
      if (bootstrap.source !== 'yaml') {
        app.log.warn(
          { source: bootstrap.source, path: bootstrap.path, warnings: bootstrap.warnings },
          'catálogo físico carregado do fallback embutido',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isPendingMigrationError(error)) {
        app.log.warn(
          { error: message },
          'catálogo físico não sincronizado: aplique a migration do módulo físico',
        );
      } else if (error instanceof PhysicalCatalogError) {
        app.log.error(
          { error: message, details: error.details },
          'physical-catalog-v1.yaml inválido: o catálogo SYSTEM não foi sincronizado',
        );
      } else {
        app.log.error({ error: message }, 'falha inesperada ao sincronizar o catálogo físico');
      }
    }
    // Reidratação READ-ONLY dos snapshots de mitigação após restart: repovoa o
    // cache de discovery (cliente/interface/prefixos/readiness) sem clique manual
    // e sem qualquer escrita no Huawei. Não bloqueia o startup.
    if (!config.DEMO_MODE) {
      void mitigationService.rehydrateSnapshots().then(
        (summary) => {
          app.log.info(
            { devices: summary.devices, succeeded: summary.succeeded, failed: summary.failed },
            'reidratacao dos snapshots de mitigacao concluida',
          );
          // Depois do rehydrate o snapshot/readiness e REAL: e o momento
          // correto para o sweep de autorizacao por DESCRIPTION.
          void runAutoDescriptionSweep();
        },
        (error: unknown) =>
          app.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'falha na reidratacao dos snapshots de mitigacao',
          ),
      );
    }
    if (config.DEMO_MODE) {
      await auth.ensureDefaultAdmin({
        username: 'admin',
        email: 'admin@netvision.local',
        name: 'Administrador',
        password: config.DEMO_ADMIN_PASSWORD,
      });
    } else {
      await auth.ensureDefaultAdmin({
        username: config.DEFAULT_ADMIN_USERNAME,
        email: config.DEFAULT_ADMIN_EMAIL,
        name: config.DEFAULT_ADMIN_NAME,
        password: config.DEFAULT_ADMIN_PASSWORD,
      });
    }
    if (productionMaps && !(await productionMaps.listMaps()).length) {
      await productionMaps.createMap({
        name: 'Mapa Principal',
        description: 'Topologia persistida do NetVision',
        mode: 'HYBRID',
        sourceMapId: null,
      });
    }
    if (!config.DEMO_MODE && config.SNMP_POLLING_ENABLED) poller.start();
  });
  app.addHook('onClose', async () => {
    poller.stop();
    // Fase Prisma-pool: os repositorios compartilham UM client, entao um unico
    // disconnect encerra todas as conexoes do processo.
    await physicalRepository.disconnect();
    await disconnectPrismaClient();
  });

  app.get('/health', async () => ({
    status: 'ok',
    demoMode: config.DEMO_MODE,
    snmpPolling: !config.DEMO_MODE && config.SNMP_POLLING_ENABLED,
  }));

  // ---- Authentication ----
  const isPublicApiPath = (pathname: string) =>
    pathname === '/api/auth/login' ||
    pathname.startsWith('/api/public/') ||
    // n8n inbound tem autenticacao propria por token (Bearer)
    pathname === '/api/integrations/n8n/mitigation-command';

  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (!pathname.startsWith('/api/') || isPublicApiPath(pathname)) return;
    if (!(options.requireAuth ?? !config.DEMO_MODE)) return;
    const user = await auth.userForToken(request.cookies.netvision_session);
    if (!user) return reply.code(401).send({ message: 'Não autenticado' });
    (request as { user?: AuthUser }).user = user;
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { usernameOrEmail, password } = loginSchema.parse(request.body);
    const result = await auth.login(usernameOrEmail, password);
    if (!result) return reply.code(401).send({ message: 'Credenciais inválidas' });
    reply.setCookie('netvision_session', result.token, {
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      path: '/',
      maxAge: config.SESSION_TTL_DAYS * 86_400,
    });
    return { user: result.user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies.netvision_session);
    reply.clearCookie('netvision_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await auth.userForToken(request.cookies.netvision_session);
    if (!user) return reply.code(401).send({ message: 'Não autenticado' });
    return { user };
  });

  // ---- User management (ADMIN only) ----
  const currentUser = (request: unknown): AuthUser | null =>
    (request as { user?: AuthUser }).user ?? null;
  const isAdmin = (request: unknown): boolean => currentUser(request)?.role === 'ADMIN';

  app.get('/api/users', async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ message: 'Apenas administradores' });
    return auth.listUsers();
  });

  app.post('/api/users', async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ message: 'Apenas administradores' });
    try {
      return reply.code(201).send(await auth.createUser(createUserSchema.parse(request.body)));
    } catch (error) {
      if (error instanceof UserAlreadyExistsError) {
        return reply.code(409).send({ message: error.message });
      }
      throw error;
    }
  });

  app.patch('/api/users/:id', async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ message: 'Apenas administradores' });
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      const updated = await auth.updateUser(
        id,
        updateUserSchema.parse(request.body) as UpdateUserInput,
      );
      return updated ?? reply.code(404).send({ message: 'Usuário não encontrado' });
    } catch (error) {
      if (error instanceof UserAlreadyExistsError) {
        return reply.code(409).send({ message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/users/:id/password', async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ message: 'Apenas administradores' });
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { password } = z.object({ password: z.string().min(6).max(1024) }).parse(request.body);
    const changed = await auth.setUserPassword(id, password);
    return changed ? { ok: true } : reply.code(404).send({ message: 'Usuário não encontrado' });
  });

  app.post('/api/users/me/password', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ message: 'Não autenticado' });
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
    const changed = await auth.changeOwnPassword(user.id, currentPassword, newPassword);
    if (!changed) return reply.code(401).send({ message: 'Senha atual inválida' });
    return { ok: true };
  });

  // ---- Public read-only views ----
  const toPublicDevice = (host: HostRecord): Device => ({
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    ip: host.ip,
    vendor: host.vendor,
    model: host.model,
    status: host.status,
    deviceType: host.deviceType,
    site: host.site,
    source: host.source,
    discoveryMethod: host.discoveryMethod,
    uptimeSeconds: host.uptimeSeconds,
    ...(host.cpuPercent !== undefined ? { cpuPercent: host.cpuPercent } : {}),
    ...(host.memoryPercent !== undefined ? { memoryPercent: host.memoryPercent } : {}),
    pppSupported: host.pppSupported,
    pppOnline: host.pppOnline,
    pppUpdatedAt: host.pppUpdatedAt,
    pppSource: host.pppSource,
    updatedAt: host.updatedAt,
    interfaces: host.interfaces,
  });

  const toPublicMap = (map: NetworkMap): PublicMapView => ({
    id: map.id,
    name: map.name,
    description: map.description,
    mode: map.mode,
    settings: map.settings,
    nodes: map.nodes,
    devices: map.devices.map(toPublicDevice),
    links: map.links,
    widgets: map.widgets,
    updatedAt: map.updatedAt,
  });

  const toPublicView = (view: PublicViewRecord): PublicView => ({
    id: view.id,
    token: view.token,
    name: view.name,
    type: view.type,
    mapId: view.mapId,
    playlistId: view.playlistId,
    enabled: view.enabled,
    expiresAt: view.expiresAt ? view.expiresAt.toISOString() : null,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  });

  const publicViewContainsHost = async (token: string, hostId: string): Promise<boolean> => {
    const view = await publicViewRepository.findByToken(token);
    if (!view || !view.enabled || (view.expiresAt && view.expiresAt.getTime() < Date.now()))
      return false;
    if (view.type === 'MAP') {
      const map = await maps.getMap(view.mapId ?? '');
      return Boolean(map?.devices.some((device) => device.id === hostId));
    }
    const playlist = (await maps.listPlaylists()).find((item) => item.id === view.playlistId);
    if (!playlist) return false;
    const playlistMaps = await Promise.all(playlist.items.map((item) => maps.getMap(item.mapId)));
    return playlistMaps.some((map) => map?.devices.some((device) => device.id === hostId));
  };

  app.get('/api/public/view/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.params);
    const view = await publicViewRepository.findByToken(token);
    if (!view || !view.enabled) {
      return reply.code(404).send({ message: 'Link público não encontrado' });
    }
    if (view.expiresAt && view.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ message: 'Link público expirado' });
    }

    if (view.type === 'MAP') {
      const map = await maps.getMap(view.mapId ?? '');
      if (!map) return reply.code(404).send({ message: 'Mapa não encontrado' });
      return { type: 'MAP' as const, map: toPublicMap(map) } satisfies PublicViewResponse;
    }

    const playlists = await maps.listPlaylists();
    const playlist = playlists.find((item) => item.id === view.playlistId);
    if (!playlist) return reply.code(404).send({ message: 'Playlist não encontrada' });
    const playlistMaps = (await Promise.all(playlist.items.map((item) => maps.getMap(item.mapId))))
      .filter((item): item is NetworkMap => Boolean(item))
      .map(toPublicMap);
    return {
      type: 'NOC' as const,
      playlist: {
        id: playlist.id,
        name: playlist.name,
        rotationIntervalSeconds: playlist.rotationIntervalSeconds,
        maps: playlistMaps,
      },
    } satisfies PublicViewResponse;
  });

  // ---- Public view management (authenticated) ----
  app.get('/api/public-views', async () => {
    const views = await publicViewRepository.list();
    return views.map(toPublicView);
  });

  app.post('/api/public-views', async (request, reply) => {
    const body = publicViewSchema.parse(request.body);
    const view = await publicViewRepository.create({
      token: randomToken(),
      name: body.name,
      type: body.type as PublicViewType,
      mapId: body.mapId ?? null,
      playlistId: body.playlistId ?? null,
      expiresAt: body.expiresAt ?? null,
    });
    return reply.code(201).send(toPublicView(view));
  });

  app.patch('/api/public-views/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = publicViewPatchSchema.parse(request.body);
    const view = await publicViewRepository.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    });
    return view
      ? toPublicView(view)
      : reply.code(404).send({ message: 'Link público não encontrado' });
  });

  app.delete('/api/public-views/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return (await publicViewRepository.remove(id))
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Link público não encontrado' });
  });

  app.get('/api/maps', async () => maps.listMaps());

  app.get('/api/maps/default', async (_request, reply) => {
    const map = await maps.getDefaultMap();
    return map ?? reply.code(404).send({ message: 'No maps available' });
  });

  app.post('/api/maps', async (request, reply) => {
    const map = await maps.createMap(createMapSchema.parse(request.body));
    return reply.code(201).send(map);
  });

  app.patch('/api/maps/:mapId', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const map = await maps.updateMap(mapId, updateMapSchema.parse(request.body) as UpdateMapInput);
    return map ?? reply.code(404).send({ message: 'Map not found' });
  });

  app.post('/api/maps/:mapId/duplicate', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const source = await maps.getMap(mapId);
    if (!source) return reply.code(404).send({ message: 'Map not found' });
    const body = z
      .object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() })
      .parse(request.body);
    return reply.code(201).send(
      await maps.createMap({
        name: body.name,
        description: body.description ?? source.description,
        mode: source.mode,
        sourceMapId: mapId,
      }),
    );
  });

  app.delete('/api/maps/:mapId', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    return (await maps.deleteMap(mapId))
      ? reply.code(204).send()
      : reply.code(409).send({ message: 'Map not found or last remaining map' });
  });

  app.get('/api/playlists', async () => maps.listPlaylists());

  app.post('/api/playlists', async (request, reply) => {
    const body = z
      .object({
        id: z.string().optional(),
        name: z.string().min(1).max(80),
        rotationIntervalSeconds: z.number().int().min(5).max(86_400),
        mapIds: z.array(z.string()).min(1),
        isDefault: z.boolean().default(false),
      })
      .parse(request.body);
    const playlistInput = {
      ...(body.id ? { id: body.id } : {}),
      name: body.name,
      rotationIntervalSeconds: body.rotationIntervalSeconds,
      mapIds: body.mapIds,
      isDefault: body.isDefault,
    };
    return reply.code(201).send(await maps.savePlaylist(playlistInput));
  });

  app.get('/api/maps/:mapId', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const map = await maps.getMap(mapId);
    return map ?? reply.code(404).send({ message: 'Map not found' });
  });

  app.put('/api/maps/:mapId/nodes/positions', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const body = z.object({ nodes: z.array(positionSchema).min(1) }).parse(request.body);
    const map = await maps.updatePositions(
      mapId,
      body.nodes.map((node) => ({
        nodeId: node.nodeId,
        position: node.position,
        ...(node.positionSource === undefined ? {} : { positionSource: node.positionSource }),
        ...(node.locked === undefined ? {} : { locked: node.locked }),
      })),
    );
    return map ?? reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/nodes/:nodeId/lock', async (request, reply) => {
    const { mapId, nodeId } = nodeParams.parse(request.params);
    const { locked } = z.object({ locked: z.boolean() }).parse(request.body);
    const map = await maps.setNodeLocked(mapId, nodeId, locked);
    return map ?? reply.code(404).send({ message: 'Map or node not found' });
  });

  app.patch('/api/maps/:mapId/nodes/:nodeId/ppp', async (request, reply) => {
    const { mapId, nodeId } = nodeParams.parse(request.params);
    const body = nodePppSchema.parse(request.body);
    const map = await maps.updateNodePpp(mapId, nodeId, {
      ...(body.pppDisplayMode === undefined ? {} : { pppDisplayMode: body.pppDisplayMode }),
      ...(body.pppPosition === undefined ? {} : { pppPosition: body.pppPosition }),
      ...(body.pppColor === undefined ? {} : { pppColor: body.pppColor }),
      ...(body.pppFontSize === undefined ? {} : { pppFontSize: body.pppFontSize }),
    });
    return map ?? reply.code(404).send({ message: 'Map or node not found' });
  });

  app.put('/api/maps/:mapId/widgets', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const body = upsertWidgetSchema.parse(request.body);
    const widget = await maps.upsertWidget(mapId, {
      type: body.type,
      ...(body.positionX === undefined ? {} : { positionX: body.positionX }),
      ...(body.positionY === undefined ? {} : { positionY: body.positionY }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.settings === undefined ? {} : { settings: pppSettingsInput(body.settings) }),
    });
    return widget ?? reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/widgets/:widgetId', async (request, reply) => {
    const { mapId, widgetId } = widgetParams.parse(request.params);
    const body = updateWidgetSchema.parse(request.body);
    const widget = await maps.updateWidget(mapId, widgetId, {
      ...(body.positionX === undefined ? {} : { positionX: body.positionX }),
      ...(body.positionY === undefined ? {} : { positionY: body.positionY }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.settings === undefined ? {} : { settings: pppSettingsInput(body.settings) }),
    });
    return widget ?? reply.code(404).send({ message: 'Widget not found' });
  });

  app.delete('/api/maps/:mapId/widgets/:widgetId', async (request, reply) => {
    const { mapId, widgetId } = widgetParams.parse(request.params);
    return (await maps.deleteWidget(mapId, widgetId))
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Widget not found' });
  });

  app.post('/api/maps/:mapId/links', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const parsed = linkSchema.parse(request.body);
    const input: CreateLinkInput = {
      ...(parsed.sourceDeviceId === undefined ? {} : { sourceDeviceId: parsed.sourceDeviceId }),
      ...(parsed.sourceInterfaceId === undefined
        ? {}
        : { sourceInterfaceId: parsed.sourceInterfaceId }),
      ...(parsed.targetDeviceId === undefined ? {} : { targetDeviceId: parsed.targetDeviceId }),
      ...(parsed.targetInterfaceId === undefined
        ? {}
        : { targetInterfaceId: parsed.targetInterfaceId }),
      ...(parsed.sourceNodeId === undefined ? {} : { sourceNodeId: parsed.sourceNodeId }),
      ...(parsed.targetNodeId === undefined ? {} : { targetNodeId: parsed.targetNodeId }),
      capacityBps: parsed.capacityBps,
      autoCapacityBps: parsed.autoCapacityBps,
      capacitySource: parsed.capacitySource,
      trafficMode:
        parsed.trafficMode ??
        ((parsed.sourceDeviceId && parsed.targetNodeId && !parsed.targetDeviceId) ||
        (parsed.targetDeviceId && parsed.sourceNodeId && !parsed.sourceDeviceId)
          ? 'SINGLE_ENDED'
          : 'BIDIRECTIONAL'),
      customColor: parsed.customColor ?? null,
      trafficColorAToB: parsed.trafficColorAToB ?? null,
      trafficColorBToA: parsed.trafficColorBToA ?? null,
      inlineLabelPositionAToB: parsed.inlineLabelPositionAToB ?? null,
      inlineLabelPositionBToA: parsed.inlineLabelPositionBToA ?? null,
      animationEnabled: parsed.animationEnabled ?? null,
      label: parsed.label,
      metricSource: parsed.metricSource,
      visualStyle: parsed.visualStyle,
      metricDisplay: parsed.metricDisplay,
      ...(parsed.aggregationMode === undefined ? {} : { aggregationMode: parsed.aggregationMode }),
      ...(parsed.metricSources === undefined ? {} : { metricSources: parsed.metricSources }),
      ...(parsed.visualPaths === undefined ? {} : { visualPaths: parsed.visualPaths }),
      ...(parsed.linkLayoutMode === undefined ? {} : { linkLayoutMode: parsed.linkLayoutMode }),
      ...(parsed.sourceHandleSide === undefined
        ? {}
        : { sourceHandleSide: parsed.sourceHandleSide }),
      ...(parsed.targetHandleSide === undefined
        ? {}
        : { targetHandleSide: parsed.targetHandleSide }),
    };
    if (input.trafficMode === 'SINGLE_ENDED' && !singleEndedMonitoredSide(input)) {
      return reply
        .code(400)
        .send({ message: 'Single-ended link requires interfaces on exactly one monitored side' });
    }
    const link = await maps.createLink(mapId, input);
    return link ? reply.code(201).send(link) : reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/links/:linkId', async (request, reply) => {
    const { mapId, linkId } = linkParams.parse(request.params);
    const body = linkSchema
      .pick({
        sourceInterfaceId: true,
        targetInterfaceId: true,
        capacityBps: true,
        autoCapacityBps: true,
        capacitySource: true,
        trafficMode: true,
        customColor: true,
        trafficColorAToB: true,
        trafficColorBToA: true,
        inlineLabelPositionAToB: true,
        inlineLabelPositionBToA: true,
        animationEnabled: true,
        label: true,
        metricSource: true,
        visualStyle: true,
        metricDisplay: true,
        aggregationMode: true,
        metricSources: true,
        visualPaths: true,
        linkLayoutMode: true,
        sourceHandleSide: true,
        targetHandleSide: true,
      })
      .parse(request.body);
    const {
      sourceInterfaceId,
      targetInterfaceId,
      trafficMode,
      customColor,
      trafficColorAToB,
      trafficColorBToA,
      inlineLabelPositionAToB,
      inlineLabelPositionBToA,
      animationEnabled,
      aggregationMode,
      metricSources,
      visualPaths,
      linkLayoutMode,
      sourceHandleSide,
      targetHandleSide,
      ...fields
    } = body;
    if (
      trafficMode !== undefined ||
      sourceInterfaceId !== undefined ||
      targetInterfaceId !== undefined ||
      metricSources !== undefined ||
      aggregationMode !== undefined
    ) {
      const existing = (await maps.getMap(mapId))?.links.find((link) => link.id === linkId);
      if (!existing) return reply.code(404).send({ message: 'Link not found' });
      const edited = { ...existing, ...body };
      if (edited.trafficMode === 'SINGLE_ENDED' && !singleEndedMonitoredSide(edited)) {
        return reply
          .code(400)
          .send({ message: 'Single-ended link requires interfaces on exactly one monitored side' });
      }
    }
    const link = await maps.updateLink(mapId, linkId, {
      ...fields,
      ...(trafficMode === undefined ? {} : { trafficMode }),
      ...(customColor === undefined ? {} : { customColor }),
      ...(trafficColorAToB === undefined ? {} : { trafficColorAToB }),
      ...(trafficColorBToA === undefined ? {} : { trafficColorBToA }),
      ...(inlineLabelPositionAToB === undefined ? {} : { inlineLabelPositionAToB }),
      ...(inlineLabelPositionBToA === undefined ? {} : { inlineLabelPositionBToA }),
      ...(animationEnabled === undefined ? {} : { animationEnabled }),
      ...(sourceInterfaceId === undefined ? {} : { sourceInterfaceId }),
      ...(targetInterfaceId === undefined ? {} : { targetInterfaceId }),
      ...(aggregationMode === undefined ? {} : { aggregationMode }),
      ...(linkLayoutMode === undefined ? {} : { linkLayoutMode }),
      ...(sourceHandleSide === undefined ? {} : { sourceHandleSide }),
      ...(targetHandleSide === undefined ? {} : { targetHandleSide }),
      ...(metricSources === undefined ? {} : { metricSources }),
      ...(visualPaths === undefined ? {} : { visualPaths }),
    });
    return link ?? reply.code(404).send({ message: 'Link not found' });
  });

  app.delete('/api/maps/:mapId/links/:linkId', async (request, reply) => {
    const { mapId, linkId } = linkParams.parse(request.params);
    return (await maps.deleteLink(mapId, linkId))
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Link not found' });
  });

  app.post('/api/maps/:mapId/devices', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const body = deviceSchema.parse(request.body);
    if (config.DEMO_MODE) {
      const result = legacyMaps.addDevice(mapId, body);
      return result
        ? reply.code(201).send(result)
        : reply.code(404).send({ message: 'Map not found' });
    }
    const input: CreateHostInput = {
      hostname: body.hostname,
      displayName: body.name,
      managementIp: body.ip,
      vendor: body.vendor,
      model: body.model,
      deviceType: body.deviceType,
      site: body.site,
      description: '',
      notes: '',
      origin: 'MANUAL',
      zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
      ssh: { enabled: false, host: body.ip, port: 22, username: '' },
      snmp: {
        enabled: false,
        version: 'SNMP_V2C',
        host: body.ip,
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
      },
    };
    const host = await hosts.createHost(input);
    const result = await productionMaps!.addHostToMap(host.id, mapId, body.position);
    return result
      ? reply.code(201).send(result)
      : reply.code(404).send({ message: 'Map not found' });
  });

  app.post('/api/maps/:mapId/nodes', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const body = z.object({ deviceIds: z.array(z.string().min(1)).min(1) }).parse(request.body);
    const map = await maps.getMap(mapId);
    if (!map) return reply.code(404).send({ message: 'Map not found' });
    const existing = new Set(map.nodes.map((node) => node.deviceId));
    const created = await maps.addHostsToMap(mapId, body.deviceIds, {
      x: 520 + (map.nodes.length % 6) * 80,
      y: 360 + (map.nodes.length % 4) * 70,
    });
    return reply.code(201).send({
      created,
      skipped: body.deviceIds.filter((deviceId) => existing.has(deviceId)),
    });
  });

  app.post('/api/maps/:mapId/generic-nodes', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const node = await maps.addGenericNode(mapId, genericNodeSchema.parse(request.body));
    return node ? reply.code(201).send(node) : reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/nodes/:nodeId', async (request, reply) => {
    const { mapId, nodeId } = nodeParams.parse(request.params);
    const body = conceptualNodeSchema.parse(request.body);
    const node = await maps.updateConceptualNode(mapId, nodeId, {
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.genericType === undefined ? {} : { genericType: body.genericType }),
      ...(body.locked === undefined ? {} : { locked: body.locked }),
    });
    return node ?? reply.code(404).send({ message: 'Conceptual node not found' });
  });

  app.delete('/api/maps/:mapId/nodes/:nodeId', async (request, reply) => {
    const { mapId, nodeId } = nodeParams.parse(request.params);
    return (await maps.deleteNode(mapId, nodeId))
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Node not found' });
  });

  app.delete('/api/maps/:mapId/devices/:deviceId', async (request, reply) => {
    const { mapId, deviceId } = deviceParams.parse(request.params);
    return (await maps.deleteDevice(mapId, deviceId))
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Device not found' });
  });

  app.get('/api/interfaces/:interfaceId/history', async (request, reply) => {
    const { interfaceId } = z.object({ interfaceId: z.string() }).parse(request.params);
    const { period } = z
      .object({ period: z.enum(['15m', '1h', '6h', '24h', '7d']).default('1h') })
      .parse(request.query);
    if (zabbix && interfaceId.startsWith('zabbix-interface-')) {
      try {
        return await zabbix.getHistory(interfaceId, period as HistoryPeriod);
      } catch {
        return reply.code(502).send({ message: 'Falha segura ao consultar histórico no Zabbix' });
      }
    }
    if (!config.DEMO_MODE) return hosts.getInterfaceHistory(interfaceId, period as HistoryPeriod);
    return metrics.getHistory(interfaceId, period as HistoryPeriod);
  });

  app.get('/api/public/view/:token/hosts/:hostId/mpls', async (request, reply) => {
    const { token, hostId } = z
      .object({ token: z.string().min(1), hostId: z.string().min(1) })
      .parse(request.params);
    if (!(await publicViewContainsHost(token, hostId))) {
      return reply.code(404).send({ message: 'Host não disponível neste link público' });
    }
    return mplsRepository.getHostOverview(hostId);
  });

  app.get('/api/public/view/:token/hosts/:hostId/mpls/events', async (request, reply) => {
    const { token, hostId } = z
      .object({ token: z.string().min(1), hostId: z.string().min(1) })
      .parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    if (!(await publicViewContainsHost(token, hostId))) {
      return reply.code(404).send({ message: 'Host não disponível neste link público' });
    }
    return mplsRepository.listEvents(hostId, limit);
  });

  app.get('/api/interfaces/:interfaceId/optical-history', async (request) => {
    const { interfaceId } = z.object({ interfaceId: z.string() }).parse(request.params);
    const { period } = z
      .object({
        period: z.enum(['15m', '1h', '6h', '24h', '7d']).default('1h'),
      })
      .parse(request.query);
    return hosts.getInterfaceOpticalHistory(interfaceId, period as HistoryPeriod);
  });

  app.get('/api/interfaces/:interfaceId/metrics', async (request, reply) => {
    const { interfaceId } = z.object({ interfaceId: z.string() }).parse(request.params);
    if (zabbix && interfaceId.startsWith('zabbix-interface-')) {
      try {
        return await zabbix.getMetrics(interfaceId);
      } catch {
        return reply.code(502).send({ message: 'Falha segura ao consultar métricas no Zabbix' });
      }
    }
    if (!config.DEMO_MODE) {
      const current = await hosts.getInterfaceMetrics(interfaceId);
      return (
        current ??
        reply.code(404).send({ message: 'Ainda não há amostras SNMP para esta interface' })
      );
    }
    return reply.code(409).send({ message: 'Interface sem fonte de métricas em tempo real' });
  });

  app.post('/api/maps/:mapId/devices/:deviceId/discover', async (request, reply) => {
    const { mapId, deviceId } = deviceParams.parse(request.params);
    const map = await maps.getMap(mapId);
    const device = map?.devices.find((item) => item.id === deviceId);
    if (!map || !device) return reply.code(404).send({ message: 'Device not found' });
    return discovery.discover(device, map.devices);
  });

  app.post('/api/topology/lldp/discover', async (request, reply) => {
    const { mapId, deepValidation } = z
      .object({
        mapId: z.string().min(1),
        deepValidation: z.boolean().optional().default(false),
      })
      .parse(request.body);
    try {
      const preview = await topologyPreview.discover(mapId, { deepValidation });
      await physicalService.recordLldpPreview(preview);
      return preview;
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : 'Falha segura na descoberta LLDP',
      });
    }
  });
  app.post('/api/hosts/:hostId/lldp/discover', async (request, reply) => {
    const { hostId } = z.object({ hostId: z.string().min(1) }).parse(request.params);
    const { mapId, deepValidation } = z
      .object({
        mapId: z.string().min(1),
        deepValidation: z.boolean().optional().default(false),
      })
      .parse(request.body);
    try {
      const preview = await topologyPreview.discoverHost(hostId, mapId, { deepValidation });
      await physicalService.recordLldpPreview(preview);
      return preview;
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : 'Falha segura na descoberta LLDP',
      });
    }
  });

  app.post('/api/topology/lldp/preview', async (request, reply) => {
    const { previewId } = z.object({ previewId: z.string().min(1) }).parse(request.body);
    const preview = await topologyPreviewStore.load(previewId);
    return preview ?? reply.code(404).send({ message: 'Preview expirado ou inexistente' });
  });

  app.post('/api/topology/lldp/apply', async (request, reply) => {
    const body = z
      .object({
        previewId: z.string().min(1),
        mapId: z.string().min(1),
        selections: z
          .array(
            z.object({
              adjacencyId: z.string().min(1),
              action: z.enum(['CREATE_LINK', 'IGNORE']),
            }),
          )
          .min(1),
      })
      .parse(request.body);
    const preview = await topologyPreviewStore.load(body.previewId);
    if (!preview) return reply.code(404).send({ message: 'Preview expirado ou inexistente' });
    const selections = body.selections as LldpApplySelection[];
    try {
      return await topologyApply.apply(body.mapId, preview, selections);
    } catch (error) {
      return reply.code(409).send({
        message: error instanceof Error ? error.message : 'Falha segura ao aplicar topologia LLDP',
      });
    }
  });

  app.get('/api/integrations/zabbix/status', async (_request, reply) => {
    if (!config.ZABBIX_URL || !config.ZABBIX_TOKEN)
      return { configured: false, status: 'not_configured' };
    try {
      const result = await zabbix!.healthcheck();
      return { configured: true, status: 'connected', ...result };
    } catch (error) {
      return reply.code(502).send({
        configured: true,
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown Zabbix error',
      });
    }
  });

  app.get('/api/integrations/zabbix/hosts', async (_request, reply) => {
    if (!config.ZABBIX_URL || !config.ZABBIX_TOKEN)
      return reply.code(409).send({ message: 'Zabbix is not configured' });
    return zabbix!.getDevices();
  });
}
