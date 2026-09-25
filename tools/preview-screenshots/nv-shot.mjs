/**
 * Screenshot driver via Chrome DevTools Protocol (sem dependencias).
 *
 * Uso:
 *   node nv-shot.mjs --url <url> --out <png> [--width 1920] [--height 1080]
 *                    [--wait 2500] [--login-user u --login-pass p]
 *                    [--eval "<js>"] [--eval-wait 900] [--port 9222]
 *
 * Faz login pela propria pagina (same-origin) para que o cookie httpOnly seja
 * gravado pelo browser, depois navega e captura a tela.
 */
import { writeFileSync } from 'node:fs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const url = arg('url');
const out = arg('out');
const width = Number(arg('width', '1920'));
const height = Number(arg('height', '1080'));
const waitMs = Number(arg('wait', '2500'));
const evalJs = arg('eval');
const evalWaitMs = Number(arg('eval-wait', '1200'));
const loginUser = arg('login-user');
const loginPass = arg('login-pass');
const debugPort = Number(arg('port', '9222'));

if (!url || !out) {
  console.error('uso: node nv-shot.mjs --url <url> --out <png> [...]');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Edge ainda nao subiu o endpoint de debug.
    }
    await sleep(250);
  }
  throw new Error(`nenhum target de pagina em http://127.0.0.1:${debugPort}/json/list`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitForEvent(method, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.events.some((event) => event.method === method)) return true;
      await sleep(80);
    }
    return false;
  }
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('falha ao abrir websocket do CDP')), {
    once: true,
  });
});

const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});

const origin = new URL(url).origin;

if (loginUser && loginPass) {
  cdp.events.length = 0;
  await cdp.send('Page.navigate', { url: `${origin}/login` });
  await cdp.waitForEvent('Page.loadEventFired');
  await sleep(1200);
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: ${JSON.stringify(loginUser)}, password: ${JSON.stringify(loginPass)} }),
      });
      return response.status;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(`login status: ${result.result?.value}`);
}

cdp.events.length = 0;
await cdp.send('Page.navigate', { url });
await cdp.waitForEvent('Page.loadEventFired');
await sleep(waitMs);

if (evalJs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: evalJs,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    console.error(`eval falhou: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
  } else {
    console.log(`eval: ${JSON.stringify(result.result?.value ?? null).slice(0, 300)}`);
  }
  await sleep(evalWaitMs);
}

const problems = cdp.events
  .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
  .map((event) => {
    if (event.method === 'Runtime.exceptionThrown') {
      const d = event.params.exceptionDetails;
      return `[exception] ${d.exception?.description ?? d.text}`.slice(0, 500);
    }
    const entry = event.params.entry;
    return `[${entry.level}] ${entry.text}`.slice(0, 500);
  })
  .filter((line) => !/Download the React DevTools|net::ERR_ABORTED/.test(line));

if (problems.length) {
  console.log(`--- ${problems.length} evento(s) de console/excecao ---`);
  for (const line of problems.slice(0, 12)) console.log(line);
}

const failedResponses = cdp.events
  .filter((event) => event.method === 'Network.responseReceived')
  .map((event) => event.params.response)
  .filter((response) => response.status >= 400)
  .map((response) => `${response.status} ${response.url}`.slice(0, 220));

if (failedResponses.length) {
  console.log(`--- ${failedResponses.length} resposta(s) >=400 ---`);
  for (const line of [...new Set(failedResponses)].slice(0, 15)) console.log(line);
}

const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`screenshot: ${out}`);
ws.close();
