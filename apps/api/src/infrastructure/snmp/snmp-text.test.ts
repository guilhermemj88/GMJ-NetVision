import { describe, expect, it } from 'vitest';
import { decodeSnmpText, normalizeLegacySnmpText } from './snmp-text';

describe('SNMP text decoding', () => {
  it('decodes UTF-8 Uint8Array values as text', () => {
    expect(decodeSnmpText(new Uint8Array(Buffer.from('Descrição óptica')))).toBe('Descrição óptica');
  });

  it('repairs the legacy comma-separated byte representation on read', () => {
    const legacy = [...Buffer.from('XGigabitEthernet0/0/1')].join(',');
    expect(normalizeLegacySnmpText(legacy)).toBe('XGigabitEthernet0/0/1');
    expect(normalizeLegacySnmpText('100GE0/0/1')).toBe('100GE0/0/1');
  });
});
