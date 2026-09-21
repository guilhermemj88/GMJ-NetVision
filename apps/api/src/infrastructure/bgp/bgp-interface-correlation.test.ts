import { describe, expect, it } from 'vitest';
import type { NetworkInterface } from '@gmj/shared';
import { makeInterface } from '../../test-fixtures';
import {
  bgpPeerDisplayName,
  correlateBgpPeerInterface as correlateBgpPeerInterfaceFamily,
  type BgpRouteCommandResult,
} from './bgp-interface-correlation';

const deviceId = 'ne8000-1';
const peerAddress = '200.150.1.193';

/** IPv4 shorthand for the family-aware correlator (the legacy fixtures are IPv4). */
function correlateBgpPeerInterface(
  targetDeviceId: string,
  address: string,
  routeCommand: BgpRouteCommandResult,
  interfaces: NetworkInterface[],
) {
  return correlateBgpPeerInterfaceFamily(
    targetDeviceId,
    address,
    'IPV4',
    routeCommand,
    interfaces,
  );
}

function networkInterface(
  name: string,
  overrides: Partial<NetworkInterface> = {},
): NetworkInterface {
  return makeInterface({
    id: `if-${name}`,
    deviceId,
    name,
    ifIndex: 10,
    ...overrides,
  });
}

function route(...interfaces: string[]): BgpRouteCommandResult {
  const rows = interfaces.map(
    (name, index) => `200.150.1.192/30 OSPF 10 ${index} D 10.0.0.${index + 1} ${name}`,
  );
  return {
    status: 'SUCCESS',
    output: `Summary Count : ${rows.length}\n${rows.join('\n')}`,
  };
}

