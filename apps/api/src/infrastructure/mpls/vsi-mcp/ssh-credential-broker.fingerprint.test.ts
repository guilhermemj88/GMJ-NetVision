import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, utils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from '../vsi-diagnostic-approval';
import { vsiMcpProfileSchema } from './access-profile';
import { approvalScope } from './contracts';
import { SshVsiMcpLiveCollector, VsiMcpLiveError } from './live-collector';
import { SshCredentialBroker } from './ssh-credential-broker';

/**
 * Prova ponta a ponta, com servidor SSH LOCAL SINTETICO (127.0.0.1, porta efemera, chave gerada no teste):
 * com fingerprint divergente a senha NUNCA chega ao servidor; com a fixada correta ela so e enviada depois.
 * Nenhum equipamento real e contatado.
 */
const OP = { id: 'exec-1', username: 'executor', role: 'OPERATOR' } as const; // quem EXECUTA (diferente de quem aprova)
const PASSWORD = 'Sint3tica-Senha-Fingerprint-0003';
const fp = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

let server: Server;
let port = 0;
let pinned = '';
const attempts: Array<{ method: string; password?: string }> = [];
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'broker-fp-'));
  const key = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key.private);
  if (parsed instanceof Error) throw parsed;
  pinned = fp(parsed.getPublicSSH());
  server = new Server({ hostKeys: [key.private] }, (client) => {
    client.on('authentication', (ctx) => {
      attempts.push({ method: ctx.method, ...(ctx.method === 'password' ? { password: ctx.password } : {}) });
      ctx.reject(['password']);
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const inventory = () =>
  ({ id: 'h-fp', name: 'PE-FP', vendor: 'Huawei', sshEnabled: true, ssh: { host: '127.0.0.1', port, username: 'svc', contextCommand: null, credentialConfigured: true } }) as unknown as HostRecord;

async function collectorWith(fingerprint: string) {
  const profile = vsiMcpProfileSchema.parse({
    hostId: 'h-fp', endpoint: '127.0.0.1', port, username: 'svc', context: null, fingerprint,
    initialPrompt: '<PE-FP>', expectedPrompt: '<PE-FP>', vendor: 'HUAWEI', family: 'NE8000_V800', disablePagingTemporary: true,
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', operations: ['VERSION'],
  });
  const store = new VsiDiagnosticApprovalStore(dir);
  const decrypt = vi.fn(async () => ({ password: PASSWORD }));
  const hosts = { getHost: async () => inventory(), getDecryptedSshCredentials: decrypt };
  const broker = new SshCredentialBroker({ hosts: hosts as never, profiles: async () => [profile], consumeApproval: (a, h, s, e) => store.consume(a, h, s, Date.now(), e) });
  const collector = new SshVsiMcpLiveCollector(hosts as never, broker, undefined, 0);
  const approvalId = store.create({ hostId: 'h-fp', vsiId: approvalScope(), createdBy: 'admin' }).approvalId;
  await broker.consumeApproval(approvalId, 'h-fp', approvalScope(), OP);
  return { collector, approvalId, decrypt };
}

describe('fingerprint SSH fixada x chave apresentada (servidor local sintetico)', () => {
  it('fingerprint divergente: conexao recusada ANTES da autenticacao; o servidor nunca recebe a senha', async () => {
    attempts.length = 0;
    const wrong = 'SHA256:' + 'B'.repeat(43);
    expect(wrong).not.toBe(pinned);
    const { collector, approvalId, decrypt } = await collectorWith(wrong);
    const error = await collector
      .collect(inventory(), [], { signal: new AbortController().signal, audit: () => {}, approvalId, operatorId: OP.id, scope: approvalScope() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VsiMcpLiveError);
    expect((error as VsiMcpLiveError).code).toBe('SSH_FAILED');
    expect(attempts).toEqual([]); // nem sequer o metodo "none": a chave foi rejeitada antes
    // A senha ja estava na memoria do cliente (liberada depois de autorizacao e identidade), mas NAO foi transmitida:
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(String((error as Error).message)).not.toContain(PASSWORD);
  });

  it('fingerprint correta: so entao a senha e enviada (servidor sintetico recusa a autenticacao)', async () => {
    attempts.length = 0;
    const { collector, approvalId } = await collectorWith(pinned);
    const error = await collector
      .collect(inventory(), [], { signal: new AbortController().signal, audit: () => {}, approvalId, operatorId: OP.id, scope: approvalScope() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VsiMcpLiveError);
    expect(attempts.some((a) => a.method === 'password' && a.password === PASSWORD)).toBe(true);
    expect(String((error as Error).message)).not.toContain(PASSWORD);
  });
});
