import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { VsiDiagnosticApprovalStore } from '../vsi-diagnostic-approval';
import { VsiMcpProfileError, vsiMcpProfileSchema, type VsiMcpAccessProfile } from './access-profile';
import { VsiMcpPolicyError, type VsiMcpOperation } from './command-policy';
import { approvalScope } from './contracts';
import {
  parseApprovalScope, redactSecret, scrubSshMessage, secretVariants, SSH_GRANT_MAX_SESSIONS, SSH_GRANT_TTL_MS,
  SshCredentialBroker, SshCredentialBrokerError, type SshCredentialBrokerAuditEvent, type SshCredentialBrokerErrorCode,
  type SshSessionSequence,
} from './ssh-credential-broker';

// Somente valores SINTETICOS: nenhuma credencial real existe neste arquivo.
const PASSWORD = 'Sint3tica-Senha-Teste-0001';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const VSI = 'VSI-TESTE';
const SCOPE = approvalScope(VSI);
const DISCOVERY = approvalScope();
const FP = 'SHA256:' + 'A'.repeat(43);

const profile = (over: Record<string, unknown> = {}): VsiMcpAccessProfile =>
  vsiMcpProfileSchema.parse({
    hostId: 'h1', endpoint: '10.0.0.1', port: 2222, username: 'svc', context: null, fingerprint: FP,
    initialPrompt: '<H>', expectedPrompt: '<H>', vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
    validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z',
    operations: ['VERSION', 'VSI_LIST', 'VSI_VERBOSE', 'VSI_MAC', 'INTERFACE_CONFIG', 'INTERFACE_STATE', 'VLAN_INFO', 'ETH_TRUNK_INFO', 'ETRUNK_BRIEF', 'ETRUNK_INFO'],
    maxInterfaces: 2, vlans: [3066], carrierInterfaces: ['Eth-Trunk1'], eTrunks: [4], ...over,
  });
const inventoryHost = (over: Record<string, unknown> = {}, ssh: Record<string, unknown> = {}): HostRecord =>
  ({ id: 'h1', name: 'PE-SINTETICO', vendor: 'Huawei', sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 2222, username: 'svc', contextCommand: null, credentialConfigured: true, ...ssh }, ...over }) as unknown as HostRecord;

const OP = { id: 'exec-1', username: 'executor', role: 'OPERATOR' } as const; // quem EXECUTA (diferente de quem aprova)
const V = { kind: 'VERSION' } as VsiMcpOperation;
const verbose = (vsi = VSI) => ({ kind: 'VSI_VERBOSE', vsiName: vsi }) as VsiMcpOperation;
const mac = (vsi = VSI) => ({ kind: 'VSI_MAC', vsiName: vsi }) as VsiMcpOperation;
const cfg = (name: string) => ({ kind: 'INTERFACE_CONFIG', interfaceName: name }) as VsiMcpOperation;
const carrier = (name: string) => ({ kind: 'INTERFACE_CONFIG', interfaceName: name, role: 'CARRIER' }) as VsiMcpOperation;

let dir: string;
let clock: number;
let store: VsiDiagnosticApprovalStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-'));
  store = new VsiDiagnosticApprovalStore(dir);
  clock = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface SetupOpts {
  serviceAccounts?: string[];
  host?: HostRecord | null;
  password?: string | null;
  profiles?: VsiMcpAccessProfile[];
  allowedPurposes?: never;
}

function setup(opts: SetupOpts = {}) {
  const events: SshCredentialBrokerAuditEvent[] = [];
  const state = { profiles: opts.profiles ?? [profile()], host: opts.host === undefined ? inventoryHost() : opts.host };
  const getHost = vi.fn(async () => state.host);
  const getDecrypted = vi.fn(async () => (opts.password === null ? null : { password: opts.password ?? PASSWORD }));
  const make = () =>
    new SshCredentialBroker({
      hosts: { getHost, getDecryptedSshCredentials: getDecrypted } as never,
      profiles: async () => state.profiles,
      serviceAccounts: () => new Set(opts.serviceAccounts ?? []),
      consumeApproval: (approvalId, hostId, scope, executor) => store.consume(approvalId, hostId, scope, clock, executor),
      audit: (e) => events.push(e),
      now: () => clock,
      ...(opts.allowedPurposes ? { allowedPurposes: opts.allowedPurposes } : {}),
    });
  const broker = make();
  const approve = (over: { hostId?: string; scope?: string; at?: number } = {}) =>
    store.create({ hostId: over.hostId ?? 'h1', vsiId: over.scope ?? SCOPE, createdBy: 'admin', now: over.at ?? clock }).approvalId;
  const session = (
    approvalId: string | undefined, ops: VsiMcpOperation[] = [verbose()], sequence: SshSessionSequence = 1,
    scope: string = SCOPE, hostId = 'h1',
  ) => ({ purpose: 'VSI_DIAGNOSTIC_LIVE' as const, hostId, approvalId, operatorId: OP.id, plan: { scope, sequence, operations: [V, ...ops] } });
  const preflight = (ops: VsiMcpOperation[] = [verbose()], sequence: SshSessionSequence = 1, scope: string = SCOPE) =>
    ({ purpose: 'VSI_DIAGNOSTIC_LIVE' as const, hostId: 'h1', plan: { scope, sequence, operations: [V, ...ops] } });
  return { broker, make, state, getHost, getDecrypted, events, approve, session, preflight };
}

