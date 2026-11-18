import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VSI_CLAUSE_CODES, vsiEndpointEvidenceState, type MplsVsi, type VsiServiceDiagnosis } from '@gmj/shared';
import { VsiMcpTools, VsiMcpToolError } from '../vsi-mcp/tools';
import { fakeCollector, host } from '../vsi-mcp/__fixtures__/harness';
import { CDB, CDB_RECORDINGS, CDB_VSI, VTA_MCP_AT, VTA_MCP_RECORDINGS, cdbHost, cdbInventory, replayCollector } from './__fixtures__/replay';
import { aggregateVsiService } from './aggregator';
import { VsiServiceDiagnosticService, VsiServiceError } from './service';

const ADMIN = { id: 'u1', username: 'admin', role: 'ADMIN' } as const;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-16T14:00:00.000Z';

/**
 * REPLAY da VSI 3072: motor VSI/MCP REAL (politica de comandos, parsers, correlator) + agregador,
 * alimentados pelas capturas reais de 16/11 em vez de SSH. Nenhum equipamento e acessado.
 */
function cdbService(consumeApproval = vi.fn()) {
  const { collector, sessions } = replayCollector(CDB_RECORDINGS, { family: 'S6730_V200', completedAt: AT });
  const tools = new VsiMcpTools({
    hosts: { getHost: async (id) => cdbHost(id) },
    mpls: { listVsis: async (id) => cdbInventory(id) },
    live: collector,
    consumeApproval,
    audit: vi.fn(),
    now: () => new Date(AT),
  });
  const service = new VsiServiceDiagnosticService({
    hosts: { getHost: async (id) => cdbHost(id) },
    mpls: { listVsis: async (id) => cdbInventory(id) },
    tools,
    engineVersion: 'replay',
    now: () => new Date(AT),
    newRunId: () => '33333333-3333-4333-8333-333333333333',
  });
  return { service, sessions, consumeApproval };
}
const cdbRequest = {
  vsiName: CDB_VSI,
  includeMac: false,
  homologation: true,
  endpoints: [
    { hostId: CDB.likee, approvalId: A, carrierInterfaces: ['Eth-Trunk17'], eTrunkIds: [4] },
    { hostId: CDB.vta, approvalId: B, carrierInterfaces: ['Eth-Trunk26'], eTrunkIds: [4] },
  ],
};

const REPLAY_JSON = join(__dirname, '..', '..', '..', '..', '..', 'web', 'src', 'components', 'diagnostics', 'service', 'fixtures', 'engine-replay-3072.json');
const withProvenance = (d: VsiServiceDiagnosis): VsiServiceDiagnosis => ({
  ...d,
  origin: 'REPLAY',
  demonstration: {
    label: 'Replay em DEV',
    provenance:
      'Resposta do motor VSI/MCP e do agregador, gerada em teste a partir das capturas reais de 16/11/2026 (E-Trunk, LACP, configuração dos trunks) e do inventário SNMP. Nenhum SSH foi aberto. Comandos sem captura gravada (display vsi, configuração das subinterfaces) aparecem como saída incompleta. O horário das evidências é o do replay, não o da captura original.',
  },
});

