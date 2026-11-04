import { describe, expect, it } from 'vitest';
import { fastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';
import { listFastTrafficTargets } from '../../infrastructure/snmp/fast-traffic-targets';
import { lifecycleConfig } from './auto-lifecycle';
import { assertSinglePilotAuthorization, SINGLE_AUTO_PILOT } from './single-pilot-trigger';
import { autoExpansionPhysicalScopeMatches } from './auto-expansion-scope';
import type { MitigationProfileRecord } from '../../infrastructure/bgp/mitigation/mitigation-repository';

const DEVICE = 'host-1';
const BOGONS = 'ip ip-prefix BOGONS index 10 permit 0.0.0.0 8 less-equal 32';

function profile(over: Partial<MitigationProfileRecord> & { id: string }): MitigationProfileRecord {
  return {
    deviceId: DEVICE,
    interfaceId: `if-${over.id}`,
    addressFamily: 'IPV4',
    policyName: 'PL-CLIENTE_IPv4-IN',
    mode: 'ALERT_ONLY',
    enabled: true,
    mitigationExcluded: false,
    detectedBandwidthBps: 10_000_000_000n,
    triggerPercent: 90,
    bandwidthOverrideBps: null,
    ...over,
  } as unknown as MitigationProfileRecord;
}

const host = () => ({
  id: DEVICE,
  snmpEnabled: true,
  snmp: { version: 'SNMP_V2C' },
  interfaces: [
    { id: 'if-a', ifIndex: 1, name: 'Eth-Trunk1.1', speedBps: 10_000_000_000 },
    { id: 'if-b', ifIndex: 2, name: 'Eth-Trunk1.2', speedBps: 10_000_000_000 },
    { id: 'if-v6', ifIndex: 3, name: 'Eth-Trunk1.3', speedBps: 10_000_000_000 },
  ],
});

describe('D10 — ALL_IPV4_REQUIRES_OBSERVE', () => {
  it('a flag so vale em OBSERVE e nunca e o default', () => {
    expect(fastPollerConfig({}).observeAllIpv4).toBe(false);
    expect(
      fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'OBSERVE', MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED: '1' })
        .observeAllIpv4,
    ).toBe(true);
    expect(() =>
      fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'ENFORCE', MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED: '1' }),
    ).toThrow(/ALL_IPV4_REQUIRES_OBSERVE/);
    expect(() =>
      fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'OFF', MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED: '1' }),
    ).toThrow(/ALL_IPV4_REQUIRES_OBSERVE/);
  });

  it('sem a flag, lista de perfis vazia e erro (coleta nunca e implicita)', () => {
    expect(() => fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'OBSERVE' })).toThrow(
      /MITIGATION_FAST_PROFILE_IDS is required/,
    );
  });
});

