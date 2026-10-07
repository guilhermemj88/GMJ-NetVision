import { randomUUID } from 'node:crypto';
import type {
  OperationalOccurrenceApplyInput,
  OperationalOccurrenceApplyResult,
  OperationalOccurrenceAcknowledgeInput,
  OperationalOccurrenceListFilter,
  OperationalOccurrenceListResult,
  OperationalOccurrenceRecord,
  OperationalOccurrenceRepository,
} from './operational-occurrence-repository';
import type { OperationalOccurrenceCloseReason, OperationalOccurrenceType } from '@gmj/shared';

/** Identidade de exibicao usada quando o host nao esta cadastrado (testes/DEMO). */
export interface OccurrenceInterfaceIdentity {
  deviceName: string;
  interfaceName: string;
  interfaceLabel?: string | null;
  ifIndex: number;
}

function sourceKey(interfaceId: string, timestamp: Date, type: OperationalOccurrenceType): string {
  return `${interfaceId}|${timestamp.getTime()}|${type}`;
}

/**
 * Repositorio em memoria (DEMO_MODE / testes): mesma semantica do Prisma,
 * inclusive a idempotencia por (interface, timestamp, tipo) — replay nunca soma
 * o delta duas vezes nem cria episodio novo.
 */
export class DemoOperationalOccurrenceRepository implements OperationalOccurrenceRepository {
  private readonly occurrences = new Map<string, OperationalOccurrenceRecord>();
  private readonly sourceIndex = new Map<string, string>();
  private readonly identities: (interfaceId: string, deviceId: string) => OccurrenceInterfaceIdentity;

  constructor(
    identities: (interfaceId: string, deviceId: string) => OccurrenceInterfaceIdentity = (
      interfaceId,
      deviceId,
    ) => ({ deviceName: deviceId, interfaceName: interfaceId, ifIndex: 0 }),
  ) {
    this.identities = identities;
  }

  async apply(input: OperationalOccurrenceApplyInput): Promise<OperationalOccurrenceApplyResult> {
    const key = sourceKey(input.interfaceId, input.sourceTimestamp, input.type);
    if (this.sourceIndex.has(key)) return { applied: false, record: null };

    const values = {
      firstSeenAt: new Date(input.values.firstSeenAtMs),
      lastSeenAt: new Date(input.values.lastSeenAtMs),
      lastSampleAt: new Date(input.values.lastSampleAtMs),
      occurrenceCount: input.values.occurrenceCount,
      crcDeltaTotal: input.values.crcDeltaTotal,
      rxDiscardDeltaTotal: input.values.rxDiscardDeltaTotal,
      txDiscardDeltaTotal: input.values.txDiscardDeltaTotal,
      currentRatePerMin: input.values.currentRatePerMin,
      peakRatePerMin: input.values.peakRatePerMin,
    };

    let record: OperationalOccurrenceRecord;
    if (input.action === 'UPDATE' && input.targetId) {
      const existing = this.occurrences.get(input.targetId);
      if (!existing) return { applied: false, record: null };
      record = { ...existing, ...values, updatedAt: new Date() };
    } else {
      if (input.close) this.closeInPlace(input.close.id, input.close.reason, input.close.closedAtMs);
      const identity = this.identities(input.interfaceId, input.deviceId);
      record = {
        id: randomUUID(),
        fingerprint: input.fingerprint,
        type: input.type,
        deviceId: input.deviceId,
        deviceName: identity.deviceName,
        interfaceId: input.interfaceId,
        interfaceName: identity.interfaceName,
        interfaceLabel: identity.interfaceLabel ?? identity.interfaceName,
        ifIndex: identity.ifIndex,
        acknowledgedAt: null,
        acknowledgedBy: null,
        closedAt: null,
        closeReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
      };
    }
    this.occurrences.set(record.id, record);
    this.sourceIndex.set(key, record.id);
    return { applied: true, record: { ...record } };
  }

  async findById(id: string): Promise<OperationalOccurrenceRecord | null> {
    const record = this.occurrences.get(id);
    return record ? { ...record } : null;
  }

  async findLatestByFingerprint(fingerprint: string): Promise<OperationalOccurrenceRecord | null> {
    const candidates = [...this.occurrences.values()]
      .filter((record) => record.fingerprint === fingerprint)
      .sort(
        (left, right) =>
          right.lastSampleAt.getTime() - left.lastSampleAt.getTime() ||
          right.createdAt.getTime() - left.createdAt.getTime(),
      );
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async list(filter: OperationalOccurrenceListFilter): Promise<OperationalOccurrenceListResult> {
    const quietFloor = filter.now.getTime() - filter.quietMs;
    const items = [...this.occurrences.values()]
      .filter((record) => !filter.type || record.type === filter.type)
      .filter((record) => !filter.deviceId || record.deviceId === filter.deviceId)
      .filter((record) => !filter.interfaceId || record.interfaceId === filter.interfaceId)
      .filter((record) => !filter.unacknowledged || !record.acknowledgedAt)
      .filter((record) => !filter.from || record.lastSeenAt.getTime() >= filter.from.getTime())
      .filter((record) => !filter.to || record.lastSeenAt.getTime() <= filter.to.getTime())
      .filter(
        (record) =>
          !filter.active ||
          (!record.closedAt &&
            !record.acknowledgedAt &&
            record.lastSeenAt.getTime() >= quietFloor),
      )
      .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
    return {
      items: items
        .slice(filter.offset, filter.offset + filter.limit)
        .map((record) => ({ ...record })),
      total: items.length,
    };
  }

  async acknowledge(
    id: string,
    input: OperationalOccurrenceAcknowledgeInput,
  ): Promise<OperationalOccurrenceRecord | null> {
    const record = this.occurrences.get(id);
    if (!record) return null;
    // Idempotente: preserva o primeiro operador e nao reescreve um encerramento
    // anterior (episodio expirado por 24h mantem o motivo real do fim).
    if (!record.acknowledgedAt) {
      record.acknowledgedAt = input.acknowledgedAt;
      record.acknowledgedBy = input.acknowledgedBy;
      record.updatedAt = new Date();
    }
    if (!record.closedAt) {
      record.closedAt = input.acknowledgedAt;
      record.closeReason = input.closeReason;
      record.updatedAt = new Date();
    }
    return { ...record };
  }

  async closeQuiet(input: {
    now: Date;
    before: Date;
    quietMs: number;
    limit?: number;
  }): Promise<number> {
    const candidates = [...this.occurrences.values()]
      .filter((record) => !record.closedAt && record.lastSeenAt.getTime() < input.before.getTime())
      .sort((left, right) => left.lastSeenAt.getTime() - right.lastSeenAt.getTime())
      .slice(0, input.limit ?? 500);
    let closed = 0;
    for (const record of candidates) {
      if (this.closeInPlace(record.id, 'QUIET_24H', record.lastSeenAt.getTime() + input.quietMs)) {
        closed += 1;
      }
    }
    return closed;
  }

  private closeInPlace(
    id: string,
    reason: OperationalOccurrenceCloseReason,
    closedAtMs: number,
  ): boolean {
    const record = this.occurrences.get(id);
    if (!record || record.closedAt) return false;
    record.closedAt = new Date(closedAtMs);
    record.closeReason = reason;
    record.updatedAt = new Date();
    return true;
  }
}
