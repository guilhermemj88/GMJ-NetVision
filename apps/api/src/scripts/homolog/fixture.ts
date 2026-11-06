/** Synthetic equipment and seed. No API, engine, lifecycle or HTTP transport is mocked. */
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ssh2 from 'ssh2';
import { PrismaClient } from '../../generated/prisma/index.js';
import { CredentialVault } from '../../application/credential-vault';
import { PrismaHostRepository } from '../../infrastructure/persistence/prisma-host-repository';
import { PrismaBgpRepository } from '../../infrastructure/bgp/prisma-bgp-repository';
import { HuaweiBgpSshService } from '../../infrastructure/bgp/huawei-bgp-ssh';
import { BgpDiscoveryService } from '../../infrastructure/bgp/bgp-discovery-service';
import { BgpMitigationDiscoveryService } from '../../infrastructure/bgp/mitigation/mitigation-discovery-service';
import { HuaweiBgpMitigationConfigSource } from '../../infrastructure/bgp/mitigation/mitigation-config-source';
import { PrismaMitigationRepository } from '../../infrastructure/bgp/mitigation/prisma-mitigation-repository';
import { BgpMitigationService } from '../../infrastructure/bgp/mitigation/mitigation-service';
import { PrismaMitigationSchemaProbe } from '../../infrastructure/bgp/mitigation/mitigation-schema-probe';

export interface HomologConfig {
  containerId: string;
  containerName: string;
  port: number;
  databaseUrl: string;
  negativeDatabaseUrl: string;
  credentialKey: string;
  deviceId: string;
  adminPassword: string;
  apiPort: number;
  secondApiPort: number;
  webPort: number;
  webhookPort: number;
  sshPort: number;
}
export const clients = Array.from({ length: 23 }, (_, i) => ({
  name: `SYNTHETIC-CLIENT-${String(i + 1).padStart(2, '0')}`,
  interfaceId: `synthetic-interface-${i + 1}`,
  interfaceName: `Eth-Trunk1.${1001 + i}`,
  peer: `192.0.2.${i + 1}`,
  policy: `PL-SYNTHETIC-${i + 1}-IN`,
  ifIndex: 1001 + i,
}));
export function assertDisposable(config: HomologConfig, url: string): void {
  const u = new URL(url);
  if (
    u.hostname !== '127.0.0.1' ||
    u.port !== String(config.port) ||
    [55433, 55439, 55077].includes(config.port) ||
    ![
      '/pilot_auto_all_homolog_20261105',
      '/pilot_auto_all_homolog_final_20261105',
      '/pilot_auto_all_homolog_verified_20261105',
      '/pilot_snapshot_negative_20261105',
    ].includes(u.pathname)
  )
    throw Error('HOMOLOG_DATABASE_NOT_EXPLICITLY_ALLOWED');
  const info = JSON.parse(
    execFileSync('docker', ['inspect', config.containerId], { encoding: 'utf8' }),
  )[0];
  if (
    info.Id !== config.containerId ||
    info.Name !== '/' + config.containerName ||
    info.Config.Labels['gmj.task'] !== 'pilot-auto-all-homolog-20261105' ||
    !Object.hasOwn(info.HostConfig.Tmpfs, '/var/lib/postgresql/data') ||
    JSON.stringify(info.HostConfig.PortBindings['5432/tcp']) !==
      JSON.stringify([{ HostIp: '127.0.0.1', HostPort: String(config.port) }])
  )
    throw Error('HOMOLOG_CONTAINER_IDENTITY_MISMATCH');
}
export function loadConfig(): HomologConfig {
  return JSON.parse(readFileSync(process.env.HOMOLOG_CONFIG_PATH!, 'utf8'));
}
export function saveEvidence(name: string, data: unknown): void {
  writeFileSync(
    `${process.env.HOMOLOG_EVIDENCE_DIR}/${name}.json`,
    JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
  );
}

