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

describe('ZabbixAdapter importacao SNMP v2c', () => {
  const SECRET = 'community-super-secreta';

  function jsonResult(result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', result }), { status: 200 });
  }

  function hostPayload(interfaces: unknown[]): unknown {
    return {
      hostid: '10101',
      host: 'OLT-FIBINET-01',
      name: 'OLT FIBINET 01',
      status: '0',
      inventory: { vendor: 'Huawei', model: 'MA5800-X15' },
      interfaces,
    };
  }

  function adapterWith(hosts: unknown[]): { adapter: ZabbixAdapter; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'host.get') return jsonResult(hosts);
      return jsonResult([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      adapter: new ZabbixAdapter('https://zabbix.example.test', 'token-super-secreto'),
      fetchMock,
    };
  }

  it('prefere a interface SNMP principal (type=2 main=1) e expoe apenas metadados publicos', async () => {
    const { adapter } = adapterWith([
      hostPayload([
        { interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1', port: '10050' },
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '2', bulk: '1', community: SECRET },
        },
        {
          interfaceid: '233',
          ip: '10.0.0.35',
          main: '0',
          type: '2',
          port: '161',
          details: { version: '2', community: 'outra-community' },
        },
      ]),
    ]);

    const candidates = await adapter.getHostCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      hostId: '10101',
      hostname: 'OLT-FIBINET-01',
      displayName: 'OLT FIBINET 01',
      managementIp: '10.0.0.34',
      primaryInterfaceId: '232',
      snmpAvailable: true,
      snmpVersion: null,
      snmpPort: 161,
    });
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('community');
    expect(serialized).not.toContain('details');
  });

  it('preview nunca solicita details: a community fica fora da memória do fluxo', async () => {
    const { adapter, fetchMock } = adapterWith([
      hostPayload([
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '2', community: SECRET },
        },
      ]),
    ]);
    const candidates = await adapter.getHostCandidates();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { selectInterfaces: string[] };
    };
    expect(body.method).toBe('host.get');
    expect(body.params.selectInterfaces).toEqual([
      'interfaceid',
      'ip',
      'dns',
      'useip',
      'port',
      'main',
      'type',
    ]);
    expect(body.params.selectInterfaces).not.toContain('details');
    // Mesmo que a API respondesse details por engano, o candidato não copia a
    // community nem a versão (que também vive em details).
    expect(JSON.stringify(candidates)).not.toContain(SECRET);
    expect(candidates[0]?.snmpVersion).toBeNull();
  });

  it('sem interface SNMP mantem o fallback anterior e marca SNMP indisponivel', async () => {
    const { adapter } = adapterWith([
      hostPayload([{ interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1', port: '10050' }]),
    ]);
    const candidates = await adapter.getHostCandidates();
    expect(candidates[0]).toMatchObject({
      managementIp: '192.168.10.5',
      primaryInterfaceId: '231',
      snmpAvailable: false,
      snmpVersion: null,
      snmpPort: null,
    });
  });

  it('interface SNMP sem main=1 vence a interface Agent principal (fallback type=2)', async () => {
    const { adapter } = adapterWith([
      hostPayload([
        { interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1' },
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '0',
          type: '2',
          port: '161',
          details: { version: '2', community: SECRET },
        },
      ]),
    ]);
    const candidates = await adapter.getHostCandidates();
    expect(candidates[0]).toMatchObject({ managementIp: '10.0.0.34', snmpPort: 161 });
  });

  it('getSnmpImportConfig devolve a config v2c e consulta details na interface', async () => {
    const { adapter, fetchMock } = adapterWith([
      hostPayload([
        { interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1' },
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '1161',
          details: { version: '2', bulk: '1', community: SECRET },
        },
      ]),
    ]);

    await expect(adapter.getSnmpImportConfig('10101')).resolves.toEqual({
      enabled: true,
      version: 'SNMP_V2C',
      host: '10.0.0.34',
      port: 1161,
      community: SECRET,
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { hostids: string; selectInterfaces: string[] };
    };
    expect(body.method).toBe('host.get');
    expect(body.params.hostids).toBe('10101');
    expect(body.params.selectInterfaces).toContain('details');
  });

  it('getSnmpImportConfig usa 161 quando a porta do Zabbix e vazia', async () => {
    const { adapter } = adapterWith([
      hostPayload([
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '',
          details: { version: '2', community: SECRET },
        },
      ]),
    ]);
    const config = await adapter.getSnmpImportConfig('10101');
    expect(config?.port).toBe(161);
  });

  it('nunca inventa community: v3, v2c sem community e host sem SNMP retornam null', async () => {
    const { adapter: v3Adapter } = adapterWith([
      hostPayload([
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '3', securityname: 'user', authpassphrase: 'segredo-v3' },
        },
      ]),
    ]);
    await expect(v3Adapter.getSnmpImportConfig('10101')).resolves.toBeNull();
    const v3Candidates = await v3Adapter.getHostCandidates();
    // A versão só existe em `details` (privado): o preview não a conhece.
    expect(v3Candidates[0]).toMatchObject({ snmpAvailable: true, snmpVersion: null });

    const { adapter: missingCommunity } = adapterWith([
      hostPayload([
        {
          interfaceid: '232',
          ip: '10.0.0.34',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '2', bulk: '1' },
        },
      ]),
    ]);
    await expect(missingCommunity.getSnmpImportConfig('10101')).resolves.toBeNull();

    const { adapter: withoutSnmp } = adapterWith([
      hostPayload([{ interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1' }]),
    ]);
    await expect(withoutSnmp.getSnmpImportConfig('10101')).resolves.toBeNull();
  });

  it('erro do Zabbix nunca expoe a community na mensagem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Invalid params', data: SECRET },
            }),
            { status: 200 },
          ),
      ),
    );
    const adapter = new ZabbixAdapter('https://zabbix.example.test', 'token-super-secreto');
    await expect(adapter.getSnmpImportConfig('10101')).rejects.not.toThrow(/community/);
  });

  it('community com macro Zabbix nao resolvida nunca vira credential', async () => {
    for (const macro of ['{$SNMP_COMMUNITY}', '{$COMMUNITY}', 'prefixo {$SNMP_COMMUNITY} sufixo']) {
      const { adapter } = adapterWith([
        hostPayload([
          {
            interfaceid: '232',
            ip: '10.0.0.34',
            main: '1',
            type: '2',
            port: '161',
            details: { version: '2', community: macro },
          },
        ]),
      ]);
      await expect(adapter.getSnmpImportConfig('10101')).resolves.toBeNull();
    }
  });

  it('useip=0 usa DNS como alvo SNMP sem corromper o managementIp orientado a IP', async () => {
    const { adapter } = adapterWith([
      hostPayload([
        { interfaceid: '231', ip: '192.168.10.5', main: '1', type: '1' },
        {
          interfaceid: '232',
          ip: '127.0.0.1',
          dns: 'olt-dns.netvision.local',
          useip: '0',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '2', community: SECRET },
        },
      ]),
    ]);
    const candidates = await adapter.getHostCandidates();
    // O placeholder do Zabbix (127.0.0.1) não substitui o IP real da interface
    // legada — e o managementIp nunca é zerado silenciosamente.
    expect(candidates[0]).toMatchObject({
      managementIp: '192.168.10.5',
      primaryInterfaceId: '232',
      snmpPort: 161,
    });
    await expect(adapter.getSnmpImportConfig('10101')).resolves.toMatchObject({
      host: 'olt-dns.netvision.local',
    });
  });

  it('useip=0 com IP real disponivel mantem o IP no managementIp e o DNS no alvo SNMP', async () => {
    const { adapter } = adapterWith([
      hostPayload([
        {
          interfaceid: '232',
          ip: '10.9.9.9',
          dns: 'olt-dns.netvision.local',
          useip: '0',
          main: '1',
          type: '2',
          port: '161',
          details: { version: '2', community: SECRET },
        },
      ]),
    ]);
    const candidates = await adapter.getHostCandidates();
    expect(candidates[0]?.managementIp).toBe('10.9.9.9');
    await expect(adapter.getSnmpImportConfig('10101')).resolves.toMatchObject({
      host: 'olt-dns.netvision.local',
    });
  });
});
