/**
 * MAP-VISUAL-V2 — compatibilidade com os offsets manuais de rótulo da V1.
 *
 * Contrato existente (lib/traffic-label-offsets.ts + traffic-edge.tsx):
 *  - chave `gmj:traffic-labels:<mapId>`, uma entrada por LINK;
 *  - duas lanes: 'a' (A→B, ancorada em t≈0.4 na V1) e 'b' (B→A, t≈0.6);
 *  - valores `{dx, dy}` em UNIDADES DE FLUXO (os mesmos dos nós), aplicados
 *    ao ponto de ancoragem calculado — não são absolutos nem de tela.
 *
 * A V2 lê EXATAMENTE esse contrato; nada é reescrito ou apagado. O sentido
 * dominante escolhe a lane cujo ajuste o operador fez por último (a lane do
 * sentido mostrado no rótulo único). Caminhos visuais extras do mesmo enlace
 * herdam o mesmo deslocamento do link.
 *
 * Reversibilidade: como os offsets continuam armazenados no formato original,
 * voltar para a V1 devolve a posição manual sem nenhuma conversão.
 */

import { trafficLabelOffset, type TrafficLabelOffsets } from '@/lib/traffic-label-offsets';
import type { LinkV2Direction } from './map-visual-v2';

export const LAB_OFFSETS_MAP_ID = 'LAB-DEMO';

export type LinkV2ManualLane = 'a' | 'b';

/** Lane cujo ajuste manual corresponde ao rótulo único do V2. */
export function laneForDirection(direction: LinkV2Direction): LinkV2ManualLane {
  return direction === 'b2a' ? 'b' : 'a';
}

export interface ManualLabelOffset {
  dx: number;
  dy: number;
}

/**
 * Offsets válidos são aplicados como estão (unidades de fluxo). Sem ajuste
 * manual, devolve null e o posicionamento automático assume.
 */
export function manualLabelOffset(
  offsets: TrafficLabelOffsets | null | undefined,
  linkId: string,
  direction: LinkV2Direction,
): ManualLabelOffset | null {
  const lane = laneForDirection(direction);
  const primary = trafficLabelOffset(offsets, linkId, lane);
  if (primary) return { dx: primary.dx, dy: primary.dy };
  // Fallback explícito: se só a outra lane tem ajuste, ele é preservado.
  const other = trafficLabelOffset(offsets, linkId, lane === 'a' ? 'b' : 'a');
  return other ? { dx: other.dx, dy: other.dy } : null;
}
