import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertVsiMcpReadOnly, safeVsiMcpCommand, VsiMcpPolicyError } from './command-policy';
import { compareEndpoints, diagnoseEndpoint, type EndpointFacts } from './correlator';
import { checkVsiMcpScope } from './live-collector';
import { vsiMcpProfileSchema } from './access-profile';
import { parseInterfaceConfig, type ParsedVlanInfo, type ParsedVsiVerbose } from './parsers';
import { resolveCapability } from './platform';
import {
  classifyTrunkRole,
  eTrunkFromBrief,
  isPersistedPwStale,
  normalizeRd,
  parseETrunk,
  parseETrunkBrief,
  parseEthTrunk,
  type RedundancyFacts,
} from './redundancy';

/**
 * CAPTURAS REAIS: E-Trunk 4 da CDB TELECOM, BHE-VTA-6730-MPLS-01 (Eth-Trunk26) x BHE-LIKEE-6730-MPLS-01
 * (Eth-Trunk17), Huawei S6730 V200, coletadas manualmente pelo operador em 2026-11-16 (ver metadata.json).
 * NAO ha captura de `display vsi` da VSI 3072: nos diagnosticos simulados o estado de VSI/AC/PW vem do
 * inventario SNMP de 2026-11-16 e esta montado a mao (nao e saida de equipamento).
 */
const dir = join(__dirname, '..', '__fixtures__', 'cdb-etrunk-20261116');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

const VTA_ETRUNK = parseETrunk(read('vta-e-trunk-4.sanitized.txt'), 4);
const VTA_BRIEF = parseETrunkBrief(read('vta-e-trunk-brief.sanitized.txt'));
const VTA_LAG = parseEthTrunk(read('vta-eth-trunk-26.sanitized.txt'), 26);
/** Captura real TRUNCADA (sem `#`/`return`/prompt finais): o parser a recusa como incompleta. */
const VTA_CFG_TRUNCATED = parseInterfaceConfig(read('vta-config-eth-trunk26.truncated.sanitized.txt'), 'Eth-Trunk26');
/** Mesmo texto real + terminador `#`/`return` SINTETICO, usado so onde o teste precisa da lista de VLANs do trunk. */
const VTA_CFG_COMPLETED = parseInterfaceConfig(read('vta-config-eth-trunk26.truncated.sanitized.txt') + '#\nreturn\n<BHE-VTA-6730-MPLS-01>', 'Eth-Trunk26');
const LIKEE_BRIEF = parseETrunkBrief(read('likee-e-trunk-brief.sanitized.txt'));
const LIKEE_LAG = parseEthTrunk(read('likee-eth-trunk-17.sanitized.txt'), 17);
const LIKEE_CFG = parseInterfaceConfig(read('likee-config-eth-trunk17.sanitized.txt'), 'Eth-Trunk17');
/** No LIKEE so o `brief` foi coletado: estado do E-Trunk comprovado, tabela de membros nao lida. */
const LIKEE_ETRUNK = eTrunkFromBrief(LIKEE_BRIEF, 4)!;

const vtaRedundancy = (): RedundancyFacts => ({ ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: VTA_ETRUNK }, evidenceIds: { ethTrunks: { 'Eth-Trunk26': 'ev:lag26' }, eTrunks: { 4: 'ev:etrunk4' } } });
const likeeRedundancy = (): RedundancyFacts => ({ ethTrunks: { 'Eth-Trunk17': LIKEE_LAG }, eTrunks: { 4: LIKEE_ETRUNK } });

const vsi = (over: Partial<ParsedVsiVerbose>): ParsedVsiVerbose => ({
  complete: true, name: 'X', state: 'UP', signaling: 'bgp', encapsulationType: 'vlan', mtu: 1500, vsiIndex: 1, rd: '268568:1', acs: [], pws: [], ...over,
});
const pw = (peerAddress: string, state: 'UP' | 'DOWN', localLabel: number | null = null, remoteLabel: number | null = null) =>
  ({ peerAddress, vcId: null, state, localLabel, remoteLabel, pwType: 'label', tunnelId: null, tunnelType: 'LSP', outInterface: null });
const ac = (interfaceName: string, state: 'UP' | 'DOWN') => ({ interfaceName, state, acBlockState: null, accessPort: false });

const QINQ = '3072-QinQ-CDB-MANTIQUEIRA';
/** VTA-01, VSI 3072: VSI DOWN e AC Eth-Trunk26.3072 DOWN (inventario SNMP 16/11); sem PW vivo. Config do trunk fora (captura truncada). */
const vtaQinq = (over: Partial<EndpointFacts> = {}): EndpointFacts => ({
  hostId: 'h-vta', hostName: 'BHE-VTA-6730-MPLS-01', platform: null, vsiName: QINQ,
  vsi: vsi({ name: QINQ, state: 'DOWN', mtu: 2000, rd: '268568:53072', acs: [ac('Eth-Trunk26.3072', 'DOWN')] }),
  interfaces: {}, macs: null, requested: { mac: false },
  redundancy: vtaRedundancy(),
  evidenceIds: { vsi: 'ev:vsi', interfaces: {} },
  ...over,
});
/** LIKEE, VSI 3072: VSI UP, AC Eth-Trunk17.3072 UP, PW para BHE-MQT (10.100.101.2) UP 36706/35842 (inventario SNMP 16/11). */
const likeeQinq = (over: Partial<EndpointFacts> = {}): EndpointFacts => ({
  hostId: 'h-likee', hostName: 'BHE-LIKEE-6730-MPLS-01', platform: null, vsiName: QINQ,
  vsi: vsi({ name: QINQ, state: 'UP', mtu: 2000, rd: '268568:53072', acs: [ac('Eth-Trunk17.3072', 'UP')], pws: [pw('10.100.101.2', 'UP', 36706, 35842)] }),
  interfaces: {}, macs: null, requested: { mac: false },
  carriers: { 'Eth-Trunk17': LIKEE_CFG },
  redundancy: likeeRedundancy(),
  evidenceIds: { vsi: 'ev:vsi', interfaces: {}, carriers: { 'Eth-Trunk17': 'ev:cfg17' } },
  ...over,
});
const codes = (d: { findings: Array<{ code: string }> }) => d.findings.map((x) => x.code);