async function codeOf(promise: Promise<unknown>): Promise<SshCredentialBrokerErrorCode | string> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof SshCredentialBrokerError) return error.code;
    if (error instanceof VsiMcpProfileError) return `PROFILE:${error.code}`;
    if (error instanceof VsiMcpPolicyError) return `POLICY:${error.code}`;
    return `OTHER:${(error as Error).message}`;
  }
}
const ok = async () => undefined;

describe('escopo da aprovacao', () => {
  it('so existem dois escopos: descoberta de host e VSI exata', () => {
    expect(parseApprovalScope('vsi-host:discovery')).toEqual({ kind: 'DISCOVERY' });
    expect(parseApprovalScope('vsi-name:VSI-TESTE')).toEqual({ kind: 'VSI', vsiName: 'VSI-TESTE' });
    for (const bad of ['', 'vsi-name:', 'vsi-name:a b', 'vsi-name:a;b', 'vsi-host:other', 'vsi-name:' + 'x'.repeat(65), undefined, 7])
      expect(parseApprovalScope(bad), String(bad)).toBeNull();
  });
});

describe('caminho feliz e ordem', () => {
  it('cofre so depois de aprovacao, identidade e teto; entrega a senha e a conexao AUTORITATIVA ao callback', async () => {
    const order: string[] = [];
    const t = setup();
    t.getHost.mockImplementation(async () => { order.push('inventario'); return t.state.host; });
    t.getDecrypted.mockImplementation(async () => { order.push('decifra'); return { password: PASSWORD }; });
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    expect(t.getDecrypted).not.toHaveBeenCalled();
    await t.broker.preflight(t.preflight());
    expect(t.getDecrypted).not.toHaveBeenCalled();
    const seen = await t.broker.withCredential(t.session(id), async (secret, connection) => {
      order.push('sessao');
      return { password: secret.password, endpoint: connection.endpoint, port: connection.port, username: connection.username, fingerprint: connection.fingerprint };
    });
    expect(seen).toEqual({ password: PASSWORD, endpoint: '10.0.0.1', port: 2222, username: 'svc', fingerprint: FP });
    expect(order.filter((o) => o !== 'inventario')).toEqual(['decifra', 'sessao']);
    expect(order.lastIndexOf('inventario')).toBeLessThan(order.indexOf('decifra'));
  });

  it('o segredo entregue nao aparece em JSON, inspect nem Object.keys', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id), async (secret) => {
      expect(JSON.stringify(secret)).not.toContain(PASSWORD);
      expect(inspect(secret, { showHidden: false })).not.toContain(PASSWORD);
      expect(Object.keys(secret)).toEqual([]);
      expect(Object.isFrozen(secret)).toBe(true);
    });
  });

  it('a conexao devolvida e congelada: o chamador nao consegue trocar endpoint, porta, usuario nem fingerprint', async () => {
    const t = setup();
    const connection = await t.broker.preflight(t.preflight());
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.profile)).toBe(true);
    expect(() => { (connection as { endpoint: string }).endpoint = '10.9.9.9'; }).toThrow();
    expect(() => { (connection.profile as { endpoint: string }).endpoint = '10.9.9.9'; }).toThrow();
  });
});

