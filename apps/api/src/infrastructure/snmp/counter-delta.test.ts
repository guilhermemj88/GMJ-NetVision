import { describe, expect, it } from 'vitest';
import {
  calculateCounterDelta,
  calculateCounterDelta64,
  calculateCounterDeltaAuto,
  calculateFcsErrorsDelta,
  isPlausibleCounter32Wrap,
} from './counter-delta';

describe('SNMP error/discard counter deltas', () => {
  it('returns only new events', () => {
    expect(calculateCounterDelta(7057n, 7054n)).toBe(3n);
  });

  it('returns zero when the counter did not change', () => {
    expect(calculateCounterDelta(7054n, 7054n)).toBe(0n);
  });

  it('uses the first post-reset value without producing a negative delta', () => {
    expect(calculateCounterDelta(4n, 7054n)).toBe(4n);
  });

  it('handles a plausible Counter32 wrap', () => {
    expect(calculateCounterDelta(3n, 0xffff_fffen)).toBe(5n);
  });

  it('uses the first sample only as a baseline', () => {
    expect(calculateCounterDelta(7054n, undefined)).toBe(0n);
  });
});

describe('Counter64, largura mista e FCS/CRC (EtherLike-MIB)', () => {
  it('calcula delta de 64 bits com baseline e wrap por simetria', () => {
    expect(calculateCounterDelta64(10n, 4n)).toBe(6n);
    expect(calculateCounterDelta64(4n, undefined)).toBe(0n);
    expect(calculateCounterDelta64(3n, 0xffff_ffff_ffff_ffffn - 1n)).toBe(5n);
  });

  it('escolhe 32 bits quando ambos os lados cabem e 64 bits quando um excede', () => {
    expect(calculateCounterDeltaAuto(3n, 0xffff_fffen)).toBe(5n);
    expect(calculateCounterDeltaAuto(3n, 0x1_0000_0005n)).toBe(3n);
  });

  it('identifica wrap plausivel de 32 bits', () => {
    expect(isPlausibleCounter32Wrap(0xffff_fffen, 3n)).toBe(true);
    expect(isPlausibleCounter32Wrap(7_054n, 4n)).toBe(false);
  });

  it('preserva null (nao coletado) e usa baseline na primeira amostra de FCS', () => {
    expect(calculateFcsErrorsDelta(null, 10n)).toBeNull();
    expect(calculateFcsErrorsDelta(10n, null)).toBe(0n);
    expect(calculateFcsErrorsDelta(10n, undefined)).toBe(0n);
    expect(calculateFcsErrorsDelta(12n, 10n)).toBe(2n);
  });

  it('aceita wrap de 32 bits no delta de FCS', () => {
    expect(calculateFcsErrorsDelta(3n, 0xffff_fffen)).toBe(5n);
  });

  it('reset/discontinuidade continua virando o valor atual (nunca negativo)', () => {
    expect(calculateFcsErrorsDelta(1n, 9_000n)).toBe(1n);
  });
});