describe('parsers sobre as capturas reais do S6730 V200', () => {
  it('display e-trunk 4 (VTA): Backup por prioridade, peer LIKEE, BFD e revert-delay', () => {
    expect(VTA_ETRUNK).toMatchObject({
      complete: true, eTrunkId: 4, state: 'BACKUP', causation: 'PRI', priority: 30, peerPriority: 20,
      peerIp: '10.100.101.3', sourceIp: '10.100.101.0', bfdSession: 'likee', revertDelaySeconds: 120,
    });
  });

  it('display e-trunk 4 (VTA): os DOIS membros, com Peer-Member e Remote-ID', () => {
    expect(VTA_ETRUNK.members).toEqual([
      { interfaceName: 'Eth-Trunk13', trunkId: 13, localPhyState: 'DOWN', workMode: 'auto', state: 'BACKUP', causation: 'PEER_MEMBER_UP', remoteId: 21 },
      { interfaceName: 'Eth-Trunk26', trunkId: 26, localPhyState: 'DOWN', workMode: 'auto', state: 'BACKUP', causation: 'PEER_MEMBER_UP', remoteId: 17 },
    ]);
  });

  it('display e-trunk brief (VTA): le so a saida do ultimo eco do comando, ignorando as tentativas com erro da sessao', () => {
    expect(VTA_BRIEF).toMatchObject({ complete: true, declaredTotal: 6 });
    expect(VTA_BRIEF.eTrunks.map((e) => `${e.eTrunkId}:${e.state}`)).toEqual(['1:BACKUP', '2:MASTER', '4:BACKUP', '5:MASTER', '11:MASTER', '13:MASTER']);
    expect(VTA_BRIEF.eTrunks.find((e) => e.eTrunkId === 4)).toEqual({ eTrunkId: 4, state: 'BACKUP', peerIp: '10.100.101.3', sourceIp: '10.100.101.0' });
  });

  it('display e-trunk brief (LIKEE): E-Trunk 4 Master com peer no VTA-01', () => {
    expect(LIKEE_BRIEF).toMatchObject({ complete: true, declaredTotal: 5 });
    expect(LIKEE_BRIEF.eTrunks.find((e) => e.eTrunkId === 4)).toEqual({ eTrunkId: 4, state: 'MASTER', peerIp: '10.100.101.0', sourceIp: '10.100.101.3' });
  });

  it('os dois lados do E-Trunk 4 se correspondem (estado oposto, peer/source cruzados)', () => {
    const vta = VTA_BRIEF.eTrunks.find((e) => e.eTrunkId === 4)!;
    const likee = LIKEE_BRIEF.eTrunks.find((e) => e.eTrunkId === 4)!;
    expect([vta.state, likee.state]).toEqual(['BACKUP', 'MASTER']);
    expect(vta.peerIp).toBe(likee.sourceIp);
    expect(likee.peerIp).toBe(vta.sourceIp);
    // brief e comando completo do VTA concordam.
    expect(VTA_ETRUNK.state).toBe(vta.state);
    expect(VTA_ETRUNK.peerIp).toBe(vta.peerIp);
  });

  it('display eth-trunk: LACP, estado operacional, portas em uso e membro Selected/Unselect; a secao Partner nao duplica membros', () => {
    expect(VTA_LAG).toEqual({
      complete: true, trunkId: 26, workingMode: 'LACP', operStatus: 'DOWN', upPorts: 0, leastActiveLinks: 1, maxActiveLinks: 32,
      members: [{ portName: 'XGigabitEthernet0/0/48', status: 'UNSELECTED' }],
    });
    expect(LIKEE_LAG).toEqual({
      complete: true, trunkId: 17, workingMode: 'LACP', operStatus: 'UP', upPorts: 1, leastActiveLinks: 1, maxActiveLinks: 32,
      members: [{ portName: 'XGigabitEthernet0/0/3', status: 'SELECTED' }],
    });
  });

  it('config do Eth-Trunk17 (LIKEE): `mode lacp`, `e-trunk 4 remote-eth-trunk 26` e VLANs permitidas', () => {
    expect(LIKEE_CFG).toMatchObject({ complete: true, eTrunkId: 4, remoteEthTrunkId: 26, lacpMode: 'STATIC' });
    expect(LIKEE_CFG.portVlan).toMatchObject({ linkType: 'TRUNK', trunkAllow: ['820 3015 to 3016 3332 3502 3884'] });
  });

  it('config do Eth-Trunk26 (VTA): captura truncada e recusada; com o terminador mostra `e-trunk 4 remote-eth-trunk 17`', () => {
    expect(VTA_CFG_TRUNCATED.complete).toBe(false);
    expect(VTA_CFG_COMPLETED).toMatchObject({ complete: true, eTrunkId: 4, remoteEthTrunkId: 17, lacpMode: 'STATIC' });
  });

  it('vinculo E-Trunk 4 <-> Eth-Trunk17 <-> Eth-Trunk26 fecha por tres fontes independentes', () => {
    const member26 = VTA_ETRUNK.members.find((m) => m.trunkId === 26)!;
    expect(member26.remoteId).toBe(17);                      // tabela de membros do VTA
    expect(LIKEE_CFG.eTrunkId).toBe(4);                      // config do LIKEE
    expect(LIKEE_CFG.remoteEthTrunkId).toBe(26);
    expect(VTA_CFG_COMPLETED.remoteEthTrunkId).toBe(17);     // texto real da config do VTA
  });
});

