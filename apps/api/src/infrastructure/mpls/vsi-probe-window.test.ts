import { describe, it, expect } from 'vitest';
import { probeWindowCommand, type ProbeDirection } from './vsi-probe-window';
describe('fixed authorized probe window', () => {
  it('generates only the four literal commands', () => {
    expect(
      ['LOCAL', 'REMOTE'].flatMap((d) =>
        ['PING', 'TRACE'].map((o) =>
          probeWindowCommand(d as ProbeDirection, o as 'PING' | 'TRACE'),
        ),
      ),
    ).toEqual([
      'ping -a 10.100.101.0 -c 3 10.100.101.255',
      'tracert -a 10.100.101.0 -m 8 -q 1 10.100.101.255',
      'ping -a 10.100.101.255 -c 3 10.100.101.0',
      'tracert -a 10.100.101.255 -m 8 -q 1 10.100.101.0',
    ]);
  });
  it.each([
    '10.1.1.1',
    'LOCAL\n',
    'LOCAL|save',
    'LOCAL;save',
    'LOCAL&&save',
    '__proto__',
    'LOCAL -c 9',
  ])('rejects unrecognized direction %s', (d) => {
    expect(() => probeWindowCommand(d as ProbeDirection, 'PING')).toThrow('POLICY_BLOCKED');
  });
  it.each([
    'display version',
    'PING;save',
    'TRACE -m 30',
    'system-view',
    'screen-length 0 temporary',
  ])('rejects operation/command input %s', (o) => {
    expect(() => probeWindowCommand('LOCAL', o as 'PING')).toThrow('POLICY_BLOCKED');
  });
});
