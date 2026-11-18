import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { classifyHuaweiVersion, resolveCapability } from './platform';
import {
  durationToSeconds, parseInterfaceConfig, parseMacTable, parseVlanInfo, parseVsiVerbose, vlanListIncludes,
} from './parsers';
import { diagnoseEndpoint, type EndpointFacts } from './correlator';
import { assertVsiMcpReadOnly, buildVsiMcpCommand, safeVsiMcpCommand, VsiMcpPolicyError } from './command-policy';
import { SshVsiMcpLiveCollector } from './live-collector';
import { testBroker } from './__fixtures__/test-broker';
import { vsiMcpProfileSchema, VsiMcpProfileError } from './access-profile';
import * as S from './__fixtures__/synthetic';

/**
 * MAC: usa a CAPTURA REAL do S6750 (BHE-VTA-S6750-MPLS-01, VSI 3066-BGP-FLASHTELECOM, 2026-11-09).
 * VLAN e config de Eth-Trunk nos primeiros blocos: textos SINTETICOS no formato VRP classico (S-series),
 * que provam a LOGICA do motor e preservam esse formato. O bloco final usa as capturas REAIS do YunShan
 * V600R024C00SPC500 (execucao 3, 2026-11-09 21:16Z), base da homologacao de `display vlan` e config de trunk.
 */
const dir = join(__dirname, '..', '__fixtures__', 's6750-vta-3066-20261109');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const VSI = '3066-BGP-FLASHTELECOM';

const VLAN_3066 = `<BHE-VTA-S6750-MPLS-01>display vlan 3066
--------------------------------------------------------------------------------
U: Up;         D: Down;         TG: Tagged;         UT: Untagged;
MP: Vlan-mapping;               ST: Vlan-stacking;
#: ProtocolTransparent-vlan;    *: Management-vlan;
--------------------------------------------------------------------------------

VID  Type    Ports
--------------------------------------------------------------------------------
3066 common  TG:Eth-Trunk1(U)    Eth-Trunk6(U)

VID  Status  Property      MAC-LRN Statistics Description
--------------------------------------------------------------------------------
3066 enable  default       enable  disable    3066-BGP-FLASHTELECOM
<BHE-VTA-S6750-MPLS-01>`;

const trunkCfg = (name: string, body: string) => `<BHE-VTA-S6750-MPLS-01>display current-configuration interface ${name}
#
interface ${name}
${body}
#
return
<BHE-VTA-S6750-MPLS-01>`;

const facts = (over: Partial<EndpointFacts> = {}): EndpointFacts => ({
  hostId: 'h-s6750',
  hostName: 'BHE-VTA-S6750-MPLS-01',
  platform: classifyHuaweiVersion(read('version.sanitized.txt')),
  vsiName: VSI,
  vsi: parseVsiVerbose(read('vsi-verbose.sanitized.txt'), VSI),
  interfaces: { Vlanif3066: parseInterfaceConfig(read('config-vlanif3066.sanitized.txt'), 'Vlanif3066') },
  macs: parseMacTable(read('mac-vsi.sanitized.txt'), VSI),
  evidenceIds: { vsi: 'ev:vsi', macs: 'ev:mac', interfaces: { Vlanif3066: 'ev:if66' } },
  ...over,
});
const withVlan = (text = VLAN_3066, id = 3066): Partial<EndpointFacts> => ({
  vlan: parseVlanInfo(text, id),
  evidenceIds: { vsi: 'ev:vsi', macs: 'ev:mac', vlan: 'ev:vlan', interfaces: { Vlanif3066: 'ev:if66' }, carriers: { 'Eth-Trunk1': 'ev:t1', 'Eth-Trunk6': 'ev:t6' } },
});
const codes = (d: ReturnType<typeof diagnoseEndpoint>) => d.findings.map((f) => f.code);

