import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, MplsVsi } from '@gmj/shared';
import { VsiMcpTools, type VsiMcpDeps } from './tools';
import { VSI_MCP_TOOLS, approvalScope } from './contracts';
import type { VsiMcpOperation } from './command-policy';
import { SshVsiMcpLiveCollector, VsiMcpLiveError, type VsiMcpLiveCollector } from './live-collector';
import { testBroker } from './__fixtures__/test-broker';
import { matchVsiMcpProfile, vsiMcpProfileSchema, VsiMcpProfileError, type VsiMcpAccessProfile } from './access-profile';
import * as S from './__fixtures__/synthetic';
import { fakeCollector, host } from './__fixtures__/harness';

type Hosts = ConstructorParameters<typeof SshVsiMcpLiveCollector>[0];
/** Normaliza para JSON simples (acesso livre a campos em asserts). */
const j = (value: unknown) => JSON.parse(JSON.stringify(value));

const APPROVAL_A = '11111111-1111-4111-8111-111111111111';
const APPROVAL_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'u1', username: 'admin', role: 'ADMIN' } as const;
const OPERATOR = { id: 'u2', username: 'op', role: 'OPERATOR' } as const;
const VIEWER = { id: 'u3', username: 'view', role: 'VIEWER' } as const;

function build(over: Partial<VsiMcpDeps> = {}, vsis: MplsVsi[] = []) {
  const audit = vi.fn();
  const consumeApproval = vi.fn();
  const deps: VsiMcpDeps = {
    hosts: { getHost: async (id) => (id === 'h-a' || id === 'h-b' ? host(id, id === 'h-a' ? 'PE-A' : 'PE-B') : null) },
    mpls: { listVsis: async () => vsis },
    live: null,
    consumeApproval,
    audit,
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    ...over,
  };
  return { tools: new VsiMcpTools(deps), audit, consumeApproval };
}

const persistedVsi = (): MplsVsi =>
  ({
    id: 'v1', hostId: 'h-a', name: 'L2-X', signalingType: 'LDP', rd: null, vsiId: 3, status: 'UP', operationalStatus: 'UP', adminStatus: 'UP',
    mtu: 1500, vcType: 'VLAN', tunnelPolicy: null, description: null, vlanId: 3901, localInterfaceId: null, source: 'SNMP',
    lastSeenAt: '2026-11-09T11:59:00.000Z', createdAt: '', updatedAt: '',
    acs: [{ id: 'ac1', hostId: 'h-a', mplsVsiId: 'v1', vsiName: 'L2-X', ifIndex: 5, interfaceId: 'i1', interface: { id: 'i1', name: 'GigabitEthernet1/0/1.3901', alias: '', ifIndex: 5 }, status: 'UP', upStartTimeRaw: null, upSumTimeRaw: null, source: 'SNMP', lastSeenAt: '2026-11-09T11:59:00.000Z', createdAt: '', updatedAt: '' }],
    pws: [{ id: 'pw1', hostId: 'h-a', mplsVsiId: 'v1', vsiName: 'L2-X', pwId: 1, remoteIp: '10.0.0.2', remoteHostId: null, remoteHost: null, tunnelPolicy: null, pwType: 'VLAN', inboundLabel: 1000, outboundLabel: 2000, status: 'UP', state: 'UP', workingState: 'MASTER', upStartTime: null, upSumTime: null, source: 'SNMP', lastSeenAt: '2026-11-09T11:59:00.000Z', createdAt: '', updatedAt: '' }],
  }) as unknown as MplsVsi;

