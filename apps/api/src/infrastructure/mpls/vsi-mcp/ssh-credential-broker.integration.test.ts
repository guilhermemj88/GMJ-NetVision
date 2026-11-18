import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from '../vsi-diagnostic-approval';
import { VsiServiceResultArchive } from '../vsi-service/archive';
import { registerVsiMcpRoutes } from '../../../vsi-mcp-routes';
import { registerVsiServiceDiagnosticRoutes } from '../../../vsi-service-diagnostic-routes';
import { vsiMcpProfileSchema } from './access-profile';
import { approvalScope } from './contracts';
import { SshVsiMcpLiveCollector } from './live-collector';
import { SshCredentialBroker } from './ssh-credential-broker';
import { VsiMcpTools } from './tools';
import * as S from './__fixtures__/synthetic';
import { host } from './__fixtures__/harness';

// Somente valores SINTETICOS.
const PASSWORD = 'Sint3tica-Senha-Integracao-0002';
const user = (role: AuthUser['role'], username = role.toLowerCase()): AuthUser => ({ id: `u-${username}`, username, role }) as AuthUser;
const ADMIN = user('ADMIN', 'admin');
const profile = vsiMcpProfileSchema.parse({
  hostId: 'h-a', endpoint: '10.100.1.1', port: 2222, username: 'svc', context: null,
  fingerprint: 'SHA256:' + 'A'.repeat(43), initialPrompt: '<PE-A>', expectedPrompt: '<PE-A>', vendor: 'HUAWEI',
  family: 'NE8000_V800', disablePagingTemporary: true,
  validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  operations: ['VERSION', 'VSI_LIST', 'VSI_VERBOSE', 'INTERFACE_CONFIG', 'VSI_MAC'],
});

let dir: string;
let archiveDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-int-'));
  archiveDir = mkdtempSync(join(tmpdir(), 'broker-arch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(archiveDir, { recursive: true, force: true });
});