describe('BGP peer to interface correlation', () => {
  it('matches one unambiguous normalized Huawei interface', () => {
    const result = correlateBgpPeerInterface(
      deviceId,
      peerAddress,
      route('HundredGigabitEthernet 1/0/3'),
      [networkInterface('100GE1/0/3', { id: 'abc123', alias: 'TRANSITO XYZ' })],
    );
    expect(result).toMatchObject({
      correlationStatus: 'MATCHED',
      interfaceId: 'abc123',
      interfaceName: '100GE1/0/3',
      displayName: 'TRANSITO XYZ',
    });
  });

  it.each(['Null0', 'LoopBack0', 'InLoopBack0'])('rejects unsafe egress %s', (name) => {
    expect(
      correlateBgpPeerInterface(deviceId, peerAddress, route(name), [networkInterface(name)]),
    ).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', interfaceId: null });
  });

  it('rejects ECMP with two final interfaces', () => {
    expect(
      correlateBgpPeerInterface(deviceId, peerAddress, route('100GE1/0/1', '100GE1/0/2'), [
        networkInterface('100GE1/0/1'),
        networkInterface('100GE1/0/2'),
      ]),
    ).toMatchObject({ correlationStatus: 'AMBIGUOUS', interfaceId: null });
  });

  it('rejects an unresolved recursive next hop', () => {
    expect(
      correlateBgpPeerInterface(
        deviceId,
        peerAddress,
        {
          status: 'SUCCESS',
          output: 'Summary Count : 1\n200.150.1.193/32 IBGP 255 0 R 10.0.0.2',
        },
        [networkInterface('100GE1/0/1')],
      ),
    ).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', interfaceId: null });
  });

  it('rejects an interface absent from the device inventory', () => {
    expect(
      correlateBgpPeerInterface(deviceId, peerAddress, route('Vlanif999'), [
        networkInterface('Vlanif100'),
      ]),
    ).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', interfaceId: null });
  });

  it('rejects two inventory interfaces with the same normalized name', () => {
    expect(
      correlateBgpPeerInterface(deviceId, peerAddress, route('GigabitEthernet 1/0/1'), [
        networkInterface('GE1/0/1', { id: 'one' }),
        networkInterface('GigabitEthernet1/0/1', { id: 'two', ifIndex: 11 }),
      ]),
    ).toMatchObject({ correlationStatus: 'AMBIGUOUS', interfaceId: null });
  });

  it('uses the shared XGE/10GE normalization for a unique match', () => {
    expect(
      correlateBgpPeerInterface(deviceId, peerAddress, route('XGE1/0/1'), [
        networkInterface('10GE1/0/1', { id: 'ten-gig' }),
      ]),
    ).toMatchObject({ correlationStatus: 'MATCHED', interfaceId: 'ten-gig' });
  });

  it('keeps a technical SSH failure distinct from an inconclusive successful query', () => {
    expect(
      correlateBgpPeerInterface(
        deviceId,
        peerAddress,
        { status: 'COMMAND_FAILED', error: 'SSH connection timeout' },
        [],
      ),
    ).toMatchObject({
      correlationStatus: 'COMMAND_FAILED',
      interfaceId: null,
      correlationError: 'SSH connection timeout',
    });
    expect(
      correlateBgpPeerInterface(
        deviceId,
        peerAddress,
        { status: 'SUCCESS', output: 'Summary Count : 1\nparser inconclusivo' },
        [],
      ),
    ).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', correlationError: null });
  });

  it('returns NO_ROUTE when the successful lookup has no route', () => {
    expect(
      correlateBgpPeerInterface(
        deviceId,
        peerAddress,
        { status: 'SUCCESS', output: 'Summary Count : 0' },
        [],
      ),
    ).toMatchObject({ correlationStatus: 'NO_ROUTE', interfaceId: null });
  });

  it('correlates an IPv6 peer using the IPv6 route lookup output', () => {
    const ipv6Peer = '2001:db8::10';
    const result = correlateBgpPeerInterfaceFamily(
      deviceId,
      ipv6Peer,
      'IPV6',
      {
        status: 'SUCCESS',
        output: `Summary Count : 1
Destination  : 2001:DB8::10                       PrefixLength : 128
NextHop      : 2001:DB8::1                        Preference   : 60
Interface    : 100GE1/0/3                         Flags        : RD`,
      },
      [networkInterface('100GE1/0/3', { id: 'abc123', alias: 'TRANSITO IPV6' })],
    );
    expect(result).toMatchObject({
      correlationStatus: 'MATCHED',
      interfaceId: 'abc123',
      interfaceName: '100GE1/0/3',
      displayName: 'TRANSITO IPV6',
    });
  });

  it('keeps IPv6 ECMP and unresolved lookups without interface association', () => {
    const ipv6Peer = '2001:db8::10';
    const ecmp = correlateBgpPeerInterfaceFamily(
      deviceId,
      ipv6Peer,
      'IPV6',
      {
        status: 'SUCCESS',
        output: `Summary Count : 2
Destination  : 2001:DB8::10                       PrefixLength : 128
NextHop      : 2001:DB8::1                        Preference   : 60
Interface    : 100GE1/0/3                         Flags        : RD
Destination  : 2001:DB8::10                       PrefixLength : 128
NextHop      : 2001:DB8::2                        Preference   : 60
Interface    : 100GE1/0/4                         Flags        : RD`,
      },
      [networkInterface('100GE1/0/3'), networkInterface('100GE1/0/4', { ifIndex: 11 })],
    );
    expect(ecmp).toMatchObject({ correlationStatus: 'AMBIGUOUS', interfaceId: null });

    const unresolved = correlateBgpPeerInterfaceFamily(
      deviceId,
      ipv6Peer,
      'IPV6',
      { status: 'SUCCESS', output: 'Summary Count : 1\n2001:DB8::10/128 IBGP 255 0 R 2001:DB8::1' },
      [networkInterface('100GE1/0/3')],
    );
    expect(unresolved).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', interfaceId: null });
  });

  it('does not parse IPv6 output with the IPv4 route rules', () => {
    const result = correlateBgpPeerInterfaceFamily(
      deviceId,
      '2001:db8::10',
      'IPV6',
      {
        status: 'SUCCESS',
        output: 'Summary Count : 1\n200.150.1.192/30 Direct 0 0 D 200.150.1.194 100GE1/0/3',
      },
      [networkInterface('100GE1/0/3')],
    );
    expect(result).toMatchObject({ correlationStatus: 'NO_SAFE_INTERFACE', interfaceId: null });
  });
});

describe('BGP peer display name', () => {
  it('prefers alias over description and interface name', () => {
    expect(
      bgpPeerDisplayName(
        peerAddress,
        networkInterface('100GE1/0/3', {
          alias: 'TRANSITO XYZ',
          description: 'Descrição secundária',
        }),
      ),
    ).toBe('TRANSITO XYZ');
  });

  it('prefers description over interface name when alias is blank', () => {
    expect(
      bgpPeerDisplayName(
        peerAddress,
        networkInterface('100GE1/0/3', {
          alias: ' ',
          description: 'TRANSITO DESCRIPTION',
        }),
      ),
    ).toBe('TRANSITO DESCRIPTION');
  });

  it('uses interface name when alias and description are blank', () => {
    expect(bgpPeerDisplayName(peerAddress, networkInterface('100GE1/0/3'))).toBe('100GE1/0/3');
  });

  it('uses peer address as the final fallback', () => {
    expect(bgpPeerDisplayName(peerAddress, null)).toBe(peerAddress);
  });
});