describe('falhas de parsing e saidas incompletas nunca viram dado', () => {
  it('id divergente, paginacao, comando recusado e E-Trunk inexistente', () => {
    expect(parseETrunk(read('vta-e-trunk-4.sanitized.txt'), 5).complete).toBe(false);
    expect(parseEthTrunk(read('vta-eth-trunk-26.sanitized.txt'), 17).complete).toBe(false);
    expect(parseETrunk(read('vta-e-trunk-4.sanitized.txt') + '\n  ---- More ----', 4).complete).toBe(false);
    expect(parseEthTrunk('<X>display eth-trunk 26\nError: Unrecognized command\n<X>', 26).complete).toBe(false);
    expect(parseETrunk('<X>display e-trunk 4\nInfo: The E-Trunk does not exist.\n<X>', 4).complete).toBe(false);
    expect(parseETrunk("<X>display e-trunk\n      ^\nError:Incomplete command found at '^' position.\n<X>", 4).complete).toBe(false);
  });

  it('e-trunk cortado antes do estado: incompleto; cortado antes dos membros: estado sim, membros nao', () => {
    const raw = read('vta-e-trunk-4.sanitized.txt');
    expect(parseETrunk(raw.slice(0, raw.indexOf('State : Backup')), 4)).toMatchObject({ complete: false, state: null });
    const noMembers = parseETrunk(raw.slice(0, raw.indexOf('Eth-Trunk 13')), 4);
    expect(noMembers).toMatchObject({ complete: true, state: 'BACKUP', members: [] });
    // Sem a linha do membro nao ha standby comprovado.
    expect(classifyTrunkRole('Eth-Trunk26', null, { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: noMembers } }).role).toBe('ROLE_UNKNOWN');
  });

  it('eth-trunk cortado antes de "Operate status" e sem tabela de membros: incompleto', () => {
    const raw = read('vta-eth-trunk-26.sanitized.txt');
    expect(parseEthTrunk(raw.slice(0, raw.indexOf('Operate status')), 26).complete).toBe(false);
  });

  it('brief: total declarado diferente das linhas (saida cortada) e erro apos o ultimo eco sao incompletos; vazio e valido', () => {
    const raw = read('likee-e-trunk-brief.sanitized.txt');
    const cut = raw.replace(/^12 .*\n/m, '');
    expect(parseETrunkBrief(cut)).toEqual({ complete: false, eTrunks: [], declaredTotal: 5 });
    expect(parseETrunkBrief('<X>display e-trunk brief\nError: Unrecognized command\n<X>').complete).toBe(false);
    expect(parseETrunkBrief('<X>display e-trunk brief\n<X>')).toEqual({ complete: true, eTrunks: [], declaredTotal: null });
    expect(eTrunkFromBrief(parseETrunkBrief(cut), 4)).toBeNull();
    expect(eTrunkFromBrief(LIKEE_BRIEF, 9)).toBeNull();
  });

  it('diretiva e-trunk sem trunk remoto e trunk sem a diretiva', () => {
    expect(parseInterfaceConfig('#\ninterface Eth-Trunk5\n e-trunk 2\n#\nreturn', 'Eth-Trunk5')).toMatchObject({ eTrunkId: 2 });
    const plain = parseInterfaceConfig('#\ninterface Eth-Trunk1\n port link-type trunk\n port trunk allow-pass vlan 10\n#\nreturn', 'Eth-Trunk1');
    // Trunk sem a diretiva nao ganha o campo (configs antigas comparam igual).
    expect('eTrunkId' in plain).toBe(false);
    expect('lacpMode' in plain).toBe(false);
  });
});

