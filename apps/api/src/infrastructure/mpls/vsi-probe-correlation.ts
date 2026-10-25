import type { VsiDiagnosticResult } from '@gmj/shared';
import {
  isCompleteObservation,
  observeMplsLoopback,
  observeVsi,
  type CompleteCliObservation,
} from './vsi-diagnostic-observation';
import { parseInterface } from './vsi-diagnostic-parser';
import { correlateReciprocalVsi } from './vsi-diagnostic-reciprocal';
import { classifyUnderlay, observeHuaweiPing, type PingTarget } from './vsi-probe-observation';
import { PROBE_WINDOW_TARGETS, type ProbeDirection } from './vsi-probe-window';

export interface ProbeCapture extends CompleteCliObservation {
  durationMs: number;
  errorCode?: string;
}
export interface VsiEndpointCaptures {
  ldp: CompleteCliObservation;
  brief: CompleteCliObservation;
  vsi: CompleteCliObservation;
  ac: CompleteCliObservation;
}

/** Pure offline integration into the native evidence/check/probe contracts. No executor or network. */
export function correlateVsiEvidence(input: {
  targets: Record<ProbeDirection, PingTarget & { hostId: string }>;
  vsiName: string;
  startedAt?: string;
  collectedAt: string;
  pings: Record<ProbeDirection, ProbeCapture>;
  endpoints: Record<ProbeDirection, VsiEndpointCaptures>;
}) {
  const directions = ['LOCAL', 'REMOTE'] as const;
  const name = input.vsiName;
  const pings = directions.map((d) =>
    input.pings[d].errorCode ? null : observeHuaweiPing(input.pings[d], d, input.targets[d]),
  );
  if (input.startedAt) {
    const start = Date.parse(input.startedAt);
    for (const d of directions) {
      for (const c of [input.pings[d], ...Object.values(input.endpoints[d])]) {
        if (
          !Number.isFinite(start) ||
          Date.parse(c.completedAt) < start ||
          Date.parse(c.completedAt) > Date.parse(input.collectedAt)
        )
          throw new Error('EVIDENCE_OUTSIDE_DIAGNOSTIC');
      }
    }
  }
  const classification = classifyUnderlay(pings[0]!, pings[1]!);
  const observed = directions.map((d) => {
    const t = input.targets[d],
      c = input.endpoints[d],
      prompt = `<${t.name}>`;
    const loopback = observeMplsLoopback(c.ldp, c.brief, prompt);
    const vsi = observeVsi(c.vsi, name, prompt);
    const bound = vsi?.attachments.length === 1 ? vsi.attachments[0] : null;
    const ac =
      bound &&
      c.ac.command === `display interface ${bound.interfaceName}` &&
      isCompleteObservation(c.ac, prompt)
        ? parseInterface(c.ac.stdout, bound.interfaceName)
        : null;
    return {
      evidence: c.vsi,
      name,
      prompt,
      loopback,
      vsi,
      bound,
      ac,
      acObservedAt: c.ac.completedAt,
    };
  });
  const reciprocal = correlateReciprocalVsi(observed[0]!, observed[1]!);
  const serviceConfirmed =
    reciprocal.status === 'CONFIRMED_RECIPROCAL_VSI' &&
    reciprocal.labelComparisons.every((c) => c.classification === 'MATCH') &&
    observed.every(
      (o, i) =>
        o.loopback.status === 'CONFIRMED_LOOPBACK' &&
        o.loopback.address === input.targets[directions[i]!].source &&
        o.vsi?.status === 'UP' &&
        o.bound?.state === 'UP' &&
        o.ac?.physical === 'UP' &&
        o.ac.logical === 'UP' &&
        o.vsi.peers.filter(
          (p) => p.address === input.targets[directions[i]!].destination && p.state === 'UP',
        ).length === 1,
    );
  const summary =
    classification === 'UNDERLAY_REACHABLE' && serviceConfirmed
      ? 'Nenhuma falha foi identificada no underlay entre os PEs, no pseudowire ou nos attachment circuits avaliados.'
      : `Underlay: ${classification}. A causa e os demais segmentos do serviço permanecem inconclusivos.`;
  const evidence: VsiDiagnosticResult['evidence'] = directions.flatMap((d) => {
    const t = input.targets[d];
    return Object.entries({ ping: input.pings[d], ...input.endpoints[d] }).map(
      ([kind, capture]) => ({
        id: `${d}:${kind}`,
        hostId: t.hostId,
        source: 'LIVE_SSH' as const,
        observedAt: capture.complete ? capture.completedAt : null,
        collectedAt: input.collectedAt,
        command: capture.command,
        output: capture.stdout,
        ...('durationMs' in capture ? { durationMs: capture.durationMs } : {}),
        ...('errorCode' in capture ? { errorCode: capture.errorCode } : {}),
      }),
    );
  });
  const probes: VsiDiagnosticResult['probes'] = directions.map((d, i) => {
    const t = input.targets[d],
      other = input.targets[d === 'LOCAL' ? 'REMOTE' : 'LOCAL'],
      ping = pings[i];
    return {
      sourceHostId: t.hostId,
      destinationHostId: other.hostId,
      source: t.source,
      destination: t.destination,
      routingContext: 'GLOBAL',
      lossPercent: ping?.lossPercent ?? null,
      rttMs: ping?.rttMs ?? null,
      hops: [],
      status: !ping
        ? 'INSUFFICIENT_DATA'
        : ping.received === 0
          ? 'FAILED'
          : ping.lossPercent > 0
            ? 'WARNING'
            : 'OK',
    };
  });
  const checks: VsiDiagnosticResult['checks'] = directions.map((d, i) => ({
    id: `${d}:reachability`,
    category: 'LOOPBACK_REACHABILITY',
    label: d,
    hostId: input.targets[d].hostId,
    status: probes[i]!.status,
    message: pings[i]
      ? `${pings[i]!.received}/3 respostas; perda ${pings[i]!.lossPercent}%.`
      : 'Coleta inválida, incompleta ou com erro; sem conclusão de reachability.',
    evidence: [`${d}:ping`],
    durationMs: input.pings[d].durationMs,
    certainty: pings[i] ? 'CONFIRMED' : 'INCONCLUSIVE',
    required: true,
  }));
  const warnings = [
    input.startedAt
      ? 'Conclusão limitada às evidências e horários desta execução; não certifica toda a rede ou o serviço do cliente.'
      : 'Conclusão limitada aos comandos e horários registrados; as coletas VSI/PW/AC anteriores não comprovam estado simultâneo ao ping.',
    'Ping IP não comprova caminho físico, caminho completo da VSI, LSP ou entrega ao cliente. AAA não verificado nesta janela.',
  ];
  if (pings.some((p) => p && p.lossPercent > 0 && p.lossPercent < 100))
    warnings.push('Perda parcial observada; manter métricas por direção.');
  return {
    classification,
    summary,
    evidence,
    probes,
    checks,
    warnings,
    nextTests: [
      'Homologar o fluxo nativo completo pela API/WEB em release isolada, mediante nova autorização para testes ativos.',
    ],
    serviceConfirmed,
    reciprocal,
    observations: observed.map((o) => ({ vsi: o.vsi, ac: o.ac, acObservedAt: o.acObservedAt })),
    observedPings: pings,
    traceHomologated: false as const,
  };
}

/** Historical homologation wrapper; the native product always supplies freshly discovered targets. */
export function correlateProbeWindow(input: {
  collectedAt: string;
  pings: Record<ProbeDirection, ProbeCapture>;
  endpoints: Record<ProbeDirection, VsiEndpointCaptures>;
}) {
  return correlateVsiEvidence({
    ...input,
    targets: PROBE_WINDOW_TARGETS,
    vsiName: '1041-IX-BH-V4',
  });
}
