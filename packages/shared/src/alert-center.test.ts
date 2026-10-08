import { describe, expect, it } from 'vitest';
import {
  ALERT_CENTER_CATEGORIES,
  ALERT_CENTER_DEFAULT_STATE,
  ALERT_CENTER_MAX_LIMIT,
  ALERT_CENTER_OCCURRENCE_WINDOW_MS,
  ALERT_CENTER_PERIOD_MS,
  ALERT_CENTER_PERIODS,
  ALERT_CENTER_STATE_FILTERS,
  ALERT_CENTER_TYPE_OPTIONS,
  alertCenterAttentionCount,
  alertCenterCategoryLabel,
  alertCenterPeriodLabel,
  alertCenterStateFilterLabel,
  alertCenterStateLabel,
  alertCenterStateTitle,
  alertCenterTypesForCategory,
  alertCenterTypesMatching,
  type AlertCenterSummary,
} from './alert-center';

function summary(patch: Partial<AlertCenterSummary> = {}): AlertCenterSummary {
  return {
    alarmsActive: 0,
    alarmsActiveCritical: 0,
    alarmsActiveMajor: 0,
    alarmsActiveWarning: 0,
    alarmsActiveInfo: 0,
    alarmsActiveUnacknowledged: 0,
    alarmsActiveAcknowledged: 0,
    occurrencesUnacknowledged: 0,
    occurrencesAcknowledged: 0,
    occurrencesQuiet24h: 0,
    ...patch,
  };
}

