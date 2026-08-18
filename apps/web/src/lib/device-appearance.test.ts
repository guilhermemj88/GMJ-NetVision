import { describe, expect, it } from 'vitest';
import { resolveDeviceIconType } from './device-appearance';

describe('device icon appearance', () => {
  it('always gives manual selection priority over AUTO heuristics', () => {
    expect(
      resolveDeviceIconType(
        { hostname: 'NE8000-EDGE-01', model: 'Huawei NE8000', deviceType: 'edge' },
        'CORE_ROUTER',
      ),
    ).toBe('CORE_ROUTER');
  });

  it('uses role to distinguish NE8000 router variants in AUTO', () => {
    expect(resolveDeviceIconType({ model: 'NE8000', deviceType: 'core' })).toBe('CORE_ROUTER');
    expect(resolveDeviceIconType({ model: 'NE8000', deviceType: 'edge' })).toBe('EDGE_ROUTER');
    expect(resolveDeviceIconType({ model: 'NE8000', deviceType: 'router' })).toBe('ROUTER');
  });

  it('uses role to distinguish S6730 switch variants in AUTO', () => {
    expect(resolveDeviceIconType({ model: 'S6730', deviceType: 'core' })).toBe('CORE_SWITCH');
    expect(resolveDeviceIconType({ model: 'S6730', deviceType: 'switch' })).toBe('SWITCH');
    expect(resolveDeviceIconType({ model: 'S6730', deviceType: 'aggregation' })).toBe(
      'AGGREGATION',
    );
  });

  it('recognizes optical, Internet and subscriber edge equipment', () => {
    expect(resolveDeviceIconType({ hostname: 'OLT-01', deviceType: 'olt' })).toBe('OLT');
    expect(resolveDeviceIconType({ hostname: 'ONU-101', deviceType: 'generic' })).toBe('ONU');
    expect(resolveDeviceIconType({ hostname: 'INTERNET', deviceType: 'internet' })).toBe('CLOUD');
    expect(resolveDeviceIconType({ hostname: 'BNG-01', deviceType: 'router' })).toBe('BNG');
    expect(
      resolveDeviceIconType({
        hostname: 'CLIENTES',
        model: 'Subscriber Cloud',
        deviceType: 'customers',
      }),
    ).toBe('CUSTOMERS');
  });

  it('maps conceptual topology elements to their own generic icons', () => {
    expect(resolveDeviceIconType({ hostname: 'IX-SP', deviceType: 'ix' })).toBe('IX');
    expect(resolveDeviceIconType({ hostname: 'PTT-SP', deviceType: 'generic' })).toBe('IX');
    expect(resolveDeviceIconType({ hostname: 'Clientes Varejo', deviceType: 'generic' })).toBe(
      'CUSTOMERS',
    );
    expect(resolveDeviceIconType({ hostname: 'Operadora A', deviceType: 'generic' })).toBe(
      'CARRIER',
    );
    expect(resolveDeviceIconType({ hostname: 'Backbone Nacional', deviceType: 'generic' })).toBe(
      'CARRIER',
    );
    expect(resolveDeviceIconType({ hostname: 'Link IP Matriz', deviceType: 'generic' })).toBe(
      'TRANSPORT',
    );
    expect(resolveDeviceIconType({ hostname: 'Datacenter SP', deviceType: 'generic' })).toBe(
      'DATACENTER',
    );
    expect(
      resolveDeviceIconType({ hostname: 'Serviço de Autenticação', deviceType: 'generic' }),
    ).toBe('SERVICE');
    expect(
      resolveDeviceIconType({ hostname: 'Rede Externa Parceiro', deviceType: 'generic' }),
    ).toBe('PEER');
    expect(resolveDeviceIconType({ hostname: 'Cluster Lógico', deviceType: 'generic' })).toBe(
      'CLUSTER',
    );
    expect(resolveDeviceIconType({ hostname: 'Internet', deviceType: 'internet' })).toBe('CLOUD');
  });
});
