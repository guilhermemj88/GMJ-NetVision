import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vsiMcpProfileSchema } from '../infrastructure/mpls/vsi-mcp/access-profile';
import { evaluateHost, type CredentialMetadata, type DeviceMetadata } from './conformity';
import { ALLOWED_ENV_NAMES, forbiddenEnvNames, parsePreviewConfig, validatePreviewDatabaseUrl } from './config';
import { installLifecycle, WATCHDOG_GRACE_SECONDS } from './lifecycle';
import {
  CREDENTIAL_SELECT, DEVICE_SELECT, narrowPreviewDb, PREVIEW_MAX_HOSTS, PrismaConformityReader, PreviewReaderError, SyntheticConformityReader,
  sanitizeDbError, type ConformityReader, type PreviewDb,
} from './reader';
import { SYNTHETIC_CREDENTIALS, SYNTHETIC_DEVICES } from './synthetic';
import { runPreview } from './vsi-preview-main';

// Somente valores SINTETICOS.
const SECRET = 'Sint3tica-Senha-Preview-0004';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const FP = 'SHA256:' + 'A'.repeat(43);

const profile = (over: Record<string, unknown> = {}) =>
  vsiMcpProfileSchema.parse({
    hostId: 'h1', endpoint: '10.0.0.1', port: 2222, username: 'svc', context: null, fingerprint: FP,
    initialPrompt: '<H>', expectedPrompt: '<H>', vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
    validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', operations: ['VERSION'], ...over,
  });
const device = (over: Partial<DeviceMetadata> = {}): DeviceMetadata => ({
  id: 'h1', name: 'PE-SINTETICO', vendor: 'Huawei', sshEnabled: true, sshHost: '10.0.0.1', sshPort: 2222, sshUsername: 'svc',
  sshContextCommand: null, sshCredentialId: 'c1', ...over,
});
const cred = (over: Partial<CredentialMetadata> = {}): CredentialMetadata => ({
  id: 'c1', port: 2222, username: 'svc', updatedAt: new Date('2026-11-07T12:00:00.000Z'), sharedByDevices: 1, ...over,
});

describe('conformidade de cadastro (somente metadados)', () => {
  it('tudo igual: CONFORME, sem falhas', () => {
    const r = evaluateHost(profile(), device(), cred(), NOW);
    expect(r.verdict).toBe('CONFORME');
    expect(r.failed).toEqual([]);
    expect(r.credential).toEqual({ registered: true, ageDays: 10, sharedByDevices: 1 });
  });

  it.each([
    ['equipamento nao cadastrado', null, cred(), ['DEVICE_REGISTERED', 'SSH_ENABLED', 'VENDOR_HUAWEI', 'ENDPOINT_MATCHES', 'PORT_MATCHES', 'USERNAME_MATCHES', 'CONTEXT_MATCHES', 'CREDENTIAL_REGISTERED', 'CREDENTIAL_RECORD_FOUND', 'CREDENTIAL_IDENTITY_CONSISTENT']],
    ['SSH desabilitado', device({ sshEnabled: false }), cred(), ['SSH_ENABLED']],
    ['fabricante nao Huawei', device({ vendor: 'Cisco' }), cred(), ['VENDOR_HUAWEI']],
    ['endpoint diferente', device({ sshHost: '10.0.0.9' }), cred(), ['ENDPOINT_MATCHES']],
    ['porta diferente', device({ sshPort: 22 }), cred({ port: 22 }), ['PORT_MATCHES']],
    ['usuario diferente', device({ sshUsername: 'outro' }), cred({ username: 'outro' }), ['USERNAME_MATCHES']],
    ['contexto diferente', device({ sshContextCommand: 'switch virtual-system VS1' }), cred(), ['CONTEXT_MATCHES']],
    ['sem credencial cadastrada', device({ sshCredentialId: null }), null, ['CREDENTIAL_REGISTERED', 'CREDENTIAL_RECORD_FOUND', 'CREDENTIAL_IDENTITY_CONSISTENT']],
    ['registro de credencial sumiu', device(), null, ['CREDENTIAL_RECORD_FOUND', 'CREDENTIAL_IDENTITY_CONSISTENT']],
    ['credencial com usuario diferente do cadastro', device(), cred({ username: 'antigo' }), ['CREDENTIAL_IDENTITY_CONSISTENT']],
    ['credencial com porta diferente do cadastro', device(), cred({ port: 22 }), ['CREDENTIAL_IDENTITY_CONSISTENT']],
  ] as const)('%s: NAO_CONFORME com as verificacoes certas', (_n, d, c, failed) => {
    const r = evaluateHost(profile(), d, c, NOW);
    expect(r.verdict).toBe('NAO_CONFORME');
    expect(r.failed).toEqual(failed);
  });

  it('perfil vencido ou ainda nao valido: PROFILE_VALID_NOW', () => {
    expect(evaluateHost(profile({ expiresAt: '2026-11-17T12:00:00.000Z' }), device(), cred(), NOW).failed).toEqual(['PROFILE_VALID_NOW']);
    expect(evaluateHost(profile({ validFrom: '2026-11-18T00:00:00.000Z' }), device(), cred(), NOW).failed).toEqual(['PROFILE_VALID_NOW']);
  });

  it('o relatorio nao contem usuario, IP, fingerprint nem segredo', () => {
    const json = JSON.stringify(evaluateHost(profile(), device(), cred(), NOW));
    for (const forbidden of ['svc', '10.0.0.1', 'AAAAAAAAAA', 'SHA256']) expect(json).not.toContain(forbidden);
  });
});