/* ------------------------------------------------------------------------ */
describe('entrada: schema estrito, sem comando arbitrario', () => {
  it('rejeita campos desconhecidos (nao existe parametro "command")', async () => {
    const { tools } = build();
    await expect(tools.call('get_vsi_details', { hostId: 'h-a', vsiName: 'X', command: 'reboot' }, ADMIN)).rejects.toMatchObject({ httpStatus: 400, code: 'INVALID_INPUT' });
  });
  it.each(['X; reboot', 'X verbose | include a', 'X\nundo vsi', 'a b'])('rejeita nome de VSI %j antes de qualquer I/O', async (vsiName) => {
    const { tools, consumeApproval } = build({ live: fakeCollector({}).collector });
    await expect(tools.call('diagnose_vsi', { hostId: 'h-a', vsiName, approvalId: APPROVAL_A }, ADMIN)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(consumeApproval).not.toHaveBeenCalled();
  });
  it('approvalId deve ser UUID; interfaces validadas', () => {
    expect(VSI_MCP_TOOLS.diagnose_vsi.safeParse({ hostId: 'h', vsiName: 'X', approvalId: 'x' }).success).toBe(false);
    expect(VSI_MCP_TOOLS.diagnose_vsi.safeParse({ hostId: 'h', vsiName: 'X', approvalId: APPROVAL_A, interfaces: ['GE0/0/1;reboot'] }).success).toBe(false);
  });
  it('compare exige pontas distintas', () => {
    const p = { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A };
    expect(VSI_MCP_TOOLS.compare_vsi_endpoints.safeParse({ a: p, b: p }).success).toBe(false);
  });
});

describe('autorizacao', () => {
  it('VIEWER nao executa ferramenta ao vivo', async () => {
    const { tools, consumeApproval } = build({ live: fakeCollector({}).collector });
    await expect(tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A }, VIEWER)).rejects.toMatchObject({ httpStatus: 403 });
    expect(consumeApproval).not.toHaveBeenCalled();
  });
  it('homologacao exige ADMIN', async () => {
    const { tools } = build({ live: fakeCollector({}).collector });
    await expect(tools.call('get_vsi_mac_table', { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A, homologation: true }, OPERATOR)).rejects.toMatchObject({ httpStatus: 403 });
  });
  it('host inexistente => 404', async () => {
    const { tools } = build({ live: fakeCollector({}).collector });
    await expect(tools.call('diagnose_vsi', { hostId: 'nope', vsiName: 'X', approvalId: APPROVAL_A }, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it('aprovacao recusada (423) interrompe antes do SSH', async () => {
    const err = Object.assign(new Error('Aprovacao expirada'), { statusCode: 423 });
    const { collector, sessions } = fakeCollector({});
    const { tools } = build({ live: collector, consumeApproval: () => { throw err; } });
    await expect(tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A }, ADMIN)).rejects.toMatchObject({ httpStatus: 423, code: 'APPROVAL_REQUIRED' });
    expect(sessions).toHaveLength(0);
  });
  it('sem coletor ao vivo => 503', async () => {
    const { tools } = build();
    await expect(tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A }, ADMIN)).rejects.toMatchObject({ httpStatus: 503 });
  });
});

