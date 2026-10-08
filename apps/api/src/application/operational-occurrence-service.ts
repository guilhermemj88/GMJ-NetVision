import {
  OPERATIONAL_OCCURRENCE_QUIET_MS,
  OPERATIONAL_OCCURRENCE_TYPES,
  bigintToSafeNumber,
  operationalOccurrenceCloseReasonLabel,
  operationalOccurrenceFingerprint,
  type AlarmSeverity,
  type AuthUser,
  type InterfaceOccurrence,
  type OperationalOccurrence,
  type OperationalOccurrenceAckResponse,
  type OperationalOccurrenceCloseReason,
  type OperationalOccurrenceListResponse,
  type OperationalOccurrenceType,
} from '@gmj/shared';
import type {
  OperationalOccurrenceRecord,
  OperationalOccurrenceRepository,
} from '../infrastructure/alarms/operational-occurrence-repository';
import {
  bestIntervalBasisMs,
  isOccurrenceStateCurrent,
  occurrenceDeltaFor,
  planOperationalOccurrence,
  supersedeFor,
  type OccurrenceSampleDelta,
  type OperationalOccurrenceState,
} from './operational-occurrence-rules';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;
/** CRC e um sinal de camada 1/2; discard e perda local. Nao substitui regra. */
const INFORMATIVE_SEVERITY: Record<OperationalOccurrenceType, AlarmSeverity> = {
  CRC_FCS: 'WARNING',
  DISCARDS: 'INFO',
};

export type OperationalOccurrenceIngestSample = OccurrenceSampleDelta;

export interface OperationalOccurrenceIngestInput {
  deviceId: string;
  samples: readonly OperationalOccurrenceIngestSample[];
}

export interface OperationalOccurrenceListQuery {
  active?: boolean | undefined;
  unacknowledged?: boolean | undefined;
  type?: OperationalOccurrenceType | undefined;
  deviceId?: string | undefined;
  interfaceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class OperationalOccurrenceError extends Error {
  constructor(
    readonly code: 'OCCURRENCE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'OperationalOccurrenceError';
  }
}

/**
 * Ocorrencia operacional persistente (F9.2): transforma deltas de contador ja
 * coletados em episodios de 24h com id estavel, sem tocar no Alarm Engine, sem
 * midia e sem regra. Um episodio reconhecido ou sem ocorrencia por 24h sai do
 * painel compacto, mas nunca e apagado: o historico continua consultavel.
 */
export class OperationalOccurrenceService {
  private lastHousekeepingMs = 0;

  constructor(
    private readonly repository: OperationalOccurrenceRepository,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private quietMs(): number {
    return OPERATIONAL_OCCURRENCE_QUIET_MS;
  }

  /**
   * Processa as amostras de UM poll depois da persistencia. Idempotente por
   * (interface, timestamp, tipo): replays e reprocessamentos nao somam duas
   * vezes. Lanca apenas em falha real de banco — quem chama decide se aborta.
   */
  async processSamples(input: OperationalOccurrenceIngestInput): Promise<number> {
    const nowMs = this.now();
    const batchCursor = new Map<string, number>();
    let applied = 0;

    for (const sample of input.samples) {
      const batchBasis = batchCursor.get(sample.interfaceId);
      batchCursor.set(
        sample.interfaceId,
        typeof batchBasis === 'number' ? Math.max(batchBasis, sample.timestampMs) : sample.timestampMs,
      );
      for (const type of OPERATIONAL_OCCURRENCE_TYPES) {
        const delta = occurrenceDeltaFor(type, sample);
        if (delta.total === 0n) continue;
        const fingerprint = operationalOccurrenceFingerprint(sample.interfaceId, type);
        const latest = await this.repository.findLatestByFingerprint(fingerprint);
        const latestState = latest ? toState(latest) : null;
        // Vigente = aberto, sem ACK e com ocorrencia dentro da janela de 24h.
        // Um episodio reconhecido ou encerrado nunca recebe delta novo: o
        // proximo evento abre um episodio com id novo.
        const current =
          latestState &&
          latest &&
          !latest.closedAt &&
          !latest.acknowledgedAt &&
          isOccurrenceStateCurrent(latestState, nowMs)
            ? latestState
            : null;
        const basisMs = bestIntervalBasisMs(sample.timestampMs, [
          sample.previousSampleTimestampMs,
          batchBasis,
          latestState?.lastSampleAtMs,
        ]);
        const plan = planOperationalOccurrence({
          current,
          latest: latestState,
          supersede:
            !current && latestState && latest && !latest.closedAt
              ? supersedeFor(latestState, sample.timestampMs, latest.acknowledgedAt?.getTime() ?? null)
              : null,
          timestampMs: sample.timestampMs,
          delta,
          intervalBasisMs: basisMs,
        });
        if (plan.action === 'IGNORE') continue;
        const result = await this.repository.apply({
          fingerprint,
          type,
          deviceId: input.deviceId,
          interfaceId: sample.interfaceId,
          sourceTimestamp: new Date(sample.timestampMs),
          action: plan.action,
          targetId: plan.action === 'UPDATE' ? plan.targetId : null,
          close: plan.action === 'CREATE' ? plan.close : null,
          values: plan.values,
        });
        if (result.applied) applied += 1;
      }
    }

    await this.runHousekeeping(nowMs);
    return applied;
  }

  /**
   * Housekeeping com throttle: encerra como QUIET_24H o que passou da janela.
   * Roda junto do poll (nao ha agendador proprio) mas no maximo a cada 5 min.
   */
  private async runHousekeeping(nowMs: number): Promise<void> {
    if (nowMs - this.lastHousekeepingMs < HOUSEKEEPING_INTERVAL_MS) return;
    this.lastHousekeepingMs = nowMs;
    await this.repository.closeQuiet({
      now: new Date(nowMs),
      before: new Date(nowMs - this.quietMs()),
      quietMs: this.quietMs(),
    });
  }

  async list(query: OperationalOccurrenceListQuery = {}): Promise<OperationalOccurrenceListResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const now = new Date(this.now());
    const { items, total } = await this.repository.list({
      now,
      quietMs: this.quietMs(),
      limit,
      offset,
      active: query.active,
      unacknowledged: query.unacknowledged,
      type: query.type,
      deviceId: query.deviceId,
      interfaceId: query.interfaceId,
      from: query.from,
      to: query.to,
    });
    return {
      items: items.map(toDto),
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  /** ACK: preserva o primeiro operador, encerra o episodio e mantem o historico. */
  async acknowledge(id: string, user: AuthUser): Promise<OperationalOccurrenceAckResponse> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new OperationalOccurrenceError('OCCURRENCE_NOT_FOUND', 'Ocorrência não encontrada');
    }
    if (existing.acknowledgedAt) return { occurrence: toDto(existing), acknowledged: false };
    const acknowledgedAt = new Date(this.now());
    const updated = await this.repository.acknowledge(id, {
      acknowledgedAt,
      acknowledgedBy: user.username,
      closeReason: 'ACKNOWLEDGED',
    });
    return { occurrence: toDto(updated ?? existing), acknowledged: true };
  }

