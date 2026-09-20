import { describe, expect, it, vi } from 'vitest';
import type { SnmpClient, SnmpVarBind } from '../../domain/ports';
import { BGP4_PEER_STATE_OID, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID } from './bgp-oids';
import { HuaweiBgpSnmpCollector } from './huawei-bgp-snmp';

function state(peerAddress: string, stateCode: number): SnmpVarBind {
  return { oid: `${BGP4_PEER_STATE_OID}.${peerAddress}`, value: stateCode };
}

function prefixes(peerAddress: string, receivedPrefixes: number): SnmpVarBind {
  return {
    oid: `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.0.1.1.1.4.${peerAddress}`,
    value: receivedPrefixes,
  };
}

describe('HuaweiBgpSnmpCollector', () => {
  it('walks both tables once and lets BGP4-MIB state govern prefix availability', async () => {
    const walk = vi.fn(async (_host: string, oid: string) => {
      if (oid === BGP4_PEER_STATE_OID) {
        return [
          state('200.150.1.193', 6),
          state('187.16.216.253', 3),
          state('45.164.184.97', 6),
          state('172.16.0.6', 2),
        ];
      }
      return [
        prefixes('200.150.1.193', 1099912),
        prefixes('187.16.216.253', 211752),
        prefixes('45.164.184.97', 0),
        prefixes('172.16.0.6', 0),
        prefixes('198.51.100.10', 50),
      ];
    });
    const client = { walk, get: vi.fn() } as unknown as SnmpClient;

    const collection = await new HuaweiBgpSnmpCollector(client).collect('172.16.0.1', {
      community: 'protected',
      version: 'v2c',
      port: 161,
    });

    expect(walk).toHaveBeenCalledTimes(2);
    expect(walk).toHaveBeenCalledWith('172.16.0.1', BGP4_PEER_STATE_OID, expect.any(Object));
    expect(walk).toHaveBeenCalledWith(
      '172.16.0.1',
      HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID,
      expect.any(Object),
    );
    expect(collection.errors).toEqual([]);
    expect(collection.peers).toEqual([
      {
        peerAddress: '200.150.1.193',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        receivedPrefixes: 1099912,
      },
      {
        peerAddress: '187.16.216.253',
        stateCode: 3,
        state: 'ACTIVE',
        established: false,
        receivedPrefixes: null,
      },
      {
        peerAddress: '45.164.184.97',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        receivedPrefixes: 0,
      },
      {
        peerAddress: '172.16.0.6',
        stateCode: 2,
        state: 'CONNECT',
        established: false,
        receivedPrefixes: null,
      },
    ]);
  });

  it('keeps authoritative peer states when the optional Huawei walk fails', async () => {
    const client = {
      get: vi.fn(),
      walk: vi.fn(async (_host: string, oid: string) => {
        if (oid === BGP4_PEER_STATE_OID) return [state('200.150.1.193', 6)];
        throw new Error('SNMP timeout connecting to 172.16.0.1:161');
      }),
    } as unknown as SnmpClient;

    const collection = await new HuaweiBgpSnmpCollector(client).collect('172.16.0.1', {});

    expect(collection.peers).toEqual([
      {
        peerAddress: '200.150.1.193',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        receivedPrefixes: null,
      },
    ]);
    expect(collection.errors).toEqual([
      'Falha na coleta Huawei de prefixes: SNMP timeout connecting to 172.16.0.1:161',
    ]);
  });

  it('fails the collection when the authoritative BGP4-MIB state walk fails', async () => {
    const client = {
      get: vi.fn(),
      walk: vi.fn(async (_host: string, oid: string) => {
        if (oid === BGP4_PEER_STATE_OID) throw new Error('BGP4-MIB unavailable');
        return [];
      }),
    } as unknown as SnmpClient;

    await expect(new HuaweiBgpSnmpCollector(client).collect('172.16.0.1', {})).rejects.toThrow(
      'BGP4-MIB unavailable',
    );
  });
});
