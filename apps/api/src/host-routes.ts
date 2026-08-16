import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ConnectionTestResult,
  CreateHostInput,
  DiscoveryApplySelection,
  HostOrigin,
  HostRecord,
  NetworkInterface,
  SourceKind,
  UpdateHostInput,
  ZabbixHostCandidate,
} from '@gmj/shared';
import type { DiscoveryService } from './application/discovery-service';
import { config } from './config';
import { demoZabbixCandidates, type ZabbixAdapter } from './infrastructure/metrics/zabbix-adapter';
import { CredentialEncryptionUnavailableError, type DemoMapRepository } from './infrastructure/persistence/demo-map-repository';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { SnmpService } from './infrastructure/snmp/snmp-service';

const hostIdParams = z.object({ hostId: z.string().min(1) });
const sourceParams = z.object({ hostId: z.string().min(1), source: z.enum(['zabbix', 'ssh', 'snmp']) });
const deviceType = z.enum([
  'core', 'router', 'switch', 'aggregation', 'edge', 'olt', 'firewall', 'server', 'internet', 'ix', 'customers', 'generic',
]);
const zabbixInput = z.object({
  enabled: z.boolean(), hostId: z.string().max(80), hostName: z.string().max(255), primaryInterfaceId: z.string().max(80), ip: z.string().max(45),
});
const sshInput = z.object({
  enabled: z.boolean(), host: z.string().max(255), port: z.number().int().min(1).max(65_535).default(22), username: z.string().max(128), password: z.string().min(1).max(1_024).optional(), clearCredential: z.boolean().optional(),
});
const snmpInput = z.object({
  enabled: z.boolean(), version: z.enum(['SNMP_V2C', 'SNMP_V3']), host: z.string().max(255), port: z.number().int().min(1).max(65_535).default(161), community: z.string().min(1).max(1_024).optional(), username: z.string().max(128), securityLevel: z.enum(['NO_AUTH_NO_PRIV', 'AUTH_NO_PRIV', 'AUTH_PRIV']), authProtocol: z.enum(['MD5', 'SHA', 'SHA256']).nullable(), authPassword: z.string().min(1).max(1_024).optional(), privacyProtocol: z.enum(['DES', 'AES', 'AES256']).nullable(), privacyPassword: z.string().min(1).max(1_024).optional(), clearCredential: z.boolean().optional(),
});
const basicHostFields = {
  hostname: z.string().min(1).max(255), displayName: z.string().min(1).max(120), managementIp: z.string().max(45), vendor: z.string().max(80), model: z.string().max(120), deviceType, site: z.string().max(120), description: z.string().max(1_000), notes: z.string().max(2_000), origin: z.enum(['MANUAL', 'ZABBIX', 'DISCOVERY', 'IMPORTED']),
};
const createHostSchema = z.object({ ...basicHostFields, zabbix: zabbixInput, ssh: sshInput, snmp: snmpInput });
const updateHostSchema = z.object({
  hostname: basicHostFields.hostname.optional(), displayName: basicHostFields.displayName.optional(), managementIp: basicHostFields.managementIp.optional(), vendor: basicHostFields.vendor.optional(), model: basicHostFields.model.optional(), deviceType: basicHostFields.deviceType.optional(), site: basicHostFields.site.optional(), description: basicHostFields.description.optional(), notes: basicHostFields.notes.optional(), origin: basicHostFields.origin.optional(), zabbix: zabbixInput.optional(), ssh: sshInput.optional(), snmp: snmpInput.optional(),
});

function safeConnectionResult(source: SourceKind, state: ConnectionTestResult['state'], message: string, version?: string): ConnectionTestResult {
  return { source, state, message, checkedAt: new Date().toISOString(), ...(version ? { version } : {}) };
}

function filterHosts(
  hosts: HostRecord[],
  query: { q?: string | undefined; origin?: HostOrigin | undefined; source?: SourceKind | undefined; sort?: string | undefined; direction?: string | undefined },
) {
  const text = query.q?.trim().toLowerCase();
  const filtered = hosts.filter((host) => {
    const matchesText = !text || [host.hostname, host.displayName, host.managementIp, host.vendor, host.model, host.site].join(' ').toLowerCase().includes(text);
    const matchesOrigin = !query.origin || host.origin === query.origin;
    const matchesSource = !query.source || (query.source === 'ZABBIX' ? host.useZabbix : query.source === 'SSH' ? host.sshEnabled : host.snmpEnabled);
    return matchesText && matchesOrigin && matchesSource;
  });
  const sort = query.sort ?? 'hostname';
  const direction = query.direction === 'desc' ? -1 : 1;
  return filtered.sort((left, right) => {
    const leftValue = String((left as unknown as Record<string, unknown>)[sort] ?? '');
    const rightValue = String((right as unknown as Record<string, unknown>)[sort] ?? '');
    return leftValue.localeCompare(rightValue, 'pt-BR', { numeric: true }) * direction;
  });
}

