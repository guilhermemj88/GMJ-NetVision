/** Reproducible launcher: all gates are applied to each real API in one child environment. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma/index.js';
import { loadConfig, seed, syntheticEquipment, saveEvidence, assertDisposable } from './fixture';

const c = loadConfig();
assertDisposable(c, c.databaseUrl);
const fixture = await syntheticEquipment(c);
const received: Array<{ at: string; body: Record<string, unknown>; raw: string; ack: boolean }> =
  [];
let acknowledge = process.env.HOMOLOG_ACK_ENABLED === '1';
const webhook = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  const body = JSON.parse(raw);
  received.push({ at: new Date().toISOString(), body, raw, ack: acknowledge });
  saveEvidence('http-growth', { synthetic: true, loopbackOnly: true, received });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      event: body.event,
      eventId: body.eventId,
      received: true,
      routed: acknowledge,
      delivered: acknowledge,
    }),
  );
});
webhook.listen(c.webhookPort, '127.0.0.1');
await once(webhook, 'listening');
const children: ChildProcess[] = [];
function boot(name: string, ids: string[], port: number, url = c.databaseUrl) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(MITIGATION_|NETVISION_|ZABBIX_|DATABASE_URL|FAST_TEST_DATABASE_URL|DEMO_MODE|SNMP_)/.test(
          k,
        ),
    ),
  );
  Object.assign(env, {
    DATABASE_URL: url,
    DEMO_MODE: 'false',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    CREDENTIAL_ENCRYPTION_KEY: c.credentialKey,
    DEFAULT_ADMIN_USERNAME: 'homolog-admin',
    DEFAULT_ADMIN_PASSWORD: c.adminPassword,
    DEFAULT_ADMIN_EMAIL: 'admin@synthetic.invalid',
    DEFAULT_ADMIN_NAME: 'SYNTHETIC ADMIN',
    NETVISION_INSTALLATION_ID: 'IMPLANTAR',
    MITIGATION_MODE: 'AUTO',
    MITIGATION_EXECUTOR: 'MOCK',
    MITIGATION_LIVE_WRITE_ENABLED: 'false',
    MITIGATION_ALLOWED_DEVICE_IDS: c.deviceId,
    MITIGATION_FAST_READER: 'SIMULATED',
    MITIGATION_FAST_POLL_MODE: 'ENFORCE',
    MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1',
    MITIGATION_FAST_NORMAL_SECONDS: '5',
    MITIGATION_FAST_SINGLE_OWNER: '1',
    MITIGATION_FAST_BRIDGE_MODE: 'OFF',
    MITIGATION_AUTO_LIFECYCLE_ENABLED: '1',
    MITIGATION_AUTO_PERSISTENCE_ENABLED: '1',
    MITIGATION_AUTO_EXPANSION_ENABLED: '1',
    MITIGATION_AUTO_EXECUTION_ENABLED: '0',
    MITIGATION_AUTO_REMOVE_ENABLED: '0',
    MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: ids.join(','),
    MITIGATION_AUTO_MAX_ACTIVE: '1',
    MITIGATION_N8N_WEBHOOK_URL: `http://127.0.0.1:${c.webhookPort}/synthetic-only`,
    SNMP_POLLING_ENABLED: 'false',
    HOMOLOG_CONFIG_PATH: process.env.HOMOLOG_CONFIG_PATH!,
    HOMOLOG_EVIDENCE_DIR: process.env.HOMOLOG_EVIDENCE_DIR!,
  });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('apps/api/src/scripts/homolog/api-process.ts')],
    { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const log = createWriteStream(`${process.env.HOMOLOG_EVIDENCE_DIR}/boot-${name}.log`);
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  children.push(child);
  console.log('BOOT', name, 'pid', child.pid, 'port', port);
  return child;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil<T>(
  name: string,
  work: () => Promise<T | false>,
  timeout = 90000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await work();
      if (value) return value;
    } catch {
      /* bounded startup polling */
    }
    await delay(500);
  }
  throw Error('HOMOLOG_TIMEOUT: ' + name);
}
async function login(port: number) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernameOrEmail: 'homolog-admin', password: c.adminPassword }),
  });
  if (!r.ok) throw Error('AUTH_FAILED');
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
async function get(port: number, path: string, cookie: string) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie } });
  if (!r.ok) throw Error('HTTP ' + r.status + ' ' + path);
  return r.json();
}

