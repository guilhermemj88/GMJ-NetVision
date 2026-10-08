import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkInterface, ZabbixHostCandidate } from '@gmj/shared';
import type { DiscoveryService } from './application/discovery-service';
import { CredentialVault } from './application/credential-vault';
import { registerHostRoutes } from './host-routes';
import type {
  ZabbixAdapter,
  ZabbixSnmpImportConfig,
} from './infrastructure/metrics/zabbix-adapter';
import { CredentialEncryptionUnavailableError, DemoMapRepository } from './infrastructure/persistence/demo-map-repository';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import type { SnmpService } from './infrastructure/snmp/snmp-service';
import type { SshInterfaceService } from './infrastructure/ssh/ssh-interface-service';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'community-super-secreta';

function candidate(partial: Partial<ZabbixHostCandidate> = {}): ZabbixHostCandidate {
  return {
    hostId: '90001',
    hostname: 'qa-zabbix-snmp-01',
    displayName: 'QA Zabbix SNMP 01',
    managementIp: '203.0.113.34',
    primaryInterfaceId: '232',
    vendor: 'Huawei',
    model: 'MA5800-X15',
    status: 'UP',
    alreadyRegistered: false,
    matchedHostId: null,
    interfaceCount: 4,
    snmpAvailable: true,
    snmpVersion: 'SNMP_V2C',
    snmpPort: 161,
    ...partial,
  };
}

function snmpImportConfig(): ZabbixSnmpImportConfig {
  return { enabled: true, version: 'SNMP_V2C', host: '203.0.113.34', port: 161, community: SECRET };
}

interface Harness {
  app: FastifyInstance;
  hosts: DemoHostRepositoryAdapter;
  legacyMaps: DemoMapRepository;
  state: { candidates: ZabbixHostCandidate[] };
  zabbix: {
    healthcheck: ReturnType<typeof vi.fn>;
    getHostCandidates: ReturnType<typeof vi.fn>;
    getInterfaces: ReturnType<typeof vi.fn>;
    getSnmpImportConfig: ReturnType<typeof vi.fn>;
  };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createHarness(options: {
  vault: CredentialVault | null;
  candidates?: ZabbixHostCandidate[];
  snmpConfig?: ZabbixSnmpImportConfig | null;
  snmpConfigError?: boolean;
}): Promise<Harness> {
  const legacyMaps = new DemoMapRepository(options.vault);
  const hosts = new DemoHostRepositoryAdapter(new DemoMapRepository(options.vault));
  const state = { candidates: options.candidates ?? [candidate()] };
  const zabbix = {
    healthcheck: vi.fn(async () => ({ version: '6.0.33' })),
    getHostCandidates: vi.fn(async () => state.candidates),
    getInterfaces: vi.fn(async (): Promise<NetworkInterface[]> => []),
    getSnmpImportConfig: vi.fn(async () => {
      if (options.snmpConfigError) throw new Error('Zabbix host.get falhou (código -32602)');
      return options.snmpConfig ?? null;
    }),
  };
  const app = Fastify({ logger: false });
  registerHostRoutes(app, {
    legacyMaps,
    mapMembership: { addHostToMap: () => null },
    hosts,
    discovery: {} as unknown as DiscoveryService,
    snmp: {} as unknown as SnmpService,
    ssh: {} as unknown as SshInterfaceService,
    zabbix: zabbix as unknown as ZabbixAdapter,
  });
  await app.ready();
  apps.push(app);
  return { app, hosts, legacyMaps, state, zabbix };
}

describe('import Zabbix -> NetVision com SNMP v2c automatico', () => {
  it('preview expoe apenas metadados publicos de SNMP e nao busca o segredo', async () => {
    const { app, zabbix } = await createHarness({ vault: new CredentialVault(TEST_KEY) });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });

    expect(preview.statusCode).toBe(200);
    expect(preview.body).not.toContain(SECRET);
    expect(preview.body).not.toContain('community');
    expect(preview.json().hosts[0]).toMatchObject({
      hostname: 'qa-zabbix-snmp-01',
      managementIp: '203.0.113.34',
      snmpAvailable: true,
      snmpVersion: 'SNMP_V2C',
      snmpPort: 161,
    });
    expect(zabbix.getSnmpImportConfig).not.toHaveBeenCalled();
  });