  /**
   * Compatibilidade do `/api/alarms/occurrences` (F8): a MESMA lista persistente
   * alimenta o painel antigo, sem mudar o contrato `InterfaceOccurrence[]`.
   */
  async listInterfaceOccurrences(windowMinutes: number, limit: number): Promise<InterfaceOccurrence[]> {
    const nowMs = this.now();
    const { items } = await this.repository.list({
      now: new Date(nowMs),
      quietMs: this.quietMs(),
      limit,
      offset: 0,
      from: new Date(nowMs - windowMinutes * 60_000),
    });
    return items.map((record) => ({
      kind: record.type === 'CRC_FCS' ? 'CRC' : 'DISCARDS',
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      interfaceId: record.interfaceId,
      interfaceName: record.interfaceName,
      interfaceLabel: record.interfaceLabel,
      ifIndex: record.ifIndex,
      crcDelta: record.crcDeltaTotal.toString(),
      rxDelta: record.rxDiscardDeltaTotal.toString(),
      txDelta: record.txDiscardDeltaTotal.toString(),
      ratePerMinute: record.currentRatePerMin,
      lastOccurrenceAt: record.lastSeenAt.toISOString(),
      intervals: record.occurrenceCount,
      windowMinutes,
    }));
  }
}

function toState(record: OperationalOccurrenceRecord): OperationalOccurrenceState {
  return {
    id: record.id,
    firstSeenAtMs: record.firstSeenAt.getTime(),
    lastSeenAtMs: record.lastSeenAt.getTime(),
    lastSampleAtMs: record.lastSampleAt.getTime(),
    occurrenceCount: record.occurrenceCount,
    crcDeltaTotal: record.crcDeltaTotal,
    rxDiscardDeltaTotal: record.rxDiscardDeltaTotal,
    txDiscardDeltaTotal: record.txDiscardDeltaTotal,
    currentRatePerMin: record.currentRatePerMin,
    peakRatePerMin: record.peakRatePerMin,
  };
}

export function toDto(record: OperationalOccurrenceRecord): OperationalOccurrence {
  const closeReason: OperationalOccurrenceCloseReason | null = record.closeReason;
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    type: record.type,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    interfaceId: record.interfaceId,
    interfaceName: record.interfaceName,
    interfaceLabel: record.interfaceLabel || record.interfaceName,
    ifIndex: record.ifIndex,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    occurrenceCount: record.occurrenceCount,
    crcDeltaTotal: bigintToSafeNumber(record.crcDeltaTotal),
    rxDiscardDeltaTotal: bigintToSafeNumber(record.rxDiscardDeltaTotal),
    txDiscardDeltaTotal: bigintToSafeNumber(record.txDiscardDeltaTotal),
    currentRatePerMin: record.currentRatePerMin,
    peakRatePerMin: record.peakRatePerMin,
    acknowledgedAt: record.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: record.acknowledgedBy ?? null,
    closedAt: record.closedAt?.toISOString() ?? null,
    closeReason,
    closeReasonLabel: operationalOccurrenceCloseReasonLabel(closeReason),
    severity: INFORMATIVE_SEVERITY[record.type],
  };
}
