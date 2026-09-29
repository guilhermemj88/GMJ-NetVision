import { describe, expect, it } from 'vitest';
import { deriveCustomerDisplayName, interfaceMitigationScope } from './mitigation-scope';

describe('escopo da mitigacao (banda apenas de alias/description)', () => {
  it('entra no escopo quando a alias traz banda explicita', () => {
    expect(interfaceMitigationScope({ alias: 'HORIZONTE_IP_40GB', description: '' })).toEqual({
      inScope: true,
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      descriptionRaw: 'HORIZONTE_IP_40GB',
      customerDisplayName: 'HORIZONTE_IP',
    });
  });

  it('usa a description quando a alias nao tem banda', () => {
    const scope = interfaceMitigationScope({ alias: 'LINK-OLT', description: 'CLICKING_IP_20GB' });
    expect(scope.inScope).toBe(true);
    expect(scope.detectedBandwidthBps).toBe(20_000_000_000n);
    expect(scope.descriptionRaw).toBe('CLICKING_IP_20GB');
  });

  it('aceita as variacoes de banda vistas em campo', () => {
    for (const text of ['AGLINK_10GB', 'CLIENTE_X_5GB', 'CLIENTE_Y_40G', 'CLIENTE_Z_40 Gbps']) {
      expect(interfaceMitigationScope({ alias: text, description: '' }).inScope, text).toBe(true);
    }
  });

  it('fica fora do escopo sem banda explicita', () => {
    const ignored = [
      'UPLINK-ELETRONET',
      'UPLINK-TUDDO',
      'BACKBONE-SP',
      'CORE-MPLS',
      'IX-SP',
      'TRANSITO-SEABORN',
      'LINK-OLT',
      'HORIZONTE_IP',
      '',
    ];
    for (const text of ignored) {
      expect(interfaceMitigationScope({ alias: text, description: text }).inScope, text).toBe(false);
    }
  });

  it('nunca usa o nome fisico como banda (100GE0/1/48)', () => {
    const scope = interfaceMitigationScope({ alias: 'UPLINK', description: 'UPLINK' });
    expect(scope.inScope).toBe(false);
    expect(scope.detectedBandwidthBps).toBeNull();
  });

  it('deriva o nome do cliente apenas removendo o token de banda', () => {
    expect(deriveCustomerDisplayName('HORIZONTE_IP_40GB')).toBe('HORIZONTE_IP');
    expect(deriveCustomerDisplayName('CLIENTE_Z_40 Gbps')).toBe('CLIENTE_Z');
    expect(deriveCustomerDisplayName('AGLINK_10GB')).toBe('AGLINK');
    expect(deriveCustomerDisplayName('PLAY_CONNECT_10GB')).toBe('PLAY_CONNECT');
  });
});