describe('F-02: identidade resolvida pelo broker, nao pelo chamador', () => {
  it('o pedido nao carrega perfil: mesmo um campo extra com outra fingerprint/endpoint e ignorado', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    const forged = { ...t.session(id), profile: { endpoint: '10.9.9.9', port: 22, username: 'root', fingerprint: 'SHA256:' + 'Z'.repeat(43) } };
    const used = await t.broker.withCredential(forged as never, async (_s, c) => ({ e: c.endpoint, p: c.port, u: c.username, f: c.fingerprint }));
    expect(used).toEqual({ e: '10.0.0.1', p: 2222, u: 'svc', f: FP });
  });

  it('perfil alterado entre o consumo da aprovacao e a sessao 1: IDENTITY_CHANGED, cofre intacto', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    t.state.profiles = [profile({ fingerprint: 'SHA256:' + 'B'.repeat(43) })];
    expect(await codeOf(t.broker.withCredential(t.session(id), ok))).toBe('IDENTITY_CHANGED');
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });

  it('perfil alterado entre a sessao 1 e a 2 (qualquer campo, inclusive ampliar operacoes): IDENTITY_CHANGED, 2a sessao sem cofre', async () => {
    for (const change of [{ fingerprint: 'SHA256:' + 'C'.repeat(43) }, { maxInterfaces: 12 }, { vlans: [3066, 3067] }, { expiresAt: '2026-12-02T00:00:00.000Z' }]) {
      const t = setup();
      const id = t.approve();
      await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
      await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
      t.state.profiles = [profile(change)];
      expect(await codeOf(t.broker.withCredential(t.session(id, [mac()], 2), ok)), JSON.stringify(change)).toBe('IDENTITY_CHANGED');
      expect(t.getDecrypted).toHaveBeenCalledTimes(1);
    }
  });

  it('inventario diverge do perfil (usuario, porta, endpoint, contexto): erro de perfil e a senha nao e lida', async () => {
    for (const ssh of [{ username: 'outro' }, { port: 22 }, { host: '10.0.0.2' }, { contextCommand: 'switch virtual-system VS1' }]) {
      const t = setup({ host: inventoryHost({}, ssh) });
      expect(await codeOf(t.broker.preflight(t.preflight())), JSON.stringify(ssh)).toBe('PROFILE:INVENTORY_MISMATCH');
      expect(await codeOf(t.broker.consumeApproval(t.approve(), 'h1', SCOPE, OP)), JSON.stringify(ssh)).toBe('PROFILE:INVENTORY_MISMATCH');
      expect(t.getDecrypted).not.toHaveBeenCalled();
    }
  });

  it('equipamento inexistente, de outro id, sem SSH ou sem credencial cadastrada', async () => {
    expect(await codeOf(setup({ host: null }).broker.preflight(setup().preflight()))).toBe('HOST_NOT_FOUND');
    expect(await codeOf(setup({ host: inventoryHost({ id: 'outro' }) }).broker.preflight(setup().preflight()))).toBe('IDENTITY_MISMATCH');
    expect(await codeOf(setup({ host: inventoryHost({ sshEnabled: false }) }).broker.preflight(setup().preflight()))).toBe('IDENTITY_MISMATCH');
    expect(await codeOf(setup({ host: inventoryHost({}, { credentialConfigured: false }) }).broker.preflight(setup().preflight()))).toBe('CREDENTIAL_UNAVAILABLE');
  });

  it('sem perfil, perfil vencido, ainda nao valido, ambiguo ou de outro host', async () => {
    const cases: Array<[VsiMcpAccessProfile[], string]> = [
      [[], 'PROFILE:NO_PROFILE'],
      [[profile({ expiresAt: '2026-11-17T12:00:00.000Z' })], 'PROFILE:NO_PROFILE'],
      [[profile({ validFrom: '2026-11-17T12:00:01.000Z' })], 'PROFILE:NO_PROFILE'],
      [[profile(), profile()], 'PROFILE:AMBIGUOUS_PROFILE'],
      [[profile({ hostId: 'h2' })], 'PROFILE:NO_PROFILE'],
    ];
    for (const [profiles, expected] of cases) {
      const t = setup({ profiles });
      expect(await codeOf(t.broker.preflight(t.preflight()))).toBe(expected);
    }
  });

  it('fonte de perfis com fingerprint nao fixada: FINGERPRINT_NOT_PINNED', async () => {
    const t = setup({ profiles: [{ ...profile(), fingerprint: 'SHA256:curta' } as VsiMcpAccessProfile] });
    expect(await codeOf(t.broker.preflight(t.preflight()))).toBe('FINGERPRINT_NOT_PINNED');
  });

  it('o consumo da aprovacao tambem valida a identidade ANTES de gastar a aprovacao', async () => {
    const t = setup({ host: inventoryHost({}, { username: 'outro' }) });
    const id = t.approve();
    expect(await codeOf(t.broker.consumeApproval(id, 'h1', SCOPE, OP))).toBe('PROFILE:INVENTORY_MISMATCH');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    t.state.host = inventoryHost();
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, OP)).resolves.toBeUndefined();
  });
});

describe('F-01: grant vinculado a VSI, host, aprovacao, finalidade e perfil', () => {
  it('escopo desconhecido: SCOPE_NOT_AUTHORIZED, sem gastar a aprovacao', async () => {
    const t = setup();
    const id = t.approve({ scope: 'vsi-name:a b' });
    expect(await codeOf(t.broker.consumeApproval(id, 'h1', 'vsi-name:a b', OP))).toBe('SCOPE_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([verbose()], 1, 'qualquer-coisa')))).toBe('SCOPE_NOT_AUTHORIZED');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
  });

  it('aprovacao de uma VSI nao serve a outra VSI (escopo do pedido diferente do do grant): GRANT_MISMATCH', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    const other = approvalScope('OUTRA-VSI');
    expect(await codeOf(t.broker.withCredential(t.session(id, [verbose('OUTRA-VSI')], 1, other), ok))).toBe('GRANT_MISMATCH');
    expect(await codeOf(t.broker.withCredential(t.session(id, [], 1, DISCOVERY), ok))).toBe('GRANT_MISMATCH');
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });

  it('comando de OUTRA VSI dentro do escopo aprovado: PLAN_NOT_AUTHORIZED (preflight e sessao)', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    for (const ops of [[verbose('OUTRA-VSI')], [verbose(), mac('OUTRA-VSI')], [mac('OUTRA-VSI')]]) {
      expect(await codeOf(t.broker.preflight(t.preflight(ops)))).toBe('PLAN_NOT_AUTHORIZED');
      expect(await codeOf(t.broker.withCredential(t.session(id, ops), ok))).toBe('PLAN_NOT_AUTHORIZED');
    }
    expect(t.getDecrypted).not.toHaveBeenCalled();
    await expect(t.broker.withCredential(t.session(id, [verbose()]), ok)).resolves.toBeUndefined(); // ainda serve (nao gastou a vaga)
  });

  it('descoberta de host: so VERSION e VSI_LIST, uma unica sessao', async () => {
    const t = setup();
    const id = t.approve({ scope: DISCOVERY });
    await t.broker.consumeApproval(id, 'h1', DISCOVERY, OP);
    for (const ops of [[verbose()], [mac()], [cfg('GigabitEthernet0/0/1')], [{ kind: 'VLAN_INFO', vlanId: 3066 } as VsiMcpOperation]])
      expect(await codeOf(t.broker.withCredential(t.session(id, ops, 1, DISCOVERY), ok))).toBe('PLAN_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([{ kind: 'VSI_LIST' }], 2, DISCOVERY)))).toBe('PLAN_NOT_AUTHORIZED');
    await t.broker.withCredential(t.session(id, [{ kind: 'VSI_LIST' }], 1, DISCOVERY), ok);
    expect(await codeOf(t.broker.withCredential(t.session(id, [{ kind: 'VSI_LIST' }], 2, DISCOVERY), ok))).toBe('PLAN_NOT_AUTHORIZED'); // a descoberta nunca tem 2a sessao
    expect(await codeOf(t.broker.withCredential(t.session(id, [{ kind: 'VSI_LIST' }], 1, DISCOVERY), ok))).toBe('GRANT_EXHAUSTED');
  });

  it('escopo de VSI: VSI_LIST e INTERFACE_STATE nunca (nem na sessao 1)', async () => {
    const t = setup();
    for (const ops of [[{ kind: 'VSI_LIST' } as VsiMcpOperation], [{ kind: 'INTERFACE_STATE', interfaceName: 'GigabitEthernet0/0/1' } as VsiMcpOperation]])
      expect(await codeOf(t.broker.preflight(t.preflight(ops)))).toBe('PLAN_NOT_AUTHORIZED');
  });

  it('a finalidade e vinculada ao grant: outra finalidade nao usa o grant', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    const request = { ...t.session(id), purpose: 'LLDP_DISCOVERY' as never };
    expect(await codeOf(t.broker.withCredential(request, ok))).toBe('PURPOSE_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(request))).toBe('PURPOSE_NOT_AUTHORIZED');
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });

  it('a aprovacao e vinculada ao host: grant de h1 nao serve a h2', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    t.state.profiles = [profile(), profile({ hostId: 'h2' })];
    t.state.host = inventoryHost({ id: 'h2' });
    expect(await codeOf(t.broker.withCredential(t.session(id, [verbose()], 1, SCOPE, 'h2'), ok))).toBe('GRANT_MISMATCH');
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });
});

