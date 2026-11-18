import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostRecord, PhysicalCatalogEntry } from '@gmj/shared';
import { PrismaClient } from '../../../generated/prisma';
import { PrismaPhysicalRepository } from '../../physical/prisma-physical-repository';
import { PHYSICAL_CATALOG } from '../../physical/physical-catalog';
import { loadPhysicalCatalogFile } from '../../physical/physical-catalog-yaml';
import { PrismaMitigationRepository } from './prisma-mitigation-repository';
import { BgpMitigationDiscoveryService } from './mitigation-discovery-service';
import type { BgpDiscoveryOutcome } from '../bgp-discovery-service';
import { resolve } from 'node:path';

const url = process.env.NETVISION_PHASE01_TEST_DB;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/phase01'))
  throw Error('Refusing non-disposable phase01 database');

describe.skipIf(!url)('phase01 real PostgreSQL atomicity and discovery', () => {
  const db = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid' });
  const repo = new PrismaPhysicalRepository(db);
  const run = randomUUID();
  const deviceId = 'phase01-device-' + run;
  const iface = 'phase01-interface-' + run;
  const entry = (key: string, name = key): PhysicalCatalogEntry => ({
    catalogKey: key + run,
    name: name + run,
    category: 'ROUTER',
    manufacturer: 'Test',
    family: 'T',
    model: 'M',
    kind: 'NETWORK',
    heightU: 1,
    description: '',
    vendorVerified: false,
    structureConfirmed: true,
    referenceUrl: null,
    portSummary: null,
    ports: [],
    slots: [],
    modules: [],
  });
  beforeAll(async () => {
    await db.device.create({
      data: {
        id: deviceId,
        name: 'test',
        displayName: 'test',
        hostname: 'test',
        ip: '127.0.0.1',
        managementIp: '127.0.0.1',
        deviceType: 'ROUTER',
        source: 'MANUAL',
      },
    });
    await db.interface.create({
      data: {
        id: iface,
        deviceId,
        name: 'Eth-Trunk1.1',
        alias: 'CLIENT_10GB',
        ifIndex: 1,
        adminStatus: 'UP',
      },
    });
    await db.interface.create({
      data: {
        id: iface + '-2',
        deviceId,
        name: 'Eth-Trunk1.2',
        alias: 'CLIENT_10GB',
        ifIndex: 2,
        adminStatus: 'UP',
      },
    });
  });
  afterAll(() => db.$disconnect());
  it('empty catalog, repeat bootstrap and unchanged updatedAt', async () => {
    const e = entry('p01-idempotent');
    expect((await repo.syncCatalog([e])).created).toBe(1);
    const before = await db.physicalEquipmentTemplate.findUniqueOrThrow({
      where: { catalogKey: e.catalogKey },
    });
    await repo.syncCatalog([e]);
    const after = await db.physicalEquipmentTemplate.findUniqueOrThrow({
      where: { catalogKey: e.catalogKey },
    });
    expect(after.id).toBe(before.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
  it('two concurrent initializations serialize without duplicates', async () => {
    const e = entry('p01-concurrent');
    const results = await Promise.all([repo.syncCatalog([e]), repo.syncCatalog([e])]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
  });
  it('conflicting name rolls back preceding writes and never adopts CUSTOM', async () => {
    await db.physicalEquipmentTemplate.create({
      data: {
        name: 'p01-custom' + run,
        origin: 'CUSTOM',
        kind: 'NETWORK',
        heightU: 2,
        manufacturer: 'Operator',
        family: '',
        model: '',
        description: 'preserve',
        category: 'ROUTER',
      },
    });
    await expect(
      repo.syncCatalog([entry('p01-rolled-back'), entry('p01-alien', 'p01-custom')]),
    ).rejects.toThrow('PHYSICAL_CATALOG_NAME_CONFLICT');
    expect(
      await db.physicalEquipmentTemplate.findUnique({
        where: { catalogKey: 'p01-rolled-back' + run },
      }),
    ).toBeNull();
    expect(
      (
        await db.physicalEquipmentTemplate.findUniqueOrThrow({
          where: { name: 'p01-custom' + run },
        })
      ).description,
    ).toBe('preserve');
    expect((await repo.syncCatalog([entry('p01-rolled-back')])).created).toBe(1);
  });
  it('failure creating dependent ports rolls back template and permits corrected retry', async () => {
    const e = entry('p01-child-failure');
    const port = {
      name: 'same',
      label: 'same',
      order: 0,
      side: 'DEVICE' as const,
      type: 'OTHER' as const,
    };
    await expect(repo.syncCatalog([{ ...e, ports: [port, port] }])).rejects.toThrow();
    expect(
      await db.physicalEquipmentTemplate.findUnique({ where: { catalogKey: e.catalogKey } }),
    ).toBeNull();
    expect((await repo.syncCatalog([{ ...e, ports: [port] }])).created).toBe(1);
  });
  it('canonical YAML imports twice; emergency catalog conflict cannot partially mutate it', async () => {
    const yaml = loadPhysicalCatalogFile(resolve('catalog/physical-catalog-v1.yaml'));
    expect(yaml.errors).toEqual([]);
    expect(yaml.entries.length).toBe(121);
    await repo.syncCatalog(yaml.entries);
    await repo.syncCatalog(yaml.entries);
    const before = await db.physicalEquipmentTemplate.findMany({ orderBy: { id: 'asc' } });
    await expect(repo.syncCatalog(PHYSICAL_CATALOG)).rejects.toThrow(
      'PHYSICAL_CATALOG_NAME_CONFLICT',
    );
    expect(await db.physicalEquipmentTemplate.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  const repository = new PrismaMitigationRepository(db);
  const outcome: BgpDiscoveryOutcome = {
    localAs: 64500n,
    localAsAmbiguous: false,
    ipv6Supported: true,
    warnings: [],
    peers: [
      {
        peerAddress: '192.0.2.1',
        addressFamily: 'IPV4',
        localAs: null,
        remoteAs: 64501n,
        stateCode: 6,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 100,
        cliReceivedPrefixes: 2n,
        bgpPeerDescription: null,
        interfaceId: iface,
        interfaceName: 'Eth-Trunk1.1',
        interfaceAlias: 'CLIENT_10GB',
        interfaceDescription: 'CLIENT_10GB',
        displayName: 'CLIENT',
        correlationStatus: 'MATCHED',
        correlationError: null,
      },
    ],
  };
  let configFails = false;
  const service = new BgpMitigationDiscoveryService({
    repository,
    bgpDiscovery: {
      discover: async () => {
        throw Error('must not perform live BGP discovery');
      },
    },
    configSource: {
      readMitigationConfig: async () => {
        if (configFails) throw Error('read failed');
        return {
          bgpConfiguration:
            'bgp 64500\n ipv4-family unicast\n  peer 192.0.2.1 route-policy TEST-IN import',
          routePolicyConfiguration: 'route-policy TEST-IN permit node 11',
          warnings: [],
        };
      },
    },
  });
  const device = { id: deviceId } as HostRecord;
  it('repeated boot and absent snapshot do not create profiles', async () => {
    for (let n = 0; n < 2; n++) {
      const r = await service.discoverFromBgpOutcome(device, outcome, 'SNAPSHOT_ONLY');
      expect(r.profiles[0]?.profileId).toBeNull();
      expect(r.createdProfiles).toBe(0);
      expect(r.profiles[0]?.registrationStatus).toBe('PENDING_REVIEW');
    }
    expect(await db.bgpMitigationProfile.count({ where: { deviceId } })).toBe(0);
    configFails = true;
    await expect(service.discoverFromBgpOutcome(device, outcome, 'SNAPSHOT_ONLY')).rejects.toThrow(
      'read failed',
    );
    configFails = false;
  });
  it('explicit registration is ALERT_ONLY; repeat discovery does not change profile updatedAt', async () => {
    const r = await service.discoverFromBgpOutcome(device, outcome, 'REGISTER_NEW');
    const id = r.profiles[0]!.profileId!;
    expect(r.profiles[0]?.registrationStatus).toBe('CREATED_REVIEW_REQUIRED');
    const before = await repository.getProfile(id);
    expect(before?.mode).toBe('ALERT_ONLY');
    expect(before?.autoPromotedBySweep).toBe(false);
    await service.discoverFromBgpOutcome(device, outcome, 'REGISTER_NEW');
    expect((await repository.getProfile(id))?.updatedAt).toEqual(before?.updatedAt);
  });
  it('AUTO, DISABLED, manual override and timestamps survive boot and changed snapshots', async () => {
    const p = (await repository.listProfiles({ deviceId }))[0]!;
    await repository.setProfileMode(p.id, 'AUTO');
    await repository.upsertRuntime(p.id, { state: 'DISABLED' });
    await db.bgpMitigationProfile.update({
      where: { id: p.id },
      data: { bandwidthOverrideBps: 20n },
    });
    const before = await repository.getProfile(p.id);
    const changed = {
      ...outcome,
      peers: outcome.peers.map((peer) => ({
        ...peer,
        interfaceAlias: 'CLIENT_20GB',
        interfaceDescription: 'CLIENT_20GB',
      })),
    };
    await service.discoverFromBgpOutcome(device, changed, 'SNAPSHOT_ONLY');
    expect(await repository.getProfile(p.id)).toEqual(before);
    expect((await repository.getRuntime(p.id))?.state).toBe('DISABLED');
    await Promise.all([
      service.discoverFromBgpOutcome(device, changed, 'RECONCILE_EXISTING'),
      db.bgpMitigationProfile.update({
        where: { id: p.id },
        data: { enabled: false, bandwidthOverrideBps: 30n },
      }),
    ]);
    expect(await repository.getProfile(p.id)).toMatchObject({
      mode: 'AUTO',
      enabled: false,
      bandwidthOverrideBps: 30n,
      detectedBandwidthBps: 20_000_000_000n,
    });
    expect((await repository.getRuntime(p.id))?.state).toBe('DISABLED');
  });
  it('optimistic reconciliation cannot overwrite a concurrent verified command or initialize over it', async () => {
    const p = (await repository.listProfiles({ deviceId }))[0]!;
    const before = await repository.getRuntime(p.id);
    await repository.upsertRuntime(p.id, {
      state: 'MITIGATED',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
    });
    await repository.reconcileDiscoveryRuntime(
      p.id,
      { state: 'DISABLED', plannedMitigationNode: null },
      before,
    );
    await repository.reconcileDiscoveryRuntime(p.id, { state: 'NORMAL' }, null);
    expect(await repository.getRuntime(p.id)).toMatchObject({
      state: 'MITIGATED',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
    });
  });
  it('same policy on another interface is another identity, not a duplicate', async () => {
    const other = {
      ...outcome,
      peers: outcome.peers.map((peer) => ({ ...peer, interfaceId: iface + '-2' })),
    };
    expect(
      (await service.discoverFromBgpOutcome(device, other, 'RECONCILE_EXISTING')).createdProfiles,
    ).toBe(0);
    expect(
      (await service.discoverFromBgpOutcome(device, other, 'REGISTER_NEW')).createdProfiles,
    ).toBe(1);
    expect(
      await db.bgpMitigationProfile.count({ where: { deviceId, policyName: 'TEST-IN' } }),
    ).toBe(2);
  });
});
