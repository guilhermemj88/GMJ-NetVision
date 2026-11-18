import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VSI_MCP_OPERATIONS,
  VsiMcpPolicyError,
  assertVsiMcpReadOnly,
  buildVsiMcpCommand,
  safeVsiMcpCommand,
  type VsiMcpOperation,
} from './command-policy';
import { classifyHuaweiVersion, resolveCapability } from './platform';
import { parseInterfaceConfig, parseMacTable, parseVsiList, parseVsiVerbose } from './parsers';
import { compareEndpoints, diagnoseEndpoint, type EndpointFacts } from './correlator';
import * as S from './__fixtures__/synthetic';

const REAL = join(__dirname, '..', '__fixtures__');
const real = (p: string) => readFileSync(join(REAL, p), 'utf8');

/* ---------------------------------------------------------------- policy */
describe('command policy: somente consulta, sem texto livre', () => {
  it('gera exatamente os comandos esperados', () => {
    expect(buildVsiMcpCommand({ kind: 'VERSION' })).toBe('display version');
    expect(buildVsiMcpCommand({ kind: 'VSI_LIST' })).toBe('display vsi');
    expect(buildVsiMcpCommand({ kind: 'VSI_VERBOSE', vsiName: 'L2-PPPOE-3901' })).toBe(
      'display vsi name L2-PPPOE-3901 verbose',
    );
    expect(buildVsiMcpCommand({ kind: 'VSI_MAC', vsiName: 'L2-PPPOE-3901' })).toBe(
      'display mac-address vsi L2-PPPOE-3901',
    );
    expect(buildVsiMcpCommand({ kind: 'INTERFACE_CONFIG', interfaceName: 'GigabitEthernet1/0/1.3901' })).toBe(
      'display current-configuration interface GigabitEthernet1/0/1.3901',
    );
    expect(buildVsiMcpCommand({ kind: 'INTERFACE_STATE', interfaceName: 'Eth-Trunk1' })).toBe(
      'display interface Eth-Trunk1',
    );
  });

  it.each([
    'x; reset counters',
    'x verbose | include y',
    'x\nsystem-view',
    'x && undo vsi',
    'x`id`',
    'a b',
    '',
    'x'.repeat(65),
    '$(reboot)',
  ])('rejeita nome de VSI malicioso: %j', (vsiName) => {
    expect(() => buildVsiMcpCommand({ kind: 'VSI_VERBOSE', vsiName })).toThrow(VsiMcpPolicyError);
    expect(() => buildVsiMcpCommand({ kind: 'VSI_MAC', vsiName })).toThrow(VsiMcpPolicyError);
  });

  it.each(['GE0/0/1 ; system-view', 'GE0/0/1|include', '1GE', 'x y', 'GigabitEthernet1/0/1.', '../etc'])(
    'rejeita interface maliciosa: %j',
    (interfaceName) => {
      expect(() => buildVsiMcpCommand({ kind: 'INTERFACE_CONFIG', interfaceName })).toThrow(VsiMcpPolicyError);
      expect(() => buildVsiMcpCommand({ kind: 'INTERFACE_STATE', interfaceName })).toThrow(VsiMcpPolicyError);
    },
  );

  it.each([
    'system-view',
    'undo vsi name X',
    'commit',
    'save',
    'reset counters interface GigabitEthernet1/0/1',
    'reboot',
    'shutdown',
    'interface GigabitEthernet1/0/1',
    'ping 10.0.0.1',
    'tracert 10.0.0.1',
    'display current-configuration',
    'display vsi name X verbose | include a',
    'display vsi name X verbose ; reboot',
    'display interface GigabitEthernet1/0/1 undo',
    'display  vsi',
    ' display vsi',
    'display vsi ',
    'display mpls l2vc',
    'display bgp peer',
    'clear vsi',
    'display vsi name undo verbose',
    'display vsi name commit verbose',
  ])('guard recusa: %j', (command) => {
    expect(() => assertVsiMcpReadOnly(command)).toThrow(VsiMcpPolicyError);
  });

  it('todo comando gerado por qualquer operacao passa pelo guard', () => {
    const ops: VsiMcpOperation[] = [
      { kind: 'VERSION' },
      { kind: 'VSI_LIST' },
      { kind: 'VSI_VERBOSE', vsiName: 'A.b:c_d-1' },
      { kind: 'VSI_MAC', vsiName: 'A' },
      { kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk10.100' },
      { kind: 'INTERFACE_STATE', interfaceName: '100GE1/0/1' as string },
    ].filter((o) => o.kind !== 'INTERFACE_STATE') as VsiMcpOperation[];
    expect(new Set(ops.map((o) => o.kind)).size).toBeGreaterThan(3);
    for (const op of ops) expect(() => safeVsiMcpCommand(op)).not.toThrow();
    // 7 originais + ETRUNK_BRIEF, ETRUNK_INFO, ETH_TRUNK_INFO (redundancia de acesso).
    expect(VSI_MCP_OPERATIONS.length).toBe(10);
  });

  it('nenhum comando permitido contem verbo de escrita', () => {
    for (const kind of VSI_MCP_OPERATIONS) {
      const op =
        kind === 'VERSION' || kind === 'VSI_LIST' || kind === 'ETRUNK_BRIEF'
          ? ({ kind } as VsiMcpOperation)
          : kind === 'ETRUNK_INFO'
            ? ({ kind, eTrunkId: 4 } as VsiMcpOperation)
            : kind === 'ETH_TRUNK_INFO'
              ? ({ kind, trunkId: 26 } as VsiMcpOperation)
          : kind === 'VSI_VERBOSE' || kind === 'VSI_MAC'
            ? ({ kind, vsiName: 'X' } as VsiMcpOperation)
            : kind === 'VLAN_INFO'
              ? ({ kind, vlanId: 3066 } as VsiMcpOperation)
              : ({ kind, interfaceName: 'GigabitEthernet1/0/1' } as VsiMcpOperation);
      const cmd = safeVsiMcpCommand(op);
      expect(cmd.startsWith('display ')).toBe(true);
      expect(cmd).not.toMatch(/\b(undo|system-view|commit|save|reset|reboot|shutdown|clear|delete)\b/);
    }
  });
});

/* -------------------------------------------------------------- platform */
describe('plataforma e matriz de capacidades', () => {
  it('reconhece S6750 YunShan real', () => {
    const p = classifyHuaweiVersion(real('bhe-vta-remote-20261022/r2-version.sanitized.txt'));
    expect(p.family).toBe('S6750_YUNSHAN_V600');
  });
  it('reconhece NE8000 e NE40E como familias DISTINTAS', () => {
    expect(classifyHuaweiVersion(S.NE_VERSION).family).toBe('NE8000_V800');
    expect(
      classifyHuaweiVersion('VRP (R) software, Version 8.180 (NE40E-M2K-B V800R021C10SPC600)').family,
    ).toBe('NE40E_V800');
  });
  it('NE8000 F1A real (formato NetEngine do VRP 8.220) => NE8000_V800 com modelo e release', () => {
    const real = `Huawei Versatile Routing Platform Software
VRP (R) software, Version 8.220 (NetEngine 8000 F1A V800R022C00SPC600)
Copyright (C) 2012-2024 Huawei Technologies Co., Ltd.
HUAWEI NetEngine 8000 F1A-8H20Q uptime is 82 days, 1 hour, 3 minutes`;
    expect(classifyHuaweiVersion(real)).toMatchObject({ family: 'NE8000_V800', release: 'V800R022C00SPC600' });
    expect(classifyHuaweiVersion('VRP (R) software, Version 8.220 (NetEngine 8000 F1A-8H20Q V800R022C00SPC600)').model).toBe('NE8000 F1A-8H20Q');
    expect(classifyHuaweiVersion('VRP (R) software, Version 8.220 (NetEngine 40E-X8A V800R022C00SPC600)').family).toBe('NE40E_V800');
  });
  it('plataforma desconhecida', () => {
    expect(classifyHuaweiVersion('Cisco IOS XR').family).toBe('UNKNOWN');
  });
  it('NE8000/NE40E: MAC e config de interface sao NOT permitidos sem homologacao', () => {
    for (const family of ['NE8000_V800', 'NE40E_V800'] as const) {
      const d = resolveCapability(family, 'VSI_MAC');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('CANDIDATE_NOT_HOMOLOGATED');
      expect(resolveCapability(family, 'VSI_MAC', true)).toMatchObject({ allowed: true, reason: 'HOMOLOGATION_MODE' });
    }
  });
  it('version e permitido em todas as familias; UNKNOWN nao permite o resto', () => {
    expect(resolveCapability('UNKNOWN', 'VERSION').allowed).toBe(true);
    expect(resolveCapability('UNKNOWN', 'VSI_VERBOSE', true)).toMatchObject({ allowed: false, reason: 'NOT_SUPPORTED' });
  });
});

/* --------------------------------------------------------------- parsers */
describe('parseVsiVerbose', () => {
  it('extrai VSI, AC e PW da captura REAL (S6750)', () => {
    const v = parseVsiVerbose(real('bhe-vta-remote-20261022/r4-retest-vsi.sanitized.txt'), '1041-IX-BH-V4');
    expect(v.complete).toBe(true);
    expect(v).toMatchObject({ state: 'UP', signaling: 'bgp', encapsulationType: 'vlan', mtu: 1500, rd: '268568:51041' });
    expect(v.acs).toEqual([
      { interfaceName: 'Vlanif1041', state: 'UP', acBlockState: 'unblocked', accessPort: false },
    ]);
    expect(v.pws[0]).toMatchObject({
      peerAddress: '10.100.101.0', state: 'UP', localLabel: 1016584, remoteLabel: 40943, tunnelType: 'ldp', pwType: 'label',
    });
  });
  it('captura paginada ou nome divergente => incompleta, sem dados parciais', () => {
    const raw = real('bhe-vta-remote-20261022/r4-retest-vsi.sanitized.txt');
    expect(parseVsiVerbose(raw + '\n ---- More ----', '1041-IX-BH-V4')).toMatchObject({ complete: false, acs: [], pws: [] });
    expect(parseVsiVerbose(raw, 'OUTRA')).toMatchObject({ complete: false, acs: [], pws: [] });
  });
  it('extrai multiplos ACs (o diagnostico legado exigia exatamente 1)', () => {
    const v = parseVsiVerbose(S.SCEN_A_VSI, 'L2-PPPOE-3901');
    expect(v.acs.map((a) => a.interfaceName)).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/1.3901']);
  });
});

describe('parseMacTable', () => {
  it('separa aprendizado por AC e por PW', () => {
    const t = parseMacTable(S.MAC_WITH_AC_AND_PW);
    expect(t.complete).toBe(true);
    expect(t.entries.map((e) => e.side)).toEqual(['AC', 'PW']);
  });
  it('total declarado divergente => incompleto', () => {
    expect(parseMacTable(S.MAC_WITH_AC_AND_PW.replace('= 2', '= 5')).complete).toBe(false);
  });
  it('tabela vazia declarada e completa', () => {
    expect(parseMacTable(S.MAC_EMPTY)).toMatchObject({ complete: true, entries: [], declaredTotal: 0 });
  });
  it('paginacao => incompleta', () => {
    expect(parseMacTable(S.MAC_WITH_AC_AND_PW + '\n---- More ----').complete).toBe(false);
  });
});

describe('parseInterfaceConfig', () => {
  it('QinQ + binding + cabecalho "mode l2"', () => {
    const c = parseInterfaceConfig(S.SCEN_A_SUB_CFG, 'GigabitEthernet1/0/1.3901');
    expect(c).toMatchObject({
      complete: true, l2BindingVsi: 'L2-PPPOE-3901', mode: 'L2_PORT', parentInterface: 'GigabitEthernet1/0/1',
    });
    expect(c.directives.map((d) => d.kind)).toEqual(['QINQ_TERMINATION', 'REWRITE']);
  });
  it('stacking 50 -> 502', () => {
    const c = parseInterfaceConfig(S.SCEN_B_CFG_A, 'GigabitEthernet2/0/1.50');
    expect(c.directives[0]).toMatchObject({ kind: 'QINQ_STACKING', vlan: '50', stackVlan: '502' });
  });
  it('interface diferente da pedida => incompleto', () => {
    expect(parseInterfaceConfig(S.SCEN_A_PARENT_CFG, 'GigabitEthernet9/9/9').complete).toBe(false);
  });
  it('sem terminador => incompleto', () => {
    expect(parseInterfaceConfig('interface GigabitEthernet1/0/1\n l2 binding vsi X\n', 'GigabitEthernet1/0/1').complete).toBe(false);
  });
});

/* ------------------------------------------------------- correlator A / B */
function facts(
  hostId: string,
  vsiName: string,
  vsiOut: string,
  cfgs: Array<[string, string]>,
  mac?: string,
): EndpointFacts {
  return {
    hostId,
    hostName: hostId,
    platform: null,
    vsiName,
    vsi: parseVsiVerbose(vsiOut, vsiName),
    interfaces: Object.fromEntries(cfgs.map(([name, out]) => [name, parseInterfaceConfig(out, name)])),
    macs: mac ? parseMacTable(mac) : null,
    evidenceIds: {
      vsi: `${hostId}:vsi`,
      ...(mac ? { macs: `${hostId}:mac` } : {}),
      interfaces: Object.fromEntries(cfgs.map(([n]) => [n, `${hostId}:if:${n}`])),
    },
  };
}

describe('CENARIO A: VSI PPPoE 3901 com binding duplicado fisica + subinterface', () => {
  const a = facts('PE-A', 'L2-PPPOE-3901', S.SCEN_A_VSI, [
    ['GigabitEthernet1/0/1', S.SCEN_A_PARENT_CFG],
    ['GigabitEthernet1/0/1.3901', S.SCEN_A_SUB_CFG],
  ]);

  it('VSI e PW up, mas aponta o binding duplicado', () => {
    expect(a.vsi?.state).toBe('UP');
    expect(a.vsi?.pws[0]?.state).toBe('UP');
    const d = diagnoseEndpoint(a);
    const f = d.findings.find((x) => x.code === 'DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE');
    expect(f).toBeDefined();
    expect(f).toMatchObject({ severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
    expect(f!.title).toContain('GigabitEthernet1/0/1 e GigabitEthernet1/0/1.3901');
    expect(f!.evidence).toEqual(expect.arrayContaining(['PE-A:vsi', 'PE-A:if:GigabitEthernet1/0/1', 'PE-A:if:GigabitEthernet1/0/1.3901']));
    expect(d.status).toBe('FAILED');
  });

  it('explica a consequencia sem afirmar invalidez universal', () => {
    const f = diagnoseEndpoint(a).findings.find((x) => x.code.startsWith('DUPLICATE_BINDING'))!;
    expect(f.explanation).toMatch(/PPPoE/);
    expect(f.caveat).toMatch(/Nao e invalido em todo cenario/);
    expect(f.impactCertainty).not.toBe('CONFIRMED');
  });

  it('controle: somente a subinterface ligada => sem achado de duplicidade', () => {
    const c = facts('PE-A', 'L2-PPPOE-3901', S.SCEN_A_CONTROL_VSI, [['GigabitEthernet1/0/1.3901', S.SCEN_A_SUB_CFG]]);
    expect(diagnoseEndpoint(c).findings.some((x) => x.code.startsWith('DUPLICATE_BINDING'))).toBe(false);
  });

  it('detecta duplicidade tambem so pela configuracao da interface (VSI verbose sem o pai)', () => {
    const c = facts('PE-A', 'L2-PPPOE-3901', S.SCEN_A_CONTROL_VSI, [
      ['GigabitEthernet1/0/1', S.SCEN_A_PARENT_CFG],
      ['GigabitEthernet1/0/1.3901', S.SCEN_A_SUB_CFG],
    ]);
    expect(diagnoseEndpoint(c).findings.some((x) => x.code.startsWith('DUPLICATE_BINDING'))).toBe(true);
  });

  it('interfaces irmas (1/0/1 e 1/0/10.3901) nao sao confundidas com pai/filho', () => {
    const vsi = S.SCEN_A_VSI.replace('GigabitEthernet1/0/1.3901', 'GigabitEthernet1/0/10.3901');
    const c = facts('PE-A', 'L2-PPPOE-3901', vsi, []);
    expect(diagnoseEndpoint(c).findings.some((x) => x.code.startsWith('DUPLICATE_BINDING'))).toBe(false);
  });
});

describe('CENARIO B: VLAN 50 -> 502 entre NE8000 e NE40E', () => {
  const A = () => facts('NE8-A', 'SVC-50-502', S.SCEN_B_VSI_A, [['GigabitEthernet2/0/1.50', S.SCEN_B_CFG_A]], S.MAC_SCEN_B_A);
  const B = () => facts('NE40-B', 'SVC-50-502', S.SCEN_B_VSI_B, [['GigabitEthernet3/0/2.502', S.SCEN_B_CFG_B]], S.MAC_ONLY_PW);

  it('compara VLAN original x transportada, tags e modo', () => {
    const cmp = compareEndpoints(A(), B(), { peerAddressOnA: '10.0.0.9', peerAddressOnB: '10.0.0.1' });
    expect(cmp.vlanComparison.a[0]).toMatchObject({ mode: 'QINQ_STACKING', ingress: ['50'], transported: ['502', '50'], tagCount: 2 });
    expect(cmp.vlanComparison.b[0]).toMatchObject({ mode: 'DOT1Q_TERMINATION', ingress: ['502'] });
  });

  it('assimetria de tratamento e HIPOTESE, nunca causa confirmada', () => {
    const cmp = compareEndpoints(A(), B());
    const f = cmp.findings.find((x) => x.code === 'VLAN_TRANSFORM_ASYMMETRIC')!;
    expect(f).toBeDefined();
    expect(f.impactCertainty).toBe('HYPOTHESIS');
    expect(f.caveat).toMatch(/HIPOTESE/);
    expect(cmp.findings.filter((x) => x.impactCertainty === 'CONFIRMED' && /VLAN|TAG/.test(x.code))).toHaveLength(0);
  });

  it('labels do PW se correspondem => sem PW_LABEL_MISMATCH; corrompido => mismatch', () => {
    const ok = compareEndpoints(A(), B(), { peerAddressOnA: '10.0.0.9', peerAddressOnB: '10.0.0.1' });
    expect(ok.findings.some((x) => x.code === 'PW_LABEL_MISMATCH')).toBe(false);
    const badB = facts('NE40-B', 'SVC-50-502', S.SCEN_B_VSI_B.replace('Remote VC Label        : 3000', 'Remote VC Label        : 3999'), [['GigabitEthernet3/0/2.502', S.SCEN_B_CFG_B]]);
    const bad = compareEndpoints(A(), badB, { peerAddressOnA: '10.0.0.9', peerAddressOnB: '10.0.0.1' });
    expect(bad.findings.some((x) => x.code === 'PW_LABEL_MISMATCH')).toBe(true);
  });

  it('Encapsulation Type vlan x ethernet e mismatch confirmado (impacto provavel)', () => {
    const eth = facts('NE40-B', 'SVC-50-502', S.SCEN_B_VSI_B.replace('Encapsulation Type     : vlan', 'Encapsulation Type     : ethernet'), []);
    const cmp = compareEndpoints(A(), eth);
    expect(cmp.findings.find((x) => x.code === 'ENCAPSULATION_TYPE_MISMATCH')).toMatchObject({ certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
  });

  it('indica o ultimo estagio com MAC aprendido (A_PW) quando B nao aprende via AC', () => {
    const cmp = compareEndpoints(A(), facts('NE40-B', 'SVC-50-502', S.SCEN_B_VSI_B, [['GigabitEthernet3/0/2.502', S.SCEN_B_CFG_B]], S.MAC_EMPTY));
    expect(cmp.trafficObservation.stages.map((s) => s.macCount)).toEqual([1, 1, 0, 0]);
    expect(cmp.trafficObservation.lastObservedStage).toBe('A_PW');
    expect(cmp.findings.find((x) => x.code === 'TRAFFIC_STOPS_AFTER_STAGE')?.impactCertainty).toBe('HYPOTHESIS');
  });

  it('sem tabela MAC => observacao inconclusiva (sem achado de parada)', () => {
    const cmp = compareEndpoints(
      facts('NE8-A', 'SVC-50-502', S.SCEN_B_VSI_A, [['GigabitEthernet2/0/1.50', S.SCEN_B_CFG_A]]),
      facts('NE40-B', 'SVC-50-502', S.SCEN_B_VSI_B, [['GigabitEthernet3/0/2.502', S.SCEN_B_CFG_B]]),
    );
    expect(cmp.trafficObservation.note).toMatch(/inconclusiva/);
    expect(cmp.findings.some((x) => x.code === 'TRAFFIC_STOPS_AFTER_STAGE')).toBe(false);
  });

  it('evidencia ausente => INCONCLUSIVE, nunca OK', () => {
    const none = facts('NE40-B', 'SVC-50-502', '', []);
    expect(compareEndpoints(A(), none).status).toBe('INCONCLUSIVE');
    expect(diagnoseEndpoint(none).status).toBe('INCONCLUSIVE');
  });
});

/* ---------------------------------------------------------------------------
 * CAPTURAS REAIS: BHE-VTA-F1A-BGP-01, NetEngine 8000 F1A-8H20Q, VRP 8.220 V800R022C00SPC600,
 * coletadas em 2026-11-09 pelo fluxo MCP -> API -> SSH (aprovacao one-shot vsi-host:discovery).
 * ------------------------------------------------------------------------- */
describe('NE8000 F1A-8H20Q (captura real, 2026-11-09)', () => {
  const dir = join(__dirname, '..', '__fixtures__', 'ne8000-f1a-bhe-vta-20261109');
  const version = readFileSync(join(dir, 'version.sanitized.txt'), 'utf8');
  const vsi = readFileSync(join(dir, 'vsi.sanitized.txt'), 'utf8');

  it('identifica a plataforma a partir do display version real', () => {
    expect(classifyHuaweiVersion(version)).toMatchObject({
      family: 'NE8000_V800',
      model: 'NE8000 F1A-8H20Q',
      release: 'V800R022C00SPC600',
    });
  });

  it('display vsi real (corpo vazio) => lista completa e vazia', () => {
    expect(parseVsiList(vsi)).toEqual({ complete: true, vsis: [] });
  });

  it('nao adivinha: corpo nao vazio, erro de comando, paginacao ou sem prompt => incompleto', () => {
    const p = '<BHE-VTA-F1A-BGP-01>';
    expect(parseVsiList(`display vsi\r\nVSI-A up\r\n${p}`).complete).toBe(false);
    expect(parseVsiList(`display vsi\r\n ^\r\nError: Unrecognized command found at '^' position.\r\n${p}`).complete).toBe(false);
    expect(parseVsiList(`display vsi\r\n---- More ----\r\n${p}`).complete).toBe(false);
    expect(parseVsiList('display vsi\r\n').complete).toBe(false);
    expect(parseVsiList('').complete).toBe(false);
  });

  it('matriz: VERSION e VSI_LIST executam sem modo de homologacao; os demais continuam candidatos', () => {
    expect(resolveCapability('NE8000_V800', 'VERSION').allowed).toBe(true);
    expect(resolveCapability('NE8000_V800', 'VSI_LIST').allowed).toBe(true);
    for (const op of ['VSI_VERBOSE', 'VSI_MAC', 'INTERFACE_CONFIG', 'INTERFACE_STATE'] as const)
      expect(resolveCapability('NE8000_V800', op).allowed, op).toBe(false);
  });
});