describe('VSI 3072 por servico — replay das capturas reais', () => {
  it('a resposta publicada para o frontend e exatamente a que o codigo produz (golden)', async () => {
    const { service } = cdbService();
    const d = withProvenance(JSON.parse(JSON.stringify(await service.run(cdbRequest, ADMIN))));
    if (process.env.UPDATE_VSI_SERVICE_REPLAY === '1') {
      mkdirSync(dirname(REPLAY_JSON), { recursive: true });
      writeFileSync(REPLAY_JSON, `${JSON.stringify(d, null, 2)}\n`);
    }
    expect(d).toEqual(JSON.parse(readFileSync(REPLAY_JSON, 'utf8')));
  });

  it('uma aprovacao por PE, so comandos da allowlist, MQT nao recebe nenhum comando', async () => {
    const { service, sessions, consumeApproval } = cdbService();
    await service.run(cdbRequest, ADMIN);
    expect(consumeApproval.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [A, CDB.likee, `vsi-name:${CDB_VSI}`],
      [B, CDB.vta, `vsi-name:${CDB_VSI}`],
    ]);
    expect(new Set(sessions.map((s) => s.hostId))).toEqual(new Set([CDB.likee, CDB.vta]));
    for (const s of sessions) for (const c of s.commands) expect(c).toMatch(/^display /);
  });

  it('os 3 participantes aparecem; MQT descoberto pelo PW do inventario e marcado como nao lido', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    expect(d.endpoints.map((e) => [e.hostName, e.discoveredBy, e.collection])).toEqual([
      ['BHE-LIKEE-6730-MPLS-01', 'REQUESTED', 'PARTIAL'],
      ['BHE-VTA-6730-MPLS-01', 'REQUESTED', 'PARTIAL'],
      ['BHE-MQT-6730-MPLS-01', 'PW_PEER', 'NOT_READ'],
    ]);
    expect(d.endpoints[2]!.vsi).toMatchObject({ value: null, basis: 'NOT_READ', inventoryHint: { value: { state: 'UP' } } });
  });

  it('E-Trunk MASTER lido nao vira servico saudavel: veredito INCONCLUSIVO, servico nao confirmado', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const likee = d.endpoints[0]!;
    expect(likee.eTrunks[0]).toMatchObject({ id: 4, state: { value: 'MASTER', basis: 'LIVE_SSH' } });
    expect(likee.ethTrunks[0]).toMatchObject({ name: 'Eth-Trunk17', operStatus: { value: 'UP' }, selected: 1, eTrunkId: 4, remoteEthTrunkId: 26 });
    expect(likee.serviceState).toBe('NOT_CONFIRMED');
    expect(d.verdict.status).toBe('INCONCLUSIVE');
    expect(d.axes.service.state).toBe('NOT_CONFIRMED');
    expect(d.endpoints.every((e) => e.vsi.value === null)).toBe(true);
  });

  it('BACKUP lido nao gera falso CRITICAL; sem a VSI o motor nao atribui papel e a tela diz isso', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const vta = d.endpoints[1]!;
    expect(vta.eTrunks[0]).toMatchObject({ state: { value: 'BACKUP' }, causation: 'PRI', priority: 30, peerPriority: 20 });
    expect(vta.ethTrunks[0]).toMatchObject({ name: 'Eth-Trunk26', operStatus: { value: 'DOWN' }, selected: 0, memberCausation: 'PEER_MEMBER_UP', remoteEthTrunkId: 17 });
    expect(d.findings.filter((f) => f.severity === 'CRITICAL' || f.kind === 'FAILURE')).toEqual([]);
    expect(vta.accessRole).toBe('ROLE_UNKNOWN');
    expect(d.axes.redundancy).toMatchObject({ state: 'NOT_CONFIRMED', clause: { code: 'REDUNDANCY_ROLE_NOT_ASSIGNED' } });
  });

  it('os quatro estados coexistem: E-Trunk com evidencia, LACP, servico nao confirmado e papel ROLE_UNKNOWN', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const [likee, vta, mqt] = d.endpoints;
    const evidence = (id: string | null) => d.evidence.find((e) => e.id === id);
    // 1. E-Trunk 4: Master no LIKEE, Backup no VTA, cada um apontando para a saida que o comprova
    expect(likee!.eTrunks[0]).toMatchObject({ id: 4, state: { value: 'MASTER', basis: 'LIVE_SSH' } });
    expect(vta!.eTrunks[0]).toMatchObject({ id: 4, state: { value: 'BACKUP', basis: 'LIVE_SSH' } });
    expect(evidence(likee!.eTrunks[0]!.state.evidenceId)).toMatchObject({ command: 'display e-trunk brief', complete: true, hostName: 'BHE-LIKEE-6730-MPLS-01' });
    expect(evidence(vta!.eTrunks[0]!.state.evidenceId)).toMatchObject({ command: 'display e-trunk 4', complete: true, hostName: 'BHE-VTA-6730-MPLS-01' });
    // 2. LACP: Selected no LIKEE, Unselect no VTA
    expect(likee!.ethTrunks[0]).toMatchObject({ workingMode: 'LACP', selected: 1, members: [{ port: 'XGigabitEthernet0/0/3', status: 'SELECTED' }] });
    expect(vta!.ethTrunks[0]).toMatchObject({ workingMode: 'LACP', selected: 0, members: [{ port: 'XGigabitEthernet0/0/48', status: 'UNSELECTED' }] });
    expect(evidence(likee!.ethTrunks[0]!.operStatus.evidenceId)!.command).toBe('display eth-trunk 17');
    expect(evidence(vta!.ethTrunks[0]!.operStatus.evidenceId)!.command).toBe('display eth-trunk 26');
    // 3. VSI, AC e PW: nao confirmados em nenhum PE (so dica do inventario)
    for (const e of [likee!, vta!, mqt!]) {
      expect(e.vsi.value).toBeNull();
      expect(e.serviceState).toBe('NOT_CONFIRMED');
      expect(e.acs.every((a) => a.state.value === null)).toBe(true);
      expect(e.pws.every((p) => p.state.value === null)).toBe(true);
    }
    // 4. papel da ponta: ROLE_UNKNOWN ate a correlacao completa; trunks idem; MQT (nada lido) sem papel
    expect([likee!.accessRole, vta!.accessRole, mqt!.accessRole]).toEqual(['ROLE_UNKNOWN', 'ROLE_UNKNOWN', null]);
    expect([likee!.ethTrunks[0]!.role, vta!.ethTrunks[0]!.role]).toEqual(['ROLE_UNKNOWN', 'ROLE_UNKNOWN']);
    expect(likee!.missingEvidence.join(' ')).toContain('display vsi name');
    // e nada disso vira servico saudavel
    expect(d.verdict.status).toBe('INCONCLUSIVE');
    expect(d.axes.redundancy.state).toBe('NOT_CONFIRMED');
    expect(d.axes.service.state).toBe('NOT_CONFIRMED');
  });

  it('falha de coleta e achado de COLETA, com a evidencia, e nunca falha da VSI', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const collect = d.findings.filter((f) => f.kind === 'COLLECTION');
    expect(collect.length).toBeGreaterThan(0);
    const truncated = collect.find((f) => f.hostName === 'BHE-VTA-6730-MPLS-01' && f.title.endsWith('interface Eth-Trunk26'));
    expect(truncated).toMatchObject({ code: 'COLLECTION_OUTPUT_INCOMPLETE', component: 'COLLECTION', severity: 'INFO' });
    expect(d.evidence.find((e) => e.id === truncated!.evidenceIds[0])).toMatchObject({ complete: false, command: 'display current-configuration interface Eth-Trunk26' });
    expect(d.findings.some((f) => f.code === 'VSI_DOWN' || f.code === 'AC_DOWN' || f.code === 'PW_DOWN')).toBe(false);
    for (const e of d.endpoints.slice(0, 2)) expect(e.vsi.basis).toBe('COLLECTION_FAILED');
  });

  it('PW antigo do inventario fica OBSOLETO e nao conta como up; inventario nunca vira leitura atual', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const pw = d.endpoints[1]!.pws[0]!;
    expect(pw).toMatchObject({ peerAddress: '10.100.101.2', stale: true, state: { value: null, inventoryHint: { value: 'UP', stale: true } } });
    expect(d.links.find((l) => l.aHostId === CDB.vta)).toMatchObject({ state: 'STALE' });
    expect(d.readings.filter((r) => r.kind === 'SNMP_CYCLE').every((r) => r.inThisRun === false)).toBe(true);
    expect(d.readings.filter((r) => r.kind === 'SSH_SESSION').map((r) => [r.hostName, r.inThisRun, r.outcome])).toEqual([
      ['BHE-LIKEE-6730-MPLS-01', true, 'PARTIAL'],
      ['BHE-VTA-6730-MPLS-01', true, 'PARTIAL'],
    ]);
  });

  it('rastreavel: execucao, motor, origem, e toda referencia aponta para evidencia existente', async () => {
    const { service } = cdbService();
    const d = await service.run(cdbRequest, ADMIN);
    expect(d).toMatchObject({ schemaVersion: 1, engine: 'VSI_MCP', engineVersion: 'replay', origin: 'ENGINE_RUN', runId: '33333333-3333-4333-8333-333333333333', operator: { username: 'admin', role: 'ADMIN' }, startedAt: AT, completedAt: AT });
    expect(service.get(d.runId)).toBe(d);
    const ids = new Set(d.evidence.map((e) => e.id));
    for (const f of d.findings) for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
    for (const c of [...d.verdict.clauses, ...Object.values(d.axes).map((a) => a.clause)]) expect(VSI_CLAUSE_CODES).toContain(c.code);
    expect(d.connectivity).toEqual({ evaluated: false, underlayClassification: null, probes: [] });
  });

  it('nenhuma resposta carrega credencial: so comando, saida e metadados', async () => {
    const d = await cdbService().service.run(cdbRequest, ADMIN);
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/password|passwd|secret|credential|private.key|svc"/i);
    expect(text).not.toContain('192.0.2.1'); // endereco de gerencia/SSH do host nao sai na resposta
  });
});