describe('ferramentas persistidas (sem SSH)', () => {
  it('list_vsi PERSISTED: sem coletor, com evidencia SNMP', async () => {
    const { tools } = build({}, [persistedVsi()]);
    const r = await tools.call('list_vsi', { hostId: 'h-a' }, VIEWER);
    expect(r.status).toBe('OK');
    expect(r.evidence[0]).toMatchObject({ source: 'PERSISTED_SNMP', hostId: 'h-a' });
    expect(j(r.data).vsis[0]).toMatchObject({ name: 'L2-X', acCount: 1, pwCount: 1, pwUp: 1 });
  });
  it('host sem VSI persistida => INCONCLUSIVE com orientacao', async () => {
    const { tools } = build();
    const r = await tools.call('list_vsi', { hostId: 'h-a' }, VIEWER);
    expect(r.status).toBe('INCONCLUSIVE');
    expect(r.warnings[0]).toMatch(/ao vivo/);
  });
  it('list_vsi LIVE com a captura REAL do NE8000 F1A (sem VSI) => OK, total 0, evidencia do display vsi', async () => {
    const dir = join(__dirname, '..', '__fixtures__', 'ne8000-f1a-bhe-vta-20261109');
    const outputs = { 'h-a': { 'display version': readFileSync(join(dir, 'version.sanitized.txt'), 'utf8'), 'display vsi': readFileSync(join(dir, 'vsi.sanitized.txt'), 'utf8') } };
    const { collector, sessions } = fakeCollector(outputs);
    const { tools } = build({ live: collector });
    const r = await tools.call('list_vsi', { hostId: 'h-a', source: 'LIVE', probe: 'LIST', approvalId: APPROVAL_A }, OPERATOR);
    expect(r.status).toBe('OK');
    expect(j(r.data)).toMatchObject({ total: 0, vsis: [] });
    expect(r.warnings[0]).toMatch(/nenhuma VSI configurada/);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.commands).toEqual(['display version', 'display vsi']);
  });
  it('list_vsi LIVE com saida nao reconhecida => INCONCLUSIVE (nao inventa lista)', async () => {
    const { collector } = fakeCollector({ 'h-a': { 'display version': S.NE_VERSION, 'display vsi': '<PE-A>display vsi\nVSI-A up\n<PE-A>' } });
    const { tools } = build({ live: collector });
    const r = await tools.call('list_vsi', { hostId: 'h-a', source: 'LIVE', approvalId: APPROVAL_A }, OPERATOR);
    expect(r.status).toBe('INCONCLUSIVE');
    expect(r.errors[0]?.code).toBe('VSI_LIST_UNPARSED');
  });
  it('list_vsi LIVE em familia ainda candidata para VSI_LIST => NOT_SUPPORTED', async () => {
    const { collector } = fakeCollector({}, 'NE40E_V800');
    const { tools } = build({ live: collector });
    const r = await tools.call('list_vsi', { hostId: 'h-a', source: 'LIVE', approvalId: APPROVAL_A }, OPERATOR);
    expect(r.status).toBe('NOT_SUPPORTED');
  });
  it('pseudowires e ACs persistidos', async () => {
    const { tools } = build({}, [persistedVsi()]);
    expect(j((await tools.call('get_vsi_pseudowires', { hostId: 'h-a', vsiName: 'L2-X' }, VIEWER)).data).pws[0]).toMatchObject({ peerAddress: '10.0.0.2', inboundLabel: 1000 });
    expect(j((await tools.call('get_vsi_ac_bindings', { hostId: 'h-a', vsiName: 'L2-X' }, VIEWER)).data).acs[0].interface).toBe('GigabitEthernet1/0/1.3901');
  });
  it('VSI desconhecida => INCONCLUSIVE', async () => {
    const { tools } = build({}, [persistedVsi()]);
    expect((await tools.call('get_vsi_details', { hostId: 'h-a', vsiName: 'NAO' }, VIEWER)).status).toBe('INCONCLUSIVE');
  });
});

