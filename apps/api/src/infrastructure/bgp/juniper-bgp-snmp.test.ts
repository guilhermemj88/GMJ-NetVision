import { describe, expect, it, vi } from 'vitest';
import type { SnmpClient, SnmpVarBind } from '../../domain/ports';
import {
  JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID,
  JUNIPER_PEER_INDEX_OID,
  JUNIPER_PEER_LOCAL_AS_OID,
  JUNIPER_PEER_REMOTE_AS_OID,
  JUNIPER_PEER_STATE_OID,
  JUNIPER_PREFIX_IN_PREFIXES_OID,
  JuniperBgpSnmpCollector,
  addressFromBytes,
  formatIpv6,
  numericOidSuffix,
  parseJuniperPeerIndex,
  varbindBytes,
} from './juniper-bgp-snmp';

/** Sufixo REAL do índice: routingInstance . localType . localAddr . remoteType . remoteAddr. */
const IPV4_LOCAL = [10, 141, 1, 1];
const IPV4_REMOTE = [10, 141, 1, 81];
const IPV6_LOCAL = [0xfd, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const IPV6_REMOTE = [0x20, 0x01, 0x12, 0x91, 0x16, 0x02, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x0a];

const IPV4_KEY = [0, 1, ...IPV4_LOCAL, 1, ...IPV4_REMOTE].join('.');
// Sess�o IPv6: local e remoto s�o ambos type 2 (16 octetos cada).
const IPV6_KEY = [0, 2, ...IPV6_LOCAL, 2, ...IPV6_REMOTE].join('.');

function oid(base: string, key: string): string {
  return `${base}.${key}`;
}

describe('Juniper BGP4-V2 index helpers', () => {
  it('formats IPv6 with RFC 5952 zero compression', () => {
    expect(formatIpv6(IPV6_REMOTE)).toBe('2001:1291:1602:1::a');
    expect(formatIpv6(IPV6_LOCAL)).toBe('fd00:1::1');
    expect(formatIpv6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBe('::1');
    // Run de UM grupo não é comprimido (evita ambiguidade).
    expect(formatIpv6([0x20, 0x01, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6])).toBe(
      '2001:0:1:2:3:4:5:6',
    );
    expect(formatIpv6([0x20, 0x01, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7])).toBe(
      '2001:1:2:3:4:5:6:7',
    );
  });

  it('decodes IPv4 and IPv6 from the real octet layout only', () => {
    expect(addressFromBytes(1, IPV4_REMOTE)).toBe('10.141.1.81');
    expect(addressFromBytes(2, IPV6_REMOTE)).toBe('2001:1291:1602:1::a');
    // Tamanho incoerente com o tipo é rejeitado (nunca vira endereço inventado).
    expect(addressFromBytes(1, IPV6_LOCAL)).toBeNull();
    expect(addressFromBytes(2, IPV4_REMOTE)).toBeNull();
    expect(addressFromBytes(3, IPV4_REMOTE)).toBeNull();
    expect(addressFromBytes(1, [10, 141, 1, 999])).toBeNull();
  });

  it('parses the peer index with explicit address-type boundaries', () => {
    expect(parseJuniperPeerIndex([0, 1, ...IPV4_LOCAL, 1, ...IPV4_REMOTE])).toMatchObject({
      routingInstance: 0,
      localAddressType: 1,
      localAddress: '10.141.1.1',
      remoteAddressType: 1,
      remoteAddress: '10.141.1.81',
    });
    expect(parseJuniperPeerIndex([0, 2, ...IPV6_LOCAL, 2, ...IPV6_REMOTE])).toMatchObject({
      localAddressType: 2,
      localAddress: 'fd00:1::1',
      remoteAddressType: 2,
      remoteAddress: '2001:1291:1602:1::a',
    });
    // local IPv4 + remote IPv6 (o caso de um peer IPv6 em sessão dual).
    expect(
      parseJuniperPeerIndex([0, 1, ...IPV4_LOCAL, 2, ...IPV6_REMOTE])?.remoteAddress,
    ).toBe('2001:1291:1602:1::a');
  });

  it('rejects malformed suffixes and unknown address types', () => {
    expect(parseJuniperPeerIndex(null)).toBeNull();
    expect(parseJuniperPeerIndex([0, 1])).toBeNull();
    // tipo de endereço desconhecido
    expect(parseJuniperPeerIndex([0, 9, 1, 2, 3, 4, 1, 5, 6, 7, 8])).toBeNull();
    // sobra de octetos no fim
    expect(parseJuniperPeerIndex([0, 1, ...IPV4_LOCAL, 1, ...IPV4_REMOTE, 7])).toBeNull();
    // octetos faltando
    expect(parseJuniperPeerIndex([0, 1, ...IPV4_LOCAL, 1, ...IPV4_REMOTE.slice(0, 3)])).toBeNull();
  });

  it('reads OCTET STRING varbinds as bytes, never as text', () => {
    expect(varbindBytes(new Uint8Array([10, 141, 1, 81]))).toEqual([10, 141, 1, 81]);
    expect(varbindBytes([10, 141, 1, 81] as unknown as SnmpVarBind['value'])).toEqual([
      10, 141, 1, 81,
    ]);
    expect(varbindBytes('0a8d0151')).toEqual([10, 141, 1, 81]);
    expect(varbindBytes('00:0a:8d:01:51:00')).toEqual([0, 10, 141, 1, 81, 0]);
    expect(varbindBytes('nao-e-hex')).toBeNull();
    expect(varbindBytes(6)).toBeNull();
  });

  it('normalizes OID suffixes and refuses an OID from another column', () => {
    expect(numericOidSuffix(`.${JUNIPER_PEER_STATE_OID}.${IPV4_KEY}`, JUNIPER_PEER_STATE_OID)).toEqual([
      0, 1, ...IPV4_LOCAL, 1, ...IPV4_REMOTE,
    ]);
    expect(numericOidSuffix(`${JUNIPER_PEER_STATE_OID}.x`, JUNIPER_PEER_STATE_OID)).toBeNull();
    expect(numericOidSuffix(JUNIPER_PREFIX_IN_PREFIXES_OID, JUNIPER_PEER_STATE_OID)).toBeNull();
  });
});

interface WalkOptions {
  stateRows?: SnmpVarBind[];
  fail?: readonly string[];
}

function collectorFor(options: WalkOptions = {}): {
  collector: JuniperBgpSnmpCollector;
  walk: ReturnType<typeof vi.fn>;
} {
  const stateRows = options.stateRows ?? [
    { oid: oid(JUNIPER_PEER_STATE_OID, IPV4_KEY), value: 6 },
    { oid: oid(JUNIPER_PEER_STATE_OID, IPV6_KEY), value: 6 },
  ];
  const walk = vi.fn(async (_host: string, base: string): Promise<SnmpVarBind[]> => {
    if (options.fail?.includes(base)) throw new Error(`falha em ${base}`);
    switch (base) {
      case JUNIPER_PEER_STATE_OID:
        return stateRows;
      case JUNIPER_PEER_LOCAL_AS_OID:
        return [
          // O MESMO equipamento usa local-as diferentes por peer.
          { oid: oid(JUNIPER_PEER_LOCAL_AS_OID, IPV4_KEY), value: 265_185 },
          { oid: oid(JUNIPER_PEER_LOCAL_AS_OID, IPV6_KEY), value: 52_575 },
        ];
      case JUNIPER_PEER_REMOTE_AS_OID:
        return [
          { oid: oid(JUNIPER_PEER_REMOTE_AS_OID, IPV4_KEY), value: 23_106 },
          { oid: oid(JUNIPER_PEER_REMOTE_AS_OID, IPV6_KEY), value: 16_735 },
        ];
      case JUNIPER_PEER_INDEX_OID:
        return [
          { oid: oid(JUNIPER_PEER_INDEX_OID, IPV4_KEY), value: 124 },
          { oid: oid(JUNIPER_PEER_INDEX_OID, IPV6_KEY), value: 331 },
        ];
      case JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID:
        return [
          { oid: oid(JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID, IPV4_KEY), value: 1_000 },
          { oid: oid(JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID, IPV6_KEY), value: 2_000 },
        ];
      case JUNIPER_PREFIX_IN_PREFIXES_OID:
        return [
          // Índice real: peerIndex . afi . safi
          { oid: `${JUNIPER_PREFIX_IN_PREFIXES_OID}.124.1.1`, value: 1_103_955 },
          { oid: `${JUNIPER_PREFIX_IN_PREFIXES_OID}.124.2.1`, value: 9 },
          { oid: `${JUNIPER_PREFIX_IN_PREFIXES_OID}.331.2.1`, value: 245_187 },
          // safi != 1 (multicast) não pode contaminar o contador unicast.
          { oid: `${JUNIPER_PREFIX_IN_PREFIXES_OID}.331.2.2`, value: 777 },
        ];
      default:
        return [];
    }
  });
  const client = { walk, get: vi.fn() } as unknown as SnmpClient;
  return { collector: new JuniperBgpSnmpCollector(client), walk };
}

describe('JuniperBgpSnmpCollector', () => {
  it('joins columns by the real index and prefixes by peerIndex + afi + safi', async () => {
    const { collector, walk } = collectorFor();

    const collection = await collector.collect('167.250.0.254', { community: 'c', version: 'v2c' });

    expect(collection.errors).toEqual([]);
    expect(walk).toHaveBeenCalledTimes(6);
    expect(collection.peers).toEqual([
      {
        peerAddress: '10.141.1.81',
        addressFamily: 'IPV4',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        remoteAs: 23_106n,
        localAs: 265_185n,
        sessionUptimeSeconds: 1_000,
        receivedPrefixes: 1_103_955,
        provenance: {
          peerAddress: 'SNMP',
          state: 'SNMP',
          remoteAs: 'SNMP',
          localAs: 'SNMP',
          receivedPrefixes: 'SNMP',
          sessionUptimeSeconds: 'SNMP',
        },
      },
      {
        peerAddress: '2001:1291:1602:1::a',
        addressFamily: 'IPV6',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        remoteAs: 16_735n,
        localAs: 52_575n,
        sessionUptimeSeconds: 2_000,
        receivedPrefixes: 245_187,
        provenance: {
          peerAddress: 'SNMP',
          state: 'SNMP',
          remoteAs: 'SNMP',
          localAs: 'SNMP',
          receivedPrefixes: 'SNMP',
          sessionUptimeSeconds: 'SNMP',
        },
      },
    ]);
  });

  it('keeps a real zero distinct from an absent counter', async () => {
    const stateRows: SnmpVarBind[] = [
      { oid: oid(JUNIPER_PEER_STATE_OID, IPV4_KEY), value: 6 },
    ];
    const walk = vi.fn(async (_host: string, base: string) => {
      if (base === JUNIPER_PEER_STATE_OID) return stateRows;
      if (base === JUNIPER_PEER_INDEX_OID) {
        return [{ oid: oid(JUNIPER_PEER_INDEX_OID, IPV4_KEY), value: 124 }];
      }
      if (base === JUNIPER_PREFIX_IN_PREFIXES_OID) {
        return [{ oid: `${JUNIPER_PREFIX_IN_PREFIXES_OID}.124.1.1`, value: 0 }];
      }
      return [];
    });
    const client = { walk, get: vi.fn() } as unknown as SnmpClient;

    const [peer] = (await new JuniperBgpSnmpCollector(client).collect('mx', {})).peers;

    expect(peer?.receivedPrefixes).toBe(0);
  });

  it('leaves counters null for a peer that is not established', async () => {
    const { collector } = collectorFor({
      stateRows: [{ oid: oid(JUNIPER_PEER_STATE_OID, IPV4_KEY), value: 3 }],
    });

    const [peer] = (await collector.collect('mx', {})).peers;

    expect(peer).toMatchObject({
      stateCode: 3,
      state: 'ACTIVE',
      established: false,
      receivedPrefixes: null,
      sessionUptimeSeconds: null,
    });
  });

  it('keeps peer state when an optional column fails and reports the column', async () => {
    const { collector } = collectorFor({ fail: [JUNIPER_PEER_LOCAL_AS_OID] });

    const collection = await collector.collect('mx', {});

    expect(collection.peers).toHaveLength(2);
    expect(collection.peers[0]).toMatchObject({ localAs: null, remoteAs: 23_106n });
    expect(collection.errors).toEqual([
      `Falha na coluna localAs: falha em ${JUNIPER_PEER_LOCAL_AS_OID}`,
    ]);
  });

  it('fails the collection when the state table itself is unreachable', async () => {
    const { collector } = collectorFor({ fail: [JUNIPER_PEER_STATE_OID] });

    await expect(collector.collect('mx', {})).rejects.toThrow(
      `falha em ${JUNIPER_PEER_STATE_OID}`,
    );
  });

  it('accepts a 32-bit ASN delivered as OCTET STRING', async () => {
    const walk = vi.fn(async (_host: string, base: string): Promise<SnmpVarBind[]> => {
      if (base === JUNIPER_PEER_STATE_OID) {
        return [{ oid: oid(JUNIPER_PEER_STATE_OID, IPV4_KEY), value: 6 }];
      }
      if (base === JUNIPER_PEER_REMOTE_AS_OID) {
        return [
          {
            oid: oid(JUNIPER_PEER_REMOTE_AS_OID, IPV4_KEY),
            value: new Uint8Array([0xfa, 0x56, 0xea, 0x00]),
          },
        ];
      }
      return [];
    });
    const client = { walk, get: vi.fn() } as unknown as SnmpClient;

    const [peer] = (await new JuniperBgpSnmpCollector(client).collect('mx', {})).peers;

    expect(peer?.remoteAs).toBe(4_200_000_000n);
  });

  it('ignores rows whose index cannot be decoded', async () => {
    const { collector } = collectorFor({
      stateRows: [
        { oid: oid(JUNIPER_PEER_STATE_OID, IPV4_KEY), value: 6 },
        // mesmo OID base, mas com tipo de endereço inválido
        { oid: `${JUNIPER_PEER_STATE_OID}.0.7.1.2.3.4.1.5.6.7.8`, value: 6 },
      ],
    });

    expect((await collector.collect('mx', {})).peers).toHaveLength(1);
  });
});