describe('D10 — observeAllIpv4: cobertura sem autorizacao de escrita', () => {
  it('observa IPv4 sem direcao, exclui IPv6/desabilitado/excluido e deduplica a interface', async () => {
    const profiles = [
      profile({ id: 'sem-direcao', interfaceId: 'if-a' }),
      profile({ id: 'com-direcao', interfaceId: 'if-b' }),
      profile({ id: 'compartilhado', interfaceId: 'if-a' }),
      profile({ id: 'ipv6', interfaceId: 'if-v6', addressFamily: 'IPV6' }),
      profile({ id: 'desabilitado', interfaceId: 'if-a', enabled: false }),
      profile({ id: 'excluido', interfaceId: 'if-a', mitigationExcluded: true }),
      profile({ id: 'outro-device', interfaceId: 'if-a', deviceId: 'host-2' }),
    ] as MitigationProfileRecord[];
    const targets = await listFastTrafficTargets({
      profileIds: [],
      observeAllIpv4: true,
      allowedDeviceIds: [DEVICE],
      listProfiles: async () => profiles,
      hosts: { getHost: async () => host() as never },
      direction: (p) => (p.id === 'com-direcao' ? 'tx' : null),
    });

    expect(targets).toHaveLength(2);
    const byInterface = new Map(targets.map((t) => [t.interfaceId, t]));
    // Interface compartilhada = 1 alvo com N perfis.
    expect(byInterface.get('if-a')?.profiles.map((p) => p.profileId).sort()).toEqual([
      'compartilhado',
      'sem-direcao',
    ]);
    // Perfil sem direcao continua observado (direction null), mas so isso.
    expect(byInterface.get('if-a')?.profiles.every((p) => p.direction === null)).toBe(true);
    expect(byInterface.get('if-b')?.profiles[0]?.direction).toBe('tx');
    // IPv6, desabilitado, excluido e device fora da allowlist nunca entram.
    expect(targets.some((t) => t.interfaceId === 'if-v6')).toBe(false);
  });

  it('sem a flag, somente perfis AUTO com direcao sao coletados', async () => {
    const targets = await listFastTrafficTargets({
      profileIds: ['sem-direcao', 'com-direcao'],
      allowedDeviceIds: [DEVICE],
      listProfiles: async () => [
        profile({ id: 'sem-direcao', interfaceId: 'if-a' }),
        profile({ id: 'com-direcao', interfaceId: 'if-b', mode: 'AUTO' }),
        profile({ id: 'fora-da-lista', interfaceId: 'if-a', mode: 'AUTO' }),
      ],
      hosts: { getHost: async () => host() as never },
      direction: (p) => (p.id === 'com-direcao' ? 'tx' : null),
    });
    expect(targets.map((t) => t.interfaceId)).toEqual(['if-b']);
  });
});

describe('D10 — expansionEnabled, allowlists e ausencia de autorizacao fisica', () => {
  const base = {
    NETVISION_INSTALLATION_ID: 'IMPLANTAR',
    // Producao exige o kill switch de REMOVE explicito em 0.
    MITIGATION_AUTO_REMOVE_ENABLED: '0',
  } as Record<string, string>;

  it('expansao OFF por default e sem efeito sem lifecycle', () => {
    const c = lifecycleConfig(base);
    expect(c.expansionEnabled).toBe(false);
    expect(c.enabled).toBe(false);
    expect(c.executionEnabled).toBe(false);
    expect(c.removeEnabled).toBe(false);
  });

  it('flags incompletas/conflitantes falham fechado', () => {
    const expansion = {
      ...base,
      MITIGATION_AUTO_LIFECYCLE_ENABLED: '1',
      MITIGATION_AUTO_EXPANSION_ENABLED: '1',
    };
    // Sem listas explicitas.
    expect(() => assertSinglePilotAuthorization(lifecycleConfig(expansion))).toThrow(
      /AUTO_EXPANSION_EXPLICIT_AUTHORIZATION_REQUIRED/,
    );
    // Listas presentes: passa a exigir autorizacao explicita valida.
    expect(() =>
      assertSinglePilotAuthorization(
        lifecycleConfig({
          ...expansion,
          MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: 'p1,p1',
          MITIGATION_ALLOWED_DEVICE_IDS: DEVICE,
        }),
      ),
    ).toThrow(/AUTO_EXPANSION_EXPLICIT_AUTHORIZATION_REQUIRED/);
    // Device duplicado e configuracao ambigua.
    expect(() =>
      assertSinglePilotAuthorization(
        lifecycleConfig({
          ...expansion,
          MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: 'p1,p2',
          MITIGATION_ALLOWED_DEVICE_IDS: `${DEVICE},${DEVICE}`,
        }),
      ),
    ).toThrow(/AUTO_EXPANSION_EXPLICIT_AUTHORIZATION_REQUIRED/);
    // Installation diferente de IMPLANTAR nunca expande.
    expect(() =>
      assertSinglePilotAuthorization(
        lifecycleConfig({
          ...expansion,
          NETVISION_INSTALLATION_ID: 'OUTRA',
          MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: 'p1',
          MITIGATION_ALLOWED_DEVICE_IDS: DEVICE,
        }),
      ),
    ).toThrow();
  });

  it('sem expansao o piloto unico continua obrigatorio', () => {
    const piloto = {
      ...base,
      MITIGATION_AUTO_LIFECYCLE_ENABLED: '1',
      MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: SINGLE_AUTO_PILOT.profileId,
      MITIGATION_ALLOWED_DEVICE_IDS: SINGLE_AUTO_PILOT.deviceId,
    };
    expect(() => assertSinglePilotAuthorization(lifecycleConfig(piloto))).not.toThrow();
    expect(() =>
      assertSinglePilotAuthorization(
        lifecycleConfig({ ...piloto, MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS: 'outro-perfil' }),
      ),
    ).toThrow(/SINGLE_PILOT_EXPLICIT_AUTHORIZATION_REQUIRED/);
  });

  it('MAX_ACTIVE invalido falha no boot; ausente usa 1', () => {
    expect(lifecycleConfig(base).maxActive).toBe(1);
    for (const bad of ['0', '11', '50', 'abc']) {
      expect(() => lifecycleConfig({ ...base, MITIGATION_AUTO_MAX_ACTIVE: bad })).toThrow(
        /MITIGATION_AUTO_MAX_ACTIVE_INVALID/,
      );
    }
    expect(lifecycleConfig({ ...base, MITIGATION_AUTO_MAX_ACTIVE: '3' }).maxActive).toBe(3);
  });

  it('AUTO REMOVE nunca e habilitado (M8)', () => {
    expect(lifecycleConfig(base).removeEnabled).toBe(false);
    expect(() => lifecycleConfig({ ...base, MITIGATION_AUTO_REMOVE_ENABLED: '1' })).toThrow(
      /MITIGATION_AUTO_REMOVE_ENABLED_MUST_BE_0/,
    );
  });
});