describe('CENARIO A ponta a ponta (coletor falso, mesma politica)', () => {
  const outputs = {
    'h-a': {
      'display version': S.NE_VERSION,
      'display vsi name L2-PPPOE-3901 verbose': S.SCEN_A_VSI,
      'display mac-address vsi L2-PPPOE-3901': S.MAC_WITH_AC_AND_PW,
      'display current-configuration interface GigabitEthernet1/0/1': S.SCEN_A_PARENT_CFG,
      'display current-configuration interface GigabitEthernet1/0/1.3901': S.SCEN_A_SUB_CFG,
    },
  };

  it('homologacao: le VSI, descobre os 2 ACs e a config de cada um em 2 sessoes; achado de duplicidade', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const { tools, audit, consumeApproval } = build({ live: collector });
    const r = await tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: APPROVAL_A, homologation: true }, ADMIN);
    expect(consumeApproval).toHaveBeenCalledTimes(1);
    expect(consumeApproval).toHaveBeenCalledWith(APPROVAL_A, 'h-a', approvalScope('L2-PPPOE-3901'), expect.objectContaining({ id: expect.any(String) }));
    expect(sessions).toHaveLength(2);
    expect(j(r.data).sessionsOpened).toBe(2);
    const diag = j(r.data).diagnosis;
    expect(diag.status).toBe('FAILED');
    const dup = diag.findings.find((f: { code: string }) => f.code === 'DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE');
    expect(dup).toMatchObject({ certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
    // Toda auditoria foi de comandos display.
    for (const [event] of audit.mock.calls) expect((event as { command: string }).command).toMatch(/^display /);
    // Cada evidencia traz origem, timestamp e hash.
    for (const e of r.evidence) {
      expect(e).toMatchObject({ source: 'LIVE_SSH', hostId: 'h-a' });
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.collectedAt).toBeTruthy();
    }
  });

  it('sem homologacao: NE8000 nao executa MAC/config (candidatos) => reportado em skipped, nunca enviado', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const { tools } = build({ live: collector });
    const r = await tools.call('get_vsi_mac_table', { hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: APPROVAL_A }, OPERATOR);
    expect(r.status).toBe('NOT_SUPPORTED');
    expect(r.errors[0]?.code).toBe('MAC_QUERY_NOT_HOMOLOGATED');
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(sessions.flatMap((s) => s.commands)).not.toContain('display mac-address vsi L2-PPPOE-3901');
  });

  it('interfaces explicitas evitam a segunda sessao', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const { tools } = build({ live: collector }, [{ ...persistedVsi(), name: 'L2-PPPOE-3901' } as MplsVsi]);
    const r = await tools.call('get_vsi_vlan_encapsulation', {
      hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: APPROVAL_A, homologation: true,
      interfaces: ['GigabitEthernet1/0/1.3901'],
    }, ADMIN);
    expect(sessions).toHaveLength(1);
    expect(r.status).toBe('OK');
    expect(j(r.data).vlanPaths[0]).toMatchObject({ mode: 'QINQ_TERMINATION' });
  });

  it('interfaces fora dos ACs conhecidos da VSI sao recusadas ANTES de consumir a aprovacao', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const { tools, consumeApproval } = build({ live: collector }, [{ ...persistedVsi(), name: 'L2-PPPOE-3901' } as MplsVsi]);
    await expect(tools.call('diagnose_vsi', {
      hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: APPROVAL_A, homologation: true, interfaces: ['Eth-Trunk2'],
    }, ADMIN)).rejects.toMatchObject({ httpStatus: 400, code: 'INTERFACE_NOT_AN_AC' });
    expect(consumeApproval).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it('VSI sem ACs persistidos: interfaces explicitas tambem recusadas (fail-closed)', async () => {
    const { collector } = fakeCollector(outputs);
    const { tools, consumeApproval } = build({ live: collector });
    await expect(tools.call('diagnose_vsi', {
      hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A, homologation: true, interfaces: ['GigabitEthernet1/0/1'],
    }, ADMIN)).rejects.toMatchObject({ code: 'INTERFACE_NOT_AN_AC' });
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it('pedido fora do escopo do perfil (preflight) NAO consome a aprovacao one-shot', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const guarded: VsiMcpLiveCollector = {
      ...collector,
      async preflight(_h, ops) {
        if (ops.some((o) => o.kind === 'VLAN_INFO' && o.vlanId !== 3066)) throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', 'VLAN fora do escopo do perfil');
      },
    };
    const { tools, consumeApproval } = build({ live: guarded });
    const r = await tools.call('diagnose_vsi', {
      hostId: 'h-a', vsiName: 'L2-X', approvalId: APPROVAL_A, homologation: true, vlanId: 3067,
    }, ADMIN);
    expect(r.status).toBe('NOT_SUPPORTED');
    expect(j(r.errors)[0]).toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    expect(consumeApproval).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it('saida de VSI paginada => INCONCLUSIVE, nunca veredito', async () => {
    const { collector } = fakeCollector({ 'h-a': { ...outputs['h-a'], 'display vsi name L2-PPPOE-3901 verbose': S.SCEN_A_VSI.replace('<PE-A>', '---- More ----\n<PE-A>') } });
    const { tools } = build({ live: collector });
    const r = await tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: APPROVAL_A, homologation: true }, ADMIN);
    expect(r.status).toBe('INCONCLUSIVE');
  });
});

