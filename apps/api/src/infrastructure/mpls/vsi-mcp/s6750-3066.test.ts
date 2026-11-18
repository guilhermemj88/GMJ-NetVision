import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyHuaweiVersion } from './platform';
import { parseInterfaceConfig, parseMacTable, parseVsiVerbose, type ParsedVsiVerbose } from './parsers';
import { compareEndpoints, diagnoseEndpoint, type EndpointFacts } from './correlator';
import { SshVsiMcpLiveCollector, VsiMcpLiveError } from './live-collector';
import { testBroker } from './__fixtures__/test-broker';
import { vsiMcpProfileSchema } from './access-profile';
import type { HostRecord } from '@gmj/shared';
import * as S from './__fixtures__/synthetic';

/**
 * CAPTURA REAL: BHE-VTA-S6750-MPLS-01 (S6750-H36C, YunShan OS 1.24.0.1, S6700 V600R024C00SPC500),
 * VSI 3066-BGP-FLASHTELECOM, 2026-11-09 14:46Z, via MCP -> API -> SSH (aprovacao one-shot).
 * Sessao 1 de 2 (version + verbose). Config de interface e MAC NAO foram coletados.
 */
const dir = join(__dirname, '..', '__fixtures__', 's6750-vta-3066-20261109');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const VSI = '3066-BGP-FLASHTELECOM';

const facts = (over: Partial<EndpointFacts> = {}): EndpointFacts => ({
  hostId: 'h-s6750',
  hostName: 'BHE-VTA-S6750-MPLS-01',
  platform: classifyHuaweiVersion(read('version.sanitized.txt')),
  vsiName: VSI,
  vsi: parseVsiVerbose(read('vsi-verbose.sanitized.txt'), VSI),
  interfaces: {},
  macs: null,
  evidenceIds: { vsi: 'ev:vsi', interfaces: {} },
  ...over,
});

describe('S6750 real: identificacao e parser da VSI 3066-BGP-FLASHTELECOM', () => {
  it('plataforma', () => {
    expect(classifyHuaweiVersion(read('version.sanitized.txt'))).toMatchObject({
      family: 'S6750_YUNSHAN_V600',
      release: 'V600R024C00SPC500',
    });
  });

  it('VSI, AC unico e PW da captura real', () => {
    const v = parseVsiVerbose(read('vsi-verbose.sanitized.txt'), VSI);
    expect(v).toMatchObject({
      complete: true, state: 'UP', signaling: 'bgp', encapsulationType: 'vlan', mtu: 1500, vsiIndex: 28, rd: '268568:3066',
    });
    expect(v.acs).toEqual([{ interfaceName: 'Vlanif3066', state: 'UP', acBlockState: 'unblocked', accessPort: false }]);
    expect(v.pws).toHaveLength(1);
    expect(v.pws[0]).toMatchObject({
      peerAddress: '10.100.101.6', state: 'UP', localLabel: 1016797, remoteLabel: 36464, tunnelType: 'ldp', pwType: 'label',
    });
  });
});

