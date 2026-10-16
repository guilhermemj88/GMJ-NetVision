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
 * Um sentido só recebe amostra quando o enlace realmente coleta naquele lado
 * (`metricSources` / interfaces dos canais, `trafficMode`). Sem carimbo de
 * coleta do mapa, nenhuma direção tem amostra e o V2 mostra "sem dados" — nunca
 * apresenta telemetria indisponível como saudável.
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

export function linkV2InputFromLink(
  link: NetworkLink,
  context: RealLinkV2Context,
): LinkV2Input {
  const sampledAtMs = sampledAtMsFromStamp(context.collectionStamp);
  const capacityBps =
    Number.isFinite(link.capacityBps) && link.capacityBps > 0 ? link.capacityBps : null;
  const direction = (side: 'A' | 'B', metric: NetworkLink['directions']['A_TO_B']) => {
    const monitored = sideIsMonitored(link, side);
    const hasNumber = Number.isFinite(metric.bps);
    return {
      bps: monitored && hasNumber ? metric.bps : null,
      sampledAtMs: monitored && hasNumber ? sampledAtMs : null,
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
