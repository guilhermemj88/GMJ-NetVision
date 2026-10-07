import { describe, expect, it } from 'vitest';
import {
  createAlarmRuleSchema,
  parseAlarmRuleConfig,
  parseAlarmRuleScope,
} from './alarm-rule-schema';

const validErrorsRule = {
  name: 'Erros RX — links 10G',
  type: 'INTERFACE_ERRORS',
  severity: 'MAJOR',
  scope: { speedsBps: [10_000_000_000] },
  config: {
    direction: 'RX',
    thresholdPerMinute: 50,
    recoveryThresholdPerMinute: 10,
    triggerSamples: 3,
    recoverySamples: 3,
  },
};

describe('createAlarmRuleSchema', () => {
  it('aceita regra valida e aplica defaults seguros', () => {
    const parsed = createAlarmRuleSchema.parse(validErrorsRule);
    expect(parsed).toMatchObject({
      enabled: true,
      mapLinkedOnly: true,
      mediaEnabled: false,
      scope: { speedsBps: [10_000_000_000] },
      config: { direction: 'RX', thresholdPerMinute: 50 },
    });
  });

  it('rejeita recovery >= threshold (histerese exige recuperacao mais folgada)', () => {
    const result = createAlarmRuleSchema.safeParse({
      ...validErrorsRule,
      config: { ...validErrorsRule.config, recoveryThresholdPerMinute: 50 },
    });
    expect(result.success).toBe(false);
  });

  it('rejeita campos desconhecidos no topo e no config (strict)', () => {
    expect(createAlarmRuleSchema.safeParse({ ...validErrorsRule, extra: 1 }).success).toBe(false);
    expect(
      createAlarmRuleSchema.safeParse({
        ...validErrorsRule,
        config: { ...validErrorsRule.config, surprise: true },
      }).success,
    ).toBe(false);
  });

  it('nao permite criar regra INTERFACE_DOWN nesta fase', () => {
    const result = createAlarmRuleSchema.safeParse({
      name: 'Down',
      type: 'INTERFACE_DOWN',
      severity: 'CRITICAL',
      config: {},
    });
    expect(result.success).toBe(false);
  });

  it('CRC nao aceita direcao (metrica de recepcao) e valida Counter64/32 pela mesma config', () => {
    const crc = {
      name: 'CRC/FCS 100G',
      type: 'INTERFACE_CRC',
      severity: 'CRITICAL',
      config: {
        thresholdPerMinute: 5,
        recoveryThresholdPerMinute: 0.5,
        triggerSamples: 3,
        recoverySamples: 3,
      },
    };
    expect(createAlarmRuleSchema.safeParse(crc).success).toBe(true);
    expect(
      createAlarmRuleSchema.safeParse({
        ...crc,
        config: { ...crc.config, direction: 'RX' },
      }).success,
    ).toBe(false);
  });

  it('valida scope: listas vazias e velocidades fora da faixa sao rejeitadas', () => {
    expect(
      createAlarmRuleSchema.safeParse({ ...validErrorsRule, scope: { devices: [] } }).success,
    ).toBe(false);
    expect(
      createAlarmRuleSchema.safeParse({ ...validErrorsRule, scope: { speedsBps: [0] } }).success,
    ).toBe(false);
    expect(
      createAlarmRuleSchema.safeParse({ ...validErrorsRule, scope: { speedsBps: [-1] } }).success,
    ).toBe(false);
  });

  it('limita samples de trigger/recovery ao teto do motor', () => {
    expect(
      createAlarmRuleSchema.safeParse({
        ...validErrorsRule,
        config: { ...validErrorsRule.config, triggerSamples: 11 },
      }).success,
    ).toBe(false);
  });
});

describe('parsers de leitura (revalidacao do que veio do banco)', () => {
  it('scope ausente vira objeto vazio; lixo vira null', () => {
    expect(parseAlarmRuleScope(undefined)).toEqual({});
    expect(parseAlarmRuleScope(null)).toEqual({});
    expect(parseAlarmRuleScope({ devices: 'host-1' })).toBeNull();
    expect(parseAlarmRuleScope({ devices: ['host-1'] })).toEqual({ devices: ['host-1'] });
  });

  it('config invalida ou tipo desconhecido vira null (linha ignorada)', () => {
    expect(
      parseAlarmRuleConfig('INTERFACE_ERRORS', {
        direction: 'RX',
        thresholdPerMinute: 50,
        recoveryThresholdPerMinute: 10,
        triggerSamples: 3,
        recoverySamples: 3,
      }),
    ).toMatchObject({ direction: 'RX', thresholdPerMinute: 50 });
    expect(parseAlarmRuleConfig('INTERFACE_ERRORS', { direction: 'X' })).toBeNull();
    expect(parseAlarmRuleConfig('INTERFACE_DOWN', {})).toBeNull();
    expect(parseAlarmRuleConfig('UNKNOWN', {})).toBeNull();
  });
});