/** Cliente de banco que REGISTRA toda chamada e recusa qualquer metodo fora da lista fechada. */
function recordingDb(rows: { devices?: DeviceMetadata[]; credentials?: Array<Omit<CredentialMetadata, 'sharedByDevices'>>; fail?: unknown } = {}) {
  const calls: Array<{ path: string; args?: unknown }> = [];
  const fail = rows.fail;
  const db: PreviewDb = {
    device: {
      findMany: async (args) => { calls.push({ path: 'device.findMany', args }); if (fail) throw fail; return rows.devices ?? []; },
      count: async (args) => { calls.push({ path: 'device.count', args }); return 1; },
    },
    sshCredential: {
      findMany: async (args) => { calls.push({ path: 'sshCredential.findMany', args }); if (fail) throw fail; return rows.credentials ?? []; },
    },
    $disconnect: async () => { calls.push({ path: '$disconnect' }); },
  };
  const strict = new Proxy(db, {
    get(target, key) {
      if (!(key in target)) throw new Error(`metodo fora da lista fechada: ${String(key)}`);
      return (target as never)[key];
    },
  });
  return { db: strict, calls };
}

describe('leitor de metadados: consultas fixas, sem payload cifrado nem SQL livre', () => {
  it('seleciona exatamente as colunas permitidas e nunca o payload cifrado', async () => {
    const { db, calls } = recordingDb({ devices: [device()], credentials: [{ id: 'c1', port: 2222, username: 'svc', updatedAt: new Date() }] });
    const reader = new PrismaConformityReader(db);
    await reader.readDevices(['h1']);
    await reader.readCredentials(['c1']);
    await reader.close();
    expect(calls.map((c) => c.path)).toEqual(['device.findMany', 'sshCredential.findMany', 'device.count', '$disconnect']);
    expect(Object.keys(DEVICE_SELECT).sort()).toEqual(['id', 'name', 'sshContextCommand', 'sshCredentialId', 'sshEnabled', 'sshHost', 'sshPort', 'sshUsername', 'vendor']);
    expect(Object.keys(CREDENTIAL_SELECT).sort()).toEqual(['id', 'port', 'updatedAt', 'username']);
    expect(JSON.stringify(calls)).not.toMatch(/payload|password|secret|key/i);
    expect(reader.stats()).toEqual({ deviceQueries: 1, credentialQueries: 1, countQueries: 1 });
  });

  it('nenhum metodo de escrita ou SQL cru existe na superficie exigida do banco', () => {
    const { db } = recordingDb();
    expect(Object.keys(db)).toEqual(['device', 'sshCredential', '$disconnect']);
    expect(Object.keys(db.device).sort()).toEqual(['count', 'findMany']);
    expect(Object.keys(db.sshCredential)).toEqual(['findMany']);
    for (const method of ['create', 'update', 'delete', 'upsert', '$queryRaw', '$executeRaw', '$queryRawUnsafe', '$transaction'])
      expect(() => (db as never as Record<string, unknown>)[method], method).toThrow(/fora da lista fechada/);
  });

  it(`recusa mais de ${PREVIEW_MAX_HOSTS} identificadores sem consultar`, async () => {
    const { db, calls } = recordingDb();
    const reader = new PrismaConformityReader(db);
    const ids = Array.from({ length: PREVIEW_MAX_HOSTS + 1 }, (_, i) => `h${i}`);
    await expect(reader.readDevices(ids)).rejects.toMatchObject({ code: 'TOO_MANY_HOSTS' });
    await expect(reader.readCredentials(ids)).rejects.toMatchObject({ code: 'TOO_MANY_HOSTS' });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ code: 'P1001', message: `Can't reach database server at 10.9.9.9:5432 user=svc pass=${SECRET}` }, 'DB_UNREACHABLE'],
    [{ code: 'P1000', message: `Authentication failed for ${SECRET}` }, 'DB_AUTH'],
    [{ code: '42501', message: `permission denied for table "SshCredential" ${SECRET}` }, 'DB_PERMISSION_DENIED'],
    [new Error(`permission denied for column encrypted ${SECRET}`), 'DB_PERMISSION_DENIED'],
    [new Error(`qualquer coisa com ${SECRET}`), 'DB_ERROR'],
  ])('erro do banco vira so um codigo fixo, sem a mensagem original (%#)', async (failure, code) => {
    const { db } = recordingDb({ fail: failure });
    const reader = new PrismaConformityReader(db);
    const error = (await reader.readDevices(['h1']).catch((e: unknown) => e)) as PreviewReaderError;
    expect(error).toBeInstanceOf(PreviewReaderError);
    expect(error.code).toBe(code);
    expect(`${error.message}${error.stack}`).not.toContain(SECRET);
    expect(sanitizeDbError(failure).code).toBe(code);
  });

  it('fonte sintetica: so memoria; conta compartilhamento', async () => {
    const reader = new SyntheticConformityReader(SYNTHETIC_DEVICES, SYNTHETIC_CREDENTIALS);
    expect((await reader.readDevices(['syn-ok'])).map((d) => d.id)).toEqual(['syn-ok']);
    expect((await reader.readCredentials(['cred-ok']))[0]?.sharedByDevices).toBe(1);
  });
});