describe('D10 — autoExpansionPhysicalScopeMatches', () => {
  const POLICY = 'PL-CLIENTE_IPv4-IN';
  const bgp = (peer: string) =>
    `bgp 268568\n ipv4-family unicast\n  peer ${peer} route-policy ${POLICY} import\n`;
  const policy = (...lines: string[]) => [`route-policy ${POLICY} deny node 1`, ' if-match ip-prefix BOGONS', ...lines].join('\n');

  const input = (over: Partial<{ bgpConfiguration: string | null; routePolicyConfiguration: string | null; prefixListConfiguration: string | null }> = {}) => ({
    bgpConfiguration: bgp('10.0.0.1'),
    routePolicyConfiguration: [`route-policy ${POLICY} permit node 10`, ' if-match ip-prefix PREFIX8to24'].join('\n'),
    prefixListConfiguration: BOGONS,
    ...over,
  });

  it('escopo exato do peer e nodes 1/2 livres: apto', () => {
    expect(autoExpansionPhysicalScopeMatches(input(), POLICY, ['10.0.0.1'])).toBe(true);
  });

  it('node 0, par 1/2, BOGONS ausente e peer divergente bloqueiam', () => {
    expect(
      autoExpansionPhysicalScopeMatches(
        input({ routePolicyConfiguration: [`route-policy ${POLICY} permit node 0`, `route-policy ${POLICY} permit node 10`].join('\n') }),
        POLICY,
        ['10.0.0.1'],
      ),
    ).toBe(false);
    expect(
      autoExpansionPhysicalScopeMatches(
        input({ routePolicyConfiguration: policy(`route-policy ${POLICY} permit node 2`) }),
        POLICY,
        ['10.0.0.1'],
      ),
    ).toBe(false);
    expect(
      autoExpansionPhysicalScopeMatches(input({ prefixListConfiguration: 'ip ip-prefix OUTRA index 10 permit 0.0.0.0 0 less-equal 32' }), POLICY, ['10.0.0.1']),
    ).toBe(false);
    expect(autoExpansionPhysicalScopeMatches(input(), POLICY, ['10.0.0.2'])).toBe(false);
    expect(autoExpansionPhysicalScopeMatches(input(), POLICY, [])).toBe(false);
    expect(autoExpansionPhysicalScopeMatches(input({ bgpConfiguration: null }), POLICY, ['10.0.0.1'])).toBe(false);
  });
});
