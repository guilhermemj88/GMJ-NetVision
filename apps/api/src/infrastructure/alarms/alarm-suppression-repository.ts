import type {
  AlarmSuppressionClearReason,
  AlarmSuppressionMode,
  AlarmSuppressionReason,
  AlarmType,
} from '@gmj/shared';

/**
 * Supressao operacional persistida (F9.1).
 *
 * `fingerprint` e a chave estavel do que esta suprimido; `clearedAt` marca o
 * fim (recuperacao, liberacao manual ou expiracao da janela). Uma supressao
 * expirada continua na tabela como historico, mas nunca bloqueia alarme novo.
 */
export interface AlarmSuppressionRecord {
  id: string;
  fingerprint: string;
  deviceId: string;
  interfaceId: string;
  type: AlarmType;
  ruleId: string | null;
  metricKey: string | null;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note: string | null;
  suppressedAt: Date;
  suppressedBy: string;
  expiresAt: Date | null;
  clearedAt: Date | null;
  clearedReason: AlarmSuppressionClearReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlarmSuppressionCreateInput {
  fingerprint: string;
  deviceId: string;
  interfaceId: string;
  type: AlarmType;
  ruleId?: string | null | undefined;
  metricKey?: string | null | undefined;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note?: string | null | undefined;
  suppressedAt: Date;
  suppressedBy: string;
  expiresAt?: Date | null | undefined;
}

export interface AlarmSuppressionFilter {
  deviceId?: string | undefined;
  interfaceIds?: readonly string[] | undefined;
  fingerprints?: readonly string[] | undefined;
  types?: readonly AlarmType[] | undefined;
}

export interface AlarmSuppressionRepository {
  /**
   * Cria a supressao quando o fingerprint NAO tem outra ativa; devolve `null`
   * nesse caso (a rota responde 409 sem duplicar historico).
   */
  create(input: AlarmSuppressionCreateInput): Promise<AlarmSuppressionRecord | null>;
  /** Supressoes que ainda bloqueiam reabertura (ignora expiradas e liberadas). */
  listActive(now: Date, filter?: AlarmSuppressionFilter): Promise<AlarmSuppressionRecord[]>;
  /** Historico completo, mais recente primeiro (operador precisa ver o passado). */
  listRecent(limit: number): Promise<AlarmSuppressionRecord[]>;
  findById(id: string): Promise<AlarmSuppressionRecord | null>;
  /** Liberacao explicita (operador) ou por recuperacao detectada pelo motor. */
  clear(
    id: string,
    clearedAt: Date,
    clearedReason: AlarmSuppressionClearReason,
  ): Promise<AlarmSuppressionRecord | null>;
  /**
   * Recuperacao tecnica: encerra SOMENTE as supressoes `UNTIL_CLEAR` dos
   * fingerprints informados (uma janela `UNTIL_TIME` e mantida ate expirar).
   */
  clearRecovered(fingerprints: readonly string[], clearedAt: Date): Promise<number>;
  /** Housekeeping: marca como EXPIRED as janelas UNTIL_TIME vencidas. */
  expireDue(now: Date): Promise<number>;
}
