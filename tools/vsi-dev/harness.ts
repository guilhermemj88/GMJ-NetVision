/**
 * HARNESS DE HOMOLOGACAO (somente desenvolvimento).
 *
 * Sobe, em 127.0.0.1 e porta isolada, as MESMAS rotas /api/vsi-mcp/* do NetVision, com:
 *  - inventario de UM unico host (sem banco, sem cofre de producao);
 *  - login proprio (dev-admin = humano que cria a aprovacao; dev-mcp = conta do MCP);
 *  - aprovacoes one-shot em diretorio proprio (o mesmo VsiDiagnosticApprovalStore);
 *  - perfil de acesso proprio (VSI_MCP_ACCESS_FILE);
 *  - "tee" que grava a saida BRUTA de cada comando em disco (0600) antes de qualquer parsing.
 *
 * Nao toca em /opt, systemd, banco, AUTO-ALL ou flags de producao.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from '../../apps/api/src/infrastructure/mpls/vsi-diagnostic-approval';
import { SshClientImpl } from '../../apps/api/src/infrastructure/ssh/ssh-client-impl';
import { SshVsiMcpLiveCollector } from '../../apps/api/src/infrastructure/mpls/vsi-mcp/live-collector';
import { SshCredentialBroker } from '../../apps/api/src/infrastructure/mpls/vsi-mcp/ssh-credential-broker';
import { readVsiMcpProfiles } from '../../apps/api/src/infrastructure/mpls/vsi-mcp/access-profile';
import { VsiMcpTools } from '../../apps/api/src/infrastructure/mpls/vsi-mcp/tools';
import { registerVsiMcpRoutes } from '../../apps/api/src/vsi-mcp-routes';

const ROOT = process.env.VSI_DEV_DIR ?? join(homedir(), 'vsi-dev');
const PORT = Number(process.env.VSI_DEV_PORT ?? 43901);
const HOST_JSON = join(ROOT, 'host.json'); // { id, name, ip, port, username, contextCommand }
const PASS_FILE = join(ROOT, 'ssh.pass'); // senha SSH do equipamento (0600), lida a cada sessao
const CAPTURES = join(ROOT, 'captures');
const AUDIT = join(ROOT, 'audit.log');

mkdirSync(CAPTURES, { recursive: true, mode: 0o700 });
process.env.VSI_MCP_ACCESS_FILE = join(ROOT, 'profiles.json');

const cfg = JSON.parse(readFileSync(HOST_JSON, 'utf8')) as {
  id: string; name: string; ip: string; port: number; username: string; contextCommand: string | null;
};
const host = {
  id: cfg.id, name: cfg.name, hostname: cfg.name, vendor: '', model: '',
  sshEnabled: true,
  ssh: { host: cfg.ip, port: cfg.port, username: cfg.username, contextCommand: cfg.contextCommand, credentialConfigured: true },
} as unknown as HostRecord;

// Credenciais de LOGIN DEV geradas a cada subida; somente o dono do diretorio as le.
const secrets = {
  admin: { usernameOrEmail: 'dev-admin', password: randomBytes(18).toString('hex') },
  mcp: { usernameOrEmail: 'dev-mcp', password: randomBytes(18).toString('hex') },
};
writeFileSync(join(ROOT, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
const users: Record<string, AuthUser> = {
  'dev-admin': { id: 'dev-admin', username: 'dev-admin', role: 'ADMIN' } as AuthUser,
  // Mesmo papel da producao: o MCP executa como OPERATOR e homologa so com aprovacao do ADMIN (sem bypass).
  'dev-mcp': { id: 'dev-mcp', username: 'dev-mcp', role: 'OPERATOR' } as AuthUser,
};
const sessions = new Map<string, AuthUser>();

let capN = 0;
const teeFactory = (opts: ConstructorParameters<typeof SshClientImpl>[0]) => {
  const d = opts.diagnostic!;
  const original = d.onCommandComplete;
  return new SshClientImpl({
    ...opts,
    diagnostic: {
      ...d,
      onCommandComplete: (item) => {
        // Saida bruta (ja sem a senha) ANTES de qualquer validacao/parsing.
        const file = join(CAPTURES, `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++capN).padStart(2, '0')}.txt`);
        writeFileSync(file, `# command: ${item.command}\n# completedAt: ${item.completedAt}\n${item.stdout}`, { mode: 0o600 });
        original?.(item);
      },
    },
  });
};

const app = Fastify({ logger: false });
await app.register(cookie);
const log = (event: object) => appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });

app.get('/health', async () => ({ status: 'ok', service: 'vsi-dev-harness' }));
app.post('/api/auth/login', async (req, reply) => {
  const b = req.body as { usernameOrEmail?: string; password?: string };
  const entry = Object.values(secrets).find((s) => s.usernameOrEmail === b?.usernameOrEmail);
  if (!entry || entry.password !== b?.password) return reply.code(401).send({ message: 'invalid' });
  const token = randomBytes(24).toString('hex');
  sessions.set(token, users[entry.usernameOrEmail]!);
  return reply.header('set-cookie', `netvision_session=${token}; Path=/; HttpOnly`).send({ ok: true });
});

// Identidade da sessao (o MCP confere o proprio papel aqui antes de habilitar o diagnostico operacional).
app.get('/api/auth/me', async (req, reply) => {
  const user = sessions.get((req.cookies as Record<string, string | undefined>).netvision_session ?? '');
  return user ? { user } : reply.code(401).send({ message: 'Nao autenticado' });
});

// Dados SNMP ja persistidos (extraidos do banco em modo somente leitura) para conferir contra o equipamento.
const persistedVsis = (): never[] => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'persisted.json'), 'utf8')) as never[];
  } catch {
    return [];
  }
};

const approvals = new VsiDiagnosticApprovalStore(join(ROOT, 'approvals'));
const hosts = {
  getHost: async (id: string) => (id === host.id ? host : null),
  getDecryptedSshCredentials: async () => ({ username: cfg.username, password: readFileSync(PASS_FILE, 'utf8').trim() }),
};
// Mesmo caminho de producao: a senha so passa pelo broker (grant da aprovacao one-shot + validacoes). Aqui o "cofre" e o ssh.pass DEV.
const broker = new SshCredentialBroker({
  hosts: hosts as never,
  profiles: () => readVsiMcpProfiles(process.env.VSI_MCP_ACCESS_FILE),
  consumeApproval: (approvalId, hostId, scope, executor) => approvals.consume(approvalId, hostId, scope, Date.now(), executor),
  audit: (event) => log({ type: 'ssh-credential-broker', ...event }),
});
const live = new SshVsiMcpLiveCollector(hosts as never, broker, teeFactory);
const tools = new VsiMcpTools({
  hosts, mpls: { listVsis: async () => persistedVsis() }, live,
  consumeApproval: (approvalId, hostId, scope, operator) => broker.consumeApproval(approvalId, hostId, scope, operator),
  peekApproval: (approvalId, hostId, scope, operator) => void approvals.peek(approvalId, hostId, scope, Date.now(), operator.username),
  audit: (event) => log({ type: 'ssh-command', ...event }),
  deadlineMs: 90_000,
});
registerVsiMcpRoutes(
  app, tools,
  async (req) => sessions.get((req.cookies as Record<string, string | undefined>).netvision_session ?? '') ?? null,
  approvals,
  { VSI_MCP_ENABLED: 'true' },
);

await app.listen({ host: '127.0.0.1', port: PORT });
log({ type: 'start', port: PORT, hostId: host.id });
console.log(`vsi-dev harness em http://127.0.0.1:${PORT} (host ${host.name})`);