describe('S6750 real: o motor nao declara saude sem evidencia', () => {
  it('VSI/AC/PW up, mas sem config de interface e sem MAC => INCONCLUSIVE (nunca OK) com cobertura explicita', () => {
    const d = diagnoseEndpoint(facts());
    expect(d.status).toBe('INCONCLUSIVE');
    expect(d.coverage).toEqual({ vsi: true, acConfigs: { collected: 0, total: 1 }, mac: 'MISSING' });
    expect(d.findings.map((f) => f.code).sort()).toEqual(['AC_CONFIG_MISSING', 'MAC_EVIDENCE_MISSING']);
    expect(d.findings.some((f) => f.severity !== 'INFO')).toBe(false);
  });

  it('MAC nao solicitado nao vira lacuna', () => {
    const d = diagnoseEndpoint(facts({ requested: { mac: false } }));
    expect(d.coverage.mac).toBe('NOT_REQUESTED');
    expect(d.findings.some((f) => f.code === 'MAC_EVIDENCE_MISSING')).toBe(false);
  });

  it('AC persistido que a VSI viva nao lista (Vlanif3064) => achado de higiene, nao de falha', () => {
    const d = diagnoseEndpoint(facts({ persistedAcs: ['Vlanif3064', 'Vlanif3066'] }));
    const f = d.findings.find((x) => x.code === 'PERSISTED_AC_NOT_IN_LIVE_VSI')!;
    expect(f).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS' });
    expect(f.title).toContain('Vlanif3064');
    expect(f.caveat).toMatch(/Nao indica falha do circuito/);
    expect(d.findings.filter((x) => x.code === 'PERSISTED_AC_NOT_IN_LIVE_VSI')).toHaveLength(1);
  });

  it('sem MAC via AC NAO e falha de trafego: informativo, hipotese', () => {
    const f = facts({ macs: { complete: true, declaredTotal: 0, entries: [] } });
    const d = diagnoseEndpoint(f);
    const m = d.findings.find((x) => x.code === 'NO_MAC_FROM_AC')!;
    expect(m).toMatchObject({ severity: 'INFO', impactCertainty: 'HYPOTHESIS' });
    expect(d.status).not.toBe('FAILED');
  });

  it('com TODAS as evidencias e sem anomalia => OK', () => {
    const cfg = {
      complete: true, interfaceName: 'Vlanif3066', l2BindingVsi: VSI, mode: 'L3' as const, shutdown: false,
      mtu: null, directives: [], parentInterface: null,
    };
    const f = facts({
      interfaces: { Vlanif3066: { ...cfg, directives: [{ kind: 'DOT1Q_TERMINATION', vid: '3066', raw: 'dot1q termination vid 3066' }] } },
      macs: { complete: true, declaredTotal: 2, entries: [
        { mac: '0011-2233-4455', learnedFrom: 'GE0/0/1', side: 'AC', type: 'dynamic' },
        { mac: '0011-2233-4466', learnedFrom: '10.100.101.6', side: 'PW', type: 'dynamic' },
      ] },
    });
    const d = diagnoseEndpoint(f);
    expect(d.coverage).toEqual({ vsi: true, acConfigs: { collected: 1, total: 1 }, mac: 'COLLECTED' });
    expect(d.status).toBe('OK');
  });
});

