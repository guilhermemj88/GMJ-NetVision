/**
 * MAP-VISUAL-V2 — Fase D: adaptador dos dados REAIS do mapa operacional.
 *
 * O laboratório (Fases B/C) usava cenários mock; aqui o MESMO contrato do lib
 * puro (`resolveLinkV2Visual`) é alimentado pelo `NetworkLink` que o
 * NetworkCanvas já recebe da API. Nenhum dado é inventado:
 *
 *  - taxa por sentido: `directions.A_TO_B.bps` / `directions.B_TO_A.bps`;
 *  - capacidade: `link.capacityBps` (a API resolve `capacitySource=AUTO`);
 *  - status operacional: `link.status`;
 *  - consistência: `directions.*.consistency` (quando a origem declara);
 *  - frescor: o carimbo de COLETA mais recente do mapa (`newestCollectionStamp`),
 *    a mesma regra que a TopBar usa para dizer "pode estar desatualizado".
 *
 * Fase H — enlaces SINGLE_ENDED (trânsito IP, PNI, SEABORN…): existe UMA única
 * interface monitorada e ela alimenta as DUAS direções (TX saindo pelo sentido
 * direto e RX entrando pelo inverso). A falta de SNMP na ponta remota não pode
 * zerar a direção oposta: a orientação já vem resolvida no contrato, com
 * `txBps` = contador da ponta que transmite naquele sentido e `observedRxBps` =
 * contador da ponta oposta que recebe.
 *
 * Sem carimbo de coleta do mapa, nenhuma direção tem amostra e o V2 mostra "sem
 * dados" — nunca apresenta telemetria indisponível como saudável.
 */

import type { NetworkLink } from '@gmj/shared';
import {
  formatCompactBps,
  resolveLinkV2Visual,
  type LinkV2Input,
  type LinkV2Visual,
} from './map-visual-v2';

/**
 * Mesmo limite do `FreshnessTag` da TopBar (5 minutos): acima disso o dado
 * deixou de ser fresco e a UI assume isso em vez de afirmar que está atualizado.
 * A cadência de SNMP é configurável por ambiente, então o limite é folgado de
 * propósito e fica num único lugar.
 */
export const LINK_V2_COLLECTION_STALE_AFTER_MS = 5 * 60_000;

export interface RealLinkV2Context {
  nowMs: number;
  /** Carimbo de coleta mais recente do mapa (ISO) — `newestCollectionStamp`. */
  collectionStamp: string | null;
}

function sampledAtMsFromStamp(collectionStamp: string | null): number | null {
  if (!collectionStamp) return null;
  const parsed = Date.parse(collectionStamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/** O sentido A(coleta)/B está monitorado neste enlace? */
function sideIsMonitored(link: NetworkLink, side: 'A' | 'B'): boolean {
  if (link.trafficMode === 'BIDIRECTIONAL') return true;
  return side === 'A' ? link.sourceInterfaceId !== null : link.targetInterfaceId !== null;
}

type LinkV2DirectionMetric = NetworkLink['directions']['A_TO_B'];

/**
 * Este sentido tem amostra aproveitável?
 *
 * Contrato (packages/shared `link-telemetry.ts` → `direction()`):
 *  - `txBps` é o contador da ponta que TRANSMITE no sentido;
 *  - `observedRxBps` é o contador da ponta OPOSTA que recebe;
 *  - sem nenhum dos dois o sentido é "vazio" e `bps` chega como 0.
 *
 * Logo a origem define qual interface precisa estar monitorada:
 *  - A→B: TX da ponta A ou RX da ponta B;
 *  - B→A: TX da ponta B ou RX da ponta A.
 *
 * Com isso um enlace SINGLE_ENDED (uma interface só) mostra TX em um sentido e
 * RX no outro, sem exigir SNMP na ponta remota — e `TX = 0` continua sendo uma
 * medição válida (tem origem), diferente de "sem medição" (bps 0 sem origem).
 */
function directionHasSample(
  link: NetworkLink,
  side: 'A' | 'B',
  metric: LinkV2DirectionMetric,
): boolean {
  const opposite: 'A' | 'B' = side === 'A' ? 'B' : 'A';
  if (Number.isFinite(metric.txBps)) return sideIsMonitored(link, side);
  if (Number.isFinite(metric.observedRxBps)) return sideIsMonitored(link, opposite);
  // Taxa positiva sem contador de origem só existe quando houve medição
  // (o "vazio" do contrato é bps 0 sem origem); exige alguma ponta monitorada.
  return metric.bps > 0 && (sideIsMonitored(link, side) || sideIsMonitored(link, opposite));
}

export function linkV2InputFromLink(
  link: NetworkLink,
  context: RealLinkV2Context,
): LinkV2Input {
  const sampledAtMs = sampledAtMsFromStamp(context.collectionStamp);
  const capacityBps =
    Number.isFinite(link.capacityBps) && link.capacityBps > 0 ? link.capacityBps : null;
  const direction = (side: 'A' | 'B', metric: LinkV2DirectionMetric) => {
    const sampled = directionHasSample(link, side, metric);
    return {
      bps: sampled ? metric.bps : null,
      sampledAtMs: sampled ? sampledAtMs : null,
    };
  };

  const inconsistent = Object.values(link.directions).some(
    (metric) => metric.consistency === 'DIVERGENT',
  );

  return {
    operational: link.status === 'DOWN' ? 'down' : link.status === 'UP' ? 'up' : 'unknown',
    capacityBps,
    aToB: direction('A', link.directions.A_TO_B),
    bToA: direction('B', link.directions.B_TO_A),
    inconsistent,
  };
}

export function resolveRealLinkV2(
  link: NetworkLink,
  context: RealLinkV2Context,
): LinkV2Visual {
  return resolveLinkV2Visual(linkV2InputFromLink(link, context), {
    nowMs: context.nowMs,
    staleAfterMs: LINK_V2_COLLECTION_STALE_AFTER_MS,
  });
}

/** Versão curta do rótulo, usada quando a anticolisão não tem espaço. */
export function linkV2CompactLabel(visual: LinkV2Visual): string {
  if (visual.state === 'down') return 'DOWN';
  if (visual.state === 'no-data') return 'sem dados';
  if (visual.state === 'stale') return 'desatualizado';
  if (visual.utilizationPercent === null) return formatCompactBps(visual.dominantBps);
  return `${Math.round(visual.utilizationPercent)}%`;
}

/**
 * Prioridade do rótulo na anticolisão (maior vence):
 *  3 = selecionado · 2 = DOWN/alarme · 1 = informativo (atenção/crítico/parcial)
 *  0 = saudável.
 */
export function linkV2LabelPriority({
  visual,
  selected,
  alarmCount = 0,
}: {
  visual: LinkV2Visual;
  selected: boolean;
  alarmCount?: number;
}): number {
  if (selected) return 3;
  if (visual.state === 'down' || alarmCount > 0) return 2;
  if (visual.state === 'no-data' || visual.state === 'stale') return 2;
  if (visual.state === 'critical' || visual.state === 'attention' || visual.partial) return 1;
  return 0;
}
