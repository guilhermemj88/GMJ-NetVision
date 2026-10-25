import { parseVsiFacts, resolveMplsLoopback } from './vsi-diagnostic-parser';

/** Completeness is transport evidence, not something inferred from a plausible body. */
export interface CompleteCliObservation {
  command: string;
  stdout: string;
  complete: boolean;
  completedAt: string;
}
export function isCompleteObservation(
  evidence: CompleteCliObservation,
  expectedPrompt: string,
): boolean {
  return (
    evidence.complete === true &&
    /^<[A-Za-z0-9_.:-]{1,120}>$/.test(expectedPrompt) &&
    evidence.stdout.trimEnd().split(/\r?\n/).at(-1)?.trim() === expectedPrompt &&
    !/----\s*More\s*----|--More--|\[y\/n\]|\(y\/n\)/i.test(evidence.stdout) &&
    Buffer.byteLength(evidence.stdout) <= 131072 &&
    Number.isFinite(Date.parse(evidence.completedAt))
  );
}
export function observeMplsLoopback(
  ldp: CompleteCliObservation,
  brief: CompleteCliObservation,
  expectedPrompt: string,
) {
  const eligible =
    ldp.command === 'display mpls ldp' &&
    brief.command === 'display ip interface brief' &&
    isCompleteObservation(ldp, expectedPrompt) &&
    isCompleteObservation(brief, expectedPrompt);
  const loopback = eligible ? resolveMplsLoopback(ldp.stdout, brief.stdout) : null;
  return loopback
    ? { status: 'CONFIRMED_LOOPBACK' as const, ...loopback, routingContext: 'GLOBAL' as const }
    : { status: 'INSUFFICIENT_DATA' as const };
}

/** Supplementary evidence for the local homologation report; never starts any network operation. */
export function observeVsi(
  evidence: CompleteCliObservation,
  expectedName: string,
  expectedPrompt: string,
) {
  if (
    evidence.command !== `display vsi name ${expectedName} verbose` ||
    !isCompleteObservation(evidence, expectedPrompt)
  )
    return null;
  const output = evidence.stdout.replace(/\r/g, '');
  const names = [...output.matchAll(/^\s*\*{0,3}\s*VSI Name\s*:\s*(\S+)\s*$/gim)];
  if (names.length !== 1 || names[0]?.[1] !== expectedName) return null;
  const facts = parseVsiFacts(output, expectedName);
  const field = (key: string, text = output): string | null => {
    const value = new RegExp('^[ \\t]*' + key + '[ \\t]*:[ \\t]*([^\\n]*?)[ \\t]*$', 'im')
      .exec(text)?.[1]
      ?.trim();
    return !value || value === '--' || value === '-' ? null : value;
  };
  // Global attributes end before AC/PW sections; a label block is retained separately.
  const header = output.split(/^[ \t]*(?:Interface Name[ \t]*:|\*\*PW Information:)/im)[0]!;
  const signaling = field('PW Signaling', header)?.toUpperCase() ?? null;
  const rawMtu = field('MTU', header);
  const mtu =
    rawMtu && /^\d+$/.test(rawMtu) && Number.isSafeInteger(Number(rawMtu)) ? Number(rawMtu) : null;
  const acs = [
    ...output.matchAll(
      /^[ \t]*Interface Name[ \t]*:[ \t]*(\S+)[ \t]*\n([\s\S]*?)(?=^[ \t]*(?:Interface Name[ \t]*:|\*\*PW Information:)|$(?![\s\S]))/gim,
    ),
  ].map((m) => ({ interfaceName: m[1]!, state: field('State', m[2]!)?.toUpperCase() ?? null }));
  const peerBlocks = output.split(/(?=^[ \t]*\*?[ \t]*Peer Ip Address[ \t]*:)/im).slice(1);
  return {
    name: expectedName,
    ...facts,
    signaling,
    rd: field('BGP RD', header) ?? field('RD', header),
    mtu,
    encapsulation: field('Encapsulation Type', header)?.toUpperCase() ?? null,
    tunnelPolicy: field('Tunnel Policy', header),
    bgpLabelBlocks: {
      local: field('Local Label Block', header),
      remote: field('Remote Label Block', header),
    },
    attachments: acs,
    peers: facts.peers.map((peer) => {
      const matches = peerBlocks.filter(
        (block) => field('\\*?[ \\t]*Peer Ip Address', block) === peer.address,
      );
      const unique =
        matches.length === 1 && facts.peers.filter((p) => p.address === peer.address).length === 1;
      return {
        ...peer,
        tunnelType: unique ? field('Tnl Type', matches[0]) : null,
        outInterface: unique ? field('OutInterface', matches[0]) : null,
      };
    }),
    observedAt: evidence.completedAt,
  };
}

export type CliSnmpComparison =
  'MATCH' | 'DIVERGENT' | 'CLI_MISSING' | 'SNMP_MISSING' | 'NOT_COMPARABLE';
export function compareCliSnmpField(input: {
  field: string;
  cli: string | number | null;
  snmp: string | number | null;
  cliObservedAt: string | null;
  snmpObservedAt: string | null;
  comparable?: boolean;
  reason?: string;
}) {
  const cliMissing = input.cli === null || input.cli === '';
  const snmpMissing = input.snmp === null || input.snmp === '';
  const classification: CliSnmpComparison =
    input.comparable === false || (cliMissing && snmpMissing)
      ? 'NOT_COMPARABLE'
      : cliMissing
        ? 'CLI_MISSING'
        : snmpMissing
          ? 'SNMP_MISSING'
          : input.cli === input.snmp
            ? 'MATCH'
            : 'DIVERGENT';
  return { ...input, classification, assertsNetworkFailure: false as const };
}
