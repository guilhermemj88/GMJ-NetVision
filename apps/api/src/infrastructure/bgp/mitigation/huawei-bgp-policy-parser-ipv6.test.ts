import { describe, expect, it } from 'vitest';
import {
  bgpPolicyKey,
  parseHuaweiBgpPolicyConfiguration,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';

// BUG 1 — IPv6 policy lookup: normalizacao de endereco + contexto de address-family.

function v6(...peerLines: string[]): string {
  return ['bgp 64500', ' ipv6-family unicast', ...peerLines.map((line) => ` ${line}`)].join('\n');
}
function v4(...peerLines: string[]): string {
  return ['bgp 64500', ' ipv4-family unicast', ...peerLines.map((line) => ` ${line}`)].join('\n');
}

function resolve(
  config: string,
  peer: string,
  family: 'IPV4' | 'IPV6' = 'IPV6',
): string | null {
  return resolvePeerInboundPolicy(peer, family, parseHuaweiBgpPolicyConfiguration(config));
}

describe('policy discovery — normalizacao IPv6 (dentro da family)', () => {
  it('A) config VRP (MAIUSCULO) resolve lookup canonico minusculo', () => {
    expect(resolve(v6('peer 2804:532C:0:1::142 route-policy PL-BHNET_IPv6-IN import'), '2804:532c:0:1::142')).toBe('PL-BHNET_IPv6-IN');
  });

  it('B) IPv6 expandido vs comprimido', () => {
    expect(resolve(v6('peer 2804:532C:0000:0001:0000:0000:0000:0142 route-policy PL-X import'), '2804:532c:0:1::142')).toBe('PL-X');
  });

  it('C) config lowercase / lookup uppercase', () => {
    expect(resolve(v6('peer 2804:532c:0:1::142 route-policy PL-Y import'), '2804:532C:0:1::142')).toBe('PL-Y');
  });

  it('D) IPv4 continua funcionando', () => {
    expect(resolve(v4('peer 10.200.200.222 route-policy PL-BHNET_IPv4-IN import'), '10.200.200.222', 'IPV4')).toBe('PL-BHNET_IPv4-IN');
  });

  it('E) peer-group IPv6 com lookup normalizado', () => {
    const config = v6(
      'peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import',
      'peer 2804:532C:0:1::142 group GRUPO-V6',
    );
    expect(resolve(config, '2804:532c:0:1::142')).toBe('PL-GRUPO-V6-IN');
  });

  it('F) policy direta vence o peer-group', () => {
    const config = v6(
      'peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import',
      'peer 2804:532C:0:1::142 group GRUPO-V6',
      'peer 2804:532C:0:1::142 route-policy PL-DIRETA import',
    );
    expect(resolve(config, '2804:532c:0:1::142')).toBe('PL-DIRETA');
  });

  it('G) nome de peer-group NAO e normalizado como IP', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      v6('peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import'),
    );
    expect([...parsed.groupPolicies.keys()]).toEqual([bgpPolicyKey('IPV6', 'GRUPO-V6')]);
    expect(parsed.directPeerPolicies.size).toBe(0);
  });

  it('H) sem bloco de family a policy nao e atribuida (fail-closed)', () => {
    expect(resolve('peer 2804:532C:0:1::142 route-policy PL-SEM-FAMILY import', '2804:532c:0:1::142', 'IPV6')).toBeNull();
  });
});
