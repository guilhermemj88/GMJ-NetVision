import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Server, utils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Bundle do harness DEV (o que seria usado na homologacao do MQT) executado como processo real, com credencial
 * SINTETICA e servidor SSH SINTETICO local (127.0.0.1). Nenhum equipamento, banco ou credencial real e usado.
 * Prova que o harness agora passa pelo SshCredentialBroker: aprovacao one-shot, fingerprint fixada e nenhuma
 * senha em log, auditoria ou resposta.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..'); // raiz do repositorio
const PASSWORD = 'Sint3tica-Senha-Harness-0006';
const HOST_ID = 'host-mqt-sintetico';
const NAME = 'BHE-MQT-SINTETICO';
const fp = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

let work = '';
let harnessBundle = '';
let harness: ChildProcess | undefined;
let sshServer: Server;
let sshPort = 0;
let apiPort = 0;
let pinned = '';
const attempts: Array<{ method: string; password?: string }> = [];
let harnessOut = '';

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function startHarness(fingerprint: string): Promise<void> {
  work = mkdtempSync(join(tmpdir(), 'vsi-harness-'));
  mkdirSync(join(work, 'approvals'), { mode: 0o700 });
  writeFileSync(join(work, 'host.json'), JSON.stringify({ id: HOST_ID, name: NAME, ip: '127.0.0.1', port: sshPort, username: 'svc-mqt', contextCommand: null }), { mode: 0o600 });
  writeFileSync(join(work, 'ssh.pass'), PASSWORD, { mode: 0o600 });
  writeFileSync(
    join(work, 'profiles.json'),
    JSON.stringify({
      profiles: [{
        hostId: HOST_ID, endpoint: '127.0.0.1', port: sshPort, username: 'svc-mqt', context: null, fingerprint,
        initialPrompt: `<${NAME}>`, expectedPrompt: `<${NAME}>`, vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
        validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', operations: ['VERSION', 'VSI_VERBOSE'],
      }],
    }),
    { mode: 0o600 },
  );
  apiPort = await freePort();
  harness = spawn(process.execPath, [harnessBundle], {
    env: { PATH: process.env.PATH ?? '', VSI_DEV_DIR: work, VSI_DEV_PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  harnessOut = '';
  harness.stdout!.on('data', (d) => (harnessOut += d));
  harness.stderr!.on('data', (d) => (harnessOut += d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('harness nao subiu');
}

async function stopHarness(): Promise<void> {
  harness?.kill();
  await new Promise((r) => setTimeout(r, 300));
  if (work) rmSync(work, { recursive: true, force: true });
  work = '';
}

/** `admin` APROVA (cria a aprovacao); `mcp` EXECUTA: a API recusa aprovador = executor. */
async function login(who: 'admin' | 'mcp' = 'mcp'): Promise<string> {
  const secrets = JSON.parse(readFileSync(join(work, 'secrets.json'), 'utf8')) as Record<'admin' | 'mcp', { usernameOrEmail: string; password: string }>;
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(secrets[who]) });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

const post = async (cookie: string, path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  // So o harness (o MCP nao e necessario aqui nem esta instalado na integracao de producao).
  const { harnessOptions } = (await import(pathToFileURL(join(ROOT, 'tools', 'vsi-dev', 'options.mjs')).href)) as {
    harnessOptions: (outfile: string) => Parameters<typeof build>[0];
  };
  harnessBundle = join(tmpdir(), `vsi-harness-bundle-${process.pid}.mjs`);
  await build({ ...harnessOptions(harnessBundle), absWorkingDir: ROOT, logLevel: 'silent' });
  const key = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key.private);
  if (parsed instanceof Error) throw parsed;
  pinned = fp(parsed.getPublicSSH());
  sshServer = new Server({ hostKeys: [key.private] }, (client) => {
    client.on('authentication', (ctx) => {
      attempts.push({ method: ctx.method, ...(ctx.method === 'password' ? { password: ctx.password } : {}) });
      ctx.reject(['password']);
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((r) => sshServer.listen(0, '127.0.0.1', r));
  sshPort = (sshServer.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await stopHarness();
  rmSync(harnessBundle, { force: true });
  sshServer?.close();
});

describe('bundle do harness DEV (MQT) com o broker, credencial e servidor SSH sinteticos', () => {
  it('fingerprint correta: a senha sintetica so chega ao servidor apos a verificacao; sem aprovacao nada acontece; sem vazamento', async () => {
    attempts.length = 0;
    await startHarness(pinned);
    const cookie = await login('mcp');
    const adminCookie = await login('admin');

    // 1) sem aprovacao: recusado, nenhuma conexao SSH
    const noApproval = await post(cookie, '/api/vsi-mcp/tools/list_vsi', { hostId: HOST_ID, source: 'LIVE', probe: 'VERSION' });
    expect(noApproval.status).toBe(423);
    expect(attempts).toEqual([]);

    // 2) aprovacao ADMIN one-shot: a sessao e aberta (o servidor sintetico recusa a autenticacao)
    const approval = JSON.parse((await post(adminCookie, '/api/vsi-mcp/approvals', { hostId: HOST_ID, ttlSeconds: 600 })).text) as { approvalId: string };
    const first = await post(cookie, '/api/vsi-mcp/tools/list_vsi', { hostId: HOST_ID, source: 'LIVE', probe: 'VERSION', approvalId: approval.approvalId, homologation: true });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text).status).toBe('ERROR');
    expect(attempts.some((a) => a.method === 'password' && a.password === PASSWORD)).toBe(true);
    const sent = attempts.length;

    // 3) mesma aprovacao de novo: 423 e nenhuma nova conexao
    const reuse = await post(cookie, '/api/vsi-mcp/tools/list_vsi', { hostId: HOST_ID, source: 'LIVE', probe: 'VERSION', approvalId: approval.approvalId, homologation: true });
    expect(reuse.status).toBe(423);
    expect(attempts.length).toBe(sent);

    // 4) auditoria do broker presente e sem senha em nenhum lugar
    const audit = readFileSync(join(work, 'audit.log'), 'utf8');
    const events = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type?: string; action?: string });
    const broker = events.filter((e) => e.type === 'ssh-credential-broker').map((e) => e.action);
    // sem aprovacao (negado), emissao e sessao liberada. O REUSO (homologacao por OPERATOR) e barrado ANTES do broker,
    // na verificacao previa da aprovacao (423): nem chega a tentar o cofre, entao nao gera evento de lease.
    expect(broker).toEqual(['LEASE_DENIED', 'GRANT_ISSUED', 'LEASE_GRANTED']);
    for (const text of [audit, harnessOut, noApproval.text, first.text, reuse.text]) expect(text).not.toContain(PASSWORD);
    await stopHarness();
  }, 90_000);

  it('fingerprint divergente: o servidor nunca recebe a senha', async () => {
    attempts.length = 0;
    await startHarness('SHA256:' + 'B'.repeat(43));
    const cookie = await login('mcp');
    const approval = JSON.parse((await post(await login('admin'), '/api/vsi-mcp/approvals', { hostId: HOST_ID, ttlSeconds: 600 })).text) as { approvalId: string };
    const res = await post(cookie, '/api/vsi-mcp/tools/list_vsi', { hostId: HOST_ID, source: 'LIVE', probe: 'VERSION', approvalId: approval.approvalId, homologation: true });
    expect(JSON.parse(res.text).status).toBe('ERROR');
    expect(attempts).toEqual([]);
    expect(res.text).not.toContain(PASSWORD);
    expect(readFileSync(join(work, 'audit.log'), 'utf8')).not.toContain(PASSWORD);
    await stopHarness();
  }, 90_000);
});