describe('estados da Central de Alertas', () => {
  it('tem rótulo curto e descrição para todo estado normalizado', () => {
    const states = [
      'ACTIVE_UNACKNOWLEDGED',
      'ACTIVE_ACKNOWLEDGED',
      'RESOLVED',
      'SUPPRESSED',
      'UNACKNOWLEDGED',
      'ACKNOWLEDGED',
      'QUIET_24H',
      'CLOSED',
    ] as const;
    for (const state of states) {
      expect(alertCenterStateLabel(state).length).toBeGreaterThan(0);
      expect(alertCenterStateTitle(state).length).toBeGreaterThan(alertCenterStateLabel(state).length);
    }
  });

  it('ACK de alarme e de ocorrência usam rótulos distintos do ativo', () => {
    expect(alertCenterStateLabel('ACTIVE_UNACKNOWLEDGED')).toBe('ATIVO');
    expect(alertCenterStateLabel('ACTIVE_ACKNOWLEDGED')).toBe('ACK');
    expect(alertCenterStateLabel('RESOLVED')).toBe('RESOLVIDO');
    expect(alertCenterStateLabel('SUPPRESSED')).toBe('SUPRIMIDO');
    expect(alertCenterStateLabel('QUIET_24H')).toBe('24H');
  });

  it('filtros de estado seguem os nomes operacionais e o default é ATIVOS', () => {
    expect(ALERT_CENTER_STATE_FILTERS).toHaveLength(6);
    expect(alertCenterStateFilterLabel('ACTIVE')).toBe('Ativos');
    expect(alertCenterStateFilterLabel('UNACKNOWLEDGED')).toBe('Não reconhecidos');
    expect(alertCenterStateFilterLabel('SUPPRESSED')).toBe('Suprimidos');
    expect(alertCenterStateFilterLabel('ALL')).toBe('Todos');
    expect(ALERT_CENTER_DEFAULT_STATE).toBe('ACTIVE');
  });

  it('categorias e janela de 24h são explícitas', () => {
    expect(ALERT_CENTER_CATEGORIES).toEqual(['ALARM', 'OCCURRENCE']);
    expect(alertCenterCategoryLabel('ALARM')).toBe('ALARME');
    expect(alertCenterCategoryLabel('OCCURRENCE')).toBe('OCORRÊNCIA');
    expect(ALERT_CENTER_OCCURRENCE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('períodos cobrem 1h/24h/7d/30d com ms corretos', () => {
    expect(ALERT_CENTER_PERIODS).toEqual(['1h', '24h', '7d', '30d']);
    expect(ALERT_CENTER_PERIOD_MS['1h']).toBe(3_600_000);
    expect(ALERT_CENTER_PERIOD_MS['24h']).toBe(86_400_000);
    expect(ALERT_CENTER_PERIOD_MS['7d']).toBe(604_800_000);
    expect(ALERT_CENTER_PERIOD_MS['30d']).toBe(2_592_000_000);
    expect(alertCenterPeriodLabel('7d')).toBe('Últimos 7 dias');
  });

  it('mantém o teto de paginação em 100 itens', () => {
    expect(ALERT_CENTER_MAX_LIMIT).toBe(100);
  });
});

describe('tipos da Central', () => {
  it('usa apenas tipos reais do domínio', () => {
    const values = ALERT_CENTER_TYPE_OPTIONS.map((option) => option.value);
    expect(values).toEqual([
      'INTERFACE_DOWN',
      'INTERFACE_ERRORS',
      'INTERFACE_CRC',
      'INTERFACE_DISCARDS',
      'OPTICAL_RX_DEGRADATION',
      'CRC_FCS',
      'DISCARDS',
    ]);
    expect(ALERT_CENTER_TYPE_OPTIONS.filter((option) => option.category === 'OCCURRENCE')).toHaveLength(2);
  });

  it('busca por tipo encontra alarme e ocorrência equivalentes', () => {
    expect(alertCenterTypesMatching('crc')).toEqual(
      expect.arrayContaining(['INTERFACE_CRC', 'CRC_FCS']),
    );
    expect(alertCenterTypesMatching('CRC/FCS')).toEqual(
      expect.arrayContaining(['INTERFACE_CRC', 'CRC_FCS']),
    );
    expect(alertCenterTypesMatching('discard')).toEqual(
      expect.arrayContaining(['INTERFACE_DISCARDS', 'DISCARDS']),
    );
    expect(alertCenterTypesMatching('link down')).toEqual(['INTERFACE_DOWN']);
    expect(alertCenterTypesMatching('optico')).toEqual(['OPTICAL_RX_DEGRADATION']);
    expect(alertCenterTypesMatching('nao-existe')).toEqual([]);
    expect(alertCenterTypesMatching('   ')).toEqual([]);
  });
});

describe('badge operacional', () => {
  it('conta apenas o que exige atenção: alarme ativo não reconhecido + ocorrência vigente', () => {
    expect(
      alertCenterAttentionCount(
        summary({
          alarmsActive: 9,
          alarmsActiveAcknowledged: 4,
          alarmsActiveUnacknowledged: 5,
          occurrencesUnacknowledged: 3,
        }),
      ),
    ).toBe(8);
  });

  it('sem pendências o badge fica em zero', () => {
    expect(alertCenterAttentionCount(summary({ alarmsActiveAcknowledged: 2 }))).toBe(0);
  });
});

describe('tipos por categoria (busca da Central)', () => {
  it('separa os tipos citados pela busca entre alarme e ocorrencia', () => {
    const matches = alertCenterTypesMatching('crc');
    expect(matches).toContain('INTERFACE_CRC');
    expect(matches).toContain('CRC_FCS');
    expect(alertCenterTypesForCategory(matches, 'ALARM')).toEqual(['INTERFACE_CRC']);
    expect(alertCenterTypesForCategory(matches, 'OCCURRENCE')).toEqual(['CRC_FCS']);
  });

  it('descarta tipos da outra entidade em qualquer direcao', () => {
    expect(alertCenterTypesForCategory(['INTERFACE_DOWN'], 'OCCURRENCE')).toEqual([]);
    expect(alertCenterTypesForCategory(['DISCARDS', 'INTERFACE_DISCARDS'], 'ALARM')).toEqual([
      'INTERFACE_DISCARDS',
    ]);
    expect(alertCenterTypesForCategory([], 'ALARM')).toEqual([]);
  });
});