async function build(opts: { noPeek?: boolean; serviceAccounts?: string; persistedAcs?: string[]; profileOver?: Record<string, unknown>; outputs?: Record<string, string>; clientFails?: Error; allowedPurposes?: never; current?: AuthUser | null } = {}) {
  const store = new VsiDiagnosticApprovalStore(dir);
  const brokerEvents: unknown[] = [];
  const toolEvents: unknown[] = [];
  const passwordsSeenByClient: string[] = [];
  const decrypt = vi.fn(async () => ({ password: PASSWORD }));
  const hosts = { getHost: vi.fn(async (id: string) => (id === 'h-a' ? host('h-a', 'PE-A') : null)), getDecryptedSshCredentials: decrypt };
  const state = { profiles: [opts.profileOver ? vsiMcpProfileSchema.parse({ ...profile, ...opts.profileOver }) : profile] };
  const connections: Array<{ host: string; port: number; username: string; fingerprint: string | undefined }> = [];
  const broker = new SshCredentialBroker({
    hosts: hosts as never,
    profiles: async () => state.profiles,
    consumeApproval: (a, h, s, e) => store.consume(a, h, s, Date.now(), e),
    audit: (e) => brokerEvents.push(e),
    serviceAccounts: () => new Set((opts.serviceAccounts ?? '').split(',').filter(Boolean)),
    ...(opts.allowedPurposes ? { allowedPurposes: opts.allowedPurposes } : {}),
  });
  const spies = {
    withCredential: vi.spyOn(broker, 'withCredential'),
    preflight: vi.spyOn(broker, 'preflight'),
    consumeApproval: vi.spyOn(broker, 'consumeApproval'),
  };
  const clientFactory = vi.fn((o: { password: string; port: number; username: string; diagnostic?: { fingerprint?: string; sessionPreparation?: string; onCommand: (c: string) => void; onCommandComplete?: (r: { command: string; stdout: string; completedAt: string }) => void } }) => {
    passwordsSeenByClient.push(o.password);
    return {
      async execute(_h: string, commands: string[]) {
        connections.push({ host: _h, port: o.port, username: o.username, fingerprint: o.diagnostic?.fingerprint });
        if (opts.clientFails) throw opts.clientFails;
        const d = o.diagnostic!;
        for (const c of [d.sessionPreparation!, ...commands]) {
          d.onCommand(c);
          d.onCommandComplete?.({ command: c, stdout: c === 'display version' ? S.NE_VERSION : (opts.outputs?.[c] ?? `<PE-A>${c}\n<PE-A>`), completedAt: '2026-11-09T12:00:00.000Z' });
        }
        return [{ stdout: '', stderr: '', exitCode: 0 }];
      },
    };
  });
  const collector = new SshVsiMcpLiveCollector(hosts as never, broker, clientFactory as never, 0);
  const tools = new VsiMcpTools({
    hosts: hosts as never, live: collector,
    mpls: { listVsis: async () => (opts.persistedAcs ? [{ id: 'v', hostId: 'h-a', name: 'X', signalingType: 'BGP', status: 'UP', acs: opts.persistedAcs.map((n, i) => ({ ifIndex: i + 1, status: 'UP', lastSeenAt: '2026-11-16T00:00:00.000Z', interface: { name: n } })), pws: [] }] as never : []) },
    consumeApproval: (a, h, s, op) => broker.consumeApproval(a, h, s, op),
    ...(opts.noPeek ? {} : { peekApproval: (a: string | undefined, h: string, sc: string, op: { username: string }) => void store.peek(a, h, sc, Date.now(), op.username) }),
    audit: (e) => toolEvents.push(e),
  });
  const current = opts.current === undefined ? ADMIN : opts.current;
  const server = Fastify();
  server.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError ? reply.code(400).send({ message: 'Invalid request' }) : reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: 'erro' }),
  );
  registerVsiMcpRoutes(server, tools, async () => current, store, { VSI_MCP_ENABLED: 'true', ...(opts.serviceAccounts ? { VSI_MCP_SERVICE_ACCOUNTS: opts.serviceAccounts } : {}) });
  registerVsiServiceDiagnosticRoutes(server, null, { get: () => { throw new Error('legado nao usado'); } } as never, async () => current, { VSI_SERVICE_DIAGNOSTIC_ENABLED: 'true' }, new VsiServiceResultArchive(archiveDir));
  await server.ready();
  const approve = () => store.create({ hostId: 'h-a', vsiId: approvalScope(), createdBy: 'aprovador' }).approvalId;
  const callList = (payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: { hostId: 'h-a', source: 'LIVE', probe: 'VERSION', ...payload } });
  return { state, connections, server, store, broker, collector, spies, decrypt, hosts, clientFactory, passwordsSeenByClient, brokerEvents, toolEvents, approve, callList };
}

