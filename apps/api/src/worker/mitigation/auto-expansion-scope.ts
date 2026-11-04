import { parseHuaweiBgpPolicyConfiguration, parseHuaweiRoutePolicyNodes, resolvePeerInboundPolicy } from '../../infrastructure/bgp/mitigation/huawei-bgp-policy-parser';
import { IPV4_MITIGATION_CONTRACT } from '../../infrastructure/bgp/mitigation/mitigation-contract';

/** Existing executor remains the writer. This is only its fresh peer/policy scope gate. */
export function autoExpansionPhysicalScopeMatches(input: {
  bgpConfiguration: string | null;
  routePolicyConfiguration: string | null;
  prefixListConfiguration: string | null;
}, policy: string, expectedPeers: readonly string[]): boolean {
  if (!input.bgpConfiguration || !input.routePolicyConfiguration || !input.prefixListConfiguration || !expectedPeers.length) return false;
  if (new Set(expectedPeers).size !== expectedPeers.length) return false;
  const bgp = parseHuaweiBgpPolicyConfiguration(input.bgpConfiguration);
  const actual = [...new Set([...bgp.directPeerPolicies.keys(), ...bgp.peerGroups.keys()])].filter(key => {
    const [family, peer] = key.split('\0');
    return peer && (family === 'IPV4' || family === 'IPV6') && resolvePeerInboundPolicy(peer, family, bgp) === policy;
  }).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPeers.map(peer => 'IPV4\0' + peer).sort())) return false;
  const nodes = parseHuaweiRoutePolicyNodes(input.routePolicyConfiguration).get(policy);
  // Node 0 precede o par: nem descoberta nem expansao podem tratar a policy
  // como livre. `<= 2` cobre 0, 1 e 2 (nodes reservados/anteriores).
  return !!nodes?.length && !nodes.some(n => n.node <= IPV4_MITIGATION_CONTRACT.mitigationNode) && /^ip ip-prefix BOGONS /m.test(input.prefixListConfiguration);
}