async function zabbixCandidates(
  maps: DemoMapRepository,
  zabbix: ZabbixAdapter | null,
): Promise<{ candidates: ZabbixHostCandidate[]; version: string; demoMode: boolean }> {
  if (!zabbix) {
    if (!config.DEMO_MODE) throw new Error('Zabbix is not configured');
    return { candidates: demoZabbixCandidates(maps.listHosts()), version: '6.0.33-demo', demoMode: true };
  }
  const [{ version }, candidates] = await Promise.all([zabbix.healthcheck(), zabbix.getHostCandidates()]);
  return { candidates, version, demoMode: false };
}

function importInput(record: HostRecord): CreateHostInput {
  return {
    hostname: record.hostname,
    displayName: record.displayName,
    managementIp: record.managementIp,
    vendor: record.vendor,
    model: record.model,
    deviceType: record.deviceType,
    site: record.site,
    description: record.description,
    notes: record.notes,
    origin: record.origin,
    zabbix: record.zabbix
      ? { enabled: true, hostId: record.zabbix.hostId, hostName: record.zabbix.hostName, primaryInterfaceId: record.zabbix.primaryInterfaceId, ip: record.zabbix.ip }
      : { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
    ssh: { enabled: false, host: record.managementIp, port: 22, username: '' },
    snmp: { enabled: false, version: 'SNMP_V2C', host: record.managementIp, port: 161, username: '', securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null },
  };
}

export function registerHostRoutes(
  app: FastifyInstance,
  dependencies: {
    maps: DemoMapRepository;
    hosts: HostRepository;
    discovery: DiscoveryService;
    snmp: SnmpService;
    zabbix: ZabbixAdapter | null;
  },
): void {
  const { maps, hosts, discovery, snmp, zabbix } = dependencies;

  app.get('/api/hosts', async (request) => {
    const query = z.object({
      q: z.string().optional(), origin: z.enum(['MANUAL', 'ZABBIX', 'DISCOVERY', 'IMPORTED']).optional(), source: z.enum(['ZABBIX', 'SSH', 'SNMP']).optional(), sort: z.string().optional(), direction: z.enum(['asc', 'desc']).optional(),
    }).parse(request.query);
    return filterHosts(await hosts.listHosts(), query);
  });

  app.post('/api/hosts/import/zabbix/preview', async (_request, reply) => {
    try {
      const data = await zabbixCandidates(maps, zabbix);
      return maps.storeZabbixPreview(data.candidates, data.version, data.demoMode);
    } catch {
      return reply.code(502).send({ message: 'Falha segura ao consultar o Zabbix' });
    }
  });

  app.post('/api/hosts/import/zabbix', async (request, reply) => {
    const body = z.object({ previewId: z.string().min(1), hostIds: z.array(z.string()).min(1) }).parse(request.body);
    const interfaces = new Map<string, NetworkInterface[]>();
    if (zabbix) {
      await Promise.all(body.hostIds.map(async (hostId) => interfaces.set(hostId, await zabbix.getInterfaces(hostId))));
    }
    const result = maps.importZabbixHosts(body.previewId, body.hostIds, interfaces);
    if (!result) return reply.code(404).send({ message: 'Preview expirado ou inexistente' });
    const imported = [];
    for (const record of result.imported) imported.push(await hosts.createHost(importInput(record), record.interfaces));
    return { imported, skippedHostIds: result.skippedHostIds };
  });

  app.get('/api/hosts/:hostId', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    return (await hosts.getHost(hostId)) ?? reply.code(404).send({ message: 'Host not found' });
  });

  app.post('/api/hosts', async (request, reply) => {
    try {
      return reply.code(201).send(await hosts.createHost(createHostSchema.parse(request.body) as CreateHostInput));
    } catch (error) {
      if (error instanceof CredentialEncryptionUnavailableError) return reply.code(409).send({ message: 'Configure CREDENTIAL_ENCRYPTION_KEY antes de salvar credenciais' });
      throw error;
    }
  });

  app.patch('/api/hosts/:hostId', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    try {
      const host = await hosts.updateHost(hostId, updateHostSchema.parse(request.body) as UpdateHostInput);
      return host ?? reply.code(404).send({ message: 'Host not found' });
    } catch (error) {
      if (error instanceof CredentialEncryptionUnavailableError) return reply.code(409).send({ message: 'Configure CREDENTIAL_ENCRYPTION_KEY antes de salvar credenciais' });
      throw error;
    }
  });

  app.delete('/api/hosts/:hostId', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    return (await hosts.deleteHost(hostId)) ? reply.code(204).send() : reply.code(404).send({ message: 'Host not found' });
  });

  app.get('/api/hosts/:hostId/interfaces', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    const host = await hosts.getHost(hostId);
    return host?.interfaces ?? reply.code(404).send({ message: 'Host not found' });
  });

  app.post('/api/hosts/:hostId/interfaces/discover', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });
    if (!host.snmpEnabled) return reply.code(409).send({ message: 'SNMP não está habilitado para este host' });
    try {
      const interfaces = await snmp.discoverAndPersistInterfaces(host);
      return { hostId, discoveredAt: new Date().toISOString(), count: interfaces.length, interfaces };
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : 'Falha segura no discovery SNMP' });
    }
  });

  app.post('/api/hosts/:hostId/poll', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });
    try {
      return await snmp.pollHost(host);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha segura no polling SNMP';
      await hosts.updateSourceHealth(hostId, safeConnectionResult('SNMP', 'FAILED', message));
      return reply.code(502).send({ message });
    }
  });

  app.post('/api/hosts/:hostId/maps', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    const body = z.object({ mapId: z.string().min(1), position: z.object({ x: z.number().finite(), y: z.number().finite() }) }).parse(request.body);
    const result = maps.addHostToMap(hostId, body.mapId, body.position);
    return result ? reply.code(201).send(result) : reply.code(409).send({ message: 'Host persistido, mas ainda não está sincronizado com o repositório legado de mapas' });
  });

  app.post('/api/hosts/:hostId/test/:source', async (request, reply) => {
    const { hostId, source: sourceParam } = sourceParams.parse(request.params);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });
    const source = sourceParam.toUpperCase() as SourceKind;
    const enabled = source === 'ZABBIX' ? host.useZabbix : source === 'SSH' ? host.sshEnabled : host.snmpEnabled;
    let result: ConnectionTestResult;
    if (!enabled) result = safeConnectionResult(source, 'DISABLED', 'Fonte desabilitada para este host');
    else if (source === 'ZABBIX' && zabbix) {
      try {
        const { version } = await zabbix.healthcheck();
        result = safeConnectionResult('ZABBIX', 'CONNECTED', 'Conectado', version);
      } catch {
        result = safeConnectionResult('ZABBIX', 'FAILED', 'Falha ao consultar o Zabbix');
      }
    } else if (source === 'SNMP' && !config.DEMO_MODE) {
      const { state, message } = await snmp.testConnectivity(host);
      result = safeConnectionResult('SNMP', state, message);
    } else if (config.DEMO_MODE) result = safeConnectionResult(source, 'CONNECTED', 'Conectado pelo adapter demonstrativo');
    else result = safeConnectionResult(source, 'FAILED', `Transporte ${source} não configurado no servidor`);
    await hosts.updateSourceHealth(hostId, result);
    return result;
  });

  app.post('/api/hosts/:hostId/discovery/preview', async (request, reply) => {
    const { hostId } = hostIdParams.parse(request.params);
    const { mapId } = z.object({ mapId: z.string().min(1) }).parse(request.body);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });
    const inventory = await hosts.listHosts();
    const review = await discovery.discover(host, inventory);
    let candidates: ZabbixHostCandidate[] = [];
    try { candidates = (await zabbixCandidates(maps, zabbix)).candidates; }
    catch { review.warnings.push('ZABBIX: correlação indisponível; discovery LLDP preservado'); }
    const preview = maps.createDiscoveryPreview(hostId, mapId, review, candidates);
    return preview ?? reply.code(409).send({ message: 'Discovery de mapa ainda depende do repositório legado de mapas' });
  });

  app.post('/api/hosts/:hostId/discovery/apply', async (request, reply) => {
    hostIdParams.parse(request.params);
    const body = z.object({
      previewId: z.string().min(1),
      selections: z.array(z.object({ neighborId: z.string().min(1), action: z.enum(['ADD', 'ADD_UNMONITORED', 'LINK_ONLY', 'IGNORE']), selectedDeviceId: z.string().optional() })).min(1),
    }).parse(request.body);
    const selections = body.selections.map((selection) => ({ neighborId: selection.neighborId, action: selection.action, ...(selection.selectedDeviceId ? { selectedDeviceId: selection.selectedDeviceId } : {}) })) satisfies DiscoveryApplySelection[];
    const result = maps.applyDiscovery(body.previewId, selections);
    return result ?? reply.code(404).send({ message: 'Preview expirado ou inexistente' });
  });
}
