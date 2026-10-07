import type { AlarmType } from './types';

/**
 * Supressao operacional de alarme (F9.1).
 *
 * Separacao de dominio: OCCURRENCE = algo aconteceu; ALARM = uma condicao/regra
 * precisa de atencao; SUPPRESSION = o operador decidiu que aquele alarme nao
 * deve mais ser reaberto enquanto a condicao durar (porta desligada de
 * proposito, manutencao, falso positivo).
 */

export type AlarmSuppressionMode = 'UNTIL_CLEAR' | 'UNTIL_TIME';

export type AlarmSuppressionReason =
  | 'INTENTIONAL_SHUTDOWN'
  | 'MAINTENANCE'
  | 'FALSE_POSITIVE'
  | 'OTHER';

/** Como a supressao terminou (nunca confundido com recuperacao tecnica). */
export type AlarmSuppressionClearReason = 'RECOVERED' | 'MANUAL' | 'EXPIRED';

export interface AlarmSuppression {
  id: string;
  /** Chave estavel da supressao (interface + tipo + regra + metrica). */
  fingerprint: string;
  deviceId: string;
  interfaceId: string;
  type: AlarmType;
  ruleId: string | null;
  metricKey: string | null;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note: string | null;
  suppressedAt: string;
  suppressedBy: string;
  expiresAt: string | null;
  clearedAt: string | null;
  clearedReason: AlarmSuppressionClearReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlarmSuppressionFingerprintInput {
  interfaceId: string;
  type: AlarmType;
  ruleId?: string | null | undefined;
  metricKey?: string | null | undefined;
}

/**
 * Fingerprint canonico: `INTERFACE_DOWN` e por interface (nao tem regra nem
 * metrica); metricos carregam regra + metrica (`RX`/`TX`/`FCS`/`LANE_n`), o que
 * mantem RX e lane como supressoes distintas na optica.
 */
export function alarmSuppressionFingerprint(input: AlarmSuppressionFingerprintInput): string {
  if (input.type === 'INTERFACE_DOWN') return `${input.interfaceId}|INTERFACE_DOWN`;
  return [
    input.interfaceId,
    input.type,
    input.ruleId ?? '',
    input.metricKey ?? '',
  ].join('|');
}

/**
 * Supressao ativa = nao liberada manualmente, nao recuperada e (quando
 * `UNTIL_TIME`) ainda dentro da janela combinada.
 */
export function isAlarmSuppressionActiveAt(
  input: { clearedAt?: string | Date | null | undefined; expiresAt?: string | Date | null | undefined },
  nowMs: number,
): boolean {
  if (input.clearedAt) return false;
  if (!input.expiresAt) return true;
  const expires =
    input.expiresAt instanceof Date ? input.expiresAt.getTime() : new Date(input.expiresAt).getTime();
  return Number.isFinite(expires) && expires > nowMs;
}

export function isAlarmSuppressionActive(suppression: AlarmSuppression, nowMs: number): boolean {
  return isAlarmSuppressionActiveAt(suppression, nowMs);
}

/**
 * Motivo administrativo gravado no historico do alarme encerrado pela
 * supressao. `OTHER` cai em `MANUAL_SUPPRESSION` para nao inventar categoria.
 */
export function alarmResolutionReasonForSuppression(
  reason: AlarmSuppressionReason,
): 'MANUAL_SUPPRESSION' | 'INTENTIONAL_SHUTDOWN' | 'MAINTENANCE' | 'FALSE_POSITIVE' {
  if (reason === 'OTHER') return 'MANUAL_SUPPRESSION';
  return reason;
}
