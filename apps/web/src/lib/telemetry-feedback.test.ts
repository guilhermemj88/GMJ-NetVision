import { describe, expect, it } from 'vitest';
import {
  describeCollectionAge,
  describePollFeedback,
  emptyHistoryNotice,
  historyEmptyMessage,
  latestOpticalCollectionAt,
} from './telemetry-feedback';
import type { HostPollResult } from './api';

function result(overrides: Partial<HostPollResult> = {}): HostPollResult {
  return {
    hostId: 'dev-1',
    polledAt: '2026-10-08T12:00:00.000Z',
    interfacesChecked: 10,
    interfaceSamples: 0,
    ...overrides,
  };
}

describe('feedback do VERIFICAR AGORA (F9.6)', () => {
  it('sucesso completo quando telemetria e óptico foram coletados', () => {
    const feedback = describePollFeedback(result({
      telemetry: { samples: 12, skipped: 0, baselines: 0, retryAfterSeconds: null },
      optical: { sampled: true, interfacesSampled: 4, skipped: false, retryAfterSeconds: null },
    }));
    expect(feedback).toEqual({ tone: 'ok', message: 'Telemetria e óptico atualizados.' });
  });

  it('parcial quando o óptico veio e a telemetria aguarda os 45 s', () => {
    const feedback = describePollFeedback(result({
      telemetry: { samples: 0, skipped: 3, baselines: 0, retryAfterSeconds: 32 },
      optical: { sampled: true, interfacesSampled: 4, skipped: false, retryAfterSeconds: null },
    }));
    expect(feedback.tone).toBe('partial');
    expect(feedback.message).toBe('Óptico atualizado. Telemetria aguardando intervalo mínimo de 32 s.');
  });

  it('baseline quando o gap longo/descontinuidade rebaseou os contadores', () => {
    const feedback = describePollFeedback(result({
      telemetry: { samples: 0, skipped: 0, baselines: 5, retryAfterSeconds: null },
      optical: { sampled: true, interfacesSampled: 5, skipped: false, retryAfterSeconds: null },
    }));
    expect(feedback.tone).toBe('baseline');
    expect(feedback.message).toContain('Baseline atualizado');
    expect(feedback.message).toContain('45 s');
  });

  it('falha óptica: telemetria atualizada e leitura óptica indisponível', () => {
    const feedback = describePollFeedback(result({
      telemetry: { samples: 8, skipped: 0, baselines: 0, retryAfterSeconds: null },
      optical: { sampled: false, interfacesSampled: 0, skipped: false, retryAfterSeconds: null },
    }));
    expect(feedback).toEqual({
      tone: 'partial',
      message: 'Telemetria atualizada; leitura óptica indisponível.',
    });
  });

  it('anti-spam do manual explica quanto falta para o próximo óptico', () => {
    const feedback = describePollFeedback(result({
      telemetry: { samples: 3, skipped: 0, baselines: 0, retryAfterSeconds: null },
      optical: { sampled: false, interfacesSampled: 0, skipped: true, retryAfterSeconds: 12 },
    }));
    expect(feedback.tone).toBe('warning');
    expect(feedback.message).toBe('Telemetria atualizada. Óptico aguardando o intervalo de proteção (12 s).');
  });

  it('resposta antiga sem feedback mantém a mensagem genérica', () => {
    expect(describePollFeedback(result()).message).toBe('Equipamento atualizado com sucesso.');
  });
});

describe('estado vazio do histórico (F9.6)', () => {
  const now = Date.parse('2026-10-08T12:18:00.000Z');

  it('mostra o período e a idade da última coleta', () => {
    const notice = emptyHistoryNotice('6h', '2026-10-08T00:39:58.000Z', now);
    expect(notice).toBe('Sem amostras nas últimas 6 h · Última coleta: há 11h 38min');
  });

  it('sem coleta anterior o texto é explícito', () => {
    expect(emptyHistoryNotice('15m', null, now)).toBe('Sem amostras nas últimas 15 min · Sem coleta anterior');
    expect(historyEmptyMessage('24h')).toBe('Sem amostras nas últimas 24 h');
  });

  it('idade em minutos, horas e dias', () => {
    expect(describeCollectionAge(new Date(now - 8 * 60_000).toISOString(), now)).toBe('há 8 min');
    expect(describeCollectionAge(new Date(now - 90 * 60_000).toISOString(), now)).toBe('há 1h 30min');
    expect(describeCollectionAge(new Date(now - 26 * 60 * 60_000).toISOString(), now)).toBe('há 1d 2h');
    expect(describeCollectionAge(new Date(now - 5_000).toISOString(), now)).toBe('agora');
    expect(describeCollectionAge(null, now)).toBeNull();
    expect(describeCollectionAge('nao-e-data', now)).toBeNull();
  });

  it('óptico usa a leitura mais recente entre escalar e lanes', () => {
    expect(
      latestOpticalCollectionAt('2026-10-08T00:40:10.000Z', '2026-10-07T16:54:21.000Z'),
    ).toBe('2026-10-08T00:40:10.000Z');
    expect(
      latestOpticalCollectionAt(null, '2026-10-07T16:54:21.000Z'),
    ).toBe('2026-10-07T16:54:21.000Z');
    expect(latestOpticalCollectionAt(null, null)).toBeNull();
  });
});
