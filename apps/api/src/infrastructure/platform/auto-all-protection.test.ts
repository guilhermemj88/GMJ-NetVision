import { describe, expect, it } from 'vitest';
import { evaluateAutoAllProtection } from './auto-all-protection';

const F1A = { deviceId: 'host-f1a', hostname: 'BHE-VTA-F1A-BGP-01' };

function evaluate(overrides: Partial<Parameters<typeof evaluateAutoAllProtection>[0]> = {}) {
  return evaluateAutoAllProtection({
    deviceId: 'outro',
    hostname: 'BHE-OUTRO-01',
    mitigationAllowlist: [],
    autoProfileDeviceIds: [],
    singlePilot: F1A,
    ...overrides,
  });
}

describe('A1-e — protecao AUTO-ALL para o opt-in do fallback CLI', () => {
  it('F1A e protegida pelo deviceId', () => {
    expect(evaluate({ deviceId: 'host-f1a', hostname: 'qualquer' })).toMatchObject({
      protected: true,
      by: 'SINGLE_PILOT_F1A',
    });
  });

  it('F1A e protegida pelo hostname (case-insensitive)', () => {
    expect(evaluate({ deviceId: 'id-novo', hostname: 'bhe-vta-f1a-bgp-01' })).toMatchObject({
      protected: true,
      by: 'SINGLE_PILOT_F1A',
    });
  });

  it('allowlist de mitigacao protege', () => {
    expect(evaluate({ deviceId: 'd-allow', mitigationAllowlist: ['d-allow'] })).toMatchObject({
      protected: true,
      by: 'MITIGATION_ALLOWLIST',
    });
  });

  it('profile AUTO protege', () => {
    expect(evaluate({ deviceId: 'd-auto', autoProfileDeviceIds: ['d-auto'] })).toMatchObject({
      protected: true,
      by: 'AUTO_PROFILE',
    });
  });

  it('equipamento sem contexto AUTO-ALL nao e protegido', () => {
    expect(evaluate()).toEqual({ protected: false });
  });

  it('sem piloto configurado a F1A so cai nas outras regras', () => {
    expect(
      evaluateAutoAllProtection({
        deviceId: 'host-f1a',
        hostname: 'BHE-VTA-F1A-BGP-01',
        mitigationAllowlist: [],
        autoProfileDeviceIds: [],
      }),
    ).toEqual({ protected: false });
  });

  it('precedencia: F1A antes de allowlist e de profile AUTO', () => {
    expect(
      evaluate({
        deviceId: 'host-f1a',
        mitigationAllowlist: ['host-f1a'],
        autoProfileDeviceIds: ['host-f1a'],
      }),
    ).toMatchObject({ by: 'SINGLE_PILOT_F1A' });
  });
});
