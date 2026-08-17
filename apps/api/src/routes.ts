import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CreateHostInput, HistoryPeriod, UpdateMapInput } from '@gmj/shared';
import { CredentialVault } from './application/credential-vault';
import { DiscoveryService } from './application/discovery-service';
import { config } from './config';
import { registerHostRoutes } from './host-routes';
import { DemoMetricAdapter } from './infrastructure/metrics/demo-adapter';
import { ZabbixAdapter } from './infrastructure/metrics/zabbix-adapter';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import { DemoMapRepository } from './infrastructure/persistence/demo-map-repository';
import { PrismaMapRepository } from './infrastructure/persistence/prisma-map-repository';
import { createPrismaHostRepository, PrismaHostRepository } from './infrastructure/persistence/prisma-host-repository';
import { SnmpPoller } from './infrastructure/snmp/snmp-poller';
import { SnmpService } from './infrastructure/snmp/snmp-service';
import { SshInterfaceService } from './infrastructure/ssh/ssh-interface-service';
import { DemoTopologyAdapter } from './infrastructure/topology/demo-topology-adapter';

const mapIdParams = z.object({ mapId: z.string().min(1) });
const nodeParams = z.object({ mapId: z.string().min(1), nodeId: z.string().min(1) });
const deviceParams = z.object({ mapId: z.string().min(1), deviceId: z.string().min(1) });
const linkParams = z.object({ mapId: z.string().min(1), linkId: z.string().min(1) });
const positionSchema = z.object({
  nodeId: z.string().min(1),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  locked: z.boolean().optional(),
});
const linkSchema = z.object({
  sourceDeviceId: z.string().min(1),
  sourceInterfaceId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  targetInterfaceId: z.string().min(1),
  capacityBps: z.number().positive(),
  autoCapacityBps: z.number().positive(),
  capacitySource: z.enum(['AUTO', 'MANUAL']),
  label: z.string().max(80),
  metricSource: z.enum(['DEMO', 'ZABBIX']),
  visualStyle: z.enum(['FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL']).nullable(),
  metricDisplay: z.enum(['THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE']).nullable(),
});
const mapSettingsSchema = z.object({
  nodeDisplayMode: z.enum(['ICON_2D', 'ICON_3D', 'CARD']).optional(),
  linkDisplayStyle: z.enum(['FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL']).optional(),
  linkMetricDisplay: z.enum(['THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE']).optional(),
  filters: z.object({
    showTraffic: z.boolean().optional(),
    showUtilization: z.boolean().optional(),
    showLabels: z.boolean().optional(),
    showOffline: z.boolean().optional(),
    showInterfaces: z.boolean().optional(),
  }).optional(),
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
const deviceSchema = z.object({
  name: z.string().min(1).max(80),
  hostname: z.string().min(1).max(255),
  ip: z.string().min(1).max(45),
  vendor: z.string().max(80),
  model: z.string().max(80),
  site: z.string().max(80),
  deviceType: z.enum(['core', 'router', 'switch', 'aggregation', 'edge', 'olt', 'firewall', 'server', 'internet', 'ix', 'customers', 'generic']),
  position: z.object({ x: z.number(), y: z.number() }),
});

interface RouteRegistrationOptions {
  credentialEncryptionKey?: string | null;
}

export function registerRoutes(app: FastifyInstance, options: RouteRegistrationOptions = {}): void {
  const credentialEncryptionKey = options.credentialEncryptionKey === undefined
    ? config.CREDENTIAL_ENCRYPTION_KEY
    : options.credentialEncryptionKey;
  const vault = credentialEncryptionKey ? new CredentialVault(credentialEncryptionKey) : null;

  const legacyMaps = new DemoMapRepository(vault);
  const hosts = config.DEMO_MODE
    ? new DemoHostRepositoryAdapter(legacyMaps)
    : createPrismaHostRepository(vault);
  const productionMaps = config.DEMO_MODE ? null : new PrismaMapRepository(hosts);
  const maps = productionMaps ?? legacyMaps;
  const metrics = new DemoMetricAdapter();
  const discovery = new DiscoveryService([new DemoTopologyAdapter()]);
  const ssh = new SshInterfaceService(hosts);
  const snmp = new SnmpService(hosts, ssh);
  const poller = new SnmpPoller(hosts, snmp, config.SNMP_POLL_INTERVAL_SECONDS * 1000);
  const zabbix = config.ZABBIX_URL && config.ZABBIX_TOKEN
    ? new ZabbixAdapter(config.ZABBIX_URL, config.ZABBIX_TOKEN, config.ZABBIX_AUTH_MODE)
    : null;

  registerHostRoutes(app, { legacyMaps, mapMembership: maps, hosts, discovery, snmp, ssh, zabbix });

  app.addHook('onReady', async () => {
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
    if (hosts instanceof PrismaHostRepository) await hosts.disconnect();
  });

  app.get('/health', async () => ({
    status: 'ok',
    demoMode: config.DEMO_MODE,
    snmpPolling: !config.DEMO_MODE && config.SNMP_POLLING_ENABLED,
  }));

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
    const body = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() }).parse(request.body);
    return reply.code(201).send(await maps.createMap({
      name: body.name,
      description: body.description ?? source.description,
      mode: source.mode,
      sourceMapId: mapId,
    }));
  });

  app.delete('/api/maps/:mapId', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    return await maps.deleteMap(mapId)
      ? reply.code(204).send()
      : reply.code(409).send({ message: 'Map not found or last remaining map' });
  });

  app.get('/api/playlists', async () => maps.listPlaylists());

  app.post('/api/playlists', async (request, reply) => {
    const body = z.object({
      id: z.string().optional(),
      name: z.string().min(1).max(80),
      rotationIntervalSeconds: z.number().int().min(5).max(86_400),
      mapIds: z.array(z.string()).min(1),
      isDefault: z.boolean().default(false),
    }).parse(request.body);
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
    const map = await maps.updatePositions(mapId, body.nodes.map((node) => ({
      nodeId: node.nodeId,
      position: node.position,
      ...(node.locked === undefined ? {} : { locked: node.locked }),
    })));
    return map ?? reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/nodes/:nodeId/lock', async (request, reply) => {
    const { mapId, nodeId } = nodeParams.parse(request.params);
    const { locked } = z.object({ locked: z.boolean() }).parse(request.body);
    const map = await maps.setNodeLocked(mapId, nodeId, locked);
    return map ?? reply.code(404).send({ message: 'Map or node not found' });
  });

  app.post('/api/maps/:mapId/links', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const link = await maps.createLink(mapId, linkSchema.parse(request.body));
    return link ? reply.code(201).send(link) : reply.code(404).send({ message: 'Map not found' });
  });

  app.patch('/api/maps/:mapId/links/:linkId', async (request, reply) => {
    const { mapId, linkId } = linkParams.parse(request.params);
    const body = linkSchema.pick({
      capacityBps: true,
      autoCapacityBps: true,
      capacitySource: true,
      label: true,
      metricSource: true,
      visualStyle: true,
      metricDisplay: true,
    }).parse(request.body);
    const link = await maps.updateLink(mapId, linkId, body);
    return link ?? reply.code(404).send({ message: 'Link not found' });
  });

  app.delete('/api/maps/:mapId/links/:linkId', async (request, reply) => {
    const { mapId, linkId } = linkParams.parse(request.params);
    return await maps.deleteLink(mapId, linkId)
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Link not found' });
  });

  app.post('/api/maps/:mapId/devices', async (request, reply) => {
    const { mapId } = mapIdParams.parse(request.params);
    const body = deviceSchema.parse(request.body);
    if (config.DEMO_MODE) {
      const result = legacyMaps.addDevice(mapId, body);
      return result ? reply.code(201).send(result) : reply.code(404).send({ message: 'Map not found' });
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
      snmp: { enabled: false, version: 'SNMP_V2C', host: body.ip, port: 161, username: '', securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null },
    };
    const host = await hosts.createHost(input);
    const result = await productionMaps!.addHostToMap(host.id, mapId, body.position);
    return result ? reply.code(201).send(result) : reply.code(404).send({ message: 'Map not found' });
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

  app.delete('/api/maps/:mapId/devices/:deviceId', async (request, reply) => {
    const { mapId, deviceId } = deviceParams.parse(request.params);
    return await maps.deleteDevice(mapId, deviceId)
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Device not found' });
  });

  app.get('/api/interfaces/:interfaceId/history', async (request, reply) => {
    const { interfaceId } = z.object({ interfaceId: z.string() }).parse(request.params);
    const { period } = z.object({ period: z.enum(['15m', '1h', '6h', '24h', '7d']).default('1h') }).parse(request.query);
    if (zabbix && interfaceId.startsWith('zabbix-interface-')) {
      try { return await zabbix.getHistory(interfaceId, period as HistoryPeriod); }
      catch { return reply.code(502).send({ message: 'Falha segura ao consultar histórico no Zabbix' }); }
    }
    if (!config.DEMO_MODE) return hosts.getInterfaceHistory(interfaceId, period as HistoryPeriod);
    return metrics.getHistory(interfaceId, period as HistoryPeriod);
  });

  app.get('/api/interfaces/:interfaceId/metrics', async (request, reply) => {
    const { interfaceId } = z.object({ interfaceId: z.string() }).parse(request.params);
    if (zabbix && interfaceId.startsWith('zabbix-interface-')) {
      try { return await zabbix.getMetrics(interfaceId); }
      catch { return reply.code(502).send({ message: 'Falha segura ao consultar métricas no Zabbix' }); }
    }
    if (!config.DEMO_MODE) {
      const current = await hosts.getInterfaceMetrics(interfaceId);
      return current ?? reply.code(404).send({ message: 'Ainda não há amostras SNMP para esta interface' });
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

  app.get('/api/integrations/zabbix/status', async (_request, reply) => {
    if (!config.ZABBIX_URL || !config.ZABBIX_TOKEN) return { configured: false, status: 'not_configured' };
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
    if (!config.ZABBIX_URL || !config.ZABBIX_TOKEN) return reply.code(409).send({ message: 'Zabbix is not configured' });
    return zabbix!.getDevices();
  });
}