  it('import habilita SNMP v2c, criptografa a community e nao a devolve', async () => {
    const vault = new CredentialVault(TEST_KEY);
    const encryptSpy = vi.spyOn(vault, 'encrypt');
    const { app, hosts, zabbix } = await createHarness({
      vault,
      snmpConfig: snmpImportConfig(),
    });
    const createSpy = vi.spyOn(hosts, 'createHost');
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90001'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('community');
    expect(zabbix.getSnmpImportConfig).toHaveBeenCalledWith('90001');

    // A community chega ao CreateHostInput apenas internamente...
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'qa-zabbix-snmp-01',
        displayName: 'QA Zabbix SNMP 01',
        managementIp: '203.0.113.34',
        snmp: expect.objectContaining({
          enabled: true,
          version: 'SNMP_V2C',
          host: '203.0.113.34',
          port: 161,
          community: SECRET,
          username: '',
          securityLevel: 'NO_AUTH_NO_PRIV',
          authProtocol: null,
          privacyProtocol: null,
        }),
      }),
      expect.anything(),
    );
    // ...e e criptografada pelo CredentialVault.
    expect(encryptSpy).toHaveBeenCalledWith(expect.objectContaining({ community: SECRET }));

    const record = response.json().imported[0];
    expect(record).toMatchObject({
      hostname: 'qa-zabbix-snmp-01',
      managementIp: '203.0.113.34',
      snmpEnabled: true,
    });
    expect(record.snmp).toMatchObject({
      version: 'SNMP_V2C',
      host: '203.0.113.34',
      port: 161,
      credentialConfigured: true,
    });
    expect(record.snmp).not.toHaveProperty('community');
    // Round-trip interno: a credencial foi persistida e pode ser decriptada.
    await expect(hosts.getDecryptedSnmpCredentials(record.id)).resolves.toMatchObject({
      community: SECRET,
    });
  });

  it('host ja cadastrado continua skipped e nao busca SNMP nem cria host', async () => {
    const harness = await createHarness({ vault: new CredentialVault(TEST_KEY), candidates: [] });
    const existing = harness.legacyMaps.listHosts()[0]!;
    harness.state.candidates = [
      candidate({
        hostId: '90002',
        hostname: existing.hostname,
        displayName: existing.hostname,
        managementIp: existing.managementIp,
      }),
    ];
    const { app, hosts, zabbix } = harness;
    const createSpy = vi.spyOn(hosts, 'createHost');
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    expect(preview.json().hosts[0].alreadyRegistered).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90002'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ imported: [], skippedHostIds: ['90002'] });
    expect(createSpy).not.toHaveBeenCalled();
    expect(zabbix.getSnmpImportConfig).not.toHaveBeenCalled();
  });

  it('host sem SNMP continua importavel com SNMP desabilitado', async () => {
    const { app } = await createHarness({
      vault: new CredentialVault(TEST_KEY),
      candidates: [
        candidate({
          hostId: '90003',
          hostname: 'qa-zabbix-plain-01',
          snmpAvailable: false,
          snmpVersion: null,
          snmpPort: null,
        }),
      ],
      snmpConfig: null,
    });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90003'] },
    });
    expect(response.statusCode).toBe(200);
    const record = response.json().imported[0];
    expect(record).toMatchObject({ hostname: 'qa-zabbix-plain-01', snmpEnabled: false });
    expect(record.snmp).toBeNull();
  });

  it('host SNMPv3 nao ganha SNMP automatico nem copia secrets', async () => {
    const { app } = await createHarness({
      vault: new CredentialVault(TEST_KEY),
      candidates: [
        candidate({ hostId: '90004', hostname: 'qa-zabbix-v3-01', snmpVersion: 'SNMP_V3' }),
      ],
      snmpConfig: null,
    });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    expect(preview.json().hosts[0]).toMatchObject({ snmpAvailable: true, snmpVersion: 'SNMP_V3' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90004'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().imported[0]).toMatchObject({ snmpEnabled: false });
    expect(response.body).not.toContain(SECRET);
  });

  it('falha da API Zabbix aborta com erro explicito e o retry depois funciona', async () => {
    const harness = await createHarness({
      vault: new CredentialVault(TEST_KEY),
      candidates: [candidate({ hostId: '90005', hostname: 'qa-zabbix-flaky-01' })],
      snmpConfigError: true,
    });
    const { app, hosts, legacyMaps, zabbix } = harness;
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90005'] },
    });

    // Falha do Zabbix NUNCA vira "SNMP desabilitado" silencioso.
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ failedHostIds: ['90005'] });
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('snmpEnabled');
    expect(legacyMaps.listHosts().map((item) => item.hostname)).not.toContain('qa-zabbix-flaky-01');
    expect((await hosts.listHosts()).map((item) => item.hostname)).not.toContain(
      'qa-zabbix-flaky-01',
    );

    // Depois que o Zabbix volta, o retry no mesmo preview importa com SNMP.
    zabbix.getSnmpImportConfig.mockImplementation(async () => snmpImportConfig());
    const retry = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90005'] },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().imported[0]).toMatchObject({ snmpEnabled: true });
    expect(retry.body).not.toContain(SECRET);
  });

  it('community macro nao e criptografada quando a config nao e importavel', async () => {
    const vault = new CredentialVault(TEST_KEY);
    const encryptSpy = vi.spyOn(vault, 'encrypt');
    const { app, hosts } = await createHarness({
      vault,
      candidates: [candidate({ hostId: '90006', hostname: 'qa-zabbix-macro-01' })],
      snmpConfig: null,
    });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90006'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().imported[0]).toMatchObject({ snmpEnabled: false });
    expect(encryptSpy).not.toHaveBeenCalled();
    await expect(
      hosts.getDecryptedSnmpCredentials(response.json().imported[0].id),
    ).resolves.toBeNull();
  });

  it('falha de credencial no batch nao deixa estado parcial e o retry funciona', async () => {
    const vault = new CredentialVault(TEST_KEY);
    const harness = await createHarness({
      vault,
      snmpConfig: snmpImportConfig(),
      candidates: [
        candidate({ hostId: '91001', hostname: 'qa-zabbix-batch-01', managementIp: '203.0.113.101' }),
        candidate({ hostId: '91002', hostname: 'qa-zabbix-batch-02', managementIp: '203.0.113.102' }),
      ],
    });
    const { app, hosts, legacyMaps } = harness;
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const createSpy = vi
      .spyOn(hosts, 'createHost')
      .mockRejectedValueOnce(new CredentialEncryptionUnavailableError());

    const failed = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['91001', '91002'] },
    });
    expect(failed.statusCode).toBe(409);
    // O primeiro host falhou na persistência antes de qualquer mutação em
    // memória: nenhum dos dois pode aparecer no estado legado ou persistente.
    expect(legacyMaps.listHosts().map((item) => item.hostname)).not.toContain('qa-zabbix-batch-01');
    expect(legacyMaps.listHosts().map((item) => item.hostname)).not.toContain('qa-zabbix-batch-02');
    expect((await hosts.listHosts()).map((item) => item.hostname)).not.toContain(
      'qa-zabbix-batch-01',
    );
    expect((await hosts.listHosts()).map((item) => item.hostname)).not.toContain(
      'qa-zabbix-batch-02',
    );

    // Retry no mesmo preview: nada ficou marcado como duplicado e ambos importam.
    createSpy.mockRestore();
    const retry = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['91001', '91002'] },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().skippedHostIds).toEqual([]);
    expect(retry.json().imported.map((item: { hostname: string }) => item.hostname)).toEqual([
      'qa-zabbix-batch-01',
      'qa-zabbix-batch-02',
    ]);
  });

  it('sem CREDENTIAL_ENCRYPTION_KEY falha de forma segura e nao vaza a community', async () => {
    const { app } = await createHarness({
      vault: null,
      snmpConfig: snmpImportConfig(),
    });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: ['90001'] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining('CREDENTIAL_ENCRYPTION_KEY'),
    });
    expect(response.body).not.toContain(SECRET);
  });
});