describe('broker no coletor ao vivo (cliente SSH falso)', () => {
  it('com aprovacao ADMIN: a senha vai ao cliente SSH uma unica vez e nao aparece em resposta, auditoria nem erro', async () => {
    const t = await build();
    const response = await t.callList({ approvalId: t.approve() });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('OK');
    expect(t.passwordsSeenByClient).toEqual([PASSWORD]);
    expect(t.decrypt).toHaveBeenCalledTimes(1);
    expect(t.spies.withCredential).toHaveBeenCalledTimes(1);
    for (const out of [response.body, JSON.stringify(t.brokerEvents), JSON.stringify(t.toolEvents)])
      expect(out).not.toContain(PASSWORD);
    expect(t.brokerEvents.map((e) => (e as { action: string }).action)).toEqual(['GRANT_ISSUED', 'LEASE_GRANTED']);
  });

  it('sem aprovacao: 423, a credencial NAO e descriptografada e nenhum cliente SSH e criado', async () => {
    const t = await build();
    const response = await t.callList({});
    expect(response.statusCode).toBe(423);
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
    expect(t.spies.withCredential).not.toHaveBeenCalled();
  });

  it('aprovacao reutilizada: a segunda chamada falha (423) sem nova descriptografia', async () => {
    const t = await build();
    const id = t.approve();
    expect((await t.callList({ approvalId: id })).statusCode).toBe(200);
    const again = await t.callList({ approvalId: id });
    expect(again.statusCode).toBe(423);
    expect(t.decrypt).toHaveBeenCalledTimes(1);
    expect(t.clientFactory).toHaveBeenCalledTimes(1);
  });

  it('aprovacao inexistente, de outro host ou expirada: 423 e nada e descriptografado', async () => {
    const t = await build();
    const other = t.store.create({ hostId: 'h-b', vsiId: approvalScope(), createdBy: 'aprovador' }).approvalId;
    const expired = t.store.create({ hostId: 'h-a', vsiId: approvalScope(), createdBy: 'aprovador', now: Date.now() - 3_600_000 }).approvalId;
    for (const approvalId of ['11111111-1111-4111-8111-111111111111', other, expired])
      expect((await t.callList({ approvalId })).statusCode, approvalId).toBe(423);
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });

  it('aprovacao de escopo errado (VSI especifica) nao abre a descoberta do host', async () => {
    const t = await build();
    const wrong = t.store.create({ hostId: 'h-a', vsiId: approvalScope('VSI-X'), createdBy: 'aprovador' }).approvalId;
    expect((await t.callList({ approvalId: wrong })).statusCode).toBe(423);
    expect(t.decrypt).not.toHaveBeenCalled();
  });

  it('MCP/usuario sem autorizacao: VIEWER nao executa ao vivo (403); OPERATOR executa mas sem aprovacao valida (423) e nao cria aprovacao (403); sem sessao 401', async () => {
    for (const current of [user('VIEWER'), user('OPERATOR'), null]) {
      const t = await build({ current });
      const call = await t.callList({ approvalId: '11111111-1111-4111-8111-111111111111' });
      expect(call.statusCode, `${current?.role}`).toBe(!current ? 401 : current.role === 'VIEWER' ? 403 : 423);
      const create = await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } });
      expect(create.statusCode, `${current?.role}`).toBe(current ? 403 : 401);
      expect(t.decrypt).not.toHaveBeenCalled();
      expect(t.spies.withCredential).not.toHaveBeenCalled();
      // OPERATOR chega a tentar consumir, mas a aprovacao forjada e recusada: nenhum grant, nenhuma senha.
      if (current?.role !== 'OPERATOR') expect(t.spies.consumeApproval).not.toHaveBeenCalled();
      expect(t.clientFactory).not.toHaveBeenCalled();
    }
  });

  it('nenhuma rota devolve a senha: respostas de status e de erro nao a contem', async () => {
    const t = await build();
    const bodies: string[] = [];
    bodies.push((await t.server.inject({ method: 'GET', url: '/api/vsi-mcp/status' })).body);
    bodies.push((await t.callList({})).body);
    bodies.push((await t.callList({ approvalId: 'nao-e-uuid' })).body);
    bodies.push((await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } })).body);
    for (const b of bodies) expect(b).not.toContain(PASSWORD);
  });

  it('credencial desatualizada (equipamento recusa): erro sem a senha, UMA tentativa, aprovacao consumida', async () => {
    const t = await build({ clientFails: Object.assign(new Error(`Authentication failed for svc using ${PASSWORD}`), { level: 'client-authentication' }) });
    const id = t.approve();
    const response = await t.callList({ approvalId: id });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ERROR');
    expect(response.json().errors[0].code).toBe('SSH_FAILED');
    expect(response.body).not.toContain(PASSWORD);
    expect(JSON.stringify(t.brokerEvents)).not.toContain(PASSWORD);
    expect(t.clientFactory).toHaveBeenCalledTimes(1); // sem repeticao automatica
    expect((await t.callList({ approvalId: id })).statusCode).toBe(423); // a aprovacao se foi
    expect(t.clientFactory).toHaveBeenCalledTimes(1);
  });

  it('validacao do broker ANTES de consumir a aprovacao: recusa no preflight nao gasta a aprovacao', async () => {
    const t = await build({ allowedPurposes: [] as never });
    const id = t.approve();
    const response = await t.callList({ approvalId: id });
    expect(response.json().errors[0].code).toBe('CREDENTIAL_ACCESS_DENIED');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    expect(t.spies.consumeApproval).not.toHaveBeenCalled();
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });

  it('inventario mudou entre a leitura e a sessao: sessao recusada e senha nao lida', async () => {
    const t = await build();
    const id = t.approve();
    // O cadastro muda DEPOIS de a aprovacao ser consumida (grant emitido) e antes da sessao.
    t.hosts.getHost.mockImplementation(async (hostId: string) => {
      const h = host('h-a', 'PE-A');
      if (t.brokerEvents.some((e) => (e as { action: string }).action === 'GRANT_ISSUED') && hostId === 'h-a') (h.ssh as { username: string }).username = 'trocado';
      return h;
    });
    const response = await t.callList({ approvalId: id });
    expect(response.json().status).toBe('ERROR');
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });
});

