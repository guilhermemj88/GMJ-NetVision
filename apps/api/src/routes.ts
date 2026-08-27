import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
import {
  createPrismaHostRepository,
  PrismaHostRepository,
} from './infrastructure/persistence/prisma-host-repository';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { PublicViewRecord } from './infrastructure/persistence/public-view-repository';
import { SnmpClientImpl } from './infrastructure/snmp/snmp-client-impl';
import { SnmpPoller } from './infrastructure/snmp/snmp-poller';
import { SnmpService } from './infrastructure/snmp/snmp-service';
import { DemoMplsRepository } from './infrastructure/mpls/demo-mpls-repository';
import { HuaweiVplsSnmpCollector } from './infrastructure/mpls/huawei-vpls-snmp';
import { MplsPollingService } from './infrastructure/mpls/mpls-polling-service';
import { PrismaMplsRepository } from './infrastructure/mpls/prisma-mpls-repository';
import { PppPollingService } from './infrastructure/ppp/ppp-polling-service';
import { PrismaPppRepository } from './infrastructure/ppp/prisma-ppp-repository';
import { SshClientImpl } from './infrastructure/ssh/ssh-client-impl';
import { SshInterfaceService } from './infrastructure/ssh/ssh-interface-service';
import { DemoTopologyAdapter } from './infrastructure/topology/demo-topology-adapter';
import { HuaweiVrpDriver } from './infrastructure/topology/huawei-vrp-driver';
import { LldpSnmpDiscoveryAdapter } from './infrastructure/topology/lldp-snmp-adapter';
import { LldpSshDiscoveryAdapter } from './infrastructure/topology/lldp-ssh-adapter';

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
  animationEnabled: z.boolean().nullable().optional(),
  label: z.string().max(80),
  metricSource: z.enum(['DEMO', 'ZABBIX']),
  visualStyle: z.enum(['FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL']).nullable(),
  metricDisplay: z.enum(['THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE']).nullable(),
  aggregationMode: z.enum(['NONE', 'SUM']).optional(),
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
  const mplsRepository = config.DEMO_MODE ? new DemoMplsRepository() : new PrismaMplsRepository();
  const mplsPolling = new MplsPollingService(
    new HuaweiVplsSnmpCollector(new SnmpClientImpl(3000, 1)),
    mplsRepository,
  );
  const pppRepository = config.DEMO_MODE ? null : new PrismaPppRepository();
  const pppPolling = pppRepository
    ? new PppPollingService(new SnmpClientImpl(3000, 1), pppRepository)
    : undefined;
  const snmp = new SnmpService(
    hosts,
    ssh,
    config.OPTICAL_POLL_INTERVAL_SECONDS * 1000,
    mplsPolling,
    pppPolling,
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

  app.addHook('onReady', async () => {
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
    if (productionMaps) await productionMaps.disconnect();
    if (topologyPreviewStore instanceof PrismaTopologyPreviewStore)
      await topologyPreviewStore.disconnect();
    if (hosts instanceof PrismaHostRepository) await hosts.disconnect();
    if (authRepository instanceof PrismaAuthRepository) await authRepository.disconnect();
    if (publicViewRepository instanceof PrismaPublicViewRepository)
      await publicViewRepository.disconnect();
    if (mplsRepository instanceof PrismaMplsRepository) await mplsRepository.disconnect();
    if (pppRepository instanceof PrismaPppRepository) await pppRepository.disconnect();
  });

  app.get('/health', async () => ({
    status: 'ok',
    demoMode: config.DEMO_MODE,
    snmpPolling: !config.DEMO_MODE && config.SNMP_POLLING_ENABLED,
  }));

  // ---- Authentication ----
  const isPublicApiPath = (pathname: string) =>
    pathname === '/api/auth/login' || pathname.startsWith('/api/public/');

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
      trafficMode: parsed.trafficMode ?? 'BIDIRECTIONAL',
      customColor: parsed.customColor ?? null,
      animationEnabled: parsed.animationEnabled ?? null,
      label: parsed.label,
      metricSource: parsed.metricSource,
      visualStyle: parsed.visualStyle,
      metricDisplay: parsed.metricDisplay,
      ...(parsed.aggregationMode === undefined ? {} : { aggregationMode: parsed.aggregationMode }),
      ...(parsed.metricSources === undefined ? {} : { metricSources: parsed.metricSources }),
      ...(parsed.visualPaths === undefined ? {} : { visualPaths: parsed.visualPaths }),
    };
    if (
      input.trafficMode === 'SINGLE_ENDED' &&
      Boolean(input.sourceInterfaceId) === Boolean(input.targetInterfaceId)
    ) {
      return reply.code(400).send({ message: 'Single-ended link requires exactly one interface' });
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
        animationEnabled: true,
        label: true,
        metricSource: true,
        visualStyle: true,
        metricDisplay: true,
        aggregationMode: true,
        metricSources: true,
        visualPaths: true,
      })
      .parse(request.body);
    const {
      sourceInterfaceId,
      targetInterfaceId,
      trafficMode,
      customColor,
      animationEnabled,
      aggregationMode,
      metricSources,
      visualPaths,
      ...fields
    } = body;
    if (
      trafficMode === 'SINGLE_ENDED' &&
      Boolean(sourceInterfaceId) === Boolean(targetInterfaceId)
    ) {
      return reply.code(400).send({ message: 'Single-ended link requires exactly one interface' });
    }
    const link = await maps.updateLink(mapId, linkId, {
      ...fields,
      ...(trafficMode === undefined ? {} : { trafficMode }),
      ...(customColor === undefined ? {} : { customColor }),
      ...(animationEnabled === undefined ? {} : { animationEnabled }),
      ...(sourceInterfaceId === undefined ? {} : { sourceInterfaceId }),
      ...(targetInterfaceId === undefined ? {} : { targetInterfaceId }),
      ...(aggregationMode === undefined ? {} : { aggregationMode }),
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
      return await topologyPreview.discover(mapId, { deepValidation });
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
      return await topologyPreview.discoverHost(hostId, mapId, { deepValidation });
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
