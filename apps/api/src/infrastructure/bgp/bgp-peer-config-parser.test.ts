import { describe, expect, it } from 'vitest';
import { parseBgpPeerConfiguration } from './bgp-peer-config-parser';

// Trecho real de `display current-configuration configuration bgp` de um NE40E.
const SAMPLE = `#
bgp 266260
 router-id 192.140.88.1
 undo check-first-as
 peer 10.27.3.2 as-number 274369
 peer 10.27.3.2 connect-interface 10.27.3.1
 peer 10.200.200.254 as-number 266260
 peer 10.200.200.254 description SW_67301
 peer 172.16.16.7 as-number 28306
 peer 172.16.16.7 description VOLUY-MH
 peer 172.16.16.7 ebgp-max-hop 4
 peer 172.18.255.2 as-number 273590
 peer 172.18.255.2 description CDN_PVN-IPV4
 peer 187.16.220.8 as-number 20940
 peer 187.16.220.8 description AKAMAI-1
 peer 200.169.9.137 as-number 21574
 peer 200.169.9.137 description IP-TRANSITO-CENTURY-IPV4
 peer 2001:12F8::24 as-number 396986
 peer 2001:12F8::24 description BYTEDANCE-IPV6-2
`;

describe('parseBgpPeerConfiguration', () => {
  it('extrai AS remoto e descricao de cada peer', () => {
    const peers = parseBgpPeerConfiguration(SAMPLE);

    expect(peers.get('172.16.16.7')).toMatchObject({
      remoteAs: 28306,
      description: 'VOLUY-MH',
    });
    expect(peers.get('10.200.200.254')).toMatchObject({
      remoteAs: 266260,
      description: 'SW_67301',
    });
    expect(peers.get('200.169.9.137')).toMatchObject({
      remoteAs: 21574,
      description: 'IP-TRANSITO-CENTURY-IPV4',
    });
  });

  it('junta linhas nao adjacentes do mesmo peer', () => {
    const peers = parseBgpPeerConfiguration(SAMPLE);
    // 172.16.16.7 tem as-number, description e ebgp-max-hop intercalados.
    expect(peers.get('172.16.16.7')?.description).toBe('VOLUY-MH');
    expect(peers.get('172.16.16.7')?.remoteAs).toBe(28306);
  });

  it('funciona com IPv6 e normaliza a chave', () => {
    const peers = parseBgpPeerConfiguration(SAMPLE);
    expect(peers.get('2001:12f8::24')).toMatchObject({
      remoteAs: 396986,
      description: 'BYTEDANCE-IPV6-2',
    });
  });

  it('peer sem descricao mantem null e nao inventa valor', () => {
    const peers = parseBgpPeerConfiguration(SAMPLE);
    expect(peers.get('10.27.3.2')).toMatchObject({ remoteAs: 274369, description: null });
  });

  it('ignora linhas que nao sao de peer', () => {
    const peers = parseBgpPeerConfiguration(SAMPLE);
    expect([...peers.keys()].every((address) => !address.includes('router'))).toBe(true);
    expect(peers.size).toBe(7);
  });
});
