/**
 * Avaliação fail-safe da taxa de tráfego derivada de contadores SNMP (IF-MIB).
 *
 * Bug real (POP IMPLANTAR, SPO-EQUINIX-6750-MPLS-01 / 100GE1/0/4): uma leitura
 * anômala do contador (valor menor que o anterior, típico de cache do
 * equipamento) virava um sample de 0 bps que substituía o baseline. O poll
 * seguinte comparava o contador normal com esse valor baixo e gerava um pico
 * fisicamente impossível (124,68 Gbps numa interface de 100 Gbps).
 *
 * Regras desta função:
 *
 * - descontinuidade (`current < previous` em octets de entrada ou saída) →
 *   amostra **não utilizável** para tráfego, mas o contador atual vira o novo
 *   baseline (rebase), para o próximo delta partir do valor certo;
 * - taxa acima da capacidade da interface + tolerância → amostra **não
 *   utilizável**, também com rebase;
 * - `speedBps` desconhecido → não há como validar capacidade; o cálculo é
 *   mantido (comportamento seguro e documentado) e só a descontinuidade é
 *   rejeitada;
 * - primeiro sample (sem baseline) ou intervalo não positivo → 0 bps, como
 *   sempre foi (o baseline é estabelecido aqui).
 *
 * A amostra não utilizável é persistida como linha de **baseline** com a taxa
 * sentinela `BASELINE_ONLY_RATE_BPS`. Os leitores de tráfego filtram essa
 * sentinela, então ela nunca aparece em histórico, BGP, mapa ou mitigação —
 * mas o contador fica rebaseado para o próximo poll.
 */

/** Taxa sentinela gravada apenas para rebasear o contador (nunca vai para consumidores). */
export const BASELINE_ONLY_RATE_BPS = -1;

/**
 * Tolerância sobre `speedBps` para absorver overhead/jitter de contadores SNMP e
 * `speedBps` arredondado para baixo.
 *
 * 10% aceita rajadas legítimas (ex.: 105 Gbps num link de 100G) e rejeita o pico
 * observado em produção (124,68 Gbps = +24,7%). Coberto por teste.
 */
export const COUNTER_RATE_TOLERANCE_RATIO = 0.1;

export type TrafficRateInvalidReason = 'DISCONTINUITY' | 'ABOVE_CAPACITY';

export interface TrafficRateInput {
  currentInOctets: bigint;
  currentOutOctets: bigint;
  previousInOctets?: bigint | undefined;
  previousOutOctets?: bigint | undefined;
  /** Intervalo real entre as duas leituras, em segundos. */
  seconds: number;
  /** Capacidade da interface (`Interface.speedBps`), quando conhecida. */
  speedBps?: bigint | number | null | undefined;
}

export interface TrafficRateResult {
  rxBps: number;
  txBps: number;
  /** Teto aceito (`speedBps` + tolerância); `null` quando a capacidade é desconhecida. */
  limitBps: number | null;
  discontinuity: boolean;
  aboveCapacity: boolean;
  /** `false` ⇒ persistir apenas como baseline (sem tráfego para consumidores). */
  usable: boolean;
  reason: TrafficRateInvalidReason | null;
}

function toPositiveNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function octetsToBps(octets: bigint, seconds: number): number {
  if (seconds <= 0) return 0;
  // Os contadores IF-MIB são em octetos; a taxa apresentada é em bits por segundo.
  const value = Number(octets * 8n) / seconds;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Teto aceito para uma capacidade conhecida (`speedBps + tolerância`).
 * `null` quando a capacidade é desconhecida/zero (não há teto a aplicar).
 */
export function acceptedTrafficLimitBps(speedBps?: bigint | number | null): number | null {
  const speed = toPositiveNumber(speedBps);
  return speed === null ? null : speed * (1 + COUNTER_RATE_TOLERANCE_RATIO);
}

/**
 * Regra ÚNICA de validade de uma amostra já persistida — a mesma usada na
 * escrita (`evaluateTrafficRate`) e o que os leitores read-side aplicam:
 *
 * - sentinela `BASELINE_ONLY_RATE_BPS` (rebase de contador) nunca é tráfego;
 * - com `speedBps` conhecido, rx/tx válidos somente até `speedBps × (1 + 10%)`;
 * - sem `speedBps` conhecido, mantém o comportamento anterior (só a sentinela).
 */
export function isUsableTrafficSample(
  sample: { rxBps: number; txBps: number },
  speedBps?: bigint | number | null,
): boolean {
  if (sample.rxBps <= BASELINE_ONLY_RATE_BPS || sample.txBps <= BASELINE_ONLY_RATE_BPS) {
    return false;
  }
  const limitBps = acceptedTrafficLimitBps(speedBps);
  if (limitBps === null) return true;
  return sample.rxBps <= limitBps && sample.txBps <= limitBps;
}

/** Mantém apenas amostras utilizáveis (sentinela + teto de capacidade). */
export function filterUsableTrafficSamples<T extends { rxBps: number; txBps: number }>(
  rows: readonly T[],
  speedBps?: bigint | number | null,
): T[] {
  return rows.filter((row) => isUsableTrafficSample(row, speedBps));
}

/**
 * Primeira amostra utilizável de uma lista ordenada do mais novo para o mais
 * antigo. Se o sample mais recente for inválido, devolve o último válido
 * anterior — nunca `null` só porque o topo está inválido.
 */
export function pickLatestUsableTrafficSample<T extends { rxBps: number; txBps: number }>(
  rows: readonly T[],
  speedBps?: bigint | number | null,
): T | null {
  for (const row of rows) {
    if (isUsableTrafficSample(row, speedBps)) return row;
  }
  return null;
}

export function evaluateTrafficRate(input: TrafficRateInput): TrafficRateResult {
  const limitBps = acceptedTrafficLimitBps(input.speedBps);
  const { previousInOctets, previousOutOctets, seconds } = input;

  // Sem baseline ou sem intervalo: nada a comparar (o próprio poll estabelece o baseline).
  if (previousInOctets === undefined || previousOutOctets === undefined || seconds <= 0) {
    return {
      rxBps: 0,
      txBps: 0,
      limitBps,
      discontinuity: false,
      aboveCapacity: false,
      usable: true,
      reason: null,
    };
  }

  const discontinuity =
    input.currentInOctets < previousInOctets || input.currentOutOctets < previousOutOctets;
  const rxBps = octetsToBps(input.currentInOctets - previousInOctets, seconds);
  const txBps = octetsToBps(input.currentOutOctets - previousOutOctets, seconds);
  const aboveCapacity = limitBps !== null && (rxBps > limitBps || txBps > limitBps);

  if (discontinuity) {
    return {
      rxBps,
      txBps,
      limitBps,
      discontinuity: true,
      aboveCapacity,
      usable: false,
      reason: 'DISCONTINUITY',
    };
  }

  if (aboveCapacity) {
    return {
      rxBps,
      txBps,
      limitBps,
      discontinuity: false,
      aboveCapacity: true,
      usable: false,
      reason: 'ABOVE_CAPACITY',
    };
  }

  return {
    rxBps,
    txBps,
    limitBps,
    discontinuity: false,
    aboveCapacity: false,
    usable: true,
    reason: null,
  };
}