describe('duas sessoes da mesma aprovacao (diagnose_vsi sem ACs persistidos)', () => {
  const VERBOSE = S.SCEN_A_VSI.replace(/L2-PPPOE-3901/g, 'X');
  const diagnose = (t: Awaited<ReturnType<typeof build>>, approvalId: string | undefined) =>
    t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/diagnose_vsi', payload: { hostId: 'h-a', vsiName: 'X', includeMac: true, homologation: true, approvalId } });

  it('a coleta abre a 2a sessao com a MESMA aprovacao (consumida uma vez); depois a aprovacao esta encerrada', async () => {
    const t = await build({ outputs: { 'display vsi name X verbose': VERBOSE } });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'aprovador' }).approvalId;
    const response = await diagnose(t, id);
    expect(response.statusCode).toBe(200);
    expect(t.clientFactory).toHaveBeenCalledTimes(2);
    expect(t.decrypt).toHaveBeenCalledTimes(2);
    expect(t.spies.consumeApproval).toHaveBeenCalledTimes(1);
    const calls = t.spies.withCredential.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => [c.plan.sequence, c.approvalId, c.plan.scope])).toEqual([[1, id, approvalScope('X')], [2, id, approvalScope('X')]]);
    // 1a sessao le a VSI; a 2a e continuacao (configs/MAC) e nunca repete a leitura da VSI
    const kinds = calls.map((c) => c.plan.operations.map((o) => o.kind));
    expect(kinds[0]).toContain('VSI_VERBOSE');
    expect(kinds[1]).not.toContain('VSI_VERBOSE');
    // evidencia da sessao 1 -> restricao da sessao 2: os 2 ACs vistos foram registrados e SO eles foram lidos
    expect(t.brokerEvents.find((e) => (e as { action: string }).action === 'ACS_OBSERVED')).toMatchObject({ count: 2, scope: approvalScope('X') });
    const read = calls[1]!.plan.operations.filter((o) => o.kind === 'INTERFACE_CONFIG').map((o) => (o as { interfaceName: string }).interfaceName).sort();
    expect(read).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/1.3901']);
    expect(response.body).not.toContain(PASSWORD);
    expect((await diagnose(t, id)).statusCode).toBe(423); // aprovacao esgotada: nem cofre nem SSH
    expect(t.decrypt).toHaveBeenCalledTimes(2);
    expect(t.clientFactory).toHaveBeenCalledTimes(2);
  });

  it('chamador que tente uma 3a sessao direto no coletor, com a aprovacao esgotada, e recusado antes do cofre', async () => {
    const t = await build({ outputs: { 'display vsi name X verbose': VERBOSE } });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'aprovador' }).approvalId;
    await diagnose(t, id);
    for (const sequence of [1, 2] as const) {
      const error = await t.collector.collect(host('h-a', 'PE-A'), [], { signal: new AbortController().signal, audit: () => {}, approvalId: id, operatorId: 'u-admin', scope: approvalScope('X'), sequence }).catch((e: Error) => e);
      expect((error as Error).message).toBe('Autorizacao ja utilizada');
    }
    expect(t.decrypt).toHaveBeenCalledTimes(2);
    expect(t.clientFactory).toHaveBeenCalledTimes(2);
  });
});