describe('F-01: comandos delimitados por sessao e profile.maxInterfaces', () => {
  it('sessao 1 completa (VSI + ACs conhecidos + MAC) cabe numa unica sessao', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await expect(t.broker.withCredential(t.session(id, [verbose(), cfg('GigabitEthernet0/0/1'), cfg('GigabitEthernet0/0/2'), carrier('Eth-Trunk1'), mac()]), ok)).resolves.toBeUndefined();
  });

  it('a sessao 2 e CONTINUACAO: nunca le a VSI de novo nem lista VSIs; exige que a 1 tenha lido a VSI', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    // sessao 1 SEM ler a VSI: a 2 nao pode existir
    await t.broker.withCredential(t.session(id, [{ kind: 'VLAN_INFO', vlanId: 3066 } as VsiMcpOperation], 1), ok);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg('GigabitEthernet0/0/1')], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    // e uma 2a que releia a VSI e recusada de qualquer forma
    const u = setup();
    const id2 = u.approve();
    await u.broker.consumeApproval(id2, 'h1', SCOPE, OP);
    await u.broker.withCredential(u.session(id2, [verbose()], 1), ok);
    u.broker.observeAcs({ approvalId: id2, hostId: 'h1', scope: SCOPE, operatorId: OP.id, names: ['GigabitEthernet0/0/1'] });
    expect(await codeOf(u.broker.withCredential(u.session(id2, [verbose()], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    expect(await codeOf(u.broker.withCredential(u.session(id2, [{ kind: 'VSI_LIST' }], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    await expect(u.broker.withCredential(u.session(id2, [cfg('GigabitEthernet0/0/1'), mac()], 2), ok)).resolves.toBeUndefined();
  });

  it('nenhum comando se repete: nem na mesma sessao, nem entre sessoes (exceto display version)', async () => {
    const t = setup();
    expect(await codeOf(t.broker.preflight(t.preflight([verbose(), verbose()])))).toBe('PLAN_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([cfg('GigabitEthernet0/0/1'), cfg('GigabitEthernet0/0/1')])))).toBe('PLAN_NOT_AUTHORIZED');
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose(), mac()], 1), ok);
    t.broker.observeAcs({ approvalId: id, hostId: 'h1', scope: SCOPE, operatorId: OP.id, names: ['GigabitEthernet0/0/1'] });
    expect(await codeOf(t.broker.withCredential(t.session(id, [mac()], 2), ok))).toBe('PLAN_NOT_AUTHORIZED'); // MAC repetido
    await expect(t.broker.withCredential(t.session(id, [cfg('GigabitEthernet0/0/1')], 2), ok)).resolves.toBeUndefined(); // VERSION repete, ok
  });

  it('profile.maxInterfaces: no plano e cumulativo entre as sessoes da aprovacao', async () => {
    const t = setup(); // maxInterfaces = 2
    expect(await codeOf(t.broker.preflight(t.preflight([cfg('GigabitEthernet0/0/1'), cfg('GigabitEthernet0/0/2'), cfg('GigabitEthernet0/0/3')])))).toBe('PLAN_NOT_AUTHORIZED');
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose(), cfg('GigabitEthernet0/0/1')], 1), ok); // 1 de 2
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg('GigabitEthernet0/0/2'), cfg('GigabitEthernet0/0/3')], 2), ok))).toBe('PLAN_NOT_AUTHORIZED'); // 3 > 2
    expect(t.getDecrypted).toHaveBeenCalledTimes(1);
  });

  it('portadoras nao contam como AC, mas so as listadas no perfil; VLAN e E-Trunk tambem; nome inseguro e recusado', async () => {
    const t = setup();
    await expect(t.broker.preflight(t.preflight([carrier('Eth-Trunk1'), { kind: 'VLAN_INFO', vlanId: 3066 } as VsiMcpOperation, { kind: 'ETRUNK_INFO', eTrunkId: 4 } as VsiMcpOperation]))).resolves.toBeDefined();
    expect(await codeOf(t.broker.preflight(t.preflight([carrier('Eth-Trunk9')])))).toBe('PROFILE:OPERATION_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([{ kind: 'VLAN_INFO', vlanId: 3067 } as VsiMcpOperation])))).toBe('PROFILE:OPERATION_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([{ kind: 'ETRUNK_INFO', eTrunkId: 5 } as VsiMcpOperation])))).toBe('PROFILE:OPERATION_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.preflight(t.preflight([cfg('Gi0/0/1; reload')])))).toBe('POLICY:UNSAFE_INTERFACE');
    expect(await codeOf(t.broker.preflight(t.preflight([{ kind: 'VSI_VERBOSE', vsiName: 'x; reload' } as VsiMcpOperation], 1, 'vsi-name:x; reload')))).toBe('SCOPE_NOT_AUTHORIZED');
  });

  it('operacao que o perfil nao autoriza e recusada mesmo dentro do escopo', async () => {
    const t = setup({ profiles: [profile({ operations: ['VERSION', 'VSI_VERBOSE'] })] });
    expect(await codeOf(t.broker.preflight(t.preflight([mac()])))).toBe('PROFILE:OPERATION_NOT_AUTHORIZED');
  });

  it('sequencia invalida (0, 3, 1.5): recusada', async () => {
    const t = setup();
    for (const sequence of [0, 3, 1.5]) expect(await codeOf(t.broker.preflight(t.preflight([verbose()], sequence as never)))).toBe('GRANT_SEQUENCE');
  });
});

