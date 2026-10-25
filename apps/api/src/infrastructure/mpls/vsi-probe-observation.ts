import type { VsiDiagnosticProbe } from '@gmj/shared';
import { isCompleteObservation, type CompleteCliObservation } from './vsi-diagnostic-observation';
import { PROBE_WINDOW_TARGETS, type ProbeDirection } from './vsi-probe-window';
import { vsiCommand } from './vsi-diagnostic-policy';
export interface PingTarget {
  name: string;
  source: string;
  destination: string;
  platform: ObservedPing['platform'];
}

export interface ObservedPing {
  platform: 'VRP_V200' | 'YUNSHAN_V600';
  transmitted: 3;
  received: number;
  lossPercent: number;
  rttMs: VsiDiagnosticProbe['rttMs'];
  direction: ProbeDirection;
  observedAt: string;
}

/** Shared consistency checks; vendor entry points below own their wire grammar. */
function validatePing(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
  platform: ObservedPing['platform'],
  grammar: { header: RegExp; summary: RegExp },
  target: PingTarget = PROBE_WINDOW_TARGETS[direction],
): ObservedPing | null {
  if (!target || target.platform !== platform) return null;
  const prompt = `<${target.name}>`;
  let command: string;
  try {
    command = vsiCommand({ kind: 'PING', source: target.source, destination: target.destination });
  } catch {
    return null;
  }
  if (evidence.command !== command || !isCompleteObservation(evidence, prompt)) return null;
  const lines = evidence.stdout.replace(/\r/g, '').split('\n');
  if (lines.filter((line) => line.trim() === prompt + command).length !== 1) return null;
  const body = lines
    .slice(lines.findIndex((line) => line.trim() === prompt + command) + 1)
    .join('\n');
  if (/^[ \t]*(?:Error:|Warning:|Failure:|Unrecognized|Incomplete command)/im.test(body))
    return null;
  const headers = [...body.matchAll(grammar.header)];
  const summaries = [...body.matchAll(grammar.summary)];
  if (
    headers.length !== 1 ||
    summaries.length !== 1 ||
    headers[0]?.[1] !== target.destination ||
    summaries[0]?.[1] !== target.destination
  )
    return null;
  const one = (pattern: RegExp): string | null => {
    const matches = [...body.matchAll(pattern)];
    return matches.length === 1 ? matches[0]![1]! : null;
  };
  const sent = one(/^[ \t]*(\d+)[ \t]+packet\(s\) transmitted[ \t]*$/gim);
  const received = one(/^[ \t]*(\d+)[ \t]+packet\(s\) received[ \t]*$/gim);
  const loss = one(/^[ \t]*(\d+(?:\.\d+)?)%[ \t]+packet loss[ \t]*$/gim);
  if (sent !== '3' || received === null || loss === null) return null;
  const got = Number(received),
    lost = Number(loss);
  if (got > 3 || lost > 100 || Math.abs(lost - (100 * (3 - got)) / 3) > 0.02) return null;
  const replies = [
    ...body.matchAll(
      /^[ \t]*Reply from ([\d.]+): bytes=(\d+) Sequence=(\d+) ttl=(\d+) time=([\d.]+) ms[ \t]*$/gim,
    ),
  ];
  if (
    replies.length !== got ||
    new Set(replies.map((m) => m[3])).size !== got ||
    replies.some(
      (m) =>
        m[1] !== target.destination ||
        Number(m[3]) < 1 ||
        Number(m[3]) > 3 ||
        Number(m[4]) < 1 ||
        Number(m[4]) > 255 ||
        !Number.isFinite(Number(m[5])),
    )
  )
    return null;
  const rtts = [
    ...body.matchAll(
      /^[ \t]*round-trip min\/avg\/max[ \t]*=[ \t]*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)[ \t]*ms[ \t]*$/gim,
    ),
  ];
  if (rtts.length !== (got > 0 ? 1 : 0)) return null;
  const rtt = rtts[0];
  const rttMs = rtt ? { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) } : null;
  if (
    rttMs &&
    (!Object.values(rttMs).every(Number.isFinite) || rttMs.min > rttMs.avg || rttMs.avg > rttMs.max)
  )
    return null;
  if (rttMs && replies.some((m) => Number(m[5]) < rttMs.min || Number(m[5]) > rttMs.max))
    return null;
  // Summary must follow the probe header/replies; an echoed unrelated summary is insufficient.
  if (
    body.indexOf(summaries[0]![0]) <= body.indexOf(headers[0]![0]) ||
    replies.some((m) => m.index! > summaries[0]!.index!)
  )
    return null;
  return {
    platform,
    transmitted: 3,
    received: got,
    lossPercent: lost,
    rttMs,
    direction,
    observedAt: evidence.completedAt,
  };
}

/** Homologated with S6730 VRP V200R022C00SPC500 capture. */
export function observeVrpV200Ping(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
): ObservedPing | null {
  return validatePing(evidence, direction, 'VRP_V200', {
    header: /^[ \t]*PING ([\d.]+): 56[ \t]+data bytes, press CTRL_C to break[ \t]*$/gim,
    summary: /^[ \t]*--- ([\d.]+) ping statistics ---[ \t]*$/gim,
  });
}
/** Independently homologated with S6750 YunShan V600R024C00SPC500 capture. */
export function observeYunShanV600Ping(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
): ObservedPing | null {
  return validatePing(evidence, direction, 'YUNSHAN_V600', {
    header: /^[ \t]*PING ([\d.]+): 56[ \t]+data bytes, press CTRL_C to break[ \t]*$/gim,
    summary: /^[ \t]*--- ([\d.]+) ping statistics ---[ \t]*$/gim,
  });
}

export function observeWindowPing(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
): ObservedPing | null {
  return direction === 'LOCAL'
    ? observeVrpV200Ping(evidence, direction)
    : observeYunShanV600Ping(evidence, direction);
}
/** No trace for unknown, incomplete, partial-loss or any responding ping. */
export function traceAuthorizedByObservation(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
): boolean {
  const ping = observeWindowPing(evidence, direction);
  return ping?.transmitted === 3 && ping.received === 0 && ping.lossPercent === 100;
}

export function classifyUnderlay(local: ObservedPing | null, remote: ObservedPing | null) {
  if (!local || !remote || local.direction !== 'LOCAL' || remote.direction !== 'REMOTE')
    return 'INCONCLUSIVE' as const;
  if (local.received === 0 && remote.received === 0) return 'UNDERLAY_UNREACHABLE' as const;
  // A responding direction versus complete loss has precedence; partial loss is retained per probe.
  if (local.received === 0 || remote.received === 0) return 'ASYMMETRIC_REACHABILITY' as const;
  if (local.lossPercent > 0 || remote.lossPercent > 0) return 'DEGRADED_REACHABILITY' as const;
  return 'UNDERLAY_REACHABLE' as const;
}

export function observeHuaweiPing(
  evidence: CompleteCliObservation,
  direction: ProbeDirection,
  target: PingTarget,
): ObservedPing | null {
  if (!['VRP_V200', 'YUNSHAN_V600'].includes(target.platform)) return null;
  return validatePing(
    evidence,
    direction,
    target.platform,
    {
      header: /^[ \t]*PING ([\d.]+): 56[ \t]+data bytes, press CTRL_C to break[ \t]*$/gim,
      summary: /^[ \t]*--- ([\d.]+) ping statistics ---[ \t]*$/gim,
    },
    target,
  );
}