describe('papel do Eth-Trunk', () => {
  it('VTA: Eth-Trunk26 e STANDBY_EXPECTED mesmo sem a config (associacao pela tabela de membros do E-Trunk 4)', () => {
    const r = classifyTrunkRole('Eth-Trunk26', null, vtaRedundancy());
    expect(r).toMatchObject({ role: 'STANDBY_EXPECTED', mechanism: 'E_TRUNK', eTrunkId: 4, selectedMembers: 0, totalMembers: 1, missingEvidence: [], alerts: [] });
    expect(r.reasons.join(' | ')).toContain('E-Trunk 4: BACKUP (causa PRI), peer 10.100.101.3');
    expect(r.reasons.join(' | ')).toContain('membro Eth-Trunk26: BACKUP (causa PEER_MEMBER_UP), fisico local DOWN');
    expect(r.reasons.join(' | ')).toContain('operacional DOWN, 0/1 membro(s) Selected');
  });

  it('LIKEE: Eth-Trunk17 e ACTIVE (E-Trunk Master pelo brief + trunk operacional com membro Selected)', () => {
    const r = classifyTrunkRole('Eth-Trunk17', LIKEE_CFG, likeeRedundancy());
    expect(r).toMatchObject({ role: 'ACTIVE', mechanism: 'E_TRUNK', eTrunkId: 4, selectedMembers: 1, totalMembers: 1 });
    // A linha do membro no LIKEE nao foi coletada: registrada como evidencia que falta, sem inventar o estado.
    expect(r.missingEvidence.join(' ')).toContain('tabela de membros de display e-trunk 4');
  });

  it('config com e-trunk mas sem display e-trunk: ROLE_UNKNOWN com a evidencia que falta', () => {
    const r = classifyTrunkRole('Eth-Trunk17', LIKEE_CFG, { ethTrunks: {}, eTrunks: {} });
    expect(r.role).toBe('ROLE_UNKNOWN');
    expect(r.missingEvidence).toEqual(['display e-trunk 4 (estado Master/Backup e causa)']);
  });

  it('Backup sem PEER_MEMBER_UP nao e standby comprovado (par pode nao estar ativo)', () => {
    const et = { ...VTA_ETRUNK, members: VTA_ETRUNK.members.map((m) => ({ ...m, causation: 'FORCE_BACKUP' })) };
    const r = classifyTrunkRole('Eth-Trunk26', null, { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: et } });
    expect(r.role).toBe('ROLE_UNKNOWN');
    expect(r.alerts).toContain('FORCED_STATE');
  });

  it('contradicao (membro Backup, mas trunk operacional com membro Selected) nunca vira standby', () => {
    const lag = { ...LIKEE_LAG, trunkId: 26 };
    expect(classifyTrunkRole('Eth-Trunk26', null, { ethTrunks: { 'Eth-Trunk26': lag }, eTrunks: { 4: VTA_ETRUNK } }).role).toBe('ROLE_UNKNOWN');
  });

  it('Master com o trunk fora de operacao e DOWN_UNEXPECTED', () => {
    const et = { ...VTA_ETRUNK, state: 'MASTER' as const, members: VTA_ETRUNK.members.map((m) => ({ ...m, state: 'MASTER' as const, causation: 'PEER_MEMBER_DOWN' })) };
    expect(classifyTrunkRole('Eth-Trunk26', null, { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: et } }).role).toBe('DOWN_UNEXPECTED');
  });

  it('so o brief em Backup (sem membros): papel indeterminado, nunca standby', () => {
    const fromBrief = eTrunkFromBrief(VTA_BRIEF, 4)!;
    expect(fromBrief).toMatchObject({ complete: true, state: 'BACKUP', members: [] });
    expect(classifyTrunkRole('Eth-Trunk26', VTA_CFG_COMPLETED, { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: fromBrief } }).role).toBe('ROLE_UNKNOWN');
  });

  it('LACP sem E-Trunk: em uso = ACTIVE; sem membro em uso = DOWN_UNEXPECTED; membro fora do agregado so alerta', () => {
    const cfg = parseInterfaceConfig('#\ninterface Eth-Trunk9\n port link-type trunk\n mode lacp\n#\nreturn', 'Eth-Trunk9');
    const up = parseEthTrunk("Eth-Trunk9's state information is:\nWorkingMode: LACP\nOperate status: up   Number Of Up Port In Trunk: 1\nXGigabitEthernet0/0/1 Selected 10GE\nXGigabitEthernet0/0/2 Unselect 10GE\n", 9);
    const down = parseEthTrunk("Eth-Trunk9's state information is:\nWorkingMode: LACP\nOperate status: down   Number Of Up Port In Trunk: 0\nXGigabitEthernet0/0/1 Unselect 10GE\n", 9);
    expect(classifyTrunkRole('Eth-Trunk9', cfg, { ethTrunks: { 'Eth-Trunk9': up }, eTrunks: {} })).toMatchObject({ role: 'ACTIVE', mechanism: 'LACP', alerts: ['MEMBER_NOT_SELECTED'] });
    expect(classifyTrunkRole('Eth-Trunk9', cfg, { ethTrunks: { 'Eth-Trunk9': down }, eTrunks: {} })).toMatchObject({ role: 'DOWN_UNEXPECTED', mechanism: 'LACP' });
  });
});