describe('F-01/F-02 pela pilha real: teto de interfaces, endpoint efetivo e perfil de registro', () => {
  const VERBOSE = S.SCEN_A_VSI.replace(/L2-PPPOE-3901/g, 'X'); // 2 ACs
  const diagnose = (t: Awaited<ReturnType<typeof build>>, approvalId: string) =>
    t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/diagnose_vsi', payload: { hostId: 'h-a', vsiName: 'X', includeMac: true, homologation: true, approvalId } });
  const approveX = (t: Awaited<ReturnType<typeof build>>) => t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'aprovador' }).approvalId;

  it('profile.maxInterfaces e aplicado pelo perfil autoritativo: VSI com 2 ACs e teto 1 le so 1 e avisa', async () => {
    const t = await build({ profileOver: { maxInterfaces: 1 }, outputs: { 'display vsi name X verbose': VERBOSE } });
    const response = await diagnose(t, approveX(t));
    expect(response.statusCode).toBe(200);
    const configs = t.spies.withCredential.mock.calls.flatMap((c) => c[0].plan.operations).filter((o) => o.kind === 'INTERFACE_CONFIG');
    expect(configs).toHaveLength(1);
    expect(response.body).toMatch(/apenas 1/);
  });

  it('interfaces pedidas acima do teto do perfil: 400 antes de qualquer SSH e sem gastar a aprovacao', async () => {
    const t = await build({ profileOver: { maxInterfaces: 1 }, persistedAcs: ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/1.3901'] });
    const id = approveX(t);
    const response = await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/diagnose_vsi', payload: { hostId: 'h-a', vsiName: 'X', includeMac: false, approvalId: id, interfaces: ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/1.3901'] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('TOO_MANY_INTERFACES');
    expect(t.clientFactory).not.toHaveBeenCalled();
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
  });

  it('endpoint, porta, usuario e fingerprint usados pelo cliente SSH sao os do perfil de registro, em TODAS as sessoes', async () => {
    const t = await build({ outputs: { 'display vsi name X verbose': VERBOSE } });
    await diagnose(t, approveX(t));
    expect(t.connections).toHaveLength(2);
    for (const c of t.connections) expect(c).toEqual({ host: '10.100.1.1', port: 2222, username: 'svc', fingerprint: 'SHA256:' + 'A'.repeat(43) });
  });

  it('perfil trocado DEPOIS da aprovacao: nenhuma conexao, nenhuma leitura do cofre', async () => {
    const t = await build();
    const id = t.approve();
    t.hosts.getHost.mockImplementation(async (hostId: string) => {
      if (t.brokerEvents.some((e) => (e as { action: string }).action === 'GRANT_ISSUED')) t.state.profiles = [vsiMcpProfileSchema.parse({ ...profile, fingerprint: 'SHA256:' + 'F'.repeat(43) })];
      return hostId === 'h-a' ? host('h-a', 'PE-A') : null;
    });
    const response = await t.callList({ approvalId: id });
    expect(response.json().status).toBe('ERROR');
    expect(response.json().errors[0].code).toBe('CREDENTIAL_ACCESS_DENIED');
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });

  it('aprovacao de DESCOBERTA nao serve para diagnose_vsi (escopo da aprovacao) e vice-versa', async () => {
    const t = await build();
    expect((await diagnose(t, t.approve())).statusCode).toBe(423);
    expect((await t.callList({ approvalId: approveX(t) })).statusCode).toBe(423);
    expect(t.decrypt).not.toHaveBeenCalled();
  });
});