describe('aprovacao com duas sessoes: sequencia, fechamento e reuso', () => {
  it('as duas sessoes usam a MESMA aprovacao, 1 -> 2; a 3a e recusada', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    await t.broker.withCredential(t.session(id, [mac()], 2), ok);
    for (const sequence of [1, 2] as const)
      expect(await codeOf(t.broker.withCredential(t.session(id, [cfg('GigabitEthernet0/0/9')], sequence), ok))).toBe('GRANT_EXHAUSTED');
    expect(t.getDecrypted).toHaveBeenCalledTimes(SSH_GRANT_MAX_SESSIONS);
  });

  it('2 antes da 1 e repetir a 1 como se fosse 2: GRANT_SEQUENCE', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    expect(await codeOf(t.broker.withCredential(t.session(id, [mac()], 2), ok))).toBe('GRANT_SEQUENCE');
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    expect(await codeOf(t.broker.withCredential(t.session(id, [verbose('VSI-TESTE')], 1), ok))).toBe('GRANT_SEQUENCE');
    expect(t.getDecrypted).toHaveBeenCalledTimes(1);
  });

  it('nunca em paralelo', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    let second: string | undefined;
    await t.broker.withCredential(t.session(id, [verbose()], 1), async () => {
      second = await codeOf(t.broker.withCredential(t.session(id, [mac()], 2), ok));
    });
    expect(second).toBe('GRANT_SEQUENCE');
  });

  it('duas chamadas simultaneas da mesma sessao: so uma passa (estado reservado de forma sincrona)', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    const results = await Promise.all([1, 2, 3, 4].map(() => codeOf(t.broker.withCredential(t.session(id, [verbose()], 1), async () => { await new Promise((r) => setTimeout(r, 5)); }))));
    expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
    expect(t.getDecrypted).toHaveBeenCalledTimes(1);
  });

  it('1a falhou (recusada, erro ou cofre): aprovacao fechada, sem 2a nem repeticao', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), async () => { throw new Error('recusada'); }).catch(() => undefined);
    for (const sequence of [1, 2] as const) expect(await codeOf(t.broker.withCredential(t.session(id, [mac()], sequence), ok))).toBe('GRANT_EXHAUSTED');
    const u = setup({ password: null });
    const id2 = u.approve();
    await u.broker.consumeApproval(id2, 'h1', SCOPE, OP);
    expect(await codeOf(u.broker.withCredential(u.session(id2), ok))).toBe('CREDENTIAL_UNAVAILABLE');
    expect(await codeOf(u.broker.withCredential(u.session(id2), ok))).toBe('GRANT_EXHAUSTED');
  });

  it('validacao que falha antes do grant NAO gasta a vaga', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    expect(await codeOf(t.broker.withCredential(t.session(id, [verbose('OUTRA')]), ok))).toBe('PLAN_NOT_AUTHORIZED');
    t.state.host = inventoryHost({}, { username: 'errado' });
    expect(await codeOf(t.broker.withCredential(t.session(id), ok))).toBe('PROFILE:INVENTORY_MISMATCH');
    t.state.host = inventoryHost();
    await expect(t.broker.withCredential(t.session(id), ok)).resolves.toBeUndefined();
  });

  it('sem aprovacao, forjada, expirada, de outro host/VSI: nenhum grant e o cofre nunca e tocado', async () => {
    const t = setup();
    expect(() => t.broker.consumeApproval(undefined, 'h1', SCOPE, OP)).rejects.toThrow(/obrigatoria/i);
    expect(await codeOf(t.broker.withCredential(t.session(undefined), ok))).toBe('GRANT_REQUIRED');
    expect(await codeOf(t.broker.withCredential(t.session('11111111-1111-4111-8111-111111111111'), ok))).toBe('GRANT_REQUIRED');
    const created = t.approve(); // criada e NAO consumida
    expect(await codeOf(t.broker.withCredential(t.session(created), ok))).toBe('GRANT_REQUIRED');
    await expect(t.broker.consumeApproval(t.approve({ at: NOW - 3_600_000 }), 'h1', SCOPE, OP)).rejects.toThrow(/expirada/i);
    await expect(t.broker.consumeApproval(t.approve({ hostId: 'h2' }), 'h1', SCOPE, OP)).rejects.toThrow(/host\/VSI/i);
    await expect(t.broker.consumeApproval(t.approve({ scope: approvalScope('OUTRA') }), 'h1', SCOPE, OP)).rejects.toThrow(/host\/VSI/i);
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });

  it('reconsumir a mesma aprovacao falha e NAO reabastece o grant', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    await t.broker.withCredential(t.session(id, [mac()], 2), ok);
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, OP)).rejects.toThrow(/ja utilizada/i);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg('GigabitEthernet0/0/1')], 1), ok))).toBe('GRANT_EXHAUSTED');
    expect(t.getDecrypted).toHaveBeenCalledTimes(2);
  });

  it('grant expira apos o prazo e nunca vai alem da validade da aprovacao', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    clock += SSH_GRANT_TTL_MS + 1;
    expect(await codeOf(t.broker.withCredential(t.session(id), ok))).toBe('GRANT_EXPIRED');
    const u = setup();
    const short = store.create({ hostId: 'h1', vsiId: SCOPE, createdBy: 'admin', ttlSeconds: 30, now: clock }).approvalId;
    await u.broker.consumeApproval(short, 'h1', SCOPE, OP);
    clock += 31_000;
    expect(await codeOf(u.broker.withCredential(u.session(short), ok))).toBe('GRANT_EXPIRED');
  });

  it('reinicio: um broker novo nao tem o grant (GRANT_REQUIRED) e a aprovacao ja esta queimada em disco', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    const restarted = t.make(); // novo processo: memoria zerada
    expect(await codeOf(restarted.withCredential(t.session(id, [mac()], 2), ok))).toBe('GRANT_REQUIRED');
    await expect(restarted.consumeApproval(id, 'h1', SCOPE, OP)).rejects.toThrow(/ja utilizada/i);
    expect(t.getDecrypted).toHaveBeenCalledTimes(1);
  });

  it('finalidade invalida no consumo: recusada ANTES de gastar a aprovacao', async () => {
    const t = setup();
    const id = t.approve();
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, OP, 'LLDP_DISCOVERY' as never)).rejects.toBeInstanceOf(SshCredentialBrokerError);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, OP)).resolves.toBeUndefined();
  });

  it('lista vazia de finalidades bloqueia tudo', async () => {
    const t = setup({ allowedPurposes: [] as never });
    await expect(t.broker.consumeApproval(t.approve(), 'h1', SCOPE, OP)).rejects.toBeInstanceOf(SshCredentialBrokerError);
    expect(await codeOf(t.broker.preflight(t.preflight()))).toBe('PURPOSE_NOT_AUTHORIZED');
  });
});

