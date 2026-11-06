/** Real API process for the disposable homologation launcher. Stdin controls equipment only. */
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { assertDisposable, loadConfig } from './fixture';

const config = loadConfig();
assertDisposable(config, process.env.DATABASE_URL!);
for (const [key, expected] of Object.entries({
  DEMO_MODE: 'false',
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  MITIGATION_FAST_READER: 'SIMULATED',
  MITIGATION_AUTO_EXECUTION_ENABLED: '0',
  MITIGATION_AUTO_REMOVE_ENABLED: '0',
  MITIGATION_LIVE_WRITE_ENABLED: 'false',
  MITIGATION_EXECUTOR: 'MOCK',
}))
  if (process.env[key] !== expected) throw Error('HOMOLOG_REQUIRED_GATE: ' + key);
if (new URL(process.env.MITIGATION_N8N_WEBHOOK_URL!).hostname !== '127.0.0.1')
  throw Error('LOCAL_WEBHOOK_REQUIRED');

// Transport safety boundary, not an HTTP mock: real sockets are allowed only to loopback.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  const host =
    a && typeof a === 'object'
      ? ((a as { host?: string }).host ?? 'localhost')
      : typeof args[1] === 'string'
        ? args[1]
        : 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw Error('HOMOLOG_NON_LOOPBACK_EGRESS_BLOCKED');
  appendFileSync(
    `${process.env.HOMOLOG_EVIDENCE_DIR}/egress-${process.env.PORT}.jsonl`,
    JSON.stringify({ at: new Date().toISOString(), host, allowed: true }) + '\n',
  );
  return Reflect.apply(connect, this, args);
} as typeof connect;

let fraction = 0.2;
const { buildApp } = await import('../../app');
const app = await buildApp({ simulatedFastTrafficScript: () => fraction });
try {
  await app.ready();
  console.log('HOMOLOG_APP_READY');
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
  console.log('HOMOLOG_LISTEN_READY');
} catch (error) {
  console.error('HOMOLOG_BOOT_FAILED', error);
  await app.close().catch(() => {});
  process.exit(1);
}
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
    if (
      command.action === 'traffic' &&
      Number.isFinite(command.fraction) &&
      command.fraction >= 0 &&
      command.fraction <= 1
    ) {
      fraction = command.fraction;
      console.log('HOMOLOG_COUNTER_FRACTION', fraction);
    }
    if (command.action === 'shutdown') void app.close().then(() => process.exit(0));
  }
});