describe('S6750 x RNS-FLOR (dados persistidos SNMP da outra ponta)', () => {
  // Valores lidos do banco (MplsPw de RNS-FLOR-6730-MPLS-01): pwId 25, remote 10.100.101.255, in 36464, out 1016797, UP.
  const rnsFlor = (override: Partial<ParsedVsiVerbose['pws'][number]> = {}): EndpointFacts => ({
    hostId: 'h-rns', hostName: 'RNS-FLOR-6730-MPLS-01', platform: null, vsiName: VSI, interfaces: {}, macs: null,
    evidenceIds: { vsi: 'db:rns', interfaces: {} }, requested: { mac: false },
    vsi: {
      complete: true, name: VSI, state: 'UP', signaling: 'bgp', encapsulationType: 'vlan', mtu: 1500, vsiIndex: null, rd: '268568:3066',
      acs: [{ interfaceName: 'Vlanif3066', state: 'UP', acBlockState: null, accessPort: null }],
      pws: [{ peerAddress: '10.100.101.255', vcId: 25, state: 'UP', localLabel: 36464, remoteLabel: 1016797, pwType: 'label', tunnelId: null, tunnelType: null, outInterface: null, ...override }],
    },
  });

  it('labels do PW se correspondem (1016797/36464) e MTU/encapsulamento coincidem', () => {
    const cmp = compareEndpoints(facts({ requested: { mac: false } }), rnsFlor());
    const codes = cmp.findings.map((f) => f.code);
    expect(codes).not.toContain('PW_LABEL_MISMATCH');
    expect(codes).not.toContain('ENCAPSULATION_TYPE_MISMATCH');
    expect(codes).not.toContain('MTU_MISMATCH');
    expect(codes).not.toContain('PW_STATE_ASYMMETRIC');
  });

  it('label divergente do outro lado => PW_LABEL_MISMATCH (fato confirmado, efeito provavel)', () => {
    const cmp = compareEndpoints(facts({ requested: { mac: false } }), rnsFlor({ remoteLabel: 1016000 }));
    expect(cmp.findings.find((f) => f.code === 'PW_LABEL_MISMATCH')).toMatchObject({ certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
  });
});

describe('intervalo minimo entre sessoes: espera na mesma chamada (pace), falha entre chamadas', () => {
  const host = (): HostRecord =>
    ({ id: 'h', name: 'H', vendor: 'Huawei', sshEnabled: true, ssh: { host: '10.0.0.1', port: 2222, username: 'u', contextCommand: null, credentialConfigured: true } }) as unknown as HostRecord;
  const profile = vsiMcpProfileSchema.parse({
    hostId: 'h', endpoint: '10.0.0.1', port: 2222, username: 'u', context: null, fingerprint: 'SHA256:' + 'A'.repeat(43),
    initialPrompt: '<H>', expectedPrompt: '<H>', vendor: 'HUAWEI', family: 'NE8000_V800', disablePagingTemporary: true,
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', operations: ['VERSION'],
  });
  const make = (cooldownMs: number) =>
    new SshVsiMcpLiveCollector(
      { getHost: async () => host() } as never,
      testBroker({ getHost: async () => host(), getDecryptedSshCredentials: async () => ({ password: 'pw' }) }, [profile]),
      (opts) => ({
        async execute(_h: string, commands: string[]) {
          const d = opts.diagnostic!;
          for (const c of [d.sessionPreparation!, ...commands]) {
            d.onCommand(c);
            d.onCommandComplete?.({ command: c, stdout: c === 'display version' ? S.NE_VERSION : `<H>${c}\n<H>`, completedAt: '2026-11-09T12:00:00.000Z' });
          }
          return [{ stdout: '', stderr: '', exitCode: 0 }];
        },
      }),
      cooldownMs,
    );
  const call = (c: SshVsiMcpLiveCollector, pace?: boolean) =>
    c.collect(host(), [], { signal: new AbortController().signal, audit: () => {}, scope: 'vsi-name:X', ...(pace ? { pace } : {}) });

  it('sem pace: segunda sessao imediata => BUSY', async () => {
    const c = make(300);
    await call(c);
    await expect(call(c)).rejects.toMatchObject({ code: 'BUSY' });
  });
  it('com pace: espera o intervalo e conclui', async () => {
    const c = make(150);
    await call(c);
    const t = Date.now();
    await expect(call(c, true)).resolves.toBeTruthy();
    expect(Date.now() - t).toBeGreaterThanOrEqual(100);
  });
  it('pace e cancelavel', async () => {
    const c = make(5_000);
    await call(c);
    const ac = new AbortController();
    const p = c.collect(host(), [], { signal: ac.signal, audit: () => {}, scope: 'vsi-name:X', pace: true });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(VsiMcpLiveError);
  });
});

/* ---------------------------------------------------------------------------
 * Execucao 2 (18:24Z): sessao unica com version, verbose, config Vlanif3064/3066 e MAC da VSI.
 * ------------------------------------------------------------------------- */
describe('S6750 real, execucao completa: o motor so conclui o que as evidencias provam', () => {
  const full = (): EndpointFacts =>
    facts({
      persistedAcs: ['Vlanif3064', 'Vlanif3066'],
      interfaces: {
        Vlanif3064: parseInterfaceConfig(read('config-vlanif3064.sanitized.txt'), 'Vlanif3064'),
        Vlanif3066: parseInterfaceConfig(read('config-vlanif3066.sanitized.txt'), 'Vlanif3066'),
      },
      macs: parseMacTable(read('mac-vsi.sanitized.txt')),
      evidenceIds: { vsi: 'ev:vsi', macs: 'ev:mac', interfaces: { Vlanif3064: 'ev:if64', Vlanif3066: 'ev:if66' } },
    });

  it('parsers das capturas reais', () => {
    const f = full();
    expect(f.interfaces.Vlanif3066).toMatchObject({ complete: true, l2BindingVsi: VSI, shutdown: false });
    expect(f.interfaces.Vlanif3064).toMatchObject({ complete: true, l2BindingVsi: '3064-PONTUALNET-IP-BHE-MQT' });
    expect(f.macs).toMatchObject({ complete: true, declaredTotal: 2 });
    expect(f.macs!.entries.map((e) => [e.learnedFrom, e.side])).toEqual([['Eth-Trunk1', 'AC'], ['Eth-Trunk6', 'AC']]);
  });

  it('Vlanif3064: registro persistido classificado como OBSOLETO (fato confirmado pelo equipamento)', () => {
    const d = diagnoseEndpoint(full());
    const f = d.findings.find((x) => x.code === 'PERSISTED_AC_OBSOLETE')!;
    expect(f).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE' });
    expect(f.explanation).toContain('3064-PONTUALNET-IP-BHE-MQT');
    expect(f.evidence).toEqual(expect.arrayContaining(['ev:vsi', 'ev:if64']));
    expect(d.findings.some((x) => x.code === 'PERSISTED_AC_NOT_IN_LIVE_VSI')).toBe(false);
  });

  it('sem Vlanif3064 coletada a obsolescencia NAO e afirmada (permanece hipotese)', () => {
    const f = full();
    delete f.interfaces.Vlanif3064;
    const d = diagnoseEndpoint(f);
    expect(d.findings.some((x) => x.code === 'PERSISTED_AC_OBSOLETE')).toBe(false);
    expect(d.findings.find((x) => x.code === 'PERSISTED_AC_NOT_IN_LIVE_VSI')).toMatchObject({ impactCertainty: 'HYPOTHESIS' });
  });

  it('dimensoes: VSI/AC/PW/binding OK; MAC observado; encapsulamento NAO avaliado => status INCONCLUSIVE (nao OK, nao falha)', () => {
    const d = diagnoseEndpoint(full());
    expect(d.dimensions).toEqual({
      VSI_STATE: 'OK', AC_STATE: 'OK', PW_STATE: 'OK', AC_BINDING: 'OK', MAC_LEARNING: 'OK', ENCAPSULATION: 'NOT_EVALUATED',
    });
    expect(d.coverage).toEqual({ vsi: true, acConfigs: { collected: 1, total: 1 }, mac: 'COLLECTED' });
    expect(d.status).toBe('INCONCLUSIVE');
    expect(d.findings.some((x) => x.severity === 'CRITICAL' || x.severity === 'WARNING')).toBe(false);
  });

  it('sem falso positivo: MAC em portas de origem nao comprovada nao vira "nenhum MAC via PW/AC" nem falha de trafego', () => {
    const d = diagnoseEndpoint(full());
    // AC Vlanif sem leitura da VLAN: as 2 entradas ficam nao classificadas, logo nenhuma ausencia e afirmada
    expect(d.macSummary).toMatchObject({ total: 2, viaAc: 0, viaPw: 0, viaUnresolved: 2 });
    expect(d.findings.some((x) => x.code === 'NO_MAC_FROM_PW' || x.code === 'NO_MAC_FROM_AC')).toBe(false);
    expect(d.status).not.toBe('FAILED');
    expect(d.status).not.toBe('WARNING');
  });

  it('binding divergente de um AC vivo e CRITICAL confirmado', () => {
    const f = full();
    f.interfaces.Vlanif3066 = { ...f.interfaces.Vlanif3066!, l2BindingVsi: 'OUTRA' };
    const d = diagnoseEndpoint(f);
    expect(d.findings.find((x) => x.code === 'AC_BINDING_MISMATCH')).toMatchObject({ severity: 'CRITICAL', certainty: 'CONFIRMED' });
    expect(d.dimensions.AC_BINDING).toBe('ISSUE');
    expect(d.status).toBe('FAILED');
  });

  it('MAC com total declarado divergente continua incompleto (YunShan: "Total items: N")', () => {
    expect(parseMacTable(read('mac-vsi.sanitized.txt').replace('Total items: 2', 'Total items: 9')).complete).toBe(false);
  });
});
