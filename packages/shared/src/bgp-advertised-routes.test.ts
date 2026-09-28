import { describe, expect, it } from 'vitest';
import { computeLocalPrepend } from './bgp-advertised-routes';

const LOCAL_AS = '268568';

describe('computeLocalPrepend', () => {
  it.each([
    [['268568', '271034'], 0],
    [['268568', '268568', '271034'], 1],
    [['268568', '268568', '268568', '271034'], 2],
    [['268568', '268633', '268633'], 0],
    [['268568', '271034', '271034', '271034'], 0],
    [
      ['268568', '268568', '268568', '268568', '268568', '268568', '268884'],
      5,
    ],
  ])('counts %j as %i', (asPath, expected) => {
    expect(computeLocalPrepend(asPath, LOCAL_AS)).toBe(expected);
  });

  it('does not count the local ASN reappearing after another ASN', () => {
    expect(computeLocalPrepend(['268568', '271034', '268568'], LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(['268568', '268568', '271034', '268568'], LOCAL_AS)).toBe(1);
  });

  it('never uses the total AS-PATH length as the prepend value', () => {
    const longThirdPartyPath = ['268568', '271034', '271034', '268633', '268725', '268884'];
    expect(computeLocalPrepend(longThirdPartyPath, LOCAL_AS)).toBe(0);
  });

  it('is zero when the path does not start with the local ASN', () => {
    expect(computeLocalPrepend(['271034', '268568', '268568'], LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(['271034'], LOCAL_AS)).toBe(0);
  });

  it('returns zero for empty or missing input instead of throwing', () => {
    expect(computeLocalPrepend([], LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(null, LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(undefined, LOCAL_AS)).toBe(0);
  });

  it('returns zero when the local ASN is unknown', () => {
    expect(computeLocalPrepend(['268568', '268568'], null)).toBe(0);
    expect(computeLocalPrepend(['268568', '268568'], '')).toBe(0);
    expect(computeLocalPrepend(['268568', '268568'], '   ')).toBe(0);
  });

  it('accepts a numeric local ASN and tolerates surrounding whitespace', () => {
    expect(computeLocalPrepend(['268568', '268568', ' 268568 ', '271034'], 268568)).toBe(2);
  });

  it('treats AS_SET members and 4-byte ASN notation literally', () => {
    // `{268568,271034}` is an AS_SET: it is not the local ASN repeated.
    expect(computeLocalPrepend(['{268568,271034}', '271034'], LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(['268568.5', '268568'], LOCAL_AS)).toBe(0);
    expect(computeLocalPrepend(['4200000001', '4200000001'], '4200000001')).toBe(1);
  });
});