describe('CENARIO B: compare_vsi_endpoints', () => {
  const outputs = {
    'h-a': { 'display version': S.NE_VERSION, 'display vsi name SVC-50-502 verbose': S.SCEN_B_VSI_A, 'display current-configuration interface GigabitEthernet2/0/1.50': S.SCEN_B_CFG_A, 'display mac-address vsi SVC-50-502': S.MAC_SCEN_B_A },
    'h-b': { 'display version': S.NE_VERSION, 'display vsi name SVC-50-502 verbose': S.SCEN_B_VSI_B, 'display current-configuration interface GigabitEthernet3/0/2.502': S.SCEN_B_CFG_B, 'display mac-address vsi SVC-50-502': S.MAC_EMPTY },
  };
  const endpoint = (hostId: string, approvalId: string, peerAddress: string) => ({ hostId, vsiName: 'SVC-50-502', approvalId, peerAddress });

  it('consome uma aprovacao por ponta e devolve hipotese (nao causa confirmada)', async () => {
    const { collector, sessions } = fakeCollector(outputs);
    const { tools, consumeApproval } = build({ live: collector });
    const r = await tools.call('compare_vsi_endpoints', { a: endpoint('h-a', APPROVAL_A, '10.0.0.9'), b: endpoint('h-b', APPROVAL_B, '10.0.0.1'), homologation: true }, ADMIN);
    expect(consumeApproval).toHaveBeenCalledTimes(2);
    expect(new Set(sessions.map((s) => s.hostId))).toEqual(new Set(['h-a', 'h-b']));
    const cmp = j(r.data).comparison;
    const f = cmp.findings.find((x: { code: string }) => x.code === 'VLAN_TRANSFORM_ASYMMETRIC');
    expect(f.impactCertainty).toBe('HYPOTHESIS');
    expect(cmp.trafficObservation.lastObservedStage).toBe('A_PW');
    expect(JSON.stringify(r)).not.toMatch(/causa raiz confirmada|root cause confirmed/i);
  });

  it('uma ponta falha => INCONCLUSIVE com erro explicito por host', async () => {
    const { collector } = fakeCollector({ 'h-a': outputs['h-a'] });
    const failing: VsiMcpLiveCollector = { collect: (h, o, opts) => (h.id === 'h-b' ? Promise.reject(new VsiMcpLiveError('SSH_FAILED', 'timeout')) : collector.collect(h, o, opts)) };
    const { tools } = build({ live: failing });
    const r = await tools.call('compare_vsi_endpoints', { a: endpoint('h-a', APPROVAL_A, '10.0.0.9'), b: endpoint('h-b', APPROVAL_B, '10.0.0.1'), homologation: true }, ADMIN);
    expect(r.status).toBe('INCONCLUSIVE');
    expect(r.errors).toEqual([expect.objectContaining({ code: 'SSH_FAILED', hostId: 'h-b' })]);
  });
});