describe('diagnostico simulado do caso CDB TELECOM (VSI 3072-QinQ-CDB-MANTIQUEIRA)', () => {
  it('VTA (Backup comprovado): sem CRITICAL, sem exigencia de MAC, VSI/AC/PW nao avaliados como defeito', () => {
    const d = diagnoseEndpoint(vtaQinq());
    expect(d.findings.filter((x) => x.severity !== 'INFO')).toEqual([]);
    expect(codes(d)).toEqual(expect.arrayContaining(['VSI_DOWN_STANDBY_EXPECTED', 'STANDBY_PATH_IDLE']));
    expect(codes(d)).not.toEqual(expect.arrayContaining(['VSI_DOWN']));
    expect(codes(d)).not.toEqual(expect.arrayContaining(['AC_DOWN']));
    expect(codes(d).some((c) => c.startsWith('NO_MAC') || c.startsWith('MAC_'))).toBe(false);
    expect(d.operationalRole).toBe('STANDBY_EXPECTED');
    expect(d.dimensions).toMatchObject({ VSI_STATE: 'NOT_EVALUATED', AC_STATE: 'NOT_EVALUATED', PW_STATE: 'NOT_EVALUATED', MAC_LEARNING: 'NOT_EVALUATED' });
    expect(d.pathRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'AC', name: 'Eth-Trunk26.3072', role: 'STANDBY_EXPECTED', mechanism: 'E_TRUNK', eTrunkId: 4 }),
      expect.objectContaining({ kind: 'ETH_TRUNK', name: 'Eth-Trunk26', role: 'STANDBY_EXPECTED' }),
    ]));
    expect(d.notVerified.join(' ')).toContain('Lado ATIVO');
    // A evidencia do mecanismo acompanha o achado.
    expect(d.findings.find((x) => x.code === 'STANDBY_PATH_IDLE')!.evidence).toEqual(expect.arrayContaining(['ev:lag26', 'ev:etrunk4']));
  });

  it('VTA: PWs gravados como UP ha semanas sao apontados como obsoletos e nao viram falha', () => {
    const d = diagnoseEndpoint(vtaQinq({ persistedPws: { vsiLastSeenAt: '2026-11-16T13:03:09.000Z', pws: [{ peerAddress: '10.100.101.2', state: 'UP', lastSeenAt: '2026-10-27T01:24:41.000Z' }] } }));
    expect(codes(d)).toContain('PERSISTED_PW_STALE');
    expect(d.findings.some((x) => x.severity === 'CRITICAL')).toBe(false);
  });

  it('LIKEE (Master): ponta ACTIVE, sem achado de falha', () => {
    const d = diagnoseEndpoint(likeeQinq());
    expect(d.operationalRole).toBe('ACTIVE');
    expect(d.findings.filter((x) => x.severity !== 'INFO')).toEqual([]);
    expect(d.dimensions).toMatchObject({ VSI_STATE: 'OK', AC_STATE: 'OK', PW_STATE: 'OK' });
    expect(d.pathRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'AC', name: 'Eth-Trunk17.3072', role: 'ACTIVE' }),
      expect.objectContaining({ kind: 'ETH_TRUNK', name: 'Eth-Trunk17', role: 'ACTIVE', mechanism: 'E_TRUNK', eTrunkId: 4 }),
    ]));
  });

  it('LIKEE: MAC aprendido na interface logica Eth-Trunk17 basta (nunca exigido por membro fisico)', () => {
    const d = diagnoseEndpoint(likeeQinq({
      requested: { mac: true },
      macs: { complete: true, declaredTotal: 2, incompleteReason: null, entries: [
        { mac: '0000-0000-0001', learnedFrom: 'Eth-Trunk17', side: 'AC', type: 'dynamic', typeClass: 'DYNAMIC', ageSeconds: 10 },
        { mac: '0000-0000-0002', learnedFrom: '10.100.101.2', side: 'PW', type: 'dynamic', typeClass: 'DYNAMIC', ageSeconds: 10 },
      ] } as never,
    }));
    expect(codes(d)).not.toContain('MAC_LEARNED_ON_NON_AC_INTERFACE');
    expect(codes(d)).not.toContain('NO_MAC_FROM_AC');
    expect(d.macSummary).toMatchObject({ viaAc: 1, viaPw: 1 });
    expect(d.findings.some((x) => x.title.includes('XGigabitEthernet'))).toBe(false);
  });

  it('comparacao LIKEE x VTA com PW down no Backup: sem PW_STATE_ASYMMETRIC CRITICAL', () => {
    const b = vtaQinq();
    b.vsi = { ...b.vsi!, pws: [pw('10.100.101.2', 'DOWN')] };
    const cmp = compareEndpoints(likeeQinq(), b, { peerAddressOnA: '10.100.101.2', peerAddressOnB: '10.100.101.2' });
    expect(codes(cmp)).toContain('PW_STATE_ASYMMETRIC_INACTIVE_PATH');
    expect(codes(cmp)).toContain('PW_DOWN_ON_INACTIVE_PATH');
    expect(codes(cmp)).not.toContain('PW_STATE_ASYMMETRIC');
    expect(codes(cmp)).not.toContain('ALL_PW_DOWN');
    expect(cmp.findings.some((x) => x.severity === 'CRITICAL')).toBe(false);
  });
});

