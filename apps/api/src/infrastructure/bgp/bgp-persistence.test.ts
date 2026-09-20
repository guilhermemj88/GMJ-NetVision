import { describe, expect, it } from 'vitest';
import {
  bigintToJsonNumber,
  bigintToJsonString,
  deriveBgpPeerDisplayName,
} from './bgp-persistence';

describe('deriveBgpPeerDisplayName', () => {
  it('prefers alias over description, name and peer address', () => {
    expect(
      deriveBgpPeerDisplayName('200.150.1.193', {
        alias: 'TRANSITO XYZ',
        description: 'desc',
        name: '100GE1/0/3',
      }),
    ).toBe('TRANSITO XYZ');
  });

  it('falls back to description when alias is empty', () => {
    expect(
      deriveBgpPeerDisplayName('200.150.1.193', {
        alias: '   ',
        description: 'UPSTREAM IX SP',
        name: '100GE1/0/4',
      }),
    ).toBe('UPSTREAM IX SP');
  });

  it('falls back to interface name when alias and description are empty', () => {
    expect(
      deriveBgpPeerDisplayName('200.150.1.193', {
        alias: null,
        description: '',
        name: 'XGE0/0/1',
      }),
    ).toBe('XGE0/0/1');
  });

  it('falls back to the peer address when there is no interface', () => {
    expect(deriveBgpPeerDisplayName('200.150.1.193', null)).toBe('200.150.1.193');
  });
});

describe('BGP BigInt JSON conversion', () => {
  it('converts safe BigInt receivedPrefixes to number', () => {
    expect(bigintToJsonNumber(1_099_912n)).toBe(1_099_912);
    expect(bigintToJsonNumber(null)).toBeNull();
  });

  it('converts remoteAs BigInt to string', () => {
    expect(bigintToJsonString(12345n)).toBe('12345');
    expect(bigintToJsonString(null)).toBeNull();
  });

  it('never returns a raw BigInt', () => {
    const converted = bigintToJsonNumber(2n ** 40n);
    expect(converted).not.toBeTypeOf('bigint');
  });
});