describe('F-06 pela pilha real: separacao aprovador x executor e conta de servico', () => {
  it('a mesma conta cria a aprovacao e tenta executar: 423, aprovacao NAO gasta, nada de cofre ou SSH', async () => {
    const t = await build(); // usuario autenticado = ADMIN 'admin'
    const created = await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().approvalId as string;
    expect((await t.callList({ approvalId: id })).statusCode).toBe(423);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });

  it('conta de SERVICO nao cria aprovacao nem sendo ADMIN; ADMIN humano cria', async () => {
    const svc = await build({ serviceAccounts: 'admin' }); // 'admin' marcada como conta de servico
    expect((await svc.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } })).statusCode).toBe(403);
    const human = await build({ serviceAccounts: 'svc-mcp' });
    expect((await human.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } })).statusCode).toBe(201);
  });

  it('conta de servico ADMIN que tenta executar com aprovacao de outro: recusada pelo broker, aprovacao preservada', async () => {
    const t = await build({ serviceAccounts: 'admin' });
    const id = t.approve(); // criada por 'aprovador'
    const response = await t.callList({ approvalId: id });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('SERVICE_ACCOUNT_ROLE');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    expect(t.decrypt).not.toHaveBeenCalled();
  });

  it('a auditoria da execucao real traz operador, aprovador, aprovacao, host, escopo e resultado', async () => {
    const t = await build();
    const id = t.approve();
    await t.callList({ approvalId: id });
    const granted = t.brokerEvents.find((e) => (e as { action: string }).action === 'LEASE_GRANTED');
    expect(granted).toMatchObject({ operatorId: 'u-admin', approvedBy: 'aprovador', approvalId: id, hostId: 'h-a', scope: approvalScope(), purpose: 'VSI_DIAGNOSTIC_LIVE' });
    expect(JSON.stringify(t.brokerEvents)).not.toContain(PASSWORD);
  });
});

describe('leituras da interface nunca acionam o broker', () => {
  const golden = () =>
    JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'web', 'src', 'components', 'diagnostics', 'service', 'fixtures', 'engine-replay-3072-vta-mcp.json'), 'utf8'));

  it('status, listar e abrir resultado guardado: zero chamadas ao broker, ao cofre e ao cliente SSH', async () => {
    writeFileSync(join(archiveDir, 'a.json'), JSON.stringify({ ...golden(), runId: 'homolog-3072', completedAt: '2026-11-17T00:15:30.000Z' }));
    const t = await build({ current: user('OPERATOR') });
    const urls = [
      '/api/vsi-mcp/status',
      '/api/vsi-service-diagnostics/status',
      '/api/vsi-service-diagnostics',
      '/api/vsi-service-diagnostics?vsiName=3072-QinQ-CDB-MANTIQUEIRA',
      '/api/vsi-service-diagnostics/homolog-3072',
      '/api/vsi-service-diagnostics/nao-existe',
    ];
    for (const url of urls) await t.server.inject({ method: 'GET', url });
    expect(t.spies.withCredential).not.toHaveBeenCalled();
    expect(t.spies.preflight).not.toHaveBeenCalled();
    expect(t.spies.consumeApproval).not.toHaveBeenCalled();
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.hosts.getHost).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  });

  it('o broker nao e alcancavel por nenhuma rota GET: so as ferramentas ao vivo (POST) o usam', async () => {
    const t = await build();
    const routes = (t.server.printRoutes({ commonPrefix: false }) as string).split('\n');
    expect(routes.join('\n')).not.toMatch(/credential|broker|ssh-pass|lease/i);
  });
});