describe('ambiente e configuracao: fail-closed', () => {
  it.each([
    'CREDENTIAL_ENCRYPTION_KEY', 'DATABASE_URL', 'MITIGATION_AUTO_EXECUTION_ENABLED', 'MITIGATION_FAST_SINGLE_OWNER', 'TELEGRAM_BOT_TOKEN',
    'ZABBIX_TOKEN', 'SNMP_POLLING_ENABLED', 'VSI_MCP_ENABLED', 'VSI_DIAGNOSTIC_ENABLED', 'VSI_SERVICE_DIAGNOSTIC_ENABLED',
  ])('%s no ambiente impede a execucao (so o NOME e reportado)', (name) => {
    expect(forbiddenEnvNames({ [name]: SECRET, PATH: '/usr/bin' })).toEqual([name]);
  });

  it('ambiente limpo passa', () => {
    expect(forbiddenEnvNames({ PATH: '/usr/bin', NETVISION_PREVIEW_SOURCE: 'synthetic', VSI_MCP_ACCESS_FILE: '/x', LC_ALL: 'C', INVOCATION_ID: 'abc', JOURNAL_STREAM: '8:1', NODE_ENV: 'production' })).toEqual([]);
  });

  it.each([
    'JWT_SECRET', 'SESSION_SECRET', 'N8N_API_TOKEN', 'INBOUND_TOKEN', 'DEFAULT_ADMIN_PASSWORD', 'REDIS_URL', 'API_KEY', 'PGPASSWORD',
    'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'NETVISION_INSTALLATION_ID', 'GMJFLOW_DB_PATH', 'NETVISION_READ_ONLY', 'ZZ_QUALQUER',
  ])('F-09: variavel desconhecida %s (qualquer nome) recusa a execucao, mesmo sem padrao conhecido', (name) => {
    expect(forbiddenEnvNames({ PATH: '/usr/bin', [name]: SECRET })).toEqual([name]);
  });

  it('a lista de permitidos e fechada e nao contem nada sensivel', () => {
    expect([...ALLOWED_ENV_NAMES].filter((n) => /KEY|SECRET|TOKEN|PASS|URL|CREDENTIAL|DATABASE/i.test(n))).toEqual([]);
    expect(ALLOWED_ENV_NAMES.has('NODE_OPTIONS')).toBe(false);
  });

  it('padrao: sintetico, 60 s; limite de tempo entre 5 e 80 s', () => {
    expect(parsePreviewConfig({})).toMatchObject({ source: 'synthetic', maxSeconds: 60 });
    expect(parsePreviewConfig({ NETVISION_PREVIEW_MAX_SECONDS: '1' }).maxSeconds).toBe(5);
    expect(parsePreviewConfig({ NETVISION_PREVIEW_MAX_SECONDS: '99999' }).maxSeconds).toBe(80); // abaixo do TimeoutStartSec=90 da unidade
    expect(() => parsePreviewConfig({ NETVISION_PREVIEW_MAX_SECONDS: 'abc' })).toThrow();
    expect(() => parsePreviewConfig({ NETVISION_PREVIEW_SOURCE: 'producao' })).toThrow();
  });

  describe('URL do banco: so a conta dedicada somente leitura, so local', () => {
    const ok = [
      `postgresql://nvvsipreview@localhost/netvision?host=/var/run/postgresql&schema=vsi_preview`,
      `postgresql://nvvsipreview:${SECRET}@127.0.0.1:5432/netvision?schema=vsi_preview`,
    ];
    it.each(ok)('aceita %#', (url) => {
      const hardened = validatePreviewDatabaseUrl(url);
      expect(hardened).toContain('connection_limit=1');
      expect(hardened).toContain('connect_timeout=5');
    });

    const bad: Array<[string, string | undefined]> = [
      ['conta dona/de producao', `postgresql://netvision:${SECRET}@127.0.0.1/netvision?schema=vsi_preview`],
      ['conta postgres', `postgresql://postgres@localhost/netvision?host=/var/run/postgresql&schema=vsi_preview`],
      ['sufixo no nome da conta', `postgresql://nvvsipreview_rw@localhost/netvision?host=/var/run/postgresql&schema=vsi_preview`],
      ['host remoto', `postgresql://nvvsipreview:${SECRET}@10.1.2.3:5432/netvision?schema=vsi_preview`],
      ['F-08: hostname remoto escondido atras de host=/socket', `postgresql://nvvsipreview@10.1.2.3/netvision?host=/var/run/postgresql&schema=vsi_preview`],
      ['host= que nao e socket', `postgresql://nvvsipreview@localhost/netvision?host=10.1.2.3&schema=vsi_preview`],
      ['F-08: sem schema (leria public)', `postgresql://nvvsipreview@localhost/netvision?host=/var/run/postgresql`],
      ['F-08: schema public', `postgresql://nvvsipreview@localhost/netvision?host=/var/run/postgresql&schema=public`],
      ['parametro options (poderia desligar o somente leitura)', `postgresql://nvvsipreview@localhost/netvision?host=/var/run/postgresql&schema=vsi_preview&options=-c%20default_transaction_read_only%3Doff`],
      ['protocolo errado', `mysql://nvvsipreview@localhost/netvision?schema=vsi_preview`],
      ['texto qualquer', 'nao-e-url'],
      ['ausente', undefined],
    ];
    it.each(bad)('recusa: %s, e a mensagem nao repete a URL nem a senha', (_n, url) => {
      let message = '';
      try {
        validatePreviewDatabaseUrl(url);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('10.1.2.3');
      expect(message).not.toContain('postgresql://');
    });
  });
});

describe('execucao do preview', () => {
  afterEach(() => vi.useRealTimers());
  const run = async (env: NodeJS.ProcessEnv, over: Partial<Parameters<typeof runPreview>[1]> = {}) => {
    const lines: Array<Record<string, unknown>> = [];
    const outcome = await runPreview(env, { emit: (l) => lines.push(l), now: () => NOW, ...over });
    return { outcome, lines };
  };

  it('sintetico: relatorio sanitizado com 1 conforme e 3 divergencias; sem banco', async () => {
    const { outcome, lines } = await run({});
    expect(outcome).toEqual({ code: 0, reason: 'DONE' });
    expect(lines).toHaveLength(1);
    const report = lines[0] as never as { summary: unknown; guarantees: unknown; dataSource: string; hosts: Array<{ hostId: string; verdict: string; failed: string[] }> };
    expect(report.dataSource).toBe('synthetic');
    expect(report.summary).toEqual({ hosts: 4, conforme: 1, naoConforme: 3 });
    expect(report.guarantees).toEqual({ decrypts: false, readsEncryptedPayload: false, writes: false, opensSsh: false });
    const byId = Object.fromEntries(report.hosts.map((h) => [h.hostId, h]));
    expect(byId['syn-ok']?.verdict).toBe('CONFORME');
    expect(byId['syn-usuario-diverge']?.failed).toEqual(['USERNAME_MATCHES']); // o cadastro diverge do PERFIL; o registro da credencial e coerente com o cadastro
    expect(byId['syn-sem-credencial']?.failed).toEqual(['CREDENTIAL_REGISTERED', 'CREDENTIAL_RECORD_FOUND', 'CREDENTIAL_IDENTITY_CONSISTENT']);
    expect(byId['syn-nao-cadastrado']?.failed).toContain('DEVICE_REGISTERED');
    const json = JSON.stringify(lines);
    for (const forbidden of ['svc-a', '10.255.0.1', 'AAAAAAAAAA', 'outro-usuario']) expect(json).not.toContain(forbidden);
  });

  it('ambiente com a chave do cofre (ou qualquer variavel nao permitida): recusa ANTES de ler dados', async () => {
    const createReader = vi.fn();
    const { outcome, lines } = await run({ CREDENTIAL_ENCRYPTION_KEY: SECRET, TELEGRAM_BOT_TOKEN: SECRET }, { createReader });
    expect(outcome.code).toBe(2);
    expect(createReader).not.toHaveBeenCalled();
    expect(lines).toEqual([{ preview: 'FAILED', reason: 'FORBIDDEN_ENVIRONMENT', variables: ['CREDENTIAL_ENCRYPTION_KEY', 'TELEGRAM_BOT_TOKEN'] }]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('modo database com a URL de producao e recusado sem conectar', async () => {
    const createReader = vi.fn();
    const { outcome, lines } = await run({ NETVISION_PREVIEW_SOURCE: 'database', NETVISION_PREVIEW_DATABASE_URL: `postgresql://netvision:${SECRET}@127.0.0.1/netvision?schema=vsi_preview`, VSI_MCP_ACCESS_FILE: '/x' }, { createReader });
    expect(outcome).toEqual({ code: 2, reason: 'INVALID_CONFIGURATION' });
    expect(createReader).not.toHaveBeenCalled();
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('sem perfis: falha sem consultar nada', async () => {
    const createReader = vi.fn();
    const { outcome } = await run({ NETVISION_PREVIEW_SOURCE: 'synthetic', VSI_MCP_ACCESS_FILE: '/inexistente' }, { createReader, readProfiles: async () => [] });
    expect(outcome).toEqual({ code: 3, reason: 'NO_PROFILES' });
    expect(createReader).not.toHaveBeenCalled();
  });

  it('falha da fonte de dados: codigo fixo (4), mensagem original nunca sai e o leitor e fechado', async () => {
    const close = vi.fn(async () => undefined);
    const reader: ConformityReader = {
      readDevices: async () => { throw Object.assign(new Error(`ECONNREFUSED 10.9.9.9 ${SECRET}`), { code: 'P1001' }); },
      readCredentials: async () => [], stats: () => ({ deviceQueries: 1, credentialQueries: 0, countQueries: 0 }), close,
    };
    const { outcome, lines } = await run({}, { createReader: async () => reader });
    expect(outcome).toEqual({ code: 4, reason: 'DB_UNREACHABLE' });
    expect(lines).toEqual([{ preview: 'FAILED', reason: 'DB_UNREACHABLE' }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('limite de tempo: fonte que nunca responde termina com 124 e fecha o leitor', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const reader: ConformityReader = {
      readDevices: () => new Promise(() => undefined), readCredentials: async () => [],
      stats: () => ({ deviceQueries: 0, credentialQueries: 0, countQueries: 0 }), close,
    };
    const promise = run({ NETVISION_PREVIEW_MAX_SECONDS: '5' }, { createReader: async () => reader });
    await vi.advanceTimersByTimeAsync(5_001);
    const { outcome, lines } = await promise;
    expect(outcome).toEqual({ code: 124, reason: 'TIMEOUT' });
    expect(lines).toEqual([{ preview: 'FAILED', reason: 'TIMEOUT' }]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('guardas estruturais do codigo do preview', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ f, code: readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') }));

  it('so importa o proprio diretorio, o perfil de acesso e o cliente de banco gerado', () => {
    const allowed = [/^\.\/[a-z-]+$/, /^\.\.\/infrastructure\/mpls\/vsi-mcp\/access-profile$/, /^\.\.\/generated\/prisma$/];
    for (const { f, code } of sources)
      for (const m of code.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g))
        expect(allowed.some((r) => r.test(m[1]!)), `${f} importa ${m[1]}`).toBe(true);
  });

  it('nao tem escrita, SQL cru, transacao, servidor, cofre nem acesso ao payload cifrado', () => {
    const forbidden = /\$queryRaw|\$executeRaw|\$transaction|\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|CredentialVault|decrypt\(|\.decrypt|encryptedPayload|createServer|\.listen\(|fastify|ssh2|SshClient|setInterval|child_process|node:net|node:http|fetch\(/;
    for (const { f, code } of sources) expect(code, f).not.toMatch(forbidden);
  });

  it('nao le arquivo nem variavel de ambiente fora da lista conhecida', () => {
    const envNames = new Set<string>();
    for (const { code } of sources) for (const m of code.matchAll(/env\.([A-Z_]+)/g)) envNames.add(m[1]!);
    expect([...envNames].sort()).toEqual(['NETVISION_PREVIEW_DATABASE_URL', 'NETVISION_PREVIEW_MAX_SECONDS', 'NETVISION_PREVIEW_SOURCE', 'VSI_MCP_ACCESS_FILE']);
    for (const { f, code } of sources) expect(code, f).not.toMatch(/readFileSync|writeFileSync|appendFile|createWriteStream/);
  });
});

describe('F-10: ciclo de vida verificavel', () => {
  function fake() {
    const handlers = new Map<string, () => void>();
    const timers: Array<{ fn: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const emitted: Array<Record<string, unknown>> = [];
    const exits: number[] = [];
    const life = installLifecycle(
      {
        host: { pid: 4242, once: (event, fn) => { handlers.set(event, fn); } },
        emit: (l) => emitted.push(l),
        exit: (c) => exits.push(c),
        now: () => NOW,
        setTimer: (fn, ms) => { const t = { fn, ms, unref: vi.fn() }; timers.push(t); return t; },
      },
      60,
    );
    return { handlers, timers, emitted, exits, life };
  }

  it('o watchdog NAO e desreferenciado e dispara em limite + folga com 124', () => {
    const f = fake();
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0]!.unref).not.toHaveBeenCalled();
    expect(f.timers[0]!.ms).toBe((60 + WATCHDOG_GRACE_SECONDS) * 1000);
    f.timers[0]!.fn();
    expect(f.exits).toEqual([124]);
    expect(f.emitted[0]).toMatchObject({ preview: 'EXIT', code: 124, reason: 'WATCHDOG', pid: 4242 });
  });

  it('laco de eventos vazio com promessa pendente: beforeExit anuncia EVENT_LOOP_DRAINED e sai com 125 (nunca 0 em silencio)', () => {
    const f = fake();
    f.handlers.get('beforeExit')!();
    expect(f.exits).toEqual([125]);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({ preview: 'EXIT', code: 125, reason: 'EVENT_LOOP_DRAINED' });
  });

  it('SIGTERM e SIGINT; a saida e unica (so a primeira vale)', () => {
    const f = fake();
    f.handlers.get('SIGTERM')!();
    f.handlers.get('SIGINT')!();
    f.timers[0]!.fn();
    f.life.finish(0, 'DONE');
    expect(f.exits).toEqual([143]);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0]).toMatchObject({ code: 143, reason: 'SIGTERM' });
  });
});

describe('F-15: fachada estreita do banco', () => {
  it('o leitor nao alcanca nada alem dos tres metodos, mesmo que o cliente real tenha SQL cru e escrita', async () => {
    const calls: string[] = [];
    const wide = {
      device: {
        findMany: async () => { calls.push('findMany'); return []; },
        count: async () => 0,
        create: async () => { calls.push('create'); },
        deleteMany: async () => { calls.push('deleteMany'); },
      },
      sshCredential: { findMany: async () => [], update: async () => { calls.push('update'); } },
      $queryRaw: async () => { calls.push('$queryRaw'); },
      $executeRaw: async () => { calls.push('$executeRaw'); },
      $transaction: async () => { calls.push('$transaction'); },
      $disconnect: async () => undefined,
    };
    const narrow = narrowPreviewDb(wide as never);
    expect(Object.keys(narrow)).toEqual(['device', 'sshCredential', '$disconnect']);
    expect(Object.keys(narrow.device).sort()).toEqual(['count', 'findMany']);
    expect(Object.keys(narrow.sshCredential)).toEqual(['findMany']);
    for (const key of ['$queryRaw', '$executeRaw', '$transaction']) expect((narrow as never as Record<string, unknown>)[key]).toBeUndefined();
    expect((narrow.device as never as Record<string, unknown>).create).toBeUndefined();
    expect(Object.isFrozen(narrow)).toBe(true);
    await new PrismaConformityReader(narrow).readDevices(['h1']);
    expect(calls).toEqual(['findMany']);
  });
});
