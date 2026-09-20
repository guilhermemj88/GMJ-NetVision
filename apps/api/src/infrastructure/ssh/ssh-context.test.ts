import { describe, expect, it } from 'vitest';
import { withSshContext } from './ssh-context';

const CONTEXT = 'switch virtual-system IMPLANTAR-IXBR';

describe('withSshContext', () => {
  it('keeps the current behaviour when no context is configured', () => {
    const commands = ['screen-length 0 temporary', 'display bgp peer'];
    expect(withSshContext(commands, null)).toEqual(commands);
    expect(withSshContext(commands, undefined)).toEqual(commands);
    expect(withSshContext(commands, '   ')).toEqual(commands);
  });

  it('inserts the context right after screen-length and before the real command', () => {
    expect(withSshContext(['screen-length 0 temporary', 'display bgp peer'], CONTEXT)).toEqual([
      'screen-length 0 temporary',
      CONTEXT,
      'display bgp peer',
    ]);
  });

  it('applies the context to the BGP verbose command', () => {
    expect(
      withSshContext(['screen-length 0 temporary', 'display bgp peer verbose'], CONTEXT),
    ).toEqual(['screen-length 0 temporary', CONTEXT, 'display bgp peer verbose']);
  });

  it('applies the context to a route lookup command', () => {
    expect(
      withSshContext(['screen-length 0 temporary', 'display ip routing-table 200.150.1.193'], CONTEXT),
    ).toEqual([
      'screen-length 0 temporary',
      CONTEXT,
      'display ip routing-table 200.150.1.193',
    ]);
  });

  it('prepends the context when there is no screen-length preparation', () => {
    expect(withSshContext(['display interface description'], CONTEXT)).toEqual([
      CONTEXT,
      'display interface description',
    ]);
  });

  it('does not mutate the original command list', () => {
    const commands = ['screen-length 0 temporary', 'display bgp peer'];
    withSshContext(commands, CONTEXT);
    expect(commands).toEqual(['screen-length 0 temporary', 'display bgp peer']);
  });
});