describe('segredos fora de erros, auditoria e logs (F-14)', () => {
  it('nenhum evento de auditoria, mensagem ou serializacao contem a senha, o usuario, o IP ou o nome do equipamento', async () => {
    const t = setup();
    const id = t.approve();
    const errors: unknown[] = [];
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    errors.push(await t.broker.withCredential(t.session(id, [verbose('X')], 2), ok).catch((e) => e));
    errors.push(await t.broker.withCredential(t.session(undefined), ok).catch((e) => e));
    errors.push(await t.broker.withCredential(t.session(id, [mac()], 2), async () => { throw new Error(`falhou ${PASSWORD}`); }).catch((e) => e));
    const dump = JSON.stringify(t.events) + errors.map((e) => `${(e as Error).name}|${(e as Error).message}|${JSON.stringify(e, Object.getOwnPropertyNames(e as object))}`).join('\n');
    for (const forbidden of [PASSWORD, 'PE-SINTETICO', 'svc', '10.0.0.1']) expect(dump, `vazou ${forbidden}`).not.toContain(forbidden);
    expect(t.events.map((e) => e.action)).toEqual(expect.arrayContaining(['GRANT_ISSUED', 'LEASE_GRANTED', 'LEASE_DENIED']));
    for (const e of t.events) expect(Object.keys(e).every((k) => ['action', 'purpose', 'hostId', 'approvalId', 'scope', 'operatorId', 'approvedBy', 'sequence', 'count', 'code'].includes(k))).toBe(true);
  });

  it('erro do callback com a senha em QUALQUER forma (literal, JSON, URL, base64) e redigido', async () => {
    const tricky = 'S3nha "com" aspas/&=+ç';
    for (const form of [tricky, JSON.stringify(tricky).slice(1, -1), encodeURIComponent(tricky), Buffer.from(tricky).toString('base64'), Buffer.from(tricky).toString('base64').replace(/=+$/, '')]) {
      const t = setup({ password: tricky });
      const id = t.approve();
      await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
      const error = await t.broker.withCredential(t.session(id), async () => { throw Object.assign(new Error(`auth falhou: ${form}`), { code: 'EAUTH' }); }).catch((e: Error) => e);
      for (const variant of secretVariants(tricky)) {
        expect(`${(error as Error).message}${(error as Error).stack}`, `forma ${form}`).not.toContain(variant);
      }
      expect((error as Error).message).toContain('[REMOVIDO]');
    }
  });

  it('redactSecret e scrubSshMessage: variantes, IPs e portas', () => {
    expect(redactSecret(`a ${PASSWORD} b ${encodeURIComponent(PASSWORD)} c ${Buffer.from(PASSWORD).toString('base64')}`, PASSWORD)).not.toMatch(/Sint3tica|Uyc/);
    const msg = scrubSshMessage(`connect ECONNREFUSED 10.100.101.2:2222 via [2001:db8::1]:22 and 10.0.0.1`, PASSWORD);
    expect(msg).not.toMatch(/10\.\d|2001|:2222/);
    expect(msg.length).toBeLessThanOrEqual(120);
    expect(secretVariants('')).toEqual([]);
  });

  it('erro que nao e Error vira mensagem generica; falha na auditoria nao derruba; erro do cofre nao repassa a mensagem', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    expect(((await t.broker.withCredential(t.session(id), async () => { throw PASSWORD; }).catch((e: Error) => e)) as Error).message).toBe('Falha SSH');

    const u = setup();
    const broken = new SshCredentialBroker({
      hosts: { getHost: async () => u.state.host, getDecryptedSshCredentials: async () => { throw new Error(`db ${PASSWORD}`); } } as never,
      profiles: async () => u.state.profiles,
      consumeApproval: (a, h, s, e) => store.consume(a, h, s, clock, e),
      audit: () => { throw new Error(`audit ${PASSWORD}`); },
      now: () => clock,
    });
    const id2 = u.approve();
    await broken.consumeApproval(id2, 'h1', SCOPE, OP);
    const error = await broken.withCredential(u.session(id2), ok).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SshCredentialBrokerError);
    expect((error as Error).message).not.toContain(PASSWORD);
  });
});