describe('redundancia nao mascara falha real', () => {
  const asMaster = (causation: string) => ({ ...VTA_ETRUNK, state: 'MASTER' as const, members: VTA_ETRUNK.members.map((m) => ({ ...m, state: 'MASTER' as const, causation })) });

  it('failover: VTA assume (Master, PEER_MEMBER_DOWN, trunk em uso) => ACTIVE + alerta de perda de redundancia', () => {
    const d = diagnoseEndpoint(vtaQinq({
      vsi: vsi({ name: QINQ, state: 'UP', acs: [ac('Eth-Trunk26.3072', 'UP')], pws: [pw('10.100.101.2', 'UP', 41335, 35840)] }),
      redundancy: { ethTrunks: { 'Eth-Trunk26': { ...LIKEE_LAG, trunkId: 26 } }, eTrunks: { 4: asMaster('PEER_MEMBER_DOWN') } },
    }));
    expect(d.operationalRole).toBe('ACTIVE');
    expect(codes(d)).toContain('REDUNDANCY_PEER_MEMBER_DOWN');
    expect(d.status).toBe('WARNING');
  });

  it('caminho que deveria estar ativo (Master) com AC down continua CRITICAL', () => {
    const d = diagnoseEndpoint(vtaQinq({ redundancy: { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: { 4: asMaster('ETRUNK_MASTER') } } }));
    expect(codes(d)).toEqual(expect.arrayContaining(['VSI_DOWN', 'AC_DOWN']));
    expect(d.status).toBe('FAILED');
    expect(d.operationalRole).toBe('DOWN_UNEXPECTED');
  });

  it('E-Trunk configurado mas nao lido: INCONCLUSIVE com a evidencia que falta, nunca "normal"', () => {
    const d = diagnoseEndpoint(vtaQinq({ carriers: { 'Eth-Trunk26': VTA_CFG_COMPLETED }, redundancy: { ethTrunks: { 'Eth-Trunk26': VTA_LAG }, eTrunks: {} } }));
    expect(d.status).toBe('INCONCLUSIVE');
    expect(d.operationalRole).toBe('ROLE_UNKNOWN');
    expect(codes(d)).toEqual(expect.arrayContaining(['PATH_ROLE_UNKNOWN', 'VSI_DOWN_ROLE_UNKNOWN']));
    expect(d.findings.find((x) => x.code === 'PATH_ROLE_UNKNOWN')!.explanation).toContain('display e-trunk 4');
  });

  it('AC Vlanif no Backup sem display vlan: ROLE_UNKNOWN (pode haver outra porta na VLAN)', () => {
    const d = diagnoseEndpoint(vtaQinq({
      vsiName: '3332-L2L-GPON-TO-CDBTELECOM', carriers: { 'Eth-Trunk26': VTA_CFG_COMPLETED },
      vsi: vsi({ name: '3332-L2L-GPON-TO-CDBTELECOM', state: 'DOWN', acs: [ac('Vlanif3332', 'DOWN')] }),
    }));
    expect(d.operationalRole).toBe('ROLE_UNKNOWN');
    expect(d.findings.find((x) => x.code === 'PATH_ROLE_UNKNOWN')!.explanation).toContain('display vlan 3332');
    expect(d.findings.some((x) => x.severity === 'CRITICAL')).toBe(false);
  });

  it('AC Vlanif no Backup com display vlan (sintetico) listando so o trunk em standby: STANDBY_EXPECTED', () => {
    const vlan: ParsedVlanInfo = { complete: true, vlanId: 3332, exists: true, vlanType: 'common', status: 'ENABLE', description: null, ports: [{ name: 'Eth-Trunk26', tagging: 'TAGGED', state: 'DOWN' }] };
    const d = diagnoseEndpoint(vtaQinq({ vsiName: 'V3332', vsi: vsi({ name: 'V3332', state: 'DOWN', acs: [ac('Vlanif3332', 'DOWN')] }), vlan }));
    expect(d.operationalRole).toBe('STANDBY_EXPECTED');
    // Outra porta na mesma VLAN: o standby do trunk nao explica sozinho o AC down.
    const mixed = diagnoseEndpoint(vtaQinq({ vsiName: 'V3332', vsi: vsi({ name: 'V3332', state: 'DOWN', acs: [ac('Vlanif3332', 'DOWN')] }), vlan: { ...vlan, ports: [...vlan.ports, { name: 'XGigabitEthernet0/0/7', tagging: 'TAGGED', state: 'DOWN' }] } }));
    expect(mixed.operationalRole).toBe('ROLE_UNKNOWN');
  });

  it('VSI down com AC up (nenhum PW) continua CRITICAL mesmo com redundancia no escopo', () => {
    const d = diagnoseEndpoint(likeeQinq({ vsi: vsi({ name: QINQ, state: 'DOWN', acs: [ac('Eth-Trunk17.3072', 'UP')] }) }));
    expect(codes(d)).toContain('VSI_DOWN');
    expect(d.status).toBe('FAILED');
  });
});

describe('VSI sem redundancia no escopo: comportamento preservado', () => {
  it('AC e VSI down sem evidencia de redundancia continuam CRITICAL e sem pathRoles', () => {
    const d = diagnoseEndpoint({
      hostId: 'h', hostName: 'X', platform: null, vsiName: 'V', vsi: vsi({ name: 'V', state: 'DOWN', acs: [ac('Vlanif10', 'DOWN')], pws: [pw('10.0.0.1', 'DOWN')] }),
      interfaces: {}, macs: null, evidenceIds: { interfaces: {} },
    });
    expect(codes(d)).toEqual(expect.arrayContaining(['VSI_DOWN', 'AC_DOWN', 'ALL_PW_DOWN']));
    expect(d.status).toBe('FAILED');
    expect('pathRoles' in d).toBe(false);
    expect('operationalRole' in d).toBe(false);
    expect(d.findings.find((x) => x.code === 'AC_DOWN')!.explanation).toBe('A interface Vlanif10 esta vinculada a VSI mas reporta State: down.');
  });
});

describe('RD e PWs persistidos', () => {
  it('normaliza asdot/asplain e preserva RD tipo IP', () => {
    expect(normalizeRd('268568:3016')).toBe('268568:3016');
    expect(normalizeRd('4.6424:3016')).toBe('268568:3016');
    expect(normalizeRd('4.6424 : 3016')).toBe('268568:3016');
    expect(normalizeRd('10.100.101.3:5')).toBe('10.100.101.3:5');
    expect(normalizeRd('65000:0100')).toBe('65000:100');
    expect(normalizeRd('abc')).toBeNull();
    expect(normalizeRd('70000.1:5')).toBeNull();
    expect(normalizeRd(null)).toBeNull();
  });

  it('compareEndpoints: mesmo RD em notacoes diferentes e INFO, nao divergencia', () => {
    const a = likeeQinq();
    const b = likeeQinq({ hostId: 'h-b', hostName: 'B' });
    b.vsi = { ...b.vsi!, rd: '4.6424:53072', pws: [pw('10.100.101.3', 'UP', 35842, 36706)] };
    const cmp = compareEndpoints(a, b);
    expect(codes(cmp)).toContain('RD_SAME_VALUE_DIFFERENT_NOTATION');
    expect(cmp.findings.some((x) => x.severity !== 'INFO')).toBe(false);
  });

  it('PW persistido e obsoleto quando a ultima leitura e anterior a da VSI (alem da tolerancia)', () => {
    expect(isPersistedPwStale('2026-10-27T01:24:41.000Z', '2026-11-16T13:03:09.000Z')).toBe(true);
    expect(isPersistedPwStale('2026-11-16T13:03:09.000Z', '2026-11-16T13:03:09.000Z')).toBe(false);
    expect(isPersistedPwStale('2026-11-16T12:55:00.000Z', '2026-11-16T13:03:09.000Z')).toBe(false);
    expect(isPersistedPwStale('lixo', '2026-11-16T13:03:09.000Z')).toBe(false);
  });
});