export async function syntheticEquipment(config: HomologConfig) {
  const commands: Array<{ at: string; command: string; allowed: boolean }> = [];
  const connections = new Set<import('ssh2').Connection>();
  const bgp = [
    '# SYNTHETIC FIXTURE ONLY',
    'bgp 64512',
    ' ipv4-family unicast',
    ...clients.map((c) => `  peer ${c.peer} route-policy ${c.policy} import`),
    '#',
  ].join('\r\n');
  const policies = [
    '# SYNTHETIC FIXTURE ONLY',
    ...clients.flatMap((c) => [
      `route-policy ${c.policy} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      '#',
    ]),
  ].join('\r\n');
  const summary = [
    'Local AS number : 64512',
    ' Peer V AS MsgRcvd MsgSent OutQ Up/Down State PrefRcv',
    ...clients.map((c) => ` ${c.peer} 4 64513 100 100 0 00:10:00 Established 5`),
  ].join('\r\n');
  function output(command: string): string | undefined {
    if (command === 'screen-length 0 temporary') return '';
    if (command === 'display current-configuration configuration bgp') return bgp;
    if (command === 'display current-configuration configuration route-policy') return policies;
    if (command === 'display bgp peer') return summary;
    if (command === 'display bgp ipv6 peer') return 'Total number of peers : 0';
    const c = clients.find((c) => command === `display ip routing-table ${c.peer}`);
    if (c) return `Summary Count : 1\r\n${c.peer}/32 Direct 0 0 D ${c.peer} ${c.interfaceName}`;
    return undefined;
  }
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  const server = new ssh2.Server({ hostKeys: [key] }, (connection) => {
    connections.add(connection);
    connection.on('error', () => {}).on('close', () => connections.delete(connection));
    connection
      .on('authentication', (ctx) => {
        if (
          ctx.method === 'password' &&
          ctx.username === 'synthetic' &&
          ctx.password === 'fixture-only'
        )
          ctx.accept();
        else ctx.reject();
      })
      .on('ready', () =>
        connection.on('session', (accept) => {
          const session = accept();
          session.on('pty', (accept) => accept?.());
          session.on('shell', (accept) => {
            const stream = accept();
            let buffer = '';
            stream.write('\r\n<SYNTHETIC-ONLY>');
            stream.on('data', (chunk: Buffer) => {
              buffer += chunk.toString();
              let newline: number;
              while ((newline = buffer.indexOf('\n')) >= 0) {
                const command = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!command) continue;
                if (command === 'quit') {
                  stream.exit(0);
                  stream.end();
                  continue;
                }
                const text = output(command);
                commands.push({
                  at: new Date().toISOString(),
                  command,
                  allowed: text !== undefined,
                });
                if (text === undefined) {
                  stream.stderr.write('Error: synthetic equipment rejects this command\r\n');
                  stream.exit(1);
                  stream.end();
                  continue;
                }
                stream.write(`${command}\r\n${text}\r\n<SYNTHETIC-ONLY>`);
              }
            });
          });
        }),
      );
  });
  server.listen(config.sshPort, '127.0.0.1');
  await once(server, 'listening');
  return {
    commands,
    bgp,
    policies,
    close: async () => {
      for (const c of connections) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function seed(config: HomologConfig, negative = false): Promise<string[]> {
  const url = negative ? config.negativeDatabaseUrl : config.databaseUrl;
  assertDisposable(config, url);
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    if ((await db.device.count()) || (await db.bgpMitigationProfile.count()))
      throw Error('SEED_REQUIRES_FRESH_EMPTY_DATABASE');
    const vault = new CredentialVault(config.credentialKey);
    const credential = await db.sshCredential.create({
      data: {
        name: 'SYNTHETIC ONLY',
        port: config.sshPort,
        username: 'synthetic',
        encryptedPayload: vault.encrypt({ password: 'fixture-only' }),
      },
    });
    await db.device.create({
      data: {
        id: config.deviceId,
        name: 'SYNTHETIC ONLY',
        displayName: 'SYNTHETIC LOOPBACK ROUTER',
        hostname: 'synthetic-router.invalid',
        ip: '127.0.0.1',
        managementIp: '127.0.0.1',
        vendor: 'SYNTHETIC',
        deviceType: 'ROUTER',
        source: 'SYNTHETIC_HOMOLOGATION',
        notes: 'Generated fixture; never production discovery evidence',
        sshEnabled: true,
        sshHost: '127.0.0.1',
        sshPort: config.sshPort,
        sshUsername: 'synthetic',
        sshAuthentication: 'PASSWORD',
        sshCredentialId: credential.id,
        snmpEnabled: true,
        snmpVersion: 'SNMP_V2C',
        snmpHost: '127.0.0.1',
        snmpPort: 49161,
        interfaces: {
          create: clients.map((c) => ({
            id: c.interfaceId,
            name: c.interfaceName,
            alias: `${c.name}_1GB`,
            description: `${c.name}_1GB`,
            ifIndex: c.ifIndex,
            speedBps: 10000000000n,
            mitigationTrafficDirection: 'TX',
            adminStatus: 'UP',
            operStatus: 'UP',
          })),
        },
      },
    });
    const repository = new PrismaMitigationRepository(db);
    if (negative) {
      // Reproduce the old incomplete seed: a profile/profile-peer is not a BGP discovery snapshot.
      const p = await repository.upsertProfile({
        deviceId: config.deviceId,
        interfaceId: clients[0]!.interfaceId,
        policyName: clients[0]!.policy,
        mode: 'AUTO',
        detectedBandwidthBps: 1000000000n,
      });
      await db.bgpMitigationProfilePeer.create({
        data: { profileId: p.id, peerAddress: clients[0]!.peer, addressFamily: 'IPV4' },
      });
      saveEvidence('incomplete-seed', {
        synthetic: true,
        profiles: 1,
        mitigationProfilePeers: 1,
        bgpPeers: 0,
        expectedBootFailure: 'PILOT_SNAPSHOT_UNAVAILABLE',
      });
      return [p.id];
    }
    const hosts = new PrismaHostRepository(db, vault),
      bgpRepository = new PrismaBgpRepository(db);
    const ssh = new HuaweiBgpSshService(hosts),
      bgpDiscovery = new BgpDiscoveryService(ssh, bgpRepository);
    const discovery = new BgpMitigationDiscoveryService({
      repository,
      bgpDiscovery,
      configSource: new HuaweiBgpMitigationConfigSource(ssh),
    });
    const service = new BgpMitigationService({
      repository,
      discovery,
      hosts,
      persistedPeers: {
        listForDevice: (deviceId) =>
          bgpRepository.listDashboardPeers({ scope: 'all', state: 'all', deviceId }),
      },
      schemaProbe: new PrismaMitigationSchemaProbe(db),
      repositoryKind: 'DATABASE',
    });
    // REGISTER_NEW goes through actual SSH discovery, peer/interface correlation and policy parsers.
    const result = await service.discover([config.deviceId], { persistence: 'REGISTER_NEW' });
    if (
      result.profiles.length !== 23 ||
      result.profiles.some((p) => !p.snapshotAvailable || p.readiness !== 'READY')
    )
      throw Error(
        'LEGITIMATE_DISCOVERY_DID_NOT_PRODUCE_23_READY_PROFILES: ' + JSON.stringify(result),
      );
    for (const p of await repository.listProfiles())
      await repository.upsertProfile({
        deviceId: p.deviceId,
        interfaceId: p.interfaceId!,
        policyName: p.policyName,
        addressFamily: 'IPV4',
        mode: 'AUTO',
        enabled: true,
        triggerPercent: 95,
        recoveryPercent: 70,
        triggerSamples: 3,
        recoverySamples: 3,
      });
    const profiles = await repository.listProfiles();
    saveEvidence('seed', {
      synthetic: true,
      origin: 'loopback SSH -> BgpDiscoveryService -> REGISTER_NEW',
      deviceId: config.deviceId,
      result,
      profiles,
      bgpPeers: await db.bgpPeer.count(),
      interfaces: await db.interface.count(),
      profilePeers: await db.bgpMitigationProfilePeer.count(),
    });
    return profiles.map((p) => p.id);
  } finally {
    await db.$disconnect();
  }
}
