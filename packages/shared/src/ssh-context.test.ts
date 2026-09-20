import { describe, expect, it } from 'vitest';
import {
  isValidSshContextCommand,
  normalizeSshContextCommand,
} from './ssh-context';

describe('isValidSshContextCommand', () => {
  it('accepts the Huawei switch virtual-system pattern', () => {
    expect(isValidSshContextCommand('switch virtual-system IMPLANTAR-IXBR')).toBe(true);
    expect(isValidSshContextCommand('switch virtual-system vr_1.2-test')).toBe(true);
    expect(isValidSshContextCommand('  switch virtual-system VR-A  ')).toBe(true);
  });

  it('rejects command injection attempts', () => {
    for (const value of [
      'switch virtual-system A; display bgp peer',
      'switch virtual-system A && reboot',
      'switch virtual-system A || whoami',
      'switch virtual-system A\nreboot',
      'switch virtual-system A\rquit',
      'switch virtual-system `whoami`',
      'switch virtual-system $(reboot)',
      'system-view',
      'display bgp peer',
      'switch virtual-system',
      'switch virtual-system A B',
    ]) {
      expect(isValidSshContextCommand(value), value).toBe(false);
    }
  });
});

describe('normalizeSshContextCommand', () => {
  it('trims a valid command', () => {
    expect(normalizeSshContextCommand('  switch virtual-system IMPLANTAR-IXBR ')).toBe(
      'switch virtual-system IMPLANTAR-IXBR',
    );
  });

  it('converts empty and blank values to null', () => {
    expect(normalizeSshContextCommand('')).toBeNull();
    expect(normalizeSshContextCommand('   ')).toBeNull();
    expect(normalizeSshContextCommand(null)).toBeNull();
    expect(normalizeSshContextCommand(undefined)).toBeNull();
  });
});
