// One-shot read-only consistency probe: two GETs, ten seconds apart, no engine or persistence.
// Run as root with a dedicated observer release path; credentials never print.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const release = process.argv[2];
if (!release?.startsWith('/opt/netvision-fast-observer/releases/rc-'))
  throw new Error('Observer release path required');
const config = Object.fromEntries(
  fs
    .readFileSync('/etc/netvision-fast-observer.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const n = l.indexOf('=');
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
const tools = createRequire('/opt/GMJ-NetVision-production-alarm-chart/package.json');
const source = path.join(release, 'build/apps/api/src');
const core = path.join(release, 'audit/probe-core.cjs');
tools('esbuild').buildSync({
  stdin: {
    contents: `export {FastSnmpReader} from './infrastructure/snmp/fast-snmp-reader';
export {SnmpClientImpl} from './infrastructure/snmp/snmp-client-impl';
export {deriveFastTraffic} from './infrastructure/snmp/fast-traffic-rate';
export {CredentialVault} from './application/credential-vault';`,
    resolveDir: source,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  outfile: core,
});
// audit/ lives alongside runtime/; make external SNMP dependencies resolvable through an explicit require path.
const modules = path.join(release, 'node_modules');
if (!fs.existsSync(modules)) fs.symlinkSync(path.join(release, 'runtime/node_modules'), modules);
const require = createRequire(core);
const { FastSnmpReader, SnmpClientImpl, deriveFastTraffic, CredentialVault } = require(core);
const { PrismaClient } = require(path.join(release, 'runtime/dist/generated/prisma'));
const db = new PrismaClient({
  datasources: { db: { url: config.MITIGATION_FAST_SOURCE_DATABASE_URL } },
});
try {
  const ro = await db.$queryRawUnsafe('SHOW transaction_read_only');
  if (ro[0].transaction_read_only !== 'on') throw new Error('Read-only source required');
  const id = 'host-377c554a-8d1e-47c4-baa4-f258693b4d91';
  const d = await db.device.findUnique({
    where: { id },
    include: { interfaces: true, snmpCredential: true },
  });
  const host = { ...d, snmp: { version: d.snmpVersion, host: d.snmpHost, port: d.snmpPort } };
  const vault = new CredentialVault(config.CREDENTIAL_ENCRYPTION_KEY);
  const reader = new FastSnmpReader(
    {
      getHost: async () => host,
      getDecryptedSnmpCredentials: async () => vault.decrypt(d.snmpCredential.encryptedPayload),
    },
    new SnmpClientImpl(1500, 0),
  );
  const targets = d.interfaces
    .filter((i) => ['Eth-Trunk1', 'Eth-Trunk1.3043', 'Eth-Trunk1.3044'].includes(i.name))
    .map((i) => ({
      deviceId: id,
      interfaceId: i.id,
      interfaceName: i.name,
      ifIndex: i.ifIndex,
      speedBps: i.speedBps,
      profiles: [],
    }));
  const first = await reader.read(targets);
  await new Promise((r) => setTimeout(r, 10000));
  const second = await reader.read(targets);
  const result = second.map((c) => {
    const t = targets.find((t) => t.interfaceId === c.interfaceId);
    const p = first.find((p) => p.interfaceId === c.interfaceId);
    const o = deriveFastTraffic(t, c, p, 'read-only-diagnostic');
    return {
      ...o,
      inOctets: String(o.inOctets),
      outOctets: String(o.outOctets),
      uptimeTicks: String(o.uptimeTicks),
      discontinuityTicks: String(o.discontinuityTicks),
      lastChangeTicks: String(o.lastChangeTicks),
      speedBps: String(o.speedBps),
    };
  });
  fs.writeFileSync(
    path.join(release, 'audit/real-snmp-probe.json'),
    JSON.stringify(
      { readOnly: true, oneShot: true, noEngine: true, observations: result },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
