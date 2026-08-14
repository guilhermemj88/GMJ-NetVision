import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeZabbixInterfaceItems, ZabbixAdapter, type ZabbixItem } from './zabbix-adapter';

afterEach(() => vi.unstubAllGlobals());

describe('ZabbixAdapter', () => {
  it('uses the JSON-RPC auth field for Zabbix 6.0 tokens by default', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: body.method === 'apiinfo.version' ? '6.0.33' : [],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ZabbixAdapter('https://zabbix.example.test', 'token-super-secreto');
    expect(await adapter.healthcheck()).toEqual({ version: '6.0.33' });
    await adapter.getItems('10101');

    const versionInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const itemInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(String(versionInit.body))).not.toHaveProperty('auth');
    expect(JSON.parse(String(itemInit.body))).toHaveProperty('auth', 'token-super-secreto');
    expect(itemInit.headers).not.toHaveProperty('Authorization');
  });

  it('groups item.get metrics by SNMP ifIndex and keeps their item references', () => {
    const item = (itemid: string, key_: string, lastvalue: string, units = ''): ZabbixItem => ({
      itemid,
      hostid: '7',
      name: 'Interface 100GE0/0/5(): metric',
      key_,
      lastvalue,
      units,
      value_type: '3',
      status: '0',
    });
    const interfaces = normalizeZabbixInterfaceItems('7', 'zabbix-7', [
      item('rx-158', 'net.if.in[ifHCInOctets.158]', '100', 'Bps'),
      item('tx-158', 'net.if.out[ifHCOutOctets.158]', '200', 'Bps'),
      item('status-158', 'net.if.status[ifOperStatus.158]', '1'),
      item('errors-158', 'net.if.in.errors[ifInErrors.158]', '3'),
      item('rx-159', 'net.if.in[ifHCInOctets.159]', '50', 'Bps'),
    ]);
    expect(interfaces).toHaveLength(2);
    expect(interfaces[0]).toMatchObject({
      ifIndex: 158,
      name: '100GE0/0/5',
      rxBps: 800,
      txBps: 1600,
      operStatus: 'UP',
      rxItemId: 'rx-158',
      txItemId: 'tx-158',
      statusItemId: 'status-158',
      inErrorsItemId: 'errors-158',
    });
  });

  it('never includes the token or Zabbix error data in thrown messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Invalid params', data: 'token-super-secreto' },
            }),
            { status: 200 },
          ),
      ),
    );
    const adapter = new ZabbixAdapter(
      'https://zabbix.example.test/api_jsonrpc.php',
      'token-super-secreto',
    );
    await expect(adapter.getItems('7')).rejects.not.toThrow(/token-super-secreto/);
  });
});
