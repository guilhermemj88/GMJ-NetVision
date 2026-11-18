import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executa o BUNDLE compilado do preview como processo separado (como rodaria no servidor), sem banco real:
 * fonte sintetica, ambiente proibido, URL invalida e um "banco" local que nunca responde.
 */
const SECRET = 'Sint3tica-Senha-Bundle-0005';
const ROOT = resolve(__dirname, '..', '..', '..', '..'); // raiz do repositorio
let dir = '';
let bundle = '';
let inputs: string[] = [];
let sink: Server;
let sinkPort = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vsi-preview-'));
  bundle = join(dir, 'vsi-preview-main.cjs');
  const { previewBuildOptions } = (await import(pathToFileURL(join(ROOT, 'tools', 'vsi-preview', 'options.mjs')).href)) as {
    previewBuildOptions: (outfile: string) => Parameters<typeof build>[0];
  };
  const result = await build({ ...previewBuildOptions(bundle), absWorkingDir: ROOT, logLevel: 'silent' });
  inputs = Object.keys(result.metafile!.inputs);
  // "banco" que aceita a conexao TCP e nunca responde (para provar limite de tempo e encerramento).
  sink = createServer((socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolveListen) => sink.listen(0, '127.0.0.1', resolveListen));
  sinkPort = (sink.address() as { port: number }).port;
}, 60_000);

afterAll(() => {
  sink?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  lines: Array<Record<string, unknown>>;
  ms: number;
}

function run(env: Record<string, string>, timeoutMs = 30_000): Promise<Run> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    // Ambiente LIMPO: nada herdado do processo de teste.
    const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      resolveRun({ code, stdout, stderr, lines, ms: Date.now() - started });
    });
  });
}