describe('servico — autorizacao e limites', () => {
  it('PE sem approvalId nao e lido e continua visivel', async () => {
    const { service, sessions } = cdbService();
    const d = await service.run({ ...cdbRequest, endpoints: [cdbRequest.endpoints[0]!, { hostId: CDB.vta }] }, ADMIN);
    expect(sessions.map((s) => s.hostId)).not.toContain(CDB.vta);
    expect(d.endpoints[1]).toMatchObject({ hostName: 'BHE-VTA-6730-MPLS-01', collection: 'NOT_READ', eTrunks: [], vsi: { basis: 'NOT_READ' } });
    expect(d.findings.some((f) => f.code === 'ENDPOINT_SERVICE_NOT_READ' && f.hostId === CDB.vta)).toBe(true);
  });

  it('aprovacao recusada em um PE vira achado de coleta nesse PE; os demais seguem', async () => {
    const consume = vi.fn((_id: string | undefined, hostId: string) => {
      if (hostId === CDB.vta) throw Object.assign(new Error('Aprovação expirada'), { statusCode: 423 });
    });
    const d = await cdbService(consume).service.run(cdbRequest, ADMIN);
    expect(d.endpoints[1]!.collection).toBe('NOT_AUTHORIZED');
    expect(d.findings.find((f) => f.code === 'COLLECTION_NOT_AUTHORIZED')).toMatchObject({ kind: 'COLLECTION', hostId: CDB.vta });
    expect(d.endpoints[0]!.eTrunks).toHaveLength(1);
    expect(d.findings.filter((f) => f.kind === 'FAILURE')).toEqual([]);
  });

  it('VIEWER nao executa; pedido vazio, repetido ou com host inexistente e recusado', async () => {
    const { service } = cdbService();
    await expect(service.run(cdbRequest, { id: 'v', username: 'viewer', role: 'VIEWER' } as never)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(service.run({ vsiName: CDB_VSI, endpoints: [] }, ADMIN)).rejects.toBeInstanceOf(VsiServiceError);
    await expect(service.run({ vsiName: CDB_VSI, endpoints: [{ hostId: CDB.likee }, { hostId: CDB.likee }] }, ADMIN)).rejects.toMatchObject({ code: 'DUPLICATE_ENDPOINT' });
    await expect(service.run({ vsiName: CDB_VSI, endpoints: [{ hostId: 'nao-existe' }] }, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
    expect(() => service.get('44444444-4444-4444-8444-444444444444')).toThrow(VsiServiceError);
    expect(VsiMcpToolError).toBeDefined();
  });
});

/* Caso combinado, vindo do MOTOR: um PE com E-Trunk Master e servico up, outro com VSI down sem evidencia de standby. */
describe('servico — falha real nao e suprimida pela redundancia do outro PE', () => {
  const vsiOut = (name: string, state: 'up' | 'down', ac: string) => `<${name}>display vsi name ${CDB_VSI} verbose

 ***VSI Name               : ${CDB_VSI}
    Administrator VSI      : no
    PW Signaling           : bgp
    Encapsulation Type     : vlan
    MTU                    : 2000
    VSI State              : ${state}

    BGP RD                 : 268568:53072

    Interface Name         : ${ac}
    State                  : ${state}
    Access Port            : false

  **PW Information:

   *Peer Ip Address        : 10.100.101.2
    PW State               : ${state}
    Local VC Label         : 36706
    Remote VC Label        : 35842
    PW Type                : label
    Tunnel ID              : 0x1
<${name}>`;

  it('VSI down no VTA continua CRITICA e o veredito e FALHA, mesmo com o LIKEE em Master e servico up', async () => {
    const recordings = {
      [CDB.likee]: { ...CDB_RECORDINGS[CDB.likee]!, [`display vsi name ${CDB_VSI} verbose`]: vsiOut('BHE-LIKEE-6730-MPLS-01', 'up', 'Eth-Trunk17.3072') },
      // VTA: VSI down lida, SEM pedir E-Trunk/LACP -> nada comprova que seja o lado reserva
      [CDB.vta]: { [`display vsi name ${CDB_VSI} verbose`]: vsiOut('BHE-VTA-6730-MPLS-01', 'down', 'Eth-Trunk26.3072') },
    };
    const { collector } = replayCollector(recordings, { family: 'S6730_V200', completedAt: AT });
    const deps = { hosts: { getHost: async (id: string) => cdbHost(id) }, mpls: { listVsis: async (id: string) => cdbInventory(id) } };
    const tools = new VsiMcpTools({ ...deps, live: collector, consumeApproval: vi.fn(), audit: vi.fn(), now: () => new Date(AT) });
    const service = new VsiServiceDiagnosticService({ ...deps, tools, engineVersion: 'test', now: () => new Date(AT) });
    const d = await service.run(
      { vsiName: CDB_VSI, includeMac: false, homologation: true, endpoints: [{ hostId: CDB.likee, approvalId: A, carrierInterfaces: ['Eth-Trunk17'], eTrunkIds: [4] }, { hostId: CDB.vta, approvalId: B }] },
      ADMIN,
    );
    const [likee, vta] = d.endpoints;
    expect(likee!.eTrunks[0]!.state.value).toBe('MASTER');
    expect(likee!.vsi.value).toMatchObject({ state: 'UP' });
    expect(vta!.vsi).toMatchObject({ value: { state: 'DOWN' }, basis: 'LIVE_SSH', freshness: 'CURRENT' });
    expect(vta!.serviceState).toBe('ISSUE');
    const critical = d.findings.filter((f) => f.hostId === CDB.vta && f.kind === 'FAILURE');
    expect(critical.map((f) => f.code)).toEqual(expect.arrayContaining(['VSI_DOWN', 'AC_DOWN']));
    expect(critical.every((f) => f.severity === 'CRITICAL' && f.origin === 'ENGINE' && f.evidenceIds.length > 0)).toBe(true);
    expect(d.verdict.status).toBe('FAILED');
    expect(d.axes.service.state).toBe('ISSUE');
    // nenhum achado de standby foi criado para "explicar" a falha
    expect(d.findings.filter((f) => f.hostId === CDB.vta && f.kind === 'STANDBY_EXPECTED')).toEqual([]);
  });
});

/* Regressao: com a VSI lida, os papeis e a severidade sao os do motor (texto SINTETICO no layout do S6730). */
describe('servico — VSI lida (saida sintetica), papeis e severidade do motor preservados', () => {
  const QINQ = CDB_VSI;
  const vsiText = (hostName: string, state: 'up' | 'down', ac: string, pw: boolean) => `<${hostName}>display vsi name ${QINQ} verbose

 ***VSI Name               : ${QINQ}
    Administrator VSI      : no
    PW Signaling           : bgp
    Encapsulation Type     : vlan
    MTU                    : 2000
    VSI State              : ${state}

    BGP RD                 : 268568:53072

    Interface Name         : ${ac}
    State                  : ${state}
    Access Port            : false
${pw ? `
  **PW Information:

   *Peer Ip Address        : 10.100.101.2
    PW State               : up
    Local VC Label         : 36706
    Remote VC Label        : 35842
    PW Type                : label
    Tunnel ID              : 0x1
` : ''}<${hostName}>`;

  /** O coletor de teste carimba as capturas em 2026-11-09T12:00Z; `now` define a idade delas. */
  const FRESH = '2026-11-09T12:00:30.000Z';
  function run(vtaETrunk: boolean, nowIso = FRESH) {
    const AT = nowIso;
    const recordings = {
      'h-a': { ...CDB_RECORDINGS[CDB.vta]!, [`display vsi name ${QINQ} verbose`]: vsiText('PE-A', 'down', 'Eth-Trunk26.3072', false) },
    };
    const { collector } = fakeCollector(recordings, 'S6730_V200');
    const inventory = (): MplsVsi[] => cdbInventory(CDB.vta).map((v) => ({ ...v, hostId: 'h-a', pws: v.pws.map((p) => ({ ...p, remoteHostId: null })) }));
    const tools = new VsiMcpTools({ hosts: { getHost: async (id) => (id === 'h-a' ? host('h-a', 'PE-A') : null) }, mpls: { listVsis: async () => inventory() }, live: collector, consumeApproval: vi.fn(), audit: vi.fn(), now: () => new Date(AT) });
    const service = new VsiServiceDiagnosticService({ hosts: { getHost: async (id) => (id === 'h-a' ? host('h-a', 'PE-A') : null) }, mpls: { listVsis: async () => inventory() }, tools, engineVersion: 'test', now: () => new Date(AT) });
    return service.run({ vsiName: QINQ, includeMac: false, homologation: true, endpoints: [{ hostId: 'h-a', approvalId: A, ...(vtaETrunk ? { carrierInterfaces: ['Eth-Trunk26'], eTrunkIds: [4] } : {}) }] }, ADMIN);
  }

  it('VSI down com Backup comprovado: STANDBY_EXPECTED, sem CRITICAL, estado "down esperado"', async () => {
    const d = await run(true);
    const e = d.endpoints[0]!;
    expect(e.accessRole).toBe('STANDBY_EXPECTED');
    expect(e.serviceState).toBe('EXPECTED_DOWN');
    expect(e.vsi).toMatchObject({ value: { state: 'DOWN' }, basis: 'LIVE_SSH', freshness: 'CURRENT' });
    expect(d.findings.filter((f) => f.kind === 'FAILURE')).toEqual([]);
    expect(d.findings.filter((f) => f.kind === 'STANDBY_EXPECTED').map((f) => f.code)).toEqual(expect.arrayContaining(['VSI_DOWN_STANDBY_EXPECTED', 'STANDBY_PATH_IDLE']));
    // o peer do PW do inventario, sem host conhecido, continua visivel como participante nao lido
    expect(d.endpoints[1]).toMatchObject({ hostId: null, hostName: '10.100.101.2', collection: 'NOT_READ' });
    expect(d.verdict.status).toBe('INCONCLUSIVE');
  });

  it('leitura antiga nunca e tratada como atual: a mesma captura, vista 7 dias depois, fica ANTIGA', async () => {
    const d = await run(true, '2026-11-16T14:00:00.000Z');
    expect(d.endpoints[0]!.vsi).toMatchObject({ value: { state: 'DOWN' }, basis: 'LIVE_SSH', freshness: 'STALE' });
    expect(d.endpoints[0]!.serviceState).toBe('STALE');
    expect(d.endpoints[0]!.eTrunks[0]!.state.freshness).toBe('STALE');
    expect(d.axes.redundancy.state).not.toBe('PROVEN_OK');
    expect(d.axes.service.state).not.toBe('PROVEN_OK');
    expect(d.verdict.status).not.toBe('OK');
  });

  it('a MESMA VSI down sem evidencia de redundancia continua FALHA critica', async () => {
    const d = await run(false);
    expect(d.endpoints[0]!.accessRole).toBeNull();
    expect(d.endpoints[0]!.serviceState).toBe('ISSUE');
    expect(d.findings.filter((f) => f.kind === 'FAILURE').map((f) => f.code)).toEqual(expect.arrayContaining(['VSI_DOWN', 'AC_DOWN']));
    expect(d.verdict.status).toBe('FAILED');
    expect(d.axes.service.state).toBe('ISSUE');
  });
});

/* ------------------------------------------------------------------ */
/* Sessao REAL do VTA-01 pelo fluxo MCP (2026-11-16T19:37Z), em replay  */
/* ------------------------------------------------------------------ */
describe('VSI 3072 — VTA-01 lido por inteiro (Backup): coleta, evidencia e servico sao tres coisas', () => {
  const VTA_JSON = join(dirname(REPLAY_JSON), 'engine-replay-3072-vta-mcp.json');
  const vtaService = () => {
    const { collector, sessions } = replayCollector(VTA_MCP_RECORDINGS, { family: 'S6730_V200', completedAt: VTA_MCP_AT, release: 'V200R022C00SPC500' });
    const deps = { hosts: { getHost: async (id: string) => cdbHost(id) }, mpls: { listVsis: async (id: string) => cdbInventory(id) } };
    const tools = new VsiMcpTools({ ...deps, live: collector, consumeApproval: vi.fn(), audit: vi.fn(), now: () => new Date(VTA_MCP_AT) });
    const service = new VsiServiceDiagnosticService({ ...deps, tools, engineVersion: 'replay', now: () => new Date(VTA_MCP_AT), newRunId: () => '44444444-4444-4444-8444-444444444444' });
    return { service, sessions };
  };
  const request = { vsiName: CDB_VSI, includeMac: false, homologation: true, endpoints: [{ hostId: CDB.vta, approvalId: B, carrierInterfaces: ['Eth-Trunk26'], eTrunkIds: [4] }] };
  const run = async () => (await vtaService().service.run(request, ADMIN)) as VsiServiceDiagnosis;

  it('golden consumido pela pre-visualizacao', async () => {
    const d: VsiServiceDiagnosis = {
      ...(JSON.parse(JSON.stringify(await run())) as VsiServiceDiagnosis),
      origin: 'REPLAY',
      demonstration: {
        label: 'Replay em DEV',
        provenance:
          'Resposta do motor VSI/MCP e do agregador sobre a sessão real do BHE-VTA-6730-MPLS-01 de 16/11/2026 19:37Z (7 comandos display, uma sessão), reproduzida em teste. Nenhum SSH foi aberto no replay. Os demais PEs não foram lidos.',
      },
    };
    if (process.env.UPDATE_VSI_SERVICE_REPLAY === '1') writeFileSync(VTA_JSON, `${JSON.stringify(d, null, 2)}\n`);
    expect(d).toEqual(JSON.parse(readFileSync(VTA_JSON, 'utf8')));
  });

  it('coleta COMPLETA, evidencia SUFICIENTE, servico DOWN ESPERADO — sem pedir nova leitura do VTA', async () => {
    const d = await run();
    const vta = d.endpoints.find((e) => e.hostName === 'BHE-VTA-6730-MPLS-01')!;
    expect(vta.collection).toBe('READ');
    expect(vsiEndpointEvidenceState(vta)).toBe('SUFFICIENT');
    expect(vta.serviceState).toBe('EXPECTED_DOWN');
    expect(vta.accessRole).toBe('STANDBY_EXPECTED');
    expect(vta.missingEvidence).toEqual([]);
    expect(vta.notAssessed?.join(' ')).toMatch(/estado da VSI.*standby comprovado/);
    expect(d.nextSteps.some((s) => s.hostName === vta.hostName)).toBe(false);
    expect(d.readings.find((r) => r.kind === 'SSH_SESSION')).toMatchObject({ hostName: vta.hostName, outcome: 'OK' });
    expect(d.findings.filter((f) => f.kind === 'COLLECTION')).toEqual([]);
    expect(d.findings.map((f) => f.code)).not.toContain('ENCAPSULATION_NOT_EVALUATED');
  });

  it('Backup lido por inteiro NAO torna o servico saudavel: veredito segue inconclusivo e pede o Master', async () => {
    const d = await run();
    expect(d.verdict.status).toBe('INCONCLUSIVE');
    expect(d.axes.service.state).toBe('NOT_CONFIRMED');
    expect(d.axes.redundancy.clause.code).toBe('REDUNDANCY_NO_ACTIVE_PATH');
    const others = d.endpoints.filter((e) => e.hostName !== 'BHE-VTA-6730-MPLS-01');
    expect(others.length).toBeGreaterThan(0);
    for (const e of others) {
      expect(e.collection).toBe('NOT_READ');
      expect(vsiEndpointEvidenceState(e)).toBe('NONE');
      expect(d.nextSteps.some((s) => s.hostName === e.hostName)).toBe(true);
    }
  });

  it('status INCONCLUSIVE do motor nao rebaixa uma coleta inteira; comando incompleto rebaixa', async () => {
    const base = { runId: 'r', engineVersion: 't', origin: 'REPLAY' as const, vsiName: CDB_VSI, operator: null, startedAt: VTA_MCP_AT, completedAt: VTA_MCP_AT };
    const { collector } = replayCollector(VTA_MCP_RECORDINGS, { family: 'S6730_V200', completedAt: VTA_MCP_AT });
    const tools = new VsiMcpTools({ hosts: { getHost: async (id) => cdbHost(id) }, mpls: { listVsis: async (id) => cdbInventory(id) }, live: collector, consumeApproval: vi.fn(), audit: vi.fn(), now: () => new Date(VTA_MCP_AT) });
    const env = JSON.parse(JSON.stringify(await tools.call('diagnose_vsi', { hostId: CDB.vta, ...request.endpoints[0], vsiName: CDB_VSI, includeMac: false, homologation: true }, ADMIN)));
    const participant = { hostId: CDB.vta, hostName: 'BHE-VTA-6730-MPLS-01', loopback: '10.100.101.0', discoveredBy: 'REQUESTED' as const, inventory: cdbInventory(CDB.vta)[0]! };
    const collectionOf = (envelope: unknown) => aggregateVsiService({ ...base, participants: [{ ...participant, envelope: envelope as never }] }).endpoints[0]!.collection;
    expect(collectionOf({ ...env, status: 'INCONCLUSIVE' })).toBe('READ');
    expect(collectionOf({ ...env, collectionIssues: [{ code: 'OUTPUT_INCOMPLETE', command: 'display e-trunk 4', message: 'x' }] })).toBe('PARTIAL');
  });
});
