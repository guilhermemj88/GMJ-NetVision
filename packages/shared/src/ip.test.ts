import { describe, expect, it } from 'vitest';
import {
  ipAddressFamily,
  isIpv4Address,
  isIpv6Address,
  normalizeIpAddress,
  normalizeIpv4,
  normalizeIpv6,
} from './ip';

describe('IP address normalization', () => {
  it('canonicalizes equivalent IPv6 representations to a single value', () => {
    const canonical = '2001:db8::1';
    for (const variant of [
      '2001:0db8::1',
      '2001:0DB8::1',
      '2001:db8:0:0:0:0:0:1',
      '2001:db8::0:0:0:1',
      '[2001:db8::1]',
      ' 2001:db8::1 ',
    ]) {
      expect(normalizeIpv6(variant)).toBe(canonical);
    }
  });

  it('matches RFC 5952 compression and keeps IPv4-mapped notation', () => {
    expect(normalizeIpv6('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(normalizeIpv6('::1')).toBe('::1');
    expect(normalizeIpv6('::ffff:192.168.1.1')).toBe('::ffff:c0a8:101');
    expect(normalizeIpv6('FE80::ABCD')).toBe('fe80::abcd');
  });

  it('rejects invalid IPv6 input', () => {
    for (const invalid of ['', '2001:db8::1/64', '2001:zz8::1', '1:2:3:4:5:6:7:8:9', '10.0.0.1']) {
      expect(normalizeIpv6(invalid)).toBeNull();
    }
  });

  it('normalizes IPv4 and rejects invalid IPv4 input', () => {
    expect(normalizeIpv4('10.200.200.10')).toBe('10.200.200.10');
    expect(normalizeIpv4(' 010.001.02.3 ')).toBe('10.1.2.3');
    for (const invalid of [
      '256.1.1.1',
      '10.1.1',
      '10.1.1.1.1',
      '10.1.0002.3',
      '10.1.1.x',
      '2001:db8::1',
    ]) {
      expect(normalizeIpv4(invalid)).toBeNull();
    }
  });

  it('classifies families and canonicalizes dual-stack addresses', () => {
    expect(ipAddressFamily('10.0.0.1')).toBe('IPV4');
    expect(ipAddressFamily('2001:0DB8::2')).toBe('IPV6');
    expect(ipAddressFamily('not-an-ip')).toBeNull();
    expect(normalizeIpAddress('2001:0DB8::2')).toBe('2001:db8::2');
    expect(normalizeIpAddress('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIpAddress('10.0.0.999')).toBeNull();
    expect(isIpv4Address('10.0.0.1')).toBe(true);
    expect(isIpv6Address('10.0.0.1')).toBe(false);
    expect(isIpv6Address('2001:db8::1')).toBe(true);
  });
});
