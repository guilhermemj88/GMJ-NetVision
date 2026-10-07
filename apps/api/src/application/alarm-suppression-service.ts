import {
  alarmResolutionReasonForSuppression,
  alarmSuppressionFingerprint,
  isAlarmSuppressionActiveAt,
  type Alarm,
  type AlarmSuppression,
  type AlarmSuppressionMode,
  type AlarmSuppressionReason,
  type AuthUser,
} from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type {
  AlarmSuppressionRecord,
  AlarmSuppressionRepository,
} from '../infrastructure/alarms/alarm-suppression-repository';

export type AlarmSuppressionErrorCode =
  | 'ALARM_NOT_FOUND'
  | 'ALARM_NOT_ACTIVE'
  | 'SUPPRESSION_CONFLICT'
  | 'SUPPRESSION_NOT_FOUND'
  | 'INVALID_WINDOW';

/** Erro de dominio da operacao humana (ACK/supressao), mapeado para HTTP. */
export class AlarmSuppressionError extends Error {
  constructor(
    readonly code: AlarmSuppressionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlarmSuppressionError';
  }
}

export interface SuppressAlarmInput {
  alarmId: string;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note?: string | null | undefined;
  /** Obrigatorio em UNTIL_TIME; ignorado em UNTIL_CLEAR. */
  expiresAt?: Date | null | undefined;
}

export interface SuppressAlarmResult {
  suppression: AlarmSuppression;
  /** Quantos alarmes abertos foram encerrados administrativamente. */
  closedAlarms: number;
}

/** ISO strings para o DTO consumido pelo painel/Central. */
export function toAlarmSuppression(record: AlarmSuppressionRecord): AlarmSuppression {
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    deviceId: record.deviceId,
    interfaceId: record.interfaceId,
    type: record.type,
    ruleId: record.ruleId,
    metricKey: record.metricKey,
    mode: record.mode,
    reason: record.reason,
    note: record.note,
    suppressedAt: record.suppressedAt.toISOString(),
    suppressedBy: record.suppressedBy,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    clearedAt: record.clearedAt?.toISOString() ?? null,
    clearedReason: record.clearedReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Indice `fingerprint -> supressao ativa`, usado pelo motor e pelo AlarmService. */
export function indexActiveSuppressions(
  records: readonly AlarmSuppressionRecord[],
): Map<string, AlarmSuppressionRecord> {
  return new Map(records.map((record) => [record.fingerprint, record]));
}

/** Fingerprint do alarme (o mesmo que o motor usa para dedupe). */
export function fingerprintForAlarm(alarm: Alarm): string {
  return alarmSuppressionFingerprint({
    interfaceId: alarm.interfaceId,
    type: alarm.type,
    ruleId: alarm.ruleId ?? null,
    metricKey: alarm.metricKey ?? null,
  });
}

/**
 * ACK e supressao de alarmes (F9.1).
 *
 * ACK: registra o operador, NAO resolve, NAO altera endedAt, NAO mexe na regra e
 * NAO envia midia; repetir o ACK mantem o primeiro reconhecimento.
 *
 * Supressao: encerra o alarme aberto com motivo administrativo (nunca
 * apresentado como recuperacao tecnica) e impede a reabertura do fingerprint:
 * `UNTIL_CLEAR` libera quando a condicao normaliza, `UNTIL_TIME` expira sozinha.
 */
export class AlarmSuppressionService {
  constructor(
    private readonly alarms: AlarmRepository,
    private readonly suppressions: AlarmSuppressionRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acknowledge(alarmId: string, user: AuthUser): Promise<Alarm> {
    const alarm = await this.alarms.findById(alarmId);
    if (!alarm) {
      throw new AlarmSuppressionError('ALARM_NOT_FOUND', 'Alarme não encontrado');
    }
    if (alarm.endedAt) {
      throw new AlarmSuppressionError(
        'ALARM_NOT_ACTIVE',
        'Alarme já encerrado: reconhecimento não se aplica ao histórico',
      );
    }
    const updated = await this.alarms.acknowledge(alarmId, user.username ?? user.id, this.now());
    if (!updated) {
      throw new AlarmSuppressionError('ALARM_NOT_FOUND', 'Alarme não encontrado');
    }
    return updated;
  }

  async suppress(input: SuppressAlarmInput, user: AuthUser): Promise<SuppressAlarmResult> {
    const alarm = await this.alarms.findById(input.alarmId);
    if (!alarm) {
      throw new AlarmSuppressionError('ALARM_NOT_FOUND', 'Alarme não encontrado');
    }

    const now = this.now();
    const expiresAt = input.mode === 'UNTIL_TIME' ? (input.expiresAt ?? null) : null;
    if (input.mode === 'UNTIL_TIME') {
      if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
        throw new AlarmSuppressionError(
          'INVALID_WINDOW',
          'UNTIL_TIME exige um horário futuro em expiresAt',
        );
      }
    }

    const fingerprint = fingerprintForAlarm(alarm);
    // Cria primeiro: o conflito de fingerprint ativo e a unica condicao que
    // interrompe a operacao. Se o encerramento falhar depois, a supressao ja
    // existe e continua bloqueando a reabertura (estado seguro).
    const created = await this.suppressions.create({
      fingerprint,
      deviceId: alarm.deviceId,
      interfaceId: alarm.interfaceId,
      type: alarm.type,
      ruleId: alarm.ruleId ?? null,
      metricKey: alarm.metricKey ?? null,
      mode: input.mode,
      reason: input.reason,
      note: input.note ?? null,
      suppressedAt: now,
      suppressedBy: user.username ?? user.id,
      expiresAt,
    });
    if (!created) {
      throw new AlarmSuppressionError(
        'SUPPRESSION_CONFLICT',
        'Já existe supressão ativa para este alarme',
      );
    }

    const closedAlarms = await this.alarms.closeOpenAlarmsForFingerprint(
      {
        interfaceId: alarm.interfaceId,
        type: alarm.type,
        ruleId: alarm.ruleId ?? null,
        metricKey: alarm.metricKey ?? null,
      },
      now,
      alarmResolutionReasonForSuppression(input.reason),
    );

    return { suppression: toAlarmSuppression(created), closedAlarms };
  }

  async release(suppressionId: string): Promise<AlarmSuppression> {
    const cleared = await this.suppressions.clear(suppressionId, this.now(), 'MANUAL');
    if (!cleared) {
      throw new AlarmSuppressionError(
        'SUPPRESSION_NOT_FOUND',
        'Supressão não encontrada ou já liberada',
      );
    }
    return toAlarmSuppression(cleared);
  }

  async listActive(): Promise<AlarmSuppression[]> {
    const now = this.now();
    const rows = await this.suppressions.listActive(now);
    return rows.map(toAlarmSuppression);
  }

  async listRecent(limit: number): Promise<AlarmSuppression[]> {
    const rows = await this.suppressions.listRecent(limit);
    return rows.map(toAlarmSuppression);
  }

  /**
   * Housekeeping: fecha janelas UNTIL_TIME vencidas para que `clearedAt`
   * reflita o fim real e a supressao nunca seja confundida com ativa.
   */
  async expireDue(): Promise<number> {
    return this.suppressions.expireDue(this.now());
  }
}

/** Helper de leitura para a UI: a supressao ainda vale agora? */
export function isSuppressionActiveNow(
  suppression: AlarmSuppression | AlarmSuppressionRecord,
  nowMs: number,
): boolean {
  return isAlarmSuppressionActiveAt(suppression, nowMs);
}
