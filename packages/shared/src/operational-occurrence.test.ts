import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL_OCCURRENCE_QUIET_MS,
  bigintToSafeNumber,
  isOperationalOccurrenceCurrent,
  operationalOccurrenceCloseReasonLabel,
  operationalOccurrenceFingerprint,
  operationalOccurrenceTypeLabel,
  type OperationalOccurrence,
} from './operational-occurrence';

const BASE_TIME = Date.parse('2026-10-12T12:00:00.000Z');

function occurrence(patch: Partial<OperationalOccurrence> = {}): OperationalOccurrence {
  return {
    id: 'occ-1',
    fingerprint: 'iface-1|CRC_FCS',
    type: 'CRC_FCS',
    deviceId: 'dev-1',
    deviceName: 'CEM-CEN-6730-MPLS-01',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceLabel: '100GE0/0/2',
    ifIndex: 67502222,
    firstSeenAt: new Date(BASE_TIME).toISOString(),
    lastSeenAt: new Date(BASE_TIME).toISOString(),
    occurrenceCount: 1,
    crcDeltaTotal: 1,
    rxDiscardDeltaTotal: 0,
    txDiscardDeltaTotal: 0,
    currentRatePerMin: 1,
    peakRatePerMin: 1,
    acknowledgedAt: null,
    acknowledgedBy: null,
    closedAt: null,
    closeReason: null,
    severity: 'WARNING',
    ...patch,
  };
}

describe('operationalOccurrenceFingerprint', () => {
  it('usa interface + tipo: RX e TX de discard nunca viram dois episodios', () => {
    expect(operationalOccurrenceFingerprint('iface-1', 'DISCARDS')).toBe('iface-1|DISCARDS');
    expect(operationalOccurrenceFingerprint('iface-1', 'CRC_FCS')).toBe('iface-1|CRC_FCS');
  });

  it('nao depende de device nem de janela de tempo', () => {
    const first = operationalOccurrenceFingerprint('iface-1', 'CRC_FCS');
    const second = operationalOccurrenceFingerprint('iface-1', 'CRC_FCS');
    expect(first).toBe(second);
    expect(first).not.toContain('dev-1');
  });
});

describe('isOperationalOccurrenceCurrent', () => {
  it('continua vigente com 23h59 desde a ultima ocorrencia', () => {
    const lastSeen = new Date(BASE_TIME - (OPERATIONAL_OCCURRENCE_QUIET_MS - 60_000)).toISOString();
    expect(isOperationalOccurrenceCurrent({ acknowledgedAt: null, lastSeenAt: lastSeen }, BASE_TIME)).toBe(
      true,
    );
  });

  it('sai do painel compacto ao completar 24h sem nova ocorrencia', () => {
    const lastSeen = new Date(BASE_TIME - (OPERATIONAL_OCCURRENCE_QUIET_MS + 60_000)).toISOString();
    expect(isOperationalOccurrenceCurrent({ acknowledgedAt: null, lastSeenAt: lastSeen }, BASE_TIME)).toBe(
      false,
    );
  });

  it('reconhecida pelo operador nunca e considerada vigente', () => {
    expect(
      isOperationalOccurrenceCurrent(
        { acknowledgedAt: new Date(BASE_TIME - 1000).toISOString(), lastSeenAt: new Date(BASE_TIME).toISOString() },
        BASE_TIME,
      ),
    ).toBe(false);
  });

  it('timestamp invalido nao e vigente (dado ruim nao vira card eterno)', () => {
    expect(isOperationalOccurrenceCurrent({ acknowledgedAt: null, lastSeenAt: 'nope' }, BASE_TIME)).toBe(
      false,
    );
  });
});

describe('labels operacionais', () => {
  it('traduz o tipo e o motivo de encerramento', () => {
    expect(operationalOccurrenceTypeLabel('CRC_FCS')).toBe('CRC/FCS');
    expect(operationalOccurrenceTypeLabel('DISCARDS')).toBe('DISCARDS');
    expect(operationalOccurrenceCloseReasonLabel('ACKNOWLEDGED')).toBe('reconhecida pelo operador');
    expect(operationalOccurrenceCloseReasonLabel('QUIET_24H')).toBe('sem novas ocorrências por 24h');
    expect(operationalOccurrenceCloseReasonLabel('MANUAL')).toBe('encerrada manualmente');
    expect(operationalOccurrenceCloseReasonLabel(null)).toBeNull();
    expect(operationalOccurrenceCloseReasonLabel(undefined)).toBeNull();
  });
});

describe('bigintToSafeNumber', () => {
  it('converte contadores usuais sem perder valor', () => {
    expect(bigintToSafeNumber(0n)).toBe(0);
    expect(bigintToSafeNumber(1_234_567n)).toBe(1_234_567);
    expect(bigintToSafeNumber(42)).toBe(42);
  });

  it('satura em vez de perder precisao silenciosamente', () => {
    expect(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintToSafeNumber(-BigInt(Number.MAX_SAFE_INTEGER) - 10n)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('nao produz NaN para valores extremos', () => {
    expect(Number.isNaN(bigintToSafeNumber(2n ** 200n))).toBe(false);
  });
});

describe('DTO de ocorrencia', () => {
  it('carrega totais e motivo para o painel sem depender do repositorio', () => {
    const closed = occurrence({
      acknowledgedAt: new Date(BASE_TIME).toISOString(),
      acknowledgedBy: 'qa-preview',
      closedAt: new Date(BASE_TIME).toISOString(),
      closeReason: 'ACKNOWLEDGED',
      closeReasonLabel: operationalOccurrenceCloseReasonLabel('ACKNOWLEDGED'),
    });
    expect(closed.closeReasonLabel).toBe('reconhecida pelo operador');
    expect(closed.crcDeltaTotal).toBe(1);
    expect(isOperationalOccurrenceCurrent(closed, BASE_TIME)).toBe(false);
  });
});
