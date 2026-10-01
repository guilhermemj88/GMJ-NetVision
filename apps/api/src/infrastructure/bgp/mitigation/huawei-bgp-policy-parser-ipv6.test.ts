import { describe, expect, it } from 'vitest';
import {
  parseHuaweiBgpPolicyConfiguration,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';

// BUG 1 — IPv6 policy lookup (normalizacao de endereco).

function resolve(config: string, peer: string): string | null {
  return resolvePeerInboundPolicy(peer, parseHuaweiBgpPolicyConfiguration(config));
}

describe('policy discovery — normalizacao IPv6', () => {
  it('A) config VRP (MAIUSCULO) resolve lookup canonico minusculo', () => {
    expect(resolve('peer 2804:532C:0:1::142 route-policy PL-BHNET_IPv6-IN import\n', '2804:532c:0:1::142')).toBe('PL-BHNET_IPv6-IN');
  });

  it('B) IPv6 expandido vs comprimido', () => {
    expect(resolve('peer 2804:532C:0000:0001:0000:0000:0000:0142 route-policy PL-X import\n', '2804:532c:0:1::142')).toBe('PL-X');
  });

  it('C) config lowercase / lookup uppercase', () => {
    expect(resolve('peer 2804:532c:0:1::142 route-policy PL-Y import\n', '2804:532C:0:1::142')).toBe('PL-Y');
  });

  it('D) IPv4 continua funcionando', () => {
    expect(resolve('peer 10.200.200.222 route-policy PL-BHNET_IPv4-IN import\n', '10.200.200.222')).toBe('PL-BHNET_IPv4-IN');
  });

  it('E) peer-group IPv6 com lookup normalizado', () => {
    const config = 'peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import\npeer 2804:532C:0:1::142 group GRUPO-V6\n';
    expect(resolve(config, '2804:532c:0:1::142')).toBe('PL-GRUPO-V6-IN');
  });

  it('F) policy direta vence o peer-group', () => {
    const config = 'peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import\npeer 2804:532C:0:1::142 group GRUPO-V6\npeer 2804:532C:0:1::142 route-policy PL-DIRETA import\n';
    expect(resolve(config, '2804:532c:0:1::142')).toBe('PL-DIRETA');
  });

  it('G) nome de peer-group NAO e normalizado como IP', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration('peer GRUPO-V6 route-policy PL-GRUPO-V6-IN import\n');
    expect([...parsed.groupPolicies.keys()]).toEqual(['GRUPO-V6']);
    expect(parsed.directPeerPolicies.size).toBe(0);
  });
});