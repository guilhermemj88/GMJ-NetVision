import {
  observeVsi,
  type CompleteCliObservation,
  type observeMplsLoopback,
} from './vsi-diagnostic-observation';
import { vsiCommand } from './vsi-diagnostic-policy';

/** Normalize only an ASN-based RD; an IPv4 RD is never reinterpreted as an ASN. */
export function canonicalAsnRd(value: string | null): string | null {
  const match = /^\s*(\d+)(?:\.(\d+))?\s*:\s*(\d+)\s*$/.exec(value ?? '');
  if (!match) return null;
  const high = Number(match[1]),
    low = match[2] === undefined ? null : Number(match[2]);
  const asn = low === null ? high : high * 65536 + low;
  const assigned = Number(match[3]);
  if (low !== null && (high > 65535 || low > 65535)) return null;
  if (
    !Number.isSafeInteger(asn) ||
    asn < 1 ||
    asn > 4294967295 ||
    assigned > (asn > 65535 ? 65535 : 4294967295)
  )
    return null;
  return `${asn}:${assigned}`;
}
export interface PersistedVsiCandidate {
  hostId: string;
  name: string;
  rd: string | null;
  signalingType: string;
  pws: Array<{ remoteIp: string }> | null;
}
export function selectRemoteCandidate(
  candidates: PersistedVsiCandidate[],
  hostId: string,
  local: { name: string; rd: string | null; signaling: string | null; address: string },
) {
  const compatible = candidates.filter(
    (c) =>
      c.hostId === hostId &&
      c.signalingType === local.signaling &&
      canonicalAsnRd(c.rd) !== null &&
      canonicalAsnRd(c.rd) === canonicalAsnRd(local.rd),
  );
  if (compatible.length !== 1)
    return {
      status: compatible.length > 1 ? ('AMBIGUOUS' as const) : ('INSUFFICIENT_DATA' as const),
      candidate: null,
    };
  const candidate = compatible[0]!;
  const reciprocal = candidate.pws?.some((p) => p.remoteIp === local.address) ?? false;
  return {
    status: reciprocal
      ? ('PERSISTED_RECIPROCAL_CANDIDATE' as const)
      : ('TENTATIVE_CANDIDATE' as const),
    candidate,
  };
}
/** An interface read is derived from one completed, reciprocal CLI VSI, never from a VLAN suffix. */
export function interfaceFromReciprocalVsi(
  evidence: CompleteCliObservation,
  name: string,
  prompt: string,
  localAddress: string,
): string {
  const vsi = observeVsi(evidence, name, prompt);
  if (
    !vsi ||
    vsi.peers.filter((p) => p.address === localAddress).length !== 1 ||
    vsi.attachments.length !== 1
  )
    throw new Error('VSI_RECIPROCITY_OR_AC_UNPROVEN');
  return vsiCommand({ kind: 'INTERFACE', argument: vsi.attachments[0]!.interfaceName });
}

interface ObservedVsiEndpoint {
  evidence: CompleteCliObservation;
  name: string;
  prompt: string;
  loopback: ReturnType<typeof observeMplsLoopback>;
}
/** Compare observed peer-specific label directions, without asserting present end-to-end health. */
export function correlateReciprocalVsi(left: ObservedVsiEndpoint, right: ObservedVsiEndpoint) {
  const l = observeVsi(left.evidence, left.name, left.prompt);
  const r = observeVsi(right.evidence, right.name, right.prompt);
  const lp =
    l?.peers.filter(
      (p) => right.loopback.status === 'CONFIRMED_LOOPBACK' && p.address === right.loopback.address,
    ) ?? [];
  const rp =
    r?.peers.filter(
      (p) => left.loopback.status === 'CONFIRMED_LOOPBACK' && p.address === left.loopback.address,
    ) ?? [];
  const reciprocal =
    !!l &&
    !!r &&
    l.signaling === 'BGP' &&
    r.signaling === 'BGP' &&
    canonicalAsnRd(l.rd) !== null &&
    canonicalAsnRd(l.rd) === canonicalAsnRd(r.rd) &&
    lp.length === 1 &&
    rp.length === 1;
  const explicitLabels = (text: string, address: string | undefined) => {
    if (!address) return false;
    const blocks = text
      .replace(/\r/g, '')
      .split(/(?=^[ \t]*\*?[ \t]*Peer Ip Address[ \t]*:)/im)
      .slice(1);
    const matching = blocks.filter(
      (b) => /^[ \t]*\*?[ \t]*Peer Ip Address[ \t]*:[ \t]*(\S+)[ \t]*$/im.exec(b)?.[1] === address,
    );
    return (
      matching.length === 1 &&
      /^[ \t]*Local VC Label[ \t]*:[ \t]*\d+[ \t]*$/im.test(matching[0]!) &&
      /^[ \t]*Remote VC Label[ \t]*:[ \t]*\d+[ \t]*$/im.test(matching[0]!)
    );
  };
  const comparable =
    reciprocal &&
    explicitLabels(left.evidence.stdout, lp[0]?.address) &&
    explicitLabels(right.evidence.stdout, rp[0]?.address);
  const compare = (direction: string, localLabel: number | null, remoteLabel: number | null) => ({
    direction,
    localLabel,
    remoteLabel,
    classification:
      !comparable || localLabel === null || remoteLabel === null
        ? ('NOT_COMPARABLE' as const)
        : localLabel === remoteLabel
          ? ('MATCH' as const)
          : ('DIVERGENT' as const),
    localObservedAt: left.evidence.completedAt,
    remoteObservedAt: right.evidence.completedAt,
    assertsNetworkFailure: false as const,
  });
  return {
    status: reciprocal ? ('CONFIRMED_RECIPROCAL_VSI' as const) : ('INSUFFICIENT_DATA' as const),
    labelComparisons: [
      compare(
        'LOCAL.inbound / REMOTE.outbound',
        lp[0]?.inboundLabel ?? null,
        rp[0]?.outboundLabel ?? null,
      ),
      compare(
        'LOCAL.outbound / REMOTE.inbound',
        lp[0]?.outboundLabel ?? null,
        rp[0]?.inboundLabel ?? null,
      ),
    ],
  };
}