describe('F-06: separacao aprovador x executor, conta de servico e auditoria com operador', () => {
  const ADMIN_EXEC = { id: 'exec-admin', username: 'admin', role: 'ADMIN' } as const; // mesmo username de quem aprovou ('admin')

  it('quem criou a aprovacao NAO pode consumi-la: 423 antes de marcar como usada; outro operador ainda a usa', async () => {
    const t = setup();
    const id = t.approve(); // createdBy = 'admin'
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, ADMIN_EXEC)).rejects.toThrow(/quem a criou/i);
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    expect(await codeOf(t.broker.withCredential(t.session(id), ok))).toBe('GRANT_REQUIRED'); // nenhum grant nasceu
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, OP)).resolves.toBeUndefined();
    expect(t.getDecrypted).not.toHaveBeenCalled();
  });

  it('operador ausente ou incompleto: OPERATOR_REQUIRED, sem gastar a aprovacao', async () => {
    const t = setup();
    const id = t.approve();
    for (const op of [undefined, { id: '', username: 'x', role: 'OPERATOR' }, { id: 'x', username: '', role: 'OPERATOR' }])
      expect(await codeOf(t.broker.consumeApproval(id, 'h1', SCOPE, op as never)), JSON.stringify(op)).toBe('OPERATOR_REQUIRED');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
  });

  it('conta de servico com papel ADMIN nunca executa; OPERATOR de servico e ADMIN comum executam', async () => {
    const t = setup({ serviceAccounts: ['svc-mcp'] });
    const id = t.approve();
    expect(await codeOf(t.broker.consumeApproval(id, 'h1', SCOPE, { id: 's', username: 'svc-mcp', role: 'ADMIN' }))).toBe('SERVICE_ACCOUNT_ROLE');
    expect(existsSync(join(dir, `${id}.consumed`))).toBe(false);
    await expect(t.broker.consumeApproval(id, 'h1', SCOPE, { id: 's', username: 'svc-mcp', role: 'OPERATOR' })).resolves.toBeUndefined();
    const u = setup({ serviceAccounts: ['svc-mcp'] });
    await expect(u.broker.consumeApproval(u.approve(), 'h1', SCOPE, { id: 'h', username: 'humano-admin', role: 'ADMIN' })).resolves.toBeUndefined();
  });

  it('auditoria registra operador, aprovador, aprovacao, host, escopo (VSI), finalidade, sequencia e resultado, sem segredos', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    await t.broker.withCredential(t.session(id, [verbose('OUTRA')], 2), ok).catch(() => undefined);
    const issued = t.events.find((e) => e.action === 'GRANT_ISSUED')!;
    expect(issued).toMatchObject({ operatorId: 'exec-1', approvedBy: 'admin', approvalId: id, hostId: 'h1', scope: SCOPE, purpose: 'VSI_DIAGNOSTIC_LIVE' });
    const granted = t.events.find((e) => e.action === 'LEASE_GRANTED')!;
    expect(granted).toMatchObject({ operatorId: 'exec-1', approvedBy: 'admin', approvalId: id, hostId: 'h1', scope: SCOPE, sequence: 1 });
    const denied = t.events.find((e) => e.action === 'LEASE_DENIED' && e.sequence === 2)!;
    expect(denied).toMatchObject({ operatorId: 'exec-1', scope: SCOPE, code: 'PLAN_NOT_AUTHORIZED' }); // resultado
    expect(JSON.stringify(t.events)).not.toContain(PASSWORD);
  });

  it('o executor e VINCULADO ao grant: outra identidade (ou nenhuma) no pedido da sessao e recusada, sem cofre e sem gastar a vaga', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    for (const operatorId of ['forjado', undefined, 'admin'])
      expect(await codeOf(t.broker.withCredential({ ...t.session(id), operatorId } as never, ok))).toBe('GRANT_MISMATCH');
    expect(t.getDecrypted).not.toHaveBeenCalled();
    // a identidade correta ainda usa a sessao 1 (a vaga nao foi gasta)
    expect(await codeOf(t.broker.withCredential(t.session(id), ok))).toBe('NO_ERROR');
    expect(t.events.filter((e) => e.action === 'LEASE_GRANTED').every((e) => e.operatorId === 'exec-1')).toBe(true);
  });
});