describe('MAC real do S6750: o que o motor passa a consumir', () => {
  const m = parseMacTable(read('mac-vsi.sanitized.txt'), VSI);

  it('campos completos por entrada: tipo, idade, escopo de VSI', () => {
    expect(m).toMatchObject({ complete: true, declaredTotal: 2, outOfScope: 0, incompleteReason: null });
    expect(m.entries[0]).toMatchObject({
      mac: '14eb-08bf-0001', learnedFrom: 'Eth-Trunk1', side: 'AC', type: 'dynamic', typeClass: 'DYNAMIC',
      ageSeconds: 131161, vsiColumn: VSI, flag: null,
    });
  });

  it('resumo: contagem por origem/tipo/idade e historico explicitamente indisponivel', () => {
    const d = diagnoseEndpoint(facts());
    expect(d.macSummary).toEqual({
      // AC Vlanif e a VLAN nao foi lida: nao ha evidencia de que essas portas sejam do AC => nao classificadas
      total: 2, declaredTotal: 2, viaAc: 0, viaPw: 0, viaUnresolved: 2, unresolvedOrigin: ['Eth-Trunk1', 'Eth-Trunk6'],
      byLearnedFrom: { 'Eth-Trunk1': 1, 'Eth-Trunk6': 1 }, byType: { dynamic: 2 },
      oldestAgeSeconds: 131161, newestAgeSeconds: 131156,
      pwMacFlapping: [{ peer: '10.100.101.6', counter: 0 }], history: 'NOT_AVAILABLE',
    });
    expect(d.notVerified.join(' ')).toMatch(/outra ponta/);
    expect(d.notVerified.join(' ')).toMatch(/fotografia/);
  });

  it('o contador Mac Flapping do PW e lido (0 na captura real) e nao gera achado', () => {
    const v = parseVsiVerbose(read('vsi-verbose.sanitized.txt'), VSI);
    expect(v.pws[0]!.macFlapping).toBe(0);
    expect(codes(diagnoseEndpoint(facts()))).not.toContain('MAC_FLAPPING_REPORTED');
  });

  it('Mac Flapping > 0 informado pelo equipamento => WARNING (fato confirmado, efeito provavel) e dimensao MAC em ISSUE', () => {
    const raw = read('vsi-verbose.sanitized.txt').replace('Mac Flapping           : 0', 'Mac Flapping           : 7');
    const d = diagnoseEndpoint(facts({ vsi: parseVsiVerbose(raw, VSI) }));
    expect(d.findings.find((f) => f.code === 'MAC_FLAPPING_REPORTED')).toMatchObject({ severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
    expect(d.dimensions.MAC_LEARNING).toBe('ISSUE');
    expect(d.status).toBe('WARNING');
  });

  it('campo Mac Flapping ausente => contador null (nao inventa 0)', () => {
    const raw = read('vsi-verbose.sanitized.txt').replace(/^.*Mac Flapping.*$/m, '');
    const d = diagnoseEndpoint(facts({ vsi: parseVsiVerbose(raw, VSI) }));
    expect(d.macSummary!.pwMacFlapping[0]!.counter).toBeNull();
  });

  it('escopo: linha de OUTRA VSI invalida a tabela (consulta nao pode vazar para outra VSI)', () => {
    const leaked = read('mac-vsi.sanitized.txt').replace('-/3066-BGP-FLASHTELECOM/- Eth-Trunk6', '-/OUTRA-VSI/-                Eth-Trunk6');
    const t = parseMacTable(leaked, VSI);
    expect(t).toMatchObject({ complete: false, outOfScope: 1, incompleteReason: 'OUT_OF_SCOPE' });
    const d = diagnoseEndpoint(facts({ macs: t }));
    expect(codes(d)).toContain('MAC_TABLE_INCOMPLETE');
    expect(d.findings.find((f) => f.code === 'MAC_TABLE_INCOMPLETE')!.explanation).toMatch(/outra VSI/);
    expect(d.dimensions.MAC_LEARNING).toBe('NOT_EVALUATED');
  });

  it('truncamento: total declarado diferente das linhas => incompleto, sinalizado e nunca OK', () => {
    const t = parseMacTable(read('mac-vsi.sanitized.txt').replace('Total items: 2', 'Total items: 40'), VSI);
    expect(t).toMatchObject({ complete: false, incompleteReason: 'TOTAL_MISMATCH' });
    const d = diagnoseEndpoint(facts({ macs: t }));
    expect(d.findings.find((f) => f.code === 'MAC_TABLE_INCOMPLETE')!.explanation).toMatch(/truncada/);
    expect(d.status).toBe('INCONCLUSIVE');
  });

  it('paginacao (More) => incompleto', () => {
    expect(parseMacTable('MAC Address ...\n---- More ----', VSI)).toMatchObject({ complete: false, incompleteReason: 'PAGED' });
  });

  it('tipos nao dinamicos: static e informativo; blackhole e WARNING', () => {
    const base = read('mac-vsi.sanitized.txt');
    const st = parseMacTable(base.replace('dynamic          131161', 'static           -').replace('Total items: 2', 'Total items: 2'), VSI);
    expect(st.entries[0]).toMatchObject({ typeClass: 'STATIC', ageSeconds: null });
    expect(diagnoseEndpoint(facts({ macs: st })).findings.find((f) => f.code === 'MAC_NON_DYNAMIC_PRESENT')).toMatchObject({ severity: 'INFO' });
    const bh = parseMacTable(base.replace('dynamic          131156', 'blackhole        -'), VSI);
    expect(bh.entries[1]!.typeClass).toBe('BLACKHOLE');
    expect(diagnoseEndpoint(facts({ macs: bh })).findings.find((f) => f.code === 'MAC_BLACKHOLE_PRESENT')).toMatchObject({ severity: 'WARNING' });
  });

  it('MAC duplicado na tabela da VSI e hipotese informativa', () => {
    const dup = parseMacTable(read('mac-vsi.sanitized.txt').replace('f0a9-511e-0002', '14eb-08bf-0001'), VSI);
    const f = diagnoseEndpoint(facts({ macs: dup })).findings.find((x) => x.code === 'MAC_DUPLICATE_IN_TABLE')!;
    expect(f).toMatchObject({ severity: 'INFO', impactCertainty: 'HYPOTHESIS' });
  });

  it('local/remoto NAO e inventado: so a origem do campo Learned-From (interface vs peer)', () => {
    const t = parseMacTable(read('mac-vsi.sanitized.txt').replace('Eth-Trunk6 ', '10.100.101.6'), VSI);
    expect(t.entries.map((e) => e.side)).toEqual(['AC', 'PW']);
    // Nao existe campo "local"/"remote" no modelo.
    expect(Object.keys(t.entries[0]!)).not.toContain('origin');
  });

  it('AC de subinterface: MAC aprendido em interface que nao e o AC => informativo', () => {
    const v = parseVsiVerbose(read('vsi-verbose.sanitized.txt').replace('Vlanif3066', 'GigabitEthernet0/0/1.100'), VSI);
    const d = diagnoseEndpoint(facts({ vsi: v, interfaces: {} }));
    expect(d.findings.find((f) => f.code === 'MAC_LEARNED_ON_NON_AC_INTERFACE')).toMatchObject({ severity: 'INFO', impactCertainty: 'HYPOTHESIS' });
  });

  it('AC Vlanif: aprendizado em Eth-Trunk e esperado (sem achado de interface estranha)', () => {
    expect(codes(diagnoseEndpoint(facts()))).not.toContain('MAC_LEARNED_ON_NON_AC_INTERFACE');
  });
});

describe('display vlan: parser (formato VRP padrao, sintetico)', () => {
  it('VLAN existente: tipo, status, descricao e portas com tagging/estado', () => {
    expect(parseVlanInfo(VLAN_3066, 3066)).toEqual({
      complete: true, vlanId: 3066, exists: true, vlanType: 'common', status: 'ENABLE', description: '3066-BGP-FLASHTELECOM',
      ports: [
        { name: 'Eth-Trunk1', tagging: 'TAGGED', state: 'UP' },
        { name: 'Eth-Trunk6', tagging: 'TAGGED', state: 'UP' },
      ],
      macLearning: null, forwarding: null,
    });
  });
  it('marcadores UT / ST / MP e continuacao de linha', () => {
    const t = `display vlan 10
VID  Type    Ports
--------------------------------------------------------------------------------
10   common  UT:GE0/0/1(U)    GE0/0/2(D)
                TG:XGE0/0/1(U)
                ST:XGE0/0/2(U)
                MP:XGE0/0/3(U)

VID  Status  Property      MAC-LRN Statistics Description
10   enable  default       enable  disable    VLAN 0010
`;
    expect(parseVlanInfo(t, 10).ports).toEqual([
      { name: 'GE0/0/1', tagging: 'UNTAGGED', state: 'UP' },
      { name: 'GE0/0/2', tagging: 'UNTAGGED', state: 'DOWN' },
      { name: 'XGE0/0/1', tagging: 'TAGGED', state: 'UP' },
      { name: 'XGE0/0/2', tagging: 'STACKING', state: 'UP' },
      { name: 'XGE0/0/3', tagging: 'MAPPING', state: 'UP' },
    ]);
  });
  it('VLAN inexistente explicita => completa com exists=false', () => {
    expect(parseVlanInfo('display vlan 3066\nError: The VLAN does not exist.\n<H>', 3066)).toMatchObject({ complete: true, exists: false });
  });
  it('formato desconhecido, outra VLAN ou paginado => incompleto (nada adivinhado)', () => {
    expect(parseVlanInfo('<H>display vlan 3066\nUnrecognized command\n<H>', 3066).complete).toBe(false);
    expect(parseVlanInfo(VLAN_3066, 3067).complete).toBe(false);
    expect(parseVlanInfo(VLAN_3066 + '\n---- More ----', 3066).complete).toBe(false);
  });
});

describe('config de porta/trunk: allow-pass e hybrid', () => {
  it('listas de VLAN: faixas, all e nao interpretavel', () => {
    expect(vlanListIncludes(['3000 to 3100'], 3066)).toBe(true);
    expect(vlanListIncludes(['10 20', '3066'], 3066)).toBe(true);
    expect(vlanListIncludes(['10 to 20 30'], 3066)).toBe(false);
    expect(vlanListIncludes(['all'], 3066)).toBe(true);
    expect(vlanListIncludes(['abc'], 3066)).toBeNull();
    expect(vlanListIncludes([], 3066)).toBeNull();
  });
  it('Eth-Trunk trunk: link-type, pvid e allow-pass', () => {
    const c = parseInterfaceConfig(trunkCfg('Eth-Trunk1', ' port link-type trunk\n port trunk pvid vlan 1\n port trunk allow-pass vlan 3000 to 3100\n mode lacp-static'), 'Eth-Trunk1');
    expect(c).toMatchObject({ complete: true, mode: 'L2_PORT', portVlan: { linkType: 'TRUNK', trunkAllow: ['3000 to 3100'], pvid: 1 } });
  });
  it('porta hybrid e access', () => {
    expect(parseInterfaceConfig(trunkCfg('GE0/0/1', ' port link-type hybrid\n port hybrid tagged vlan 3066\n port hybrid untagged vlan 10'), 'GE0/0/1').portVlan)
      .toMatchObject({ linkType: 'HYBRID', hybridTagged: ['3066'], hybridUntagged: ['10'] });
    expect(parseInterfaceConfig(trunkCfg('GE0/0/2', ' port link-type access\n port default vlan 3066'), 'GE0/0/2').portVlan)
      .toMatchObject({ linkType: 'ACCESS', defaultVlan: 3066 });
  });
});

describe('encapsulamento: so OK com evidencia suficiente, e sempre LOCAL', () => {
  it('sem display vlan => continua INCONCLUSIVE (comportamento da captura real)', () => {
    const d = diagnoseEndpoint(facts());
    expect(d.dimensions.ENCAPSULATION).toBe('NOT_EVALUATED');
    expect(d.status).toBe('INCONCLUSIVE');
  });

  it('VLAN existe/enable + MAC aprendido em portas tagged da VLAN => encapsulamento LOCAL comprovado', () => {
    const d = diagnoseEndpoint(facts(withVlan()));
    expect(d.dimensions.ENCAPSULATION).toBe('OK');
    const f = d.findings.find((x) => x.code === 'ENCAPSULATION_LOCAL_PROVEN')!;
    expect(f).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
    expect(f.explanation).toMatch(/Eth-Trunk1: tagged, up, config da porta nao lida/);
    expect(f.caveat).toMatch(/nao implica conectividade/);
    expect(f.evidence).toEqual(expect.arrayContaining(['ev:vlan', 'ev:mac', 'ev:if66']));
    expect(d.status).toBe('OK');
    expect(d.notVerified.join(' ')).toMatch(/outra ponta/); // OK local nunca vira "ponta a ponta"
  });

  it('com config dos trunks coerente (allow-pass inclui a VLAN) => relacao reforcada', () => {
    const carriers = {
      'Eth-Trunk1': parseInterfaceConfig(trunkCfg('Eth-Trunk1', ' port link-type trunk\n port trunk allow-pass vlan 3000 to 3100'), 'Eth-Trunk1'),
      'Eth-Trunk6': parseInterfaceConfig(trunkCfg('Eth-Trunk6', ' port link-type trunk\n port trunk allow-pass vlan all'), 'Eth-Trunk6'),
    };
    const d = diagnoseEndpoint(facts({ ...withVlan(), carriers }));
    expect(d.dimensions.ENCAPSULATION).toBe('OK');
    expect(d.findings.find((x) => x.code === 'ENCAPSULATION_LOCAL_PROVEN')!.explanation).toMatch(/config da porta permite a VLAN/);
  });

  it('config do trunk NAO permite a VLAN apesar do MAC => ISSUE (WARNING) com contradicao registrada', () => {
    const carriers = { 'Eth-Trunk1': parseInterfaceConfig(trunkCfg('Eth-Trunk1', ' port link-type trunk\n port trunk allow-pass vlan 10 to 20'), 'Eth-Trunk1') };
    const d = diagnoseEndpoint(facts({ ...withVlan(), carriers }));
    expect(d.dimensions.ENCAPSULATION).toBe('ISSUE');
    expect(d.findings.find((x) => x.code === 'CARRIER_CONFIG_CONTRADICTS_VLAN')).toMatchObject({ severity: 'WARNING', certainty: 'CONFIRMED' });
    expect(d.status).toBe('WARNING');
  });

  it('VLAN inexistente ou desabilitada => ISSUE confirmado; existencia sozinha nunca basta', () => {
    const nf = diagnoseEndpoint(facts(withVlan('display vlan 3066\nError: The VLAN does not exist.\n<H>')));
    expect(nf.dimensions.ENCAPSULATION).toBe('ISSUE');
    expect(codes(nf)).toContain('VLAN_NOT_FOUND');
    const dis = diagnoseEndpoint(facts(withVlan(VLAN_3066.replace('3066 enable', '3066 disable'))));
    expect(codes(dis)).toContain('VLAN_DISABLED');
  });

  it('porta onde o MAC foi aprendido NAO consta na VLAN => nao avaliado (nao presume)', () => {
    const d = diagnoseEndpoint(facts(withVlan(VLAN_3066.replace('Eth-Trunk6(U)', ''))));
    expect(d.dimensions.ENCAPSULATION).toBe('NOT_EVALUATED');
    expect(d.findings.find((x) => x.code === 'ENCAPSULATION_NOT_EVALUATED')!.explanation).toMatch(/Eth-Trunk6.*nao consta/);
    expect(d.status).toBe('INCONCLUSIVE');
  });

  it('vlan-stacking/mapping na porta => transformacao registrada e encapsulamento nao avaliado', () => {
    const d = diagnoseEndpoint(facts(withVlan(VLAN_3066.replace('TG:Eth-Trunk1(U)', 'ST:Eth-Trunk1(U)'))));
    expect(d.dimensions.ENCAPSULATION).toBe('NOT_EVALUATED');
    expect(d.findings.find((x) => x.code === 'VLAN_TRANSFORM_ON_CARRIER')).toMatchObject({ certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
  });

  it('sem MAC aprendido nao ha como ligar portas ao servico => nao avaliado', () => {
    const d = diagnoseEndpoint(facts({ ...withVlan(), macs: parseMacTable(read('mac-vsi.sanitized.txt').replace(/^14eb[^\n]*\n|^f0a9[^\n]*\n/gm, '').replace('Total items: 2', 'Total items: 0'), VSI) }));
    expect(d.dimensions.ENCAPSULATION).toBe('NOT_EVALUATED');
    expect(d.findings.find((x) => x.code === 'ENCAPSULATION_NOT_EVALUATED')!.explanation).toMatch(/relacao porta-servico nao pode ser comprovada/);
  });

  it('saida de VLAN incompleta ou de outra VLAN => INCONCLUSIVE', () => {
    expect(codes(diagnoseEndpoint(facts(withVlan('<H>display vlan 3066\nUnrecognized command\n<H>'))))).toContain('VLAN_OUTPUT_INCOMPLETE');
    expect(codes(diagnoseEndpoint(facts({ ...withVlan(), vlan: parseVlanInfo(VLAN_3066.replace(/3066/g, '3067'), 3067) })))).toContain('VLAN_AC_NUMBER_MISMATCH');
  });

  it('ausencia de MAC via PW continua nao sendo falha, mesmo com encapsulamento OK', () => {
    const d = diagnoseEndpoint(facts(withVlan()));
    expect(d.findings.find((x) => x.code === 'NO_MAC_FROM_PW')).toMatchObject({ severity: 'INFO', impactCertainty: 'HYPOTHESIS' });
    expect(d.status).toBe('OK');
  });
});

describe('guard dos novos comandos', () => {
  it('display vlan <1..4094> e permitido; construcao e allowlist concordam', () => {
    for (const id of [1, 10, 999, 3066, 4000, 4094]) {
      expect(safeVsiMcpCommand({ kind: 'VLAN_INFO', vlanId: id })).toBe(`display vlan ${id}`);
    }
  });
  it('VLAN fora da faixa ou nao inteira nao vira comando', () => {
    for (const id of [0, 4095, -1, 30.5, Number.NaN]) {
      expect(() => buildVsiMcpCommand({ kind: 'VLAN_INFO', vlanId: id })).toThrow(VsiMcpPolicyError);
    }
  });
  it('variantes livres de display vlan sao bloqueadas', () => {
    for (const c of ['display vlan', 'display vlan all', 'display vlan 3066 verbose', 'display vlan 3066 to 3070', 'display vlan 0', 'display vlan 4095',
      'display vlan 30;66', 'display vlan 3066 | include x', 'display vlan  3066', 'display vlan 03066', 'display vlan summary', 'display vlan 3066\nsystem-view'])
      expect(() => assertVsiMcpReadOnly(c), c).toThrow(VsiMcpPolicyError);
  });
  it('interface arbitraria continua passando pelo mesmo guard (so display current-configuration interface)', () => {
    expect(safeVsiMcpCommand({ kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk1', role: 'CARRIER' })).toBe('display current-configuration interface Eth-Trunk1');
    expect(() => safeVsiMcpCommand({ kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk1; system-view', role: 'CARRIER' })).toThrow(VsiMcpPolicyError);
    expect(() => assertVsiMcpReadOnly('display current-configuration')).toThrow(VsiMcpPolicyError);
    expect(() => assertVsiMcpReadOnly('display current-configuration | include password')).toThrow(VsiMcpPolicyError);
  });
  it('matriz: VLAN_INFO homologado so no S6750 YunShan; candidato (so com homologation) nas demais; UNKNOWN nao suportado', () => {
    expect(resolveCapability('S6750_YUNSHAN_V600', 'VLAN_INFO', false)).toMatchObject({ allowed: true, reason: 'HOMOLOGATED' });
    for (const fam of ['S6730_V200', 'NE8000_V800', 'NE40E_V800'] as const) {
      expect(resolveCapability(fam, 'VLAN_INFO', false)).toMatchObject({ allowed: false, reason: 'CANDIDATE_NOT_HOMOLOGATED' });
      expect(resolveCapability(fam, 'VLAN_INFO', true)).toMatchObject({ allowed: true, reason: 'HOMOLOGATION_MODE' });
    }
    expect(resolveCapability('UNKNOWN', 'VLAN_INFO', true).allowed).toBe(false);
  });
});

describe('escopo fechado no perfil do host: VLAN e interfaces aprovadas', () => {
  const host = (): HostRecord =>
    ({ id: 'h', name: 'H', vendor: 'Huawei', sshEnabled: true, ssh: { host: '10.0.0.1', port: 2222, username: 'u', contextCommand: null, credentialConfigured: true } }) as unknown as HostRecord;
  const profile = (extra: Record<string, unknown> = {}) =>
    vsiMcpProfileSchema.parse({
      hostId: 'h', endpoint: '10.0.0.1', port: 2222, username: 'u', context: null, fingerprint: 'SHA256:' + 'A'.repeat(43),
      initialPrompt: '<H>', expectedPrompt: '<H>', vendor: 'HUAWEI', family: 'NE8000_V800', disablePagingTemporary: true,
      validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      operations: ['VERSION', 'VLAN_INFO', 'INTERFACE_CONFIG'], ...extra,
    });
  const sent: string[] = [];
  const make = (p: ReturnType<typeof profile>) =>
    new SshVsiMcpLiveCollector(
      { getHost: async () => host() } as never,
      testBroker({ getHost: async () => host(), getDecryptedSshCredentials: async () => ({ password: 'pw' }) }, [p]),
      (opts) => ({
        async execute(_h: string, commands: string[]) {
          const d = opts.diagnostic!;
          for (const c of [d.sessionPreparation!, ...commands]) {
            sent.push(c);
            d.onCommand(c);
            d.onCommandComplete?.({ command: c, stdout: c === 'display version' ? S.NE_VERSION : `<H>${c}\n<H>`, completedAt: '2026-11-09T12:00:00.000Z' });
          }
          return [{ stdout: '', stderr: '', exitCode: 0 }];
        },
      }),
      0,
    );
  const run = (c: SshVsiMcpLiveCollector, ops: Parameters<SshVsiMcpLiveCollector['collect']>[1]) =>
    c.collect(host(), ops, { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X', homologation: true });

  it('perfil sem vlans: VLAN_INFO bloqueado ANTES de qualquer SSH', async () => {
    sent.length = 0;
    await expect(run(make(profile()), [{ kind: 'VLAN_INFO', vlanId: 3066 }])).rejects.toBeInstanceOf(VsiMcpProfileError);
    expect(sent).toHaveLength(0);
  });
  it('VLAN fora da lista do perfil e bloqueada; VLAN listada passa', async () => {
    sent.length = 0;
    const c = make(profile({ vlans: [3066] }));
    await expect(run(c, [{ kind: 'VLAN_INFO', vlanId: 3067 }])).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    expect(sent).toHaveLength(0);
    await run(c, [{ kind: 'VLAN_INFO', vlanId: 3066 }]);
    expect(sent.filter((x) => x.startsWith('display'))).toEqual(['display version', 'display vlan 3066']);
  });
  it('interface transportadora fora da lista do perfil e bloqueada; AC nao precisa constar', async () => {
    sent.length = 0;
    const c = make(profile({ carrierInterfaces: ['Eth-Trunk1', 'Eth-Trunk6'] }));
    await expect(run(c, [{ kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk9', role: 'CARRIER' }])).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    expect(sent).toHaveLength(0);
    await run(c, [
      { kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk1', role: 'CARRIER' },
      { kind: 'INTERFACE_CONFIG', interfaceName: 'Vlanif3066' },
    ]);
    expect(sent.filter((x) => x.startsWith('display'))).toEqual([
      'display version', 'display current-configuration interface Eth-Trunk1', 'display current-configuration interface Vlanif3066',
    ]);
  });
  it('preflight valida o escopo SEM abrir SSH (nenhum comando enviado)', async () => {
    sent.length = 0;
    const c = make(profile({ vlans: [3066], carrierInterfaces: ['Eth-Trunk1'] }));
    await expect(c.preflight(host(), [{ kind: 'VLAN_INFO', vlanId: 3067 }], 'vsi-name:X')).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    await expect(c.preflight(host(), [{ kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk2', role: 'CARRIER' }], 'vsi-name:X')).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    await expect(c.preflight(host(), [{ kind: 'VSI_LIST' }], 'vsi-name:X')).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    await expect(c.preflight(host(), [{ kind: 'VLAN_INFO', vlanId: 3066 }, { kind: 'INTERFACE_CONFIG', interfaceName: 'Eth-Trunk1', role: 'CARRIER' }], 'vsi-name:X')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
  it('perfil: VLAN invalida e interface insegura sao recusadas na leitura do arquivo', () => {
    expect(() => profile({ vlans: [0] })).toThrow();
    expect(() => profile({ vlans: [4095] })).toThrow();
    expect(() => profile({ carrierInterfaces: ['Eth-Trunk1; system-view'] })).toThrow();
    expect(() => profile({ carrierInterfaces: Array.from({ length: 9 }, (_, i) => `Eth-Trunk${i + 1}`) })).toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * CAPTURA REAL (2026-11-09 21:16Z, S6750 YunShan V600R024C00SPC500): display vlan 3066 e config dos Eth-Trunks.
 * Descricoes removidas; allow-pass de Eth-Trunk1 reduzido a um subconjunto representativo.
 * ------------------------------------------------------------------------- */
describe('S6750 real: display vlan 3066 + Eth-Trunk1/6', () => {
  const realFacts = (over: Partial<EndpointFacts> = {}): EndpointFacts => ({
    ...facts(),
    persistedAcs: ['Vlanif3064', 'Vlanif3066'],
    interfaces: {
      Vlanif3064: parseInterfaceConfig(read('config-vlanif3064.sanitized.txt'), 'Vlanif3064'),
      Vlanif3066: parseInterfaceConfig(read('config-vlanif3066.sanitized.txt'), 'Vlanif3066'),
    },
    vlan: parseVlanInfo(read('vlan-3066.sanitized.txt'), 3066),
    carriers: {
      'Eth-Trunk1': parseInterfaceConfig(read('config-eth-trunk1.sanitized.txt'), 'Eth-Trunk1'),
      'Eth-Trunk6': parseInterfaceConfig(read('config-eth-trunk6.sanitized.txt'), 'Eth-Trunk6'),
    },
    evidenceIds: { vsi: 'ev:vsi', macs: 'ev:mac', vlan: 'ev:vlan', interfaces: { Vlanif3066: 'ev:if66' }, carriers: { 'Eth-Trunk1': 'ev:t1', 'Eth-Trunk6': 'ev:t6' } },
    ...over,
  });

  it('parser do formato REAL: tabela "VID Ports" + tabela de propriedades', () => {
    expect(parseVlanInfo(read('vlan-3066.sanitized.txt'), 3066)).toEqual({
      complete: true, vlanId: 3066, exists: true, vlanType: 'common', status: 'ENABLE', description: 'VLAN 3066',
      ports: [{ name: 'Eth-Trunk1', tagging: 'TAGGED', state: 'UP' }],
      macLearning: 'ENABLE', forwarding: { broadcast: 'FWD', multicast: 'FWD', unknownUnicast: 'FWD' },
    });
    expect(parseVlanInfo(read('vlan-3066.sanitized.txt'), 3067).complete).toBe(false);
  });

  it('parser de config dos trunks reais: Eth-Trunk1 permite 3066 (faixa 3061 to 3067); Eth-Trunk6 so a 1602', () => {
    const t1 = parseInterfaceConfig(read('config-eth-trunk1.sanitized.txt'), 'Eth-Trunk1');
    const t6 = parseInterfaceConfig(read('config-eth-trunk6.sanitized.txt'), 'Eth-Trunk6');
    expect(t1).toMatchObject({ complete: true, mode: 'L2_PORT', portVlan: { linkType: 'TRUNK' } });
    expect(vlanListIncludes(t1.portVlan!.trunkAllow, 3066)).toBe(true);
    expect(vlanListIncludes(t1.portVlan!.trunkAllow, 3068)).toBe(false);
    expect(vlanListIncludes(t6.portVlan!.trunkAllow, 3066)).toBe(false);
    expect(vlanListIncludes(t6.portVlan!.trunkAllow, 1602)).toBe(true);
  });

  // Regressao (investigacao Eth-Trunk6, 2026-11-10): a primeira versao do motor emitia WARNING
  // `MAC_ON_PORT_OUTSIDE_VLAN` assumindo que Learned-From = porta de acesso local. Com PW up, o campo
  // nao distingue porta de acesso de interface de saida do tunel do PW (Eth-Trunk6 = LACP para outro no
  // MPLS, so VLAN 1602; MAC aprendido segundos apos o ultimo up do PW). Resultado correto: INCONCLUSIVE.
  it('diagnostico real: Eth-Trunk1 comprovada; Eth-Trunk6 fora da VLAN com PW up => origem INDETERMINADA (INCONCLUSIVE), nao WARNING e nunca OK', () => {
    const d = diagnoseEndpoint(realFacts());
    expect(d.dimensions).toEqual({
      VSI_STATE: 'OK', AC_STATE: 'OK', PW_STATE: 'OK', AC_BINDING: 'OK', MAC_LEARNING: 'OK', ENCAPSULATION: 'NOT_EVALUATED',
    });
    expect(d.status).toBe('INCONCLUSIVE');
    expect(d.findings.some((f) => f.severity === 'WARNING' || f.severity === 'CRITICAL')).toBe(false);
    expect(d.findings.find((f) => f.code === 'CARRIER_PORT_VLAN_PROVEN')).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
    expect(d.findings.some((f) => f.code === 'MAC_ON_PORT_OUTSIDE_VLAN')).toBe(false);
    const u = d.findings.find((f) => f.code === 'MAC_ORIGIN_UNRESOLVED')!;
    expect(u).toMatchObject({ severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE' });
    expect(u.title).toContain('Eth-Trunk6');
    expect(u.explanation).toMatch(/interface de saida do tunel do PW/);
    expect(u.caveat).toMatch(/Nao e inconsistencia confirmada nem prova de transporte/);
    expect(u.evidence).toEqual(expect.arrayContaining(['ev:vlan', 'ev:t6', 'ev:mac']));
    // A entrada indeterminada nao conta como AC nem como PW e "nenhum MAC via PW" deixa de ser afirmado.
    expect(d.macSummary).toMatchObject({ viaAc: 1, viaPw: 0, viaUnresolved: 1, unresolvedOrigin: ['Eth-Trunk6'] });
    expect(d.findings.some((f) => f.code === 'NO_MAC_FROM_PW')).toBe(false);
    expect(d.notVerified.join(' ')).toMatch(/Eth-Trunk6/);
    expect(d.findings.some((f) => f.code === 'ENCAPSULATION_LOCAL_PROVEN')).toBe(false);
    expect(d.findings.find((f) => f.code === 'PERSISTED_AC_OBSOLETE')).toBeTruthy();
  });

  it('mesma situacao SEM PW up: nao ha tunel que explique a entrada => WARNING MAC_ON_PORT_OUTSIDE_VLAN mantido (ENCAPSULATION=ISSUE)', () => {
    const down = parseVsiVerbose(read('vsi-verbose.sanitized.txt').replace('PW State               : up', 'PW State               : down'), VSI);
    const d = diagnoseEndpoint(realFacts({ vsi: down }));
    expect(d.findings.find((f) => f.code === 'MAC_ON_PORT_OUTSIDE_VLAN')).toMatchObject({ severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
    expect(d.findings.some((f) => f.code === 'MAC_ORIGIN_UNRESOLVED')).toBe(false);
    expect(d.dimensions.ENCAPSULATION).toBe('ISSUE');
    // Eth-Trunk1 esta na VLAN (AC comprovado); Eth-Trunk6 esta FORA dela: o WARNING acima permanece e a entrada nao e contada como AC
    expect(d.macSummary).toMatchObject({ total: 2, viaAc: 1, viaPw: 0, viaUnresolved: 1, unresolvedOrigin: ['Eth-Trunk6'] });

    const noPw = parseVsiVerbose(read('vsi-verbose.sanitized.txt').replace(/^ {2}\*\*PW Information:[\s\S]*?(?=<BHE)/m, ''), VSI);
    expect(noPw.pws).toEqual([]);
    expect(diagnoseEndpoint(realFacts({ vsi: noPw })).findings.find((f) => f.code === 'MAC_ON_PORT_OUTSIDE_VLAN')).toBeTruthy();
  });

  it('PW Total Up Time e lido (YunShan e VRP classico) e vira totalUpSeconds', () => {
    expect(durationToSeconds('1 days, 8 hours, 47 minutes, 39 seconds')).toBe(118059);
    expect(durationToSeconds('15 days, 4 hours, 35 minutes, 54 seconds')).toBe(1312554);
    expect(durationToSeconds('5 minutes, 2 seconds')).toBe(302);
    expect(durationToSeconds('--')).toBeNull();
    expect(durationToSeconds('1 fortnight')).toBeNull();
    expect(parseVsiVerbose(read('vsi-verbose.sanitized.txt'), VSI).pws[0]!.totalUpSeconds).toBe(118059);
    const classic = readFileSync(join(__dirname, '..', '__fixtures__', 'bhe-vta-local-full-20261022', 'vsi.sanitized.txt'), 'utf8');
    const name = /VSI Name\s*:\s*(\S+)/.exec(classic)![1]!;
    expect(parseVsiVerbose(classic, name).pws[0]!.totalUpSeconds).toBe(1312554);
  });

  it('relacao temporal MAC x PW na mesma sessao: ages da execucao 3 (141470/141465) x PW uptime coerente => MAC_LEARNED_AT_PW_UP', () => {
    // Fixtures locais misturam execucoes (verbose da exec. 1, MAC da exec. 2): com elas a relacao NAO e afirmada.
    expect(codes(diagnoseEndpoint(realFacts()))).not.toContain('MAC_LEARNED_AT_PW_UP');
    // Valores da execucao 3 (21:16Z): PW Total Up Time no instante do verbose = 141469 s; Age = 141470 e 141465.
    const vsi3 = parseVsiVerbose(read('vsi-verbose.sanitized.txt').replace('PW Total Up Time       : 1 days, 8 hours, 47 minutes, 39 seconds', 'PW Total Up Time       : 1 days, 15 hours, 17 minutes, 49 seconds'), VSI);
    expect(vsi3.pws[0]!.totalUpSeconds).toBe(141469);
    const mac3 = parseMacTable(read('mac-vsi.sanitized.txt').replace('131161', '141470').replace('131156', '141465'), VSI);
    const d = diagnoseEndpoint(realFacts({ vsi: vsi3, macs: mac3 }));
    const t = d.findings.find((f) => f.code === 'MAC_LEARNED_AT_PW_UP')!;
    expect(t).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
    expect(t.explanation).toMatch(/Eth-Trunk1\) -1 s/);
    expect(t.explanation).toMatch(/Eth-Trunk6\) \+4 s/);
    expect(d.findings.find((f) => f.code === 'MAC_ORIGIN_UNRESOLVED')!.explanation).toMatch(/4 s depois do ultimo up do PW/);
    // MAC muito mais antigo que o PW (ou muito posterior) nao gera o achado.
    const old = parseMacTable(read('mac-vsi.sanitized.txt').replace('131161', '141470').replace('131156', '999999'), VSI);
    expect(codes(diagnoseEndpoint(realFacts({ vsi: vsi3, macs: old })))).not.toContain('MAC_LEARNED_AT_PW_UP');
  });

  it('sem a config do Eth-Trunk6 a origem tambem nao e afirmada: NOT_EVALUATED e INCONCLUSIVE (ausencia de evidencia nao vira OK)', () => {
    const f = realFacts();
    delete f.carriers!['Eth-Trunk6'];
    const d = diagnoseEndpoint(f);
    expect(d.dimensions.ENCAPSULATION).toBe('NOT_EVALUATED');
    expect(d.status).toBe('INCONCLUSIVE');
    expect(d.findings.some((x) => x.code === 'MAC_ON_PORT_OUTSIDE_VLAN' || x.code === 'MAC_ORIGIN_UNRESOLVED')).toBe(false);
    // sem a config do Eth-Trunk6 nao ha evidencia de que ele carregue a VLAN: a entrada fica nao classificada (nem AC nem PW)
    expect(d.macSummary).toMatchObject({ total: 2, viaAc: 1, viaPw: 0, viaUnresolved: 1, unresolvedOrigin: ['Eth-Trunk6'] });
    expect(d.findings.find((x) => x.code === 'CARRIER_PORT_VLAN_PROVEN')).toBeTruthy();
  });

  it('sem config do Eth-Trunk1: continua comprovada pela tabela da VLAN, marcando "config da porta nao lida"', () => {
    const f = realFacts();
    delete f.carriers!['Eth-Trunk1'];
    const d = diagnoseEndpoint(f);
    expect(d.findings.find((x) => x.code === 'CARRIER_PORT_VLAN_PROVEN')!.explanation).toMatch(/config da porta nao lida/);
  });

  it('se so Eth-Trunk1 aprendesse MAC, o encapsulamento LOCAL seria comprovado (OK) e o status OK', () => {
    const only1 = parseMacTable(read('mac-vsi.sanitized.txt').replace(/^f0a9[^\n]*\n/m, '').replace('Total items: 2', 'Total items: 1'), VSI);
    const d = diagnoseEndpoint(realFacts({ macs: only1 }));
    expect(d.dimensions.ENCAPSULATION).toBe('OK');
    expect(d.findings.find((x) => x.code === 'ENCAPSULATION_LOCAL_PROVEN')).toMatchObject({ certainty: 'CONFIRMED' });
    expect(d.status).toBe('OK');
    expect(d.notVerified.join(' ')).toMatch(/outra ponta/);
  });

  it('propriedades da VLAN: MAC-LRN desabilitado e descarte de BC/MC/UC sao sinalizados', () => {
    const raw = read('vlan-3066.sanitized.txt').replace('enable  disable FWD FWD FWD', 'disable disable DSD FWD FWD');
    const v = parseVlanInfo(raw, 3066);
    expect(v).toMatchObject({ macLearning: 'DISABLE', forwarding: { broadcast: 'DSD' } });
    const d = diagnoseEndpoint(realFacts({ vlan: v }));
    expect(d.findings.find((x) => x.code === 'VLAN_MAC_LEARNING_DISABLED')).toMatchObject({ severity: 'WARNING' });
    expect(d.findings.find((x) => x.code === 'VLAN_FORWARDING_DISCARD')!.title).toContain('broadcast');
  });

  it('Age = segundos desde o aprendizado: duas capturas reais (18:24:39Z e 21:16:28Z) diferem pelo tempo decorrido', () => {
    // MACs e portas identicos nas duas capturas; 131161 -> 141470 = +10309 s = 21:16:28 - 18:24:39.
    expect(141470 - 131161).toBe(Date.parse('2026-11-09T21:16:28Z') / 1000 - Date.parse('2026-11-09T18:24:39Z') / 1000);
  });
});
