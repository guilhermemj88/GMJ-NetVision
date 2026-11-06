// Real Playwright. Requests go to the candidate WEB/API; no route interception or HTTP fixtures.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HOMOLOG_PLAYWRIGHT_MODULE || 'playwright');
const c = JSON.parse(readFileSync(process.env.HOMOLOG_CONFIG_PATH, 'utf8'));
const out = process.env.HOMOLOG_EVIDENCE_DIR;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 2200 } });
const page = await context.newPage(),
  requests = [],
  errors = [],
  captures = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (!['127.0.0.1', 'localhost'].includes(u.hostname))
    errors.push('NON_LOCAL_REQUEST ' + u.origin);
});
page.on('response', (r) =>
  requests.push({ at: new Date().toISOString(), url: r.url(), status: r.status() }),
);
page.on('pageerror', (e) => errors.push(e.message));
const login = await context.request.post(`http://127.0.0.1:${c.apiPort}/api/auth/login`, {
  data: { usernameOrEmail: 'homolog-admin', password: c.adminPassword },
});
if (!login.ok()) throw Error('REAL_API_LOGIN_FAILED');
await page.goto(`http://127.0.0.1:${c.webPort}/?view=bgp`, { waitUntil: 'domcontentloaded' });
await page.getByRole('tab', { name: 'MITIGAÇÃO DDoS' }).click({ timeout: 90000 });
const panel = page.getByTestId('auto-all-live');
await panel.waitFor({ timeout: 90000 });
await panel.locator('[data-profile-id]').nth(22).waitFor();
if (await panel.locator('[data-profile-id]').count() !== 23) throw Error('EXPECTED_23_REAL_ROWS');
async function capture(name) {
  const file = resolve(out, `playwright-${name}.png`);
  await panel.screenshot({ path: file });
  const text = await panel.innerText();
  const rows = await panel.locator('tbody tr').count();
  captures.push({ name, file, at: new Date().toISOString(), rows, text, url: page.url() });
  writeFileSync(
    resolve(out, 'playwright.json'),
    JSON.stringify({ realBrowser: true, interception: false, captures, requests, errors }, null, 2),
  );
  console.log('CAPTURE', name, 'rows', rows);
}
await capture(process.env.HOMOLOG_INITIAL_CAPTURE || 'normal');
console.log('PLAYWRIGHT_READY');
const seen = new Set();
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const values = await panel.getByTestId('auto-all-progress').allTextContents();
    for (const stage of ['1/3', '2/3', '3/3'])
      if (values.length === 23 && values.every((v) => v === stage) && !seen.has(stage)) {
        seen.add(stage);
        await capture(stage.replace('/', '-'));
      }
    const text = await panel.innerText();
    if (text.includes('PERDIDA') && !seen.has('lease-lost')) {
      seen.add('lease-lost');
      await capture('lease-lost');
    }
  } catch (e) {
    errors.push(String(e));
  } finally {
    running = false;
  }
}, 400);
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let i;
  while ((i = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, i);
    input = input.slice(i + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.action === 'capture') void capture(command.name);
    if (command.action === 'finish') {
      clearInterval(timer);
      void browser.close().then(() => process.exit(0));
    }
  }
});