/* ------------------------------------------------------------------------ */
describe('SshVsiMcpLiveCollector (coletor real, cliente SSH falso)', () => {
  const profile = (over: Partial<VsiMcpAccessProfile> = {}): VsiMcpAccessProfile =>
    vsiMcpProfileSchema.parse({
      hostId: 'h-a', endpoint: '10.100.1.1', port: 2222, username: 'svc', context: null,
      fingerprint: 'SHA256:' + 'A'.repeat(43), initialPrompt: '<PE-A>', expectedPrompt: '<PE-A>', vendor: 'HUAWEI',
      family: 'NE8000_V800', disablePagingTemporary: true,
      validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      operations: ['VERSION', 'VSI_VERBOSE', 'VSI_MAC', 'INTERFACE_CONFIG', 'INTERFACE_STATE', 'VSI_LIST'], ...over,
    });

  function make(outputs: Record<string, string>, p = profile()) {
    const executed: string[][] = [];
    const hosts = { getHost: async () => host('h-a', 'PE-A'), getDecryptedSshCredentials: async () => ({ username: 'svc', password: 'S3cr3t!' }) };
    const collector = new SshVsiMcpLiveCollector(hosts as unknown as Hosts, testBroker(hosts as never, [p]), (opts) => ({
      async execute(_h: string, commands: string[]) {
        const d = opts.diagnostic!;
        executed.push([...commands]);
        const seq = [d.sessionPreparation!, ...(opts.contextCommand ? [opts.contextCommand] : []), ...commands];
        for (const c of seq) {
          d.onCommand(c);
          d.onCommandComplete?.({ command: c, stdout: outputs[c] ?? `<PE-A>${c}\n<PE-A>`, completedAt: '2026-11-09T12:00:00.000Z' });
        }
        return [{ stdout: '', stderr: '', exitCode: 0 }];
      },
    }));
    return { collector, executed };
  }
  const run = (c: SshVsiMcpLiveCollector, ops: VsiMcpOperation[], homologation = true) =>
    c.collect(host('h-a', 'PE-A'), ops, { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X', homologation });

  it('envia somente display, version primeiro, uma unica sessao', async () => {
    const { collector, executed } = make({ 'display version': S.NE_VERSION, 'display vsi name X verbose': S.SCEN_A_VSI.replace(/L2-PPPOE-3901/g, 'X') });
    const r = await run(collector, [{ kind: 'VSI_VERBOSE', vsiName: 'X' }]);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual(['display version', 'display vsi name X verbose']);
    for (const c of executed[0]!) expect(c).toMatch(/^display /);
    expect(r.captures.map((c) => c.command)).toEqual(['display version', 'display vsi name X verbose']);
    expect(r.captures[1]!.complete).toBe(true);
  });

  it('senha nunca aparece na saida', async () => {
    const { collector } = make({ 'display version': S.NE_VERSION + '\nS3cr3t! leaked', 'display vsi name X verbose': '<PE-A>x\n<PE-A>' });
    const r = await run(collector, [{ kind: 'VSI_VERBOSE', vsiName: 'X' }]);
    expect(JSON.stringify(r)).not.toContain('S3cr3t!');
  });

  it('familia declarada diferente da detectada => PLATFORM_MISMATCH', async () => {
    const { collector } = make({ 'display version': S.NE_VERSION }, profile({ family: 'NE40E_V800' }));
    await expect(run(collector, [{ kind: 'VSI_VERBOSE', vsiName: 'X' }])).rejects.toMatchObject({ code: 'PLATFORM_MISMATCH' });
  });

  it('comando candidato sem homologacao e descartado ANTES de conectar', async () => {
    const { collector, executed } = make({ 'display version': S.NE_VERSION });
    const r = await run(collector, [{ kind: 'VSI_MAC', vsiName: 'X' }], false);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'CANDIDATE_NOT_HOMOLOGATED' })]);
    expect(executed[0]).toEqual(['display version']);
  });

  it('operacao fora do perfil => bloqueada sem conexao', async () => {
    const { collector, executed } = make({}, profile({ operations: ['VERSION', 'VSI_VERBOSE'] }));
    await expect(run(collector, [{ kind: 'INTERFACE_CONFIG', interfaceName: 'GigabitEthernet1/0/1' }])).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    expect(executed).toHaveLength(0);
  });

  it('perfil nao corresponde ao SSH do inventario => bloqueado', () => {
    const h = host('h-a', 'PE-A');
    expect(() => matchVsiMcpProfile([profile({ endpoint: '10.9.9.9' })], h, ['VERSION'])).toThrow(/nao corresponde/);
    expect(() => matchVsiMcpProfile([profile({ expiresAt: '2020-01-01T00:00:00.000Z' })], h, ['VERSION'])).toThrow(/sem perfil/i);
    expect(() => matchVsiMcpProfile([profile({ context: 'switch virtual-system X' })], h, ['VERSION'])).toThrow(/nao corresponde/);
  });

  it('virtual-system: contexto entra na sequencia e e aceito', async () => {
    const p = profile({ context: 'switch virtual-system IMPLANTAR-IXBR' });
    const h = { ...host('h-a', 'PE-A'), ssh: { ...host('h-a', 'PE-A').ssh!, contextCommand: 'switch virtual-system IMPLANTAR-IXBR' } } as HostRecord;
    const executed: string[][] = [];
    const collector = new SshVsiMcpLiveCollector({ getHost: async () => h } as unknown as Hosts, testBroker({ getHost: async () => h, getDecryptedSshCredentials: async () => ({ password: 'pw' }) }, [p]), (opts) => ({
      async execute(_x: string, commands: string[]) {
        executed.push([...commands]);
        const d = opts.diagnostic!;
        for (const c of [d.sessionPreparation!, opts.contextCommand!, ...commands]) {
          d.onCommand(c);
          d.onCommandComplete?.({ command: c, stdout: c === 'display version' ? S.NE_VERSION : `<PE-A>${c}\n<PE-A>`, completedAt: '2026-11-09T12:00:00.000Z' });
        }
        return [{ stdout: '', stderr: '', exitCode: 0 }];
      },
    }));
    const r = await collector.collect(h, [], { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X' });
    expect(r.captures.map((c) => c.command)).toEqual(['display version']);
  });

  it('segunda sessao no mesmo host em paralelo => BUSY', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = profile();
    const collector = new SshVsiMcpLiveCollector({ getHost: async () => host('h-a', 'PE-A') } as unknown as Hosts, testBroker({ getHost: async () => host('h-a', 'PE-A'), getDecryptedSshCredentials: async () => ({ password: 'pw' }) }, [p]), (opts) => ({
      async execute(_x: string, commands: string[]) {
        const d = opts.diagnostic!;
        for (const c of [d.sessionPreparation!, ...commands]) { d.onCommand(c); if (c === 'display version') await gate; d.onCommandComplete?.({ command: c, stdout: c === 'display version' ? S.NE_VERSION : `<PE-A>${c}\n<PE-A>`, completedAt: '2026-11-09T12:00:00.000Z' }); }
        return [{ stdout: '', stderr: '', exitCode: 0 }];
      },
    }));
    const first = collector.collect(host('h-a', 'PE-A'), [], { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X' });
    await new Promise((r) => setTimeout(r, 20));
    await expect(collector.collect(host('h-a', 'PE-A'), [], { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X' })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await expect(first).resolves.toBeTruthy();
  });
});

describe('invariante de seguranca', () => {
  it('nenhuma ferramenta aceita campo que vire comando', () => {
    const forbidden = /^(command|commands|cmd|raw|script|shell|args|expression)$/i;
    for (const [name, schema] of Object.entries(VSI_MCP_TOOLS)) {
      const keys = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
      expect(keys.filter((k) => forbidden.test(k)), name).toEqual([]);
    }
  });
  it('compare tambem rejeita "command" dentro de cada ponta', () => {
    const ok = { hostId: 'h-a', vsiName: 'X', approvalId: APPROVAL_A };
    const b = { hostId: 'h-b', vsiName: 'X', approvalId: APPROVAL_B };
    expect(VSI_MCP_TOOLS.compare_vsi_endpoints.safeParse({ a: ok, b }).success).toBe(true);
    expect(VSI_MCP_TOOLS.compare_vsi_endpoints.safeParse({ a: { ...ok, command: 'reboot' }, b }).success).toBe(false);
  });
});