describe('guarda estrutural: o motor VSI so chega a senha pelo broker', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
  it('o coletor ao vivo e o resto do motor nao leem o cofre diretamente', () => {
    for (const f of ['live-collector.ts', 'tools.ts', 'correlator.ts', 'parsers.ts'])
      expect(read(f), f).not.toMatch(/getDecryptedSshCredentials/);
    // a unica referencia no motor e a do proprio broker
    expect(read('ssh-credential-broker.ts')).toMatch(/getDecryptedSshCredentials/);
  });
  it('a composicao da API injeta o broker no coletor e a aprovacao e consumida por ele', () => {
    const routes = read('..', '..', '..', 'routes.ts');
    expect(routes).toMatch(/new SshVsiMcpLiveCollector\(hosts, vsiCredentialBroker\)/);
    expect(routes).toMatch(/vsiCredentialBroker\.consumeApproval\(/);
    expect(routes).toMatch(/vsiCredentialBroker = vsiMcpEnabled\(\)/); // sem a flag, o broker nem existe
  });
});

describe('homologacao por OPERATOR: so com aprovacao ADMIN one-shot valida, especifica e previamente consumivel', () => {
  const MCP = user('OPERATOR', 'mcp');
  const VERBOSE = S.SCEN_A_VSI.replace(/L2-PPPOE-3901/g, 'X');
  const diag = (t: Awaited<ReturnType<typeof build>>, approvalId: string | undefined, over: Record<string, unknown> = {}) =>
    t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/diagnose_vsi', payload: { hostId: 'h-a', vsiName: 'X', includeMac: true, homologation: true, approvalId, ...over } });
  const nothingHappened = (t: Awaited<ReturnType<typeof build>>) => {
    expect(t.spies.consumeApproval).not.toHaveBeenCalled();
    expect(t.decrypt).not.toHaveBeenCalled();
    expect(t.clientFactory).not.toHaveBeenCalled();
  };

  it('OPERATOR + aprovacao do ADMIN (outra identidade): executa, a senha vai ao SSH e a auditoria traz aprovador e executor', async () => {
    const t = await build({ current: MCP, outputs: { 'display vsi name X verbose': VERBOSE } });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    const response = await diag(t, id);
    expect(response.statusCode).toBe(200);
    expect(t.decrypt).toHaveBeenCalledTimes(2); // 2 sessoes sequenciais, uma aprovacao
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(true);
    const granted = t.brokerEvents.filter((e) => (e as { action: string }).action === 'LEASE_GRANTED');
    expect(granted.length).toBe(2);
    for (const e of granted) expect(e).toMatchObject({ operatorId: 'u-mcp', approvedBy: 'admin-humano', approvalId: id, hostId: 'h-a', scope: approvalScope('X'), homologation: true });
    expect(JSON.stringify([t.brokerEvents, t.toolEvents, response.body])).not.toContain(PASSWORD);
  });

  it('OPERATOR sem approvalId: 403, nada consumido, sem cofre, sem SSH', async () => {
    const t = await build({ current: MCP });
    // list_vsi tem approvalId opcional: a politica recusa. Nas demais ferramentas o proprio schema (uuid obrigatorio) devolve 400.
    const response = await t.callList({ homologation: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('HOMOLOGATION_REQUIRES_APPROVAL');
    expect((await diag(t, undefined)).statusCode).toBe(400);
    nothingHappened(t);
  });

  it('aprovacao criada pelo PROPRIO executor (OPERATOR nunca aprova): 423 e a aprovacao nao e gasta', async () => {
    const t = await build({ current: MCP });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'mcp' }).approvalId;
    expect((await diag(t, id)).statusCode).toBe(423);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    nothingHappened(t);
  });

  it('OPERATOR nao consegue criar aprovacao nem pela rota (403)', async () => {
    const t = await build({ current: MCP });
    expect((await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/approvals', payload: { hostId: 'h-a' } })).statusCode).toBe(403);
  });

  it('aprovacao de OUTRO host, de OUTRA VSI, de descoberta, expirada, inexistente ou forjada: 423 antes de qualquer consumo', async () => {
    const t = await build({ current: MCP });
    const other = t.store.create({ hostId: 'h-b', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    const otherVsi = t.store.create({ hostId: 'h-a', vsiId: approvalScope('Y'), createdBy: 'admin-humano' }).approvalId;
    const discovery = t.store.create({ hostId: 'h-a', vsiId: approvalScope(), createdBy: 'admin-humano' }).approvalId;
    const expired = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano', now: Date.now() - 3_600_000, ttlSeconds: 60 }).approvalId;
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const id of [other, otherVsi, discovery, expired, unknown])
      expect((await diag(t, id)).statusCode, id.slice(0, 20)).toBe(423);
    // formatos forjados nem passam do schema
    for (const id of ['nao-existe', '../../etc/passwd', 'a'.repeat(300)]) expect((await diag(t, id)).statusCode).toBe(400);
    for (const id of [other, otherVsi, discovery, expired]) expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    nothingHappened(t);
  });

  it('REUSO: depois de usada, a mesma aprovacao e barrada ANTES do broker (423), sem nova conexao', async () => {
    const t = await build({ current: MCP, outputs: { 'display vsi name X verbose': VERBOSE } });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    expect((await diag(t, id)).statusCode).toBe(200);
    const connections = t.clientFactory.mock.calls.length;
    const consumed = t.spies.consumeApproval.mock.calls.length;
    expect((await diag(t, id)).statusCode).toBe(423);
    expect(t.clientFactory.mock.calls.length).toBe(connections);
    expect(t.spies.consumeApproval.mock.calls.length).toBe(consumed);
  });

  it('sem a verificacao previa ligada (peekApproval ausente): homologacao por OPERATOR falha fechada', async () => {
    const t = await build({ current: MCP, noPeek: true });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    expect((await diag(t, id)).statusCode).toBe(403);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    nothingHappened(t);
  });

  it('VIEWER e sessao ausente nunca homologam; consulta persistida com homologation tambem e recusada para OPERATOR', async () => {
    for (const current of [user('VIEWER'), null]) {
      const t = await build({ current });
      const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
      expect([401, 403]).toContain((await diag(t, id)).statusCode);
      nothingHappened(t);
    }
    const t = await build({ current: MCP });
    const persisted = await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/list_vsi', payload: { hostId: 'h-a', homologation: true } });
    expect(persisted.statusCode).toBe(403);
    nothingHappened(t);
  });

  it('compare: cada ponta exige a SUA aprovacao; a mesma nas duas pontas e recusada sem consumir', async () => {
    const t = await build({ current: MCP });
    const id = t.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    const response = await t.server.inject({ method: 'POST', url: '/api/vsi-mcp/tools/compare_vsi_endpoints', payload: {
      a: { hostId: 'h-a', vsiName: 'X', approvalId: id }, b: { hostId: 'h-b', vsiName: 'X', approvalId: id }, homologation: true } });
    expect(response.statusCode).toBe(423);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    nothingHappened(t);
  });

  it('ADMIN humano continua podendo homologar, e OPERATOR sem homologacao segue o fluxo normal', async () => {
    const admin = await build({ outputs: { 'display vsi name X verbose': VERBOSE } });
    const id = admin.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'outro-admin' }).approvalId;
    expect((await diag(admin, id)).statusCode).toBe(200);
    const op = await build({ current: MCP, outputs: { 'display vsi name X verbose': VERBOSE } });
    const id2 = op.store.create({ hostId: 'h-a', vsiId: approvalScope('X'), createdBy: 'admin-humano' }).approvalId;
    expect((await diag(op, id2, { homologation: false })).statusCode).not.toBe(403);
  });
});
