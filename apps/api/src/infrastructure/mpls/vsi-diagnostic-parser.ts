import type { VsiDiagnosticProbe, VsiDiagnosticVsiFacts } from '@gmj/shared';
import { ipv4 } from './vsi-diagnostic-policy';
export type VsiCliFacts = VsiDiagnosticVsiFacts;
const incompleteCli = (output: string): boolean => /----\s*More\s*----|--More--/i.test(output);
export function parseVsiFacts(output: string, expectedName: string): VsiCliFacts {
  if (incompleteCli(output)) return { vsiId: null, status: null, peers: [] };
  const name = /^\s*\*{0,3}\s*VSI Name\s*:\s*(\S+)\s*$/im.exec(output)?.[1];
  if (name !== expectedName) return { vsiId: null, status: null, peers: [] };
  const vsiId = /^\s*VSI ID\s*:\s*(\d+)\s*$/im.exec(output)?.[1];
  const state = /^\s*VSI State\s*:\s*(up|down)\s*$/im.exec(output)?.[1]?.toUpperCase();
  const peers: VsiCliFacts['peers'] = [];
  let current: VsiCliFacts['peers'][number] | undefined;
  for (const line of output.split(/\r?\n/)) {
    const address = /^\s*(?:\*\s*)?Peer Ip Address\s*:\s*(\d+\.\d+\.\d+\.\d+)\s*$/i.exec(line)?.[1];
    if (address && ipv4(address)) {
      current = {
        address,
        vcId: null,
        state: null,
        inboundLabel: null,
        outboundLabel: null,
        tunnel: null,
      };
      peers.push(current);
    }
    const pwId = /^\s*(?:Peer Vc Id|VC ID)\s*:\s*(\d+)\s*$/i.exec(line)?.[1];
    if (current && pwId !== undefined && Number.isSafeInteger(Number(pwId)))
      current.vcId = Number(pwId);
    const state = /^\s*PW State\s*:\s*(up|down)\s*$/i.exec(line)?.[1]?.toUpperCase();
    if (current && (state === 'UP' || state === 'DOWN')) current.state = state;
    const input = /^\s*(?:Local VC Label|Local Label|In Label)\s*:\s*(\d+)\s*$/i.exec(line)?.[1];
    const out = /^\s*(?:Remote VC Label|Remote Label|Out Label)\s*:\s*(\d+)\s*$/i.exec(line)?.[1];
    if (current && input !== undefined && Number(input) <= 1048575)
      current.inboundLabel = Number(input);
    if (current && out !== undefined && Number(out) <= 1048575) current.outboundLabel = Number(out);
    const tunnel = /^\s*Tunnel ID\s*:\s*([A-Za-z0-9_.:/-]{1,100})\s*$/i.exec(line)?.[1];
    if (current && tunnel) current.tunnel = tunnel;
  }
  return {
    vsiId: vsiId !== undefined && Number.isSafeInteger(Number(vsiId)) ? Number(vsiId) : null,
    status: state === 'UP' || state === 'DOWN' ? state : null,
    peers,
  };
}
export function resolveMplsLoopback(ldp: string, brief: string) {
  if (incompleteCli(ldp) || incompleteCli(brief)) return null;
  const ids = [
    ...ldp.matchAll(/(?:^|[ \t]{2,})(?:LSR ID|Local LSR ID)\s*:\s*(\d+\.\d+\.\d+\.\d+)(?=\s|$)/gim),
  ].map((m) => m[1]!);
  const unique = [...new Set(ids)];
  if (unique.length !== 1 || !ipv4(unique[0]!)) return null;
  const normalized = brief.replace(/\r/g, '');
  const vpnColumn =
    /^[ \t]*Interface[ \t]+IP Address\/Mask[ \t]+Physical[ \t]+Protocol[ \t]+VPN[ \t]*$/im.test(
      normalized,
    );
  const matches = [
    ...normalized.matchAll(
      /^[ \t]*(LoopBack\d+)[ \t]+(\d+\.\d+\.\d+\.\d+)(?:\/\d+)?[ \t]+(up|down)[ \t]+up(?:\(s\))?(?:[ \t]+(\S+))?[ \t]*$/gim,
    ),
  ].filter(
    (m) =>
      m[2] === unique[0] &&
      m[3]?.toLowerCase() === 'up' &&
      (vpnColumn ? m[4] === '--' : m[4] === undefined),
  );
  return matches.length === 1 ? { address: matches[0]![2]!, interfaceName: matches[0]![1]! } : null;
}
export function parsePing(
  output: string,
): Pick<VsiDiagnosticProbe, 'lossPercent' | 'rttMs'> | null {
  const sent = /(\d+)\s+packet\(s\) transmitted/i.exec(output)?.[1];
  const received = /(\d+)\s+packet\(s\) received/i.exec(output)?.[1];
  const loss = /(\d+(?:\.\d+)?)%\s+packet loss/i.exec(output)?.[1];
  if (sent !== '3' || received === undefined || loss === undefined) return null;
  const lost = Number(loss),
    got = Number(received);
  if (got > 3 || lost < 0 || lost > 100 || Math.abs(lost - (100 * (3 - got)) / 3) > 0.02)
    return null;
  const rtt = /round-trip\s+min\/avg\/max\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/i.exec(output);
  return {
    lossPercent: lost,
    rttMs: rtt ? { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) } : null,
  };
}
export function parseTrace(output: string): VsiDiagnosticProbe['hops'] {
  return output.split(/\r?\n/).flatMap((line) => {
    const row = /^\s*(\d{1,2})\s+(.+)$/.exec(line);
    if (!row || Number(row[1]) > 8) return [];
    const address = row[2]!.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] ?? null;
    if (address && !ipv4(address)) return [];
    return [
      {
        ttl: Number(row[1]),
        address,
        timesMs: [...row[2]!.matchAll(/([\d.]+)\s*ms/gi)].map((m) => Number(m[1])),
      },
    ];
  });
}
export function parseInterface(
  output: string,
  expected: string,
): { physical: 'UP' | 'DOWN'; logical: 'UP' | 'DOWN' } | null {
  if (incompleteCli(output)) return null;
  const first =
    /^\s*(\S+)\s+current state\s*:\s*(UP|DOWN|Administratively DOWN)(?:[ \t]+\(ifindex:[ \t]*\d+\))?\s*$/im.exec(
      output,
    );
  const logical = /^\s*Line protocol current state\s*:\s*(UP|DOWN)\s*$/im
    .exec(output)?.[1]
    ?.toUpperCase();
  if (first?.[1] !== expected || !logical) return null;
  return {
    physical: first[2]?.toUpperCase() === 'UP' ? 'UP' : 'DOWN',
    logical: logical as 'UP' | 'DOWN',
  };
}
