import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_TRAFFIC_RATE_FACTOR,
  USABLE_TRAFFIC_SAMPLE_SQL,
} from './traffic-sample-sql';
import {
  BASELINE_ONLY_RATE_BPS,
  COUNTER_RATE_TOLERANCE_RATIO,
} from '../snmp/traffic-rate';

describe('predicado SQL do guard read-side', () => {
  it('usa os MESMOS valores do traffic-rate (sem duplicar a regra)', () => {
    expect(ACCEPTED_TRAFFIC_RATE_FACTOR).toBe(1 + COUNTER_RATE_TOLERANCE_RATIO);
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain(String(BASELINE_ONLY_RATE_BPS));
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain(String(ACCEPTED_TRAFFIC_RATE_FACTOR));
  });

  it('exclui a sentinela de baseline e aplica o teto por capacidade', () => {
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('m."rxBps" > -1');
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('m."txBps" > -1');
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('i."speedBps" IS NULL');
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('i."speedBps" <= 0');
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('m."rxBps" <= i."speedBps" * 1.1');
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toContain('m."txBps" <= i."speedBps" * 1.1');
  });

  /**
   * Regressão (06/10): o predicado precisa ser SQL válido — a montagem anterior
   * gerava `OR ( AND ...` e quebrava `loadLatestMetrics` (mapa vazio). Este teste
   * fixa o texto exato e confere o balanceamento de parênteses.
   */
  it('gera SQL válido (texto exato, sem "OR ( AND", parênteses balanceados)', () => {
    expect(USABLE_TRAFFIC_SAMPLE_SQL).toBe(
      'm."rxBps" > -1 AND m."txBps" > -1 AND ' +
        '(i."speedBps" IS NULL OR i."speedBps" <= 0 OR ' +
        '(m."rxBps" <= i."speedBps" * 1.1 AND m."txBps" <= i."speedBps" * 1.1))',
    );
    expect(USABLE_TRAFFIC_SAMPLE_SQL).not.toMatch(/OR\s*\(\s*AND/i);
    const open = (USABLE_TRAFFIC_SAMPLE_SQL.match(/\(/g) ?? []).length;
    const close = (USABLE_TRAFFIC_SAMPLE_SQL.match(/\)/g) ?? []).length;
    expect(open).toBe(close);
  });
});