describe('bundle do preview (processo real, sem banco real)', () => {
  it('o bundle so contem o preview, o perfil de acesso, o cliente de banco e o zod', () => {
    const own = inputs.filter((i) => !/node_modules[\\/]/.test(i) && !/generated[\\/]prisma/.test(i)).map((i) => i.replace(/\\/g, '/'));
    expect(own.sort()).toEqual([
      'apps/api/src/infrastructure/mpls/vsi-diagnostic-policy.ts',
      'apps/api/src/infrastructure/mpls/vsi-mcp/access-profile.ts',
      'apps/api/src/infrastructure/mpls/vsi-mcp/command-policy.ts',
      'apps/api/src/infrastructure/ssh/ssh-context.ts',
      'apps/api/src/vsi-preview/config.ts',
      'apps/api/src/vsi-preview/conformity.ts',
      'apps/api/src/vsi-preview/lifecycle.ts',
      'apps/api/src/vsi-preview/reader.ts',
      'apps/api/src/vsi-preview/synthetic.ts',
      'apps/api/src/vsi-preview/vsi-preview-main.ts',
    ]);
    const external = inputs.filter((i) => /node_modules[\\/]/.test(i)).map((i) => /node_modules[\\/](@?[^\\/]+(?:[\\/][^\\/]+)?)/.exec(i)?.[1] ?? '');
    const packages = [...new Set(external.map((p) => (p.startsWith('@') ? p : p.split(/[\\/]/)[0]!)))].sort();
    expect(packages).toEqual(['zod']);
    const code = readFileSync(bundle, 'utf8');
    for (const marker of ['ssh2', 'fastify', 'CredentialVault', 'MitigationWorker', 'FastTrafficPoller', 'rehydrateSnapshots', 'pg_try_advisory_lock', 'createServer(', 'node-cron'])
      expect(code.includes(marker), marker).toBe(false);
  });

  it('sintetico: relatorio e linha final de encerramento, codigo 0, rapido, sem stderr', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.lines.map((l) => l.preview)).toEqual(['REPORT', 'EXIT']);
    expect(r.lines[1]).toMatchObject({ preview: 'EXIT', code: 0, reason: 'DONE' });
    expect((r.lines[0] as { summary: unknown }).summary).toEqual({ hosts: 4, conforme: 1, naoConforme: 3 });
    expect(r.stderr).toBe('');
    expect(r.ms).toBeLessThan(10_000);
  });

  it('com a chave do cofre no ambiente: recusa (2), imprime so o nome e nunca o valor', async () => {
    const r = await run({ CREDENTIAL_ENCRYPTION_KEY: SECRET, DATABASE_URL: `postgresql://x:${SECRET}@127.0.0.1/y` });
    expect(r.code).toBe(2);
    expect(r.lines[0]).toEqual({ preview: 'FAILED', reason: 'FORBIDDEN_ENVIRONMENT', variables: ['CREDENTIAL_ENCRYPTION_KEY', 'DATABASE_URL'] });
    expect(r.lines.at(-1)).toMatchObject({ preview: 'EXIT', code: 2 });
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it('banco com a conta de producao: recusa (2) sem tentar conectar', async () => {
    const profiles = join(dir, 'profiles.json');
    writeFileSync(profiles, JSON.stringify({ profiles: [] }), { mode: 0o600 });
    const r = await run({ NETVISION_PREVIEW_SOURCE: 'database', NETVISION_PREVIEW_DATABASE_URL: `postgresql://netvision:${SECRET}@127.0.0.1:${sinkPort}/netvision`, VSI_MCP_ACCESS_FILE: profiles });
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatchObject({ preview: 'FAILED', reason: 'INVALID_CONFIGURATION' });
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it('banco inalcancavel (porta fechada): falha fechada (4) com codigo fixo e sem vazar a senha', async () => {
    const profiles = join(dir, 'profiles-one.json');
    writeFileSync(profiles, JSON.stringify({ profiles: [profileJson()] }), { mode: 0o600 });
    const r = await run({
      NETVISION_PREVIEW_SOURCE: 'database', NETVISION_PREVIEW_MAX_SECONDS: '20',
      NETVISION_PREVIEW_DATABASE_URL: `postgresql://nvvsipreview:${SECRET}@127.0.0.1:1/netvision?schema=vsi_preview`, VSI_MCP_ACCESS_FILE: profiles,
    });
    expect(r.code).toBe(4);
    expect(r.lines[0]).toMatchObject({ preview: 'FAILED' });
    expect(['DB_UNREACHABLE', 'DB_ERROR']).toContain(r.lines[0]!.reason);
    expect(r.lines.at(-1)).toMatchObject({ preview: 'EXIT', code: 4 });
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.ms).toBeLessThan(25_000);
  }, 40_000);

  it('banco que aceita a conexao e nunca responde: encerra sozinho dentro do limite (124/4) e anuncia o EXIT', async () => {
    const profiles = join(dir, 'profiles-two.json');
    writeFileSync(profiles, JSON.stringify({ profiles: [profileJson()] }), { mode: 0o600 });
    const r = await run({
      NETVISION_PREVIEW_SOURCE: 'database', NETVISION_PREVIEW_MAX_SECONDS: '5',
      NETVISION_PREVIEW_DATABASE_URL: `postgresql://nvvsipreview:${SECRET}@127.0.0.1:${sinkPort}/netvision?schema=vsi_preview`, VSI_MCP_ACCESS_FILE: profiles,
    });
    expect([124, 4]).toContain(r.code);
    expect(r.lines.at(-1)).toMatchObject({ preview: 'EXIT' });
    expect(r.ms).toBeLessThan(12_000); // limite de 5 s + folga do watchdog (3 s)
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  }, 40_000);

  it('o processo nao abre porta: nenhum servidor e criado (a execucao termina sozinha)', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/listening/i);
  });
});

function profileJson() {
  return {
    hostId: 'h1', endpoint: '10.0.0.1', port: 2222, username: 'svc', context: null, fingerprint: 'SHA256:' + 'A'.repeat(43),
    initialPrompt: '<H>', expectedPrompt: '<H>', vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', operations: ['VERSION'],
  };
}
