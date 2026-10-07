import type { OperationalOccurrenceCloseReason, OperationalOccurrenceType } from '@gmj/shared';

/**
 * Ocorrencia operacional persistida (F9.2).
 *
 * Diferente de `Alarm` (uma regra pediu atencao), a occurrence registra o fato:
 * "houve CRC" ou "houve discard" nas ultimas 24h. O `fingerprint` e
 * `interfaceId|tipo`, portanto RX e TX de discard NUNCA sao dois episodios.
 */
export interface OperationalOccurrenceRecord {
  id: string;
  fingerprint: string;
  type: OperationalOccurrenceType;
  deviceId: string;
  deviceName: string;
  interfaceId: string;
  interfaceName: string;
  interfaceLabel: string;
  ifIndex: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Ultima amostra COM ocorrencia considerada (base do intervalo da taxa). */
  lastSampleAt: Date;
  occurrenceCount: number;
  crcDeltaTotal: bigint;
  rxDiscardDeltaTotal: bigint;
  txDiscardDeltaTotal: bigint;
  currentRatePerMin: number;
  peakRatePerMin: number;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  closedAt: Date | null;
  closeReason: OperationalOccurrenceCloseReason | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Valores calculados pelo dominio (`operational-occurrence-rules.ts`) prontos
 * para persistir. Timestamps em milissegundos: o repositorio converte para
 * `DateTime`, mantendo a matematica de intervalo em um unico tipo.
 */
export interface OperationalOccurrenceValues {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastSampleAtMs: number;
  occurrenceCount: number;
  crcDeltaTotal: bigint;
  rxDiscardDeltaTotal: bigint;
  txDiscardDeltaTotal: bigint;
  currentRatePerMin: number;
  peakRatePerMin: number;
}

/** Episodio aberto que precisa ser encerrado antes de abrir o proximo. */
export interface OperationalOccurrenceSupersede {
  id: string;
  reason: OperationalOccurrenceCloseReason;
  closedAtMs: number;
}

/**
 * Aplicacao atomica de uma amostra: registra a associacao
 * (interface, timestamp, tipo) e cria/atualiza/atualiza o episodio. Se a
 * associacao ja existia (replay), NADA muda e `applied` volta `false`.
 */
export interface OperationalOccurrenceApplyInput {
  fingerprint: string;
  type: OperationalOccurrenceType;
  deviceId: string;
  interfaceId: string;
  sourceTimestamp: Date;
  action: 'CREATE' | 'UPDATE';
  /** Episodio alvo do UPDATE. */
  targetId?: string | null | undefined;
  /** Encerramento do episodio anterior, aplicado junto com o CREATE. */
  close?: OperationalOccurrenceSupersede | null | undefined;
  values: OperationalOccurrenceValues;
}

export interface OperationalOccurrenceApplyResult {
  /** `false` = replay/amostra ja processada; contadores preservados. */
  applied: boolean;
  record: OperationalOccurrenceRecord | null;
}

export interface OperationalOccurrenceListFilter {
  /** Instante de referencia (janela de 24h e filtros de historico). */
  now: Date;
  quietMs: number;
  limit: number;
  offset: number;
  /** Vigentes: sem ACK, nao encerradas e com ocorrencia nas ultimas quietMs. */
  active?: boolean | undefined;
  unacknowledged?: boolean | undefined;
  type?: OperationalOccurrenceType | undefined;
  deviceId?: string | undefined;
  interfaceId?: string | undefined;
  /** Filtro por ultima ocorrencia (`lastSeenAt`). */
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface OperationalOccurrenceListResult {
  items: OperationalOccurrenceRecord[];
  total: number;
}

export interface OperationalOccurrenceAcknowledgeInput {
  acknowledgedAt: Date;
  acknowledgedBy: string;
  closeReason: OperationalOccurrenceCloseReason;
}

export interface OperationalOccurrenceRepository {
  /** Aplica o plano do dominio de forma transacional e idempotente. */
  apply(input: OperationalOccurrenceApplyInput): Promise<OperationalOccurrenceApplyResult>;
  findById(id: string): Promise<OperationalOccurrenceRecord | null>;
  /** Episodio mais recente do fingerprint (vigente, encerrado ou reconhecido). */
  findLatestByFingerprint(fingerprint: string): Promise<OperationalOccurrenceRecord | null>;
  list(filter: OperationalOccurrenceListFilter): Promise<OperationalOccurrenceListResult>;
  /** ACK: preserva o primeiro operador; encerra o episodio se ainda estiver aberto. */
  acknowledge(
    id: string,
    input: OperationalOccurrenceAcknowledgeInput,
  ): Promise<OperationalOccurrenceRecord | null>;
  /**
   * Housekeeping: encerra como QUIET_24H os episodios sem ocorrencia desde
   * `before`, marcando `closedAt = lastSeenAt + quietMs` (o fim real do
   * episodio, nao o instante em que percebemos).
   */
  closeQuiet(input: { now: Date; before: Date; quietMs: number; limit?: number }): Promise<number>;
}