try {
  let ids: string[];
  if (process.argv.includes('--resume')) {
    const db = new PrismaClient({ datasourceUrl: c.databaseUrl });
    try {
      ids = (await db.bgpMitigationProfile.findMany()).map((p) => p.id);
      if (ids.length !== 23) throw Error('RESUME_REQUIRES_23_SYNTHETIC_PROFILES');
    } finally {
      await db.$disconnect();
    }
  } else {
    if (!process.argv.includes('--seed-main')) {
      const negativeIds = await seed(c, true);
      const negative = boot('negative', negativeIds, c.secondApiPort, c.negativeDatabaseUrl);
      const [exit] = await once(negative, 'exit');
      if (exit !== 1) throw Error('INCOMPLETE_SEED_MUST_FAIL_BOOT');
      console.log('NEGATIVE_BOOT_GUARD_CONFIRMED');
    }
    ids = await seed(c);
  }
  saveEvidence('launch', {
    synthetic: true,
    databaseHost: '127.0.0.1',
    databasePort: c.port,
    ids,
    executionEnabled: false,
    removeEnabled: false,
    executor: 'MOCK',
    liveWrite: false,
    ports: {
      api: c.apiPort,
      secondaryApi: c.secondApiPort,
      web: c.webPort,
      webhook: c.webhookPort,
      ssh: c.sshPort,
    },
  });
  const primary = boot('primary', ids, c.apiPort);
  await waitUntil('primary health', async () => {
    const r = await fetch(`http://127.0.0.1:${c.apiPort}/health`);
    return r.ok;
  });
  const cookie = await login(c.apiPort);
  const bootState = await get(c.apiPort, '/api/bgp/mitigation/auto/lifecycle', cookie);
  if (!bootState.lifecycleReady || bootState.executionEnabled || bootState.removeEnabled)
    throw Error('BOOT_GATES');
  saveEvidence('boot-success', {
    health: await get(c.apiPort, '/health', cookie),
    lifecycle: bootState,
    mitigation: await get(c.apiPort, '/api/bgp/mitigation/health', cookie),
  });
  const secondary = boot('secondary', ids, c.secondApiPort);
  await waitUntil('secondary health', async () => {
    const r = await fetch(`http://127.0.0.1:${c.secondApiPort}/health`);
    return r.ok;
  });
  const cookie2 = await login(c.secondApiPort);
  console.log(
    'HOMOLOG_APIS_READY: equipment control via launcher stdin; use traffic/ack/finish commands',
  );
  const snapshots: unknown[] = [];
  let previousSnapshotKey = '';
  const timer = setInterval(() => {
    void (async () => {
      const at = new Date().toISOString(),
        all = await get(c.apiPort, '/api/bgp/mitigation/auto-all', cookie),
        poller = await get(c.apiPort, '/api/bgp/mitigation/fast-poller', cookie),
        second = await get(c.secondApiPort, '/api/bgp/mitigation/fast-poller', cookie2),
        health2 = await get(c.secondApiPort, '/api/bgp/mitigation/health', cookie2);
      const snapshotKey = JSON.stringify({
        owner: all.lease.acquired,
        lost: all.lease.lost,
        pid: all.lease.holderBackendPid,
        running: poller.running,
        requestBucket: Math.floor(poller.requests / 60),
        clients: all.clients.map(
          (c: { score: unknown }) =>
            c.score &&
            (({ progress, outcome, reason, trafficBps }: Record<string, unknown>) => ({
              progress,
              outcome,
              reason,
              trafficBps,
            }))(c.score as Record<string, unknown>),
        ),
      });
      if (snapshotKey === previousSnapshotKey) return;
      previousSnapshotKey = snapshotKey;
      snapshots.push({
        at,
        all,
        poller: {
          ...poller,
          profiles: poller.profiles.map((p: Record<string, unknown>) => ({
            ...p,
            history: undefined,
          })),
        },
        second,
        secondaryEngine: health2.autoEngine,
      });
      saveEvidence('timeline', snapshots);
    })().catch((e) => console.error('SNAPSHOT_ERROR', e.message));
  }, 1000);
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    let i: number;
    while ((i = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, i);
      input = input.slice(i + 1);
      if (!line.trim()) continue;
      const command = JSON.parse(line);
      if (command.action === 'traffic') primary.stdin!.write(JSON.stringify(command) + '\n');
      if (command.action === 'ack') acknowledge = command.enabled === true;
      if (command.action === 'finish') {
        clearInterval(timer);
        saveEvidence('ssh-equipment', {
          synthetic: true,
          connectionsOnly: '127.0.0.1',
          commands: fixture.commands,
        });
        for (const child of [primary, secondary]) child.stdin!.write('{"action":"shutdown"}\n');
        void Promise.all([once(primary, 'exit'), once(secondary, 'exit')]).then(() => {
          void fixture.close();
          webhook.closeAllConnections();
          webhook.close();
          process.exit(0);
        });
      }
    }
  });
} catch (error) {
  console.error(error);
  saveEvidence('failure', { error: String(error), received });
  for (const child of children)
    if (child.exitCode === null) child.stdin!.write('{"action":"shutdown"}\n');
  await fixture.close();
  webhook.closeAllConnections();
  webhook.close();
  process.exitCode = 1;
}
