import { z } from 'zod';
import type { OpticalThresholdSide, OpticalThresholdSource, OpticalThresholdsV1 } from '@gmj/shared';

/**
 * Thresholds efetivos lidos do equipamento (scalar e/ou por lane), antes de
 * virar a estrutura canonica versionada persistida em `Interface`.
 */
export interface HuaweiOpticalThresholds {
  scalar: { rx: OpticalThresholdSide; tx: OpticalThresholdSide };
  lanes: Array<{ lane: number; rx: OpticalThresholdSide; tx: OpticalThresholdSide }>;
}

/**
 * Prioridade do threshold efetivo: USER SET > DEVICE > DEFAULT > MANUAL.
 * MANUAL (regra de alarme) nunca sobrescreve nada vindo do equipamento.
 */
export const OPTICAL_THRESHOLD_SOURCE_RANK: Record<OpticalThresholdSource, number> = {
  USER: 4,
  DEVICE: 3,
  DEFAULT: 2,
  MANUAL: 1,
};

export function emptyOpticalThresholdSide(): OpticalThresholdSide {
  return { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null };
}

export function emptyHuaweiOpticalThresholds(): HuaweiOpticalThresholds {
  return {
    scalar: { rx: emptyOpticalThresholdSide(), tx: emptyOpticalThresholdSide() },
    lanes: [],
  };
}

/** Aplica a prioridade de fonte; empate mantem o valor ja lido. */
export function assignOpticalThresholdSide(
  side: OpticalThresholdSide,
  which: 'low' | 'high',
  value: number,
  source: OpticalThresholdSource,
): void {
  const valueKey = which === 'low' ? 'lowAlarmDbm' : 'highAlarmDbm';
  const sourceKey = which === 'low' ? 'lowSource' : 'highSource';
  const current = side[sourceKey];
  if (current && OPTICAL_THRESHOLD_SOURCE_RANK[current] >= OPTICAL_THRESHOLD_SOURCE_RANK[source]) {
    return;
  }
  side[valueKey] = value;
  side[sourceKey] = source;
}

export function hasUsefulThresholdSide(side: OpticalThresholdSide): boolean {
  return side.lowAlarmDbm !== null || side.highAlarmDbm !== null;
}

export function hasUsefulOpticalThresholds(thresholds: HuaweiOpticalThresholds): boolean {
  return hasUsefulThresholdSide(thresholds.scalar.rx)
    || hasUsefulThresholdSide(thresholds.scalar.tx)
    || thresholds.lanes.some((lane) => hasUsefulThresholdSide(lane.rx) || hasUsefulThresholdSide(lane.tx));
}

/**
 * Converte a leitura do equipamento para a estrutura canonica persistida.
 * Lanes observados SEM threshold entram com os dois lados nulos: e assim que o
 * layout visto pelo equipamento fica registrado para detectar mudanca de lane.
 */
export function opticalThresholdsV1FromHuawei(
  thresholds: HuaweiOpticalThresholds,
  observedLaneIds: number[],
): OpticalThresholdsV1 {
  const lanes = new Map<number, { rx: OpticalThresholdSide; tx: OpticalThresholdSide }>();
  for (const lane of thresholds.lanes) {
    lanes.set(lane.lane, { rx: { ...lane.rx }, tx: { ...lane.tx } });
  }
  for (const laneId of observedLaneIds) {
    if (!lanes.has(laneId)) {
      lanes.set(laneId, { rx: emptyOpticalThresholdSide(), tx: emptyOpticalThresholdSide() });
    }
  }
  return {
    version: 1,
    scalar: { rx: { ...thresholds.scalar.rx }, tx: { ...thresholds.scalar.tx } },
    lanes: [...lanes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([lane, sides]) => ({ lane, rx: sides.rx, tx: sides.tx })),
  };
}

const opticalThresholdSourceSchema = z.enum(['USER', 'DEVICE', 'DEFAULT', 'MANUAL']);

const opticalThresholdSideSchema = z.object({
  lowAlarmDbm: z.number().finite().nullable(),
  highAlarmDbm: z.number().finite().nullable(),
  lowSource: opticalThresholdSourceSchema.nullable(),
  highSource: opticalThresholdSourceSchema.nullable(),
});

const opticalThresholdsV1Schema = z.object({
  version: z.literal(1),
  scalar: z.object({ rx: opticalThresholdSideSchema, tx: opticalThresholdSideSchema }),
  lanes: z
    .array(
      z.object({
        lane: z.number().int().min(0),
        rx: opticalThresholdSideSchema,
        tx: opticalThresholdSideSchema,
      }),
    )
    .max(64),
});

export function isOpticalThresholdSource(value: unknown): value is OpticalThresholdSource {
  return typeof value === 'string'
    && (['USER', 'DEVICE', 'DEFAULT', 'MANUAL'] as const).includes(value as OpticalThresholdSource);
}

/** Le a coluna JSON tolerando schema ausente, invalido ou de versao futura. */
export function parseOpticalThresholdsV1(value: unknown): OpticalThresholdsV1 | null {
  if (value === null || value === undefined) return null;
  const parsed = opticalThresholdsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function opticalThresholdLaneIds(thresholds: OpticalThresholdsV1 | null): number[] {
  return (thresholds?.lanes ?? []).map((lane) => lane.lane).sort((left, right) => left - right);
}

/**
 * Mudanca de layout so e considerada quando o registro JA tem lanes gravados:
 * equipamento que nunca reporta threshold por lane nao pode forcar refresh a
 * cada ciclo (evita loop de SSH no slow path).
 */
export function opticalThresholdsLayoutChanged(
  stored: OpticalThresholdsV1 | null,
  observedLaneIds: number[],
): boolean {
  if (!stored || !observedLaneIds.length) return false;
  const storedLaneIds = opticalThresholdLaneIds(stored);
  if (!storedLaneIds.length) return false;
  const observed = [...observedLaneIds].sort((left, right) => left - right);
  return storedLaneIds.length !== observed.length
    || storedLaneIds.some((lane, index) => lane !== observed[index]);
}

/** Fonte resumida dos thresholds efetivos (a de maior prioridade presente). */
export function summaryOpticalThresholdSource(
  thresholds: OpticalThresholdsV1 | null,
): OpticalThresholdSource | null {
  if (!thresholds) return null;
  const sides = [
    thresholds.scalar.rx,
    thresholds.scalar.tx,
    ...thresholds.lanes.flatMap((lane) => [lane.rx, lane.tx]),
  ];
  let best: OpticalThresholdSource | null = null;
  for (const side of sides) {
    for (const source of [side.lowSource, side.highSource]) {
      if (!source) continue;
      if (!best || OPTICAL_THRESHOLD_SOURCE_RANK[source] > OPTICAL_THRESHOLD_SOURCE_RANK[best]) {
        best = source;
      }
    }
  }
  return best;
}
