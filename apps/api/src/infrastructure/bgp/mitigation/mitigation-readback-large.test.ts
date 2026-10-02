import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { BgpDiscoveryOutcome, DiscoveredBgpPeer } from '../bgp-discovery-service';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { BgpMitigationDiscoveryService, type MitigationDiscoveryResult } from './mitigation-discovery-service';
import {
  parseHuaweiBgpPolicyConfiguration,
  parseHuaweiRoutePolicyNodes,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';

// REGRESSAO DO READ-BACK TRUNCADO DO F1A (~33 KB).
//
// O VRP abortava a saida quando o cliente enviava o `quit` junto com o comando
// (corrigido no SshClientImpl). Estes testes garantem que as duas pontas que
// dependem do TEXTO completo continuam funcionando quando o conteudo relevante
// esta DEPOIS do offset de 33 KB:
//   A) definicao de route-policy depois de 33 KB;
//   B) assignment peer+AF+policy depois de 33 KB;
//   E) policy resolvida mas realmente ausente => POLICY_NOT_FOUND;
//   F) read-back falhou => READBACK_FAILED.

const LIMITE_ANTIGO = 33_000;
const DEVICE = { id: 'device-1', interfaces: [] } as unknown as HostRecord;

/** Gera um dump de route-policy com mais de 33 KB e a policy ALVO no FINAL. */
function bigRoutePolicyConfig(): string {
  const lines: string[] = ['#'];
  let index = 0;
  while (lines.join('\n').length < LIMITE_ANTIGO + 2_000) {
    lines.push(`route-policy PL-PADRAO-${index} permit node 10`);
    lines.push(' if-match ip-prefix PREFIX-PADRAO');
    lines.push(' apply local-preference 100');
    lines.push('#');
    index += 1;
  }
  lines.push('route-policy PL-ALVO-IPv4-IN permit node 10');
  lines.push(' if-match ip-prefix PREFIX-ALVO');
  lines.push(' apply extcommunity rt 268568:660 additive');
  lines.push('route-policy PL-ALVO-IPv4-IN deny node 1000');
  lines.push('#');
  lines.push('route-policy PL-ALVO-IPv6-IN permit node 10');
  lines.push(' if-match ipv6 address prefix-list PREFIX-ALVO-V6');
  lines.push(' apply extcommunity rt 268568:660 additive');
  lines.push('route-policy PL-ALVO-IPv6-IN deny node 1000');
  lines.push('#');
  lines.push('return');
  return lines.join('\n');
}

/** Gera um dump BGP com mais de 33 KB e o assignment ALVO no fim do ipv6-family. */
function bigBgpConfig(): string {
  const lines: string[] = ['#', 'bgp 268568'];
  let index = 0;
  // bloco global (as-number/description) de enchimento
  while (lines.join('\n').length < LIMITE_ANTIGO - 4_000) {
    lines.push(` peer 10.99.${Math.floor(index / 250)}.${index % 250} as-number 65000`);
    index += 1;
  }
  lines.push(' ipv4-family unicast');
  lines.push('  peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-IN import');
  for (let i = 0; i < 120; i += 1) {
    lines.push(`  peer 10.98.${Math.floor(i / 250)}.${i % 250} route-policy PL-PADRAO-${i}-IN import`);
  }
  lines.push(' #');
  lines.push(' ipv6-family unicast');
  for (let i = 0; i < 120; i += 1) {
    lines.push(`  peer 2804:532C:0:9::${(i + 2).toString(16).toUpperCase()} route-policy PL-V6-PADRAO-${i}-IN import`);
  }
  lines.push('  peer 2804:532C:0:9::FF route-policy PL-ALVO-IPv6-IN import');
  lines.push('#');
  lines.push('return');
  return lines.join('\n');
}

function makePeer(over: Partial<DiscoveredBgpPeer> & Pick<DiscoveredBgpPeer, 'peerAddress'>): DiscoveredBgpPeer {
  return {
    addressFamily: 'IPV4',
    remoteAs: 6939n,
    stateCode: 6,
    state: 'ESTABLISHED' as DiscoveredBgpPeer['state'],
    sessionUptimeSeconds: 3600,
    cliReceivedPrefixes: 12n,
    bgpPeerDescription: null,
    interfaceId: 'if-1',
    interfaceName: '100GE0/1/48',
    interfaceAlias: 'HORIZONTE_IP_40GB',
    interfaceDescription: 'HORIZONTE_IP_40GB',
    displayName: 'HORIZONTE_IP_40GB',
    correlationStatus: 'MATCHED',
    correlationError: null,
    ...over,
  };
}

function outcomeOf(peers: DiscoveredBgpPeer[]): BgpDiscoveryOutcome {
  return { peers, localAs: 64500n, localAsAmbiguous: false, ipv6Supported: true, warnings: [] };
}

async function discoverWith(bgp: string | null, routePolicy: string | null, peers: DiscoveredBgpPeer[]): Promise<MitigationDiscoveryResult> {
  const service = new BgpMitigationDiscoveryService({
    bgpDiscovery: { discover: async () => { throw new Error('nao usar ao vivo'); } },
    configSource: {
      readMitigationConfig: async () => ({ bgpConfiguration: bgp, routePolicyConfiguration: routePolicy, warnings: [] }),
    },
    repository: new InMemoryMitigationRepository(),
  });
  return service.discoverFromBgpOutcome(DEVICE, outcomeOf(peers));
}

describe('read-back > 33 KB (regressao do truncamento do F1A)', () => {
  it('A) policy definida DEPOIS do offset de 33 KB e encontrada', () => {
    const config = bigRoutePolicyConfig();
    expect(config.length).toBeGreaterThan(LIMITE_ANTIGO);
    expect(config.indexOf('route-policy PL-ALVO-IPv4-IN')).toBeGreaterThan(LIMITE_ANTIGO);

    const nodes = parseHuaweiRoutePolicyNodes(config);
    const alvo = nodes.get('PL-ALVO-IPv4-IN') ?? [];
    expect(alvo.map((n) => n.node)).toEqual([10, 1000]);
    expect(alvo.find((n) => n.node === 10)?.routeTargets).toEqual(['268568:660']);
  });

  it('B) assignment peer+AF+policy DEPOIS de 33 KB resolve (IPv6 no fim)', () => {
    const config = bigBgpConfig();
    expect(config.length).toBeGreaterThan(LIMITE_ANTIGO);
    expect(config.indexOf('PL-ALVO-IPv6-IN')).toBeGreaterThan(LIMITE_ANTIGO);

    const parsed = parseHuaweiBgpPolicyConfiguration(config);
    expect(resolvePeerInboundPolicy('2804:532c:0:9::ff', 'IPV6', parsed)).toBe('PL-ALVO-IPv6-IN');
    // Nao cruza para IPv4.
    expect(resolvePeerInboundPolicy('2804:532c:0:9::ff', 'IPV4', parsed)).toBeNull();
  });

  it('B2) discovery ponta a ponta com dump > 33 KB: o alvo fica READY', async () => {
    const bgp = bigBgpConfig();
    const routePolicy = bigRoutePolicyConfig();
    const result = await discoverWith(bgp, routePolicy, [
      makePeer({ peerAddress: '2804:532c:0:9::ff', addressFamily: 'IPV6' }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.policyName).toBe('PL-ALVO-IPv6-IN');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
  });

  it('E) policy resolvida mas DEFINICAO realmente ausente => POLICY_NOT_FOUND', async () => {
    const bgp = bigBgpConfig();
    const routePolicy = 'route-policy PL-OUTRA permit node 10';
    const result = await discoverWith(bgp, routePolicy, [
      makePeer({ peerAddress: '2804:532c:0:9::ff', addressFamily: 'IPV6' }),
    ]);
    expect(result.profiles[0]?.policyName).toBe('PL-ALVO-IPv6-IN');
    expect(result.profiles[0]?.readiness).toBe('NOT_READY');
    expect(result.profiles[0]?.blockedReason).toBe('POLICY_NOT_FOUND');
  });

  it('F) falha de read-back (route-policy indisponivel) => READBACK_FAILED', async () => {
    const result = await discoverWith(bigBgpConfig(), null, [
      makePeer({ peerAddress: '2804:532c:0:9::ff', addressFamily: 'IPV6' }),
    ]);
    expect(result.profiles[0]?.readiness).toBe('NOT_READY');
    expect(result.profiles[0]?.blockedReason).toBe('READBACK_FAILED');
  });

  it('G) export-only nunca vira import (dump grande)', () => {
    const bgp = bigBgpConfig().replace('PL-ALVO-IPv6-IN import', 'PL-ALVO-IPv6-IN export');
    const parsed = parseHuaweiBgpPolicyConfiguration(bgp);
    expect(resolvePeerInboundPolicy('2804:532c:0:9::ff', 'IPV6', parsed)).toBeNull();
  });
});