describe('politica de comandos, matriz e escopo', () => {
  it('gera somente os tres comandos exatos e recusa ids fora da faixa do equipamento (E-Trunk 1-16)', () => {
    expect(safeVsiMcpCommand({ kind: 'ETRUNK_BRIEF' })).toBe('display e-trunk brief');
    expect(safeVsiMcpCommand({ kind: 'ETRUNK_INFO', eTrunkId: 4 })).toBe('display e-trunk 4');
    expect(safeVsiMcpCommand({ kind: 'ETRUNK_INFO', eTrunkId: 16 })).toBe('display e-trunk 16');
    expect(safeVsiMcpCommand({ kind: 'ETH_TRUNK_INFO', trunkId: 26 })).toBe('display eth-trunk 26');
    expect(() => safeVsiMcpCommand({ kind: 'ETRUNK_INFO', eTrunkId: 0 })).toThrow(VsiMcpPolicyError);
    expect(() => safeVsiMcpCommand({ kind: 'ETRUNK_INFO', eTrunkId: 17 })).toThrow(VsiMcpPolicyError);
    expect(() => safeVsiMcpCommand({ kind: 'ETH_TRUNK_INFO', trunkId: 256 })).toThrow(VsiMcpPolicyError);
    expect(() => safeVsiMcpCommand({ kind: 'ETH_TRUNK_INFO', trunkId: 1.5 })).toThrow(VsiMcpPolicyError);
    for (const bad of ['display e-trunk', 'display e-trunk ?', 'display e-trunk br', 'display e-trunk packet-statistics', 'display e-trunk 4 verbose', 'display e-trunk 04', 'display e-trunk 17', 'display eth-trunk', 'display eth-trunk 26 verbose', 'display eth-trunk 26 | include x', 'e-trunk 4', 'display e-trunk  4'])
      expect(() => assertVsiMcpReadOnly(bad)).toThrow(VsiMcpPolicyError);
  });

  it('S6730 V200: os tres comandos estao homologados com captura real; demais familias seguem candidatas', () => {
    for (const op of ['ETRUNK_BRIEF', 'ETRUNK_INFO', 'ETH_TRUNK_INFO'] as const) {
      expect(resolveCapability('S6730_V200', op, false)).toMatchObject({ allowed: true, reason: 'HOMOLOGATED' });
      for (const family of ['S6750_YUNSHAN_V600', 'NE8000_V800', 'NE40E_V800'] as const) {
        expect(resolveCapability(family, op, false)).toMatchObject({ allowed: false, reason: 'CANDIDATE_NOT_HOMOLOGATED' });
        expect(resolveCapability(family, op, true).allowed).toBe(true);
      }
    }
    expect(resolveCapability('UNKNOWN', 'ETRUNK_INFO', true).allowed).toBe(false);
  });

  it('escopo fechado no perfil: Eth-Trunk fora de carrierInterfaces e E-Trunk fora de eTrunks sao negados', () => {
    const profile = vsiMcpProfileSchema.parse({
      hostId: 'h', endpoint: '10.0.0.1', port: 22, username: 'u', context: null, fingerprint: 'SHA256:' + 'A'.repeat(43),
      initialPrompt: '<X>', expectedPrompt: '<X>', vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
      validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
      operations: ['VERSION', 'ETRUNK_INFO', 'ETH_TRUNK_INFO'], carrierInterfaces: ['Eth-Trunk26'], eTrunks: [4],
    });
    expect(() => checkVsiMcpScope(profile, [{ kind: 'ETH_TRUNK_INFO', trunkId: 26 }, { kind: 'ETRUNK_INFO', eTrunkId: 4 }])).not.toThrow();
    expect(() => checkVsiMcpScope(profile, [{ kind: 'ETH_TRUNK_INFO', trunkId: 17 }])).toThrow(/fora do escopo/);
    expect(() => checkVsiMcpScope(profile, [{ kind: 'ETRUNK_INFO', eTrunkId: 5 }])).toThrow(/fora do escopo/);
    // Perfil sem a lista: nada e permitido por padrao.
    expect(vsiMcpProfileSchema.parse({ ...profile, eTrunks: undefined }).eTrunks).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Ferramenta diagnose_vsi de ponta a ponta (coletor falso com a MESMA politica/matriz do real).   */
/* E-Trunk/Eth-Trunk = capturas reais; `display vsi ... verbose` = texto SINTETICO no layout do    */
/* S6730 V200 (a VSI 3072 ainda nao foi lida no equipamento).                                      */
/* ---------------------------------------------------------------------------------------------- */
import { vi } from 'vitest';
import type { MplsVsi } from '@gmj/shared';
import { VsiMcpTools } from './tools';
import { fakeCollector, host } from './__fixtures__/harness';

const VSI_DOWN_SYNTH = `<PE-A>display vsi name ${QINQ} verbose

 ***VSI Name               : ${QINQ}
    Administrator VSI      : no
    PW Signaling           : bgp
    Encapsulation Type     : vlan
    MTU                    : 2000
    VSI State              : down

    BGP RD                 : 268568:53072

    Interface Name         : Eth-Trunk26.3072
    State                  : down
    Access Port            : false
<PE-A>`;

describe('diagnose_vsi com eTrunkIds (fluxo da ferramenta)', () => {
  const persisted = (): MplsVsi => ({
    id: 'v', hostId: 'h-a', name: QINQ, lastSeenAt: '2026-11-16T13:51:10.253Z',
    acs: [{ interface: { name: 'Eth-Trunk26.3072' } }],
    pws: [{ remoteIp: '10.100.101.2', state: 'UP', lastSeenAt: '2026-10-27T01:24:40.900Z' }],
  }) as unknown as MplsVsi;
  const run = async (outputs: Record<string, string>) => {
    const { collector, sessions } = fakeCollector({ 'h-a': outputs }, 'S6730_V200');
    const tools = new VsiMcpTools({
      hosts: { getHost: async (id) => (id === 'h-a' ? host('h-a', 'PE-A') : null) },
      mpls: { listVsis: async () => [persisted()] }, live: collector, consumeApproval: vi.fn(), audit: vi.fn(),
    });
    const env = await tools.call('diagnose_vsi', {
      hostId: 'h-a', vsiName: QINQ, approvalId: '11111111-1111-4111-8111-111111111111', includeMac: false,
      carrierInterfaces: ['Eth-Trunk26'], eTrunkIds: [4], homologation: true,
    }, { id: 'u', username: 'admin', role: 'ADMIN' });
    return { env: JSON.parse(JSON.stringify(env)), sessions };
  };
  const real = {
    [`display vsi name ${QINQ} verbose`]: VSI_DOWN_SYNTH,
    'display eth-trunk 26': read('vta-eth-trunk-26.sanitized.txt').trimEnd(),
    'display e-trunk brief': read('vta-e-trunk-brief.sanitized.txt').trimEnd(),
    'display e-trunk 4': read('vta-e-trunk-4.sanitized.txt').trimEnd(),
  };

  it('uma sessao, comandos exatos em ordem, Backup classificado como STANDBY_EXPECTED e PW obsoleto apontado', async () => {
    const { env, sessions } = await run(real);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.commands).toEqual([
      'display version', `display vsi name ${QINQ} verbose`, 'display current-configuration interface Eth-Trunk26.3072',
      'display current-configuration interface Eth-Trunk26', 'display eth-trunk 26', 'display e-trunk brief', 'display e-trunk 4',
    ]);
    const d = env.data.diagnosis;
    expect(d.operationalRole).toBe('STANDBY_EXPECTED');
    expect(d.findings.filter((x: { severity: string }) => x.severity === 'CRITICAL')).toEqual([]);
    expect(d.findings.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['VSI_DOWN_STANDBY_EXPECTED', 'STANDBY_PATH_IDLE', 'PERSISTED_PW_STALE']));
    expect(d.findings.some((x: { code: string }) => x.code === 'VSI_DOWN' || x.code === 'AC_DOWN')).toBe(false);
  });

  it('display e-trunk 4 recusado: cai no brief (so o estado), papel fica ROLE_UNKNOWN e o aviso diz o que falta', async () => {
    const { env } = await run({ ...real, 'display e-trunk 4': '<PE-A>display e-trunk 4\nError: Unrecognized command\n<PE-A>' });
    const d = env.data.diagnosis;
    expect(d.operationalRole).toBe('ROLE_UNKNOWN');
    expect(d.status).toBe('INCONCLUSIVE');
    expect(env.warnings.join(' ')).toContain('usado somente o estado do brief (BACKUP)');
    expect(d.findings.some((x: { severity: string }) => x.severity === 'CRITICAL')).toBe(false);
  });

  it('brief e comando completo divergentes: estado do E-Trunk nao e usado', async () => {
    const { env } = await run({ ...real, 'display e-trunk brief': real['display e-trunk brief'].replace('4             Backup', '4             Master') });
    expect(env.warnings.join(' ')).toContain('divergem');
    expect(env.data.diagnosis.operationalRole).not.toBe('STANDBY_EXPECTED');
  });

  it('sem eTrunkIds nada de E-Trunk e enviado e o AC down continua CRITICAL', async () => {
    const { collector, sessions } = fakeCollector({ 'h-a': real }, 'S6730_V200');
    const tools = new VsiMcpTools({ hosts: { getHost: async () => host('h-a', 'PE-A') }, mpls: { listVsis: async () => [persisted()] }, live: collector, consumeApproval: vi.fn(), audit: vi.fn() });
    const env = JSON.parse(JSON.stringify(await tools.call('diagnose_vsi', { hostId: 'h-a', vsiName: QINQ, approvalId: '11111111-1111-4111-8111-111111111111', includeMac: false, homologation: true }, { id: 'u', username: 'admin', role: 'ADMIN' })));
    expect(sessions[0]!.commands.some((c) => c.includes('trunk 26') && !c.includes('configuration') || c.includes('e-trunk'))).toBe(false);
    expect(env.data.diagnosis.findings.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['VSI_DOWN', 'AC_DOWN']));
  });
});