describe('segunda sessao: ACs vinculados as evidencias da sessao 1', () => {
  const GI1 = 'GigabitEthernet0/0/1';
  const GI2 = 'GigabitEthernet0/0/2';
  const flow = async (t: ReturnType<typeof setup>) => {
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    return id;
  };
  const observe = (t: ReturnType<typeof setup>, id: string, names: string[], scope = SCOPE, hostId = 'h1') =>
    t.broker.observeAcs({ approvalId: id, hostId, scope, operatorId: OP.id, names });

  it('a sessao 2 so le ACs OBSERVADOS na sessao 1; qualquer outro e recusado sem tocar o cofre', async () => {
    const t = setup();
    const id = await flow(t);
    observe(t, id, [GI1]);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg(GI2)], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg(GI1), cfg(GI2)], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    expect(t.getDecrypted).toHaveBeenCalledTimes(1);
    await expect(t.broker.withCredential(t.session(id, [cfg(GI1), mac()], 2), ok)).resolves.toBeUndefined(); // vaga nao foi gasta pelas recusas
  });

  it('sem observacao nenhuma: fail-closed para configs de AC; MAC e portadoras nao dependem dela', async () => {
    const t = setup();
    const id = await flow(t);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg(GI1)], 2), ok))).toBe('PLAN_NOT_AUTHORIZED');
    await expect(t.broker.withCredential(t.session(id, [mac(), carrier('Eth-Trunk1')], 2), ok)).resolves.toBeUndefined();
  });

  it('observacao so depois de a sessao 1 CONCLUIR, uma unica vez, no mesmo host/escopo e sem falha', async () => {
    const t = setup();
    const id = t.approve();
    await t.broker.consumeApproval(id, 'h1', SCOPE, OP);
    expect(() => observe(t, id, [GI1])).toThrow(/sequencia/i); // antes da sessao 1
    await t.broker.withCredential(t.session(id, [verbose()], 1), ok);
    expect(() => observe(t, id, [GI1], approvalScope('OUTRA'))).toThrow(/equipamento ou escopo/i);
    expect(() => observe(t, id, [GI1], SCOPE, 'h2')).toThrow(/equipamento ou escopo/i);
    observe(t, id, [GI1]);
    expect(() => observe(t, id, [GI2])).toThrow(/sequencia/i); // so uma vez: nao da para ampliar depois
    expect(() => t.broker.observeAcs({ approvalId: undefined, hostId: 'h1', scope: SCOPE, operatorId: OP.id, names: [GI1] })).toThrow(/obrigatoria/i);
    // sessao 1 falhou: fechada, nada a observar
    const u = setup();
    const id2 = u.approve();
    await u.broker.consumeApproval(id2, 'h1', SCOPE, OP);
    await u.broker.withCredential(u.session(id2, [verbose()], 1), async () => { throw new Error('x'); }).catch(() => undefined);
    expect(() => observe(u, id2, [GI1])).toThrow(/sequencia/i);
  });

  it('a descoberta de host nao tem sessao 2 nem observacao', async () => {
    const t = setup();
    const id = t.approve({ scope: DISCOVERY });
    await t.broker.consumeApproval(id, 'h1', DISCOVERY, OP);
    await t.broker.withCredential(t.session(id, [{ kind: 'VSI_LIST' }], 1, DISCOVERY), ok);
    expect(() => observe(t, id, [GI1], DISCOVERY)).toThrow(/sequencia/i);
  });

  it('nomes invalidos nao entram na lista (e nao ampliam nada); o teto de interfaces continua valendo', async () => {
    const t = setup(); // maxInterfaces = 2
    const id = await flow(t);
    observe(t, id, ['Gi0/0/1; reload', '', 'a b', GI1, GI2, 'GigabitEthernet0/0/3']);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg('Gi0/0/1; reload' as never)], 2), ok))).toMatch(/POLICY|PLAN/);
    expect(await codeOf(t.broker.withCredential(t.session(id, [cfg(GI1), cfg(GI2), cfg('GigabitEthernet0/0/3')], 2), ok))).toBe('PLAN_NOT_AUTHORIZED'); // 3 > teto 2
    await expect(t.broker.withCredential(t.session(id, [cfg(GI1), cfg(GI2)], 2), ok)).resolves.toBeUndefined();
  });

  it('o evento ACS_OBSERVED registra so a contagem, com operador e escopo', async () => {
    const t = setup();
    const id = await flow(t);
    observe(t, id, [GI1, GI2]);
    expect(t.events.find((e) => e.action === 'ACS_OBSERVED')).toMatchObject({ count: 2, operatorId: 'exec-1', scope: SCOPE, approvalId: id });
    expect(JSON.stringify(t.events)).not.toContain(GI1);
  });
});
