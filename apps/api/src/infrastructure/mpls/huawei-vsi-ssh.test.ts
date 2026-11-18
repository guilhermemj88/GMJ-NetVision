import { describe, expect, it, vi } from 'vitest';
import type { SshClient } from '../../domain/ports';
import { makeHost } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { validateReadOnlyCommand } from '../../worker/mitigation/read-only-command-guard';
import { HuaweiVsiSshService } from './huawei-vsi-ssh';

function host() {
  return makeHost({
    id: 's6730-mpls',
    hostname: 'ELOI MENDES - SW MPLS',
    vendor: 'Huawei',
    sshEnabled: true,
    ssh: {
      host: '10.100.101.8',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
  });
}

function repository(): HostRepository {
  return {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'protected-password' }),
  } as unknown as HostRepository;
}

const VSI_VERBOSE = `**VSI Name               : VSI-GERENCIA
  VSI State              : up
  VSI ID                 : 100
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.40
   VC State              : up
   Link ID               : 1
   Local VC Label        : 1024
   Remote VC Label       : 1025
   Local AC Interface    : GE0/0/1
`;

const LDP_TABLE = `PeerID             Status      LAM  SsnRole  SsnAge      KASent/Rcv
10.20.30.40:0       Operational DU   Passive  0000:00:01  10/10`;

const L2VC = ` *Client Interface     : GigabitEthernet0/0/1
  VC State             : up
  VC ID                : 100
  Destination          : 10.20.30.40
  Local VC Label       : 1024
  Remote VC Label      : 1025`;

function simulator(responses: Record<string, string>, sent: string[] = []) {
  return vi.fn(async (_host: string, commands: string[]) => {
    sent.push(...commands);
    const command = commands.at(-1) ?? '';
    const stdout = responses[command] ?? 'Error: Unrecognized command found at "^" position.';
    return [{ stdout, stderr: '', exitCode: 0 }];
  });
}

describe('HuaweiVsiSshService', () => {
  it('le VSI, sessoes LDP e l2vc enviando apenas comandos de leitura', async () => {
    const sent: string[] = [];
    const execute = simulator(
      {
        'display vsi verbose': VSI_VERBOSE,
        'display mpls ldp session': LDP_TABLE,
        'display mpls l2vc': L2VC,
      },
      sent,
    );
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const reading = await service.readVsi(host());

    expect(reading).toMatchObject({ available: true, supported: true, errorSafe: null });
    expect(reading.vsis[0]).toMatchObject({
      name: 'VSI-GERENCIA',
      signalingType: 'LDP',
      operationalStatus: 'UP',
    });
    expect(reading.ldpPeers[0]).toMatchObject({ peerLdpId: '10.20.30.40:0', state: 'UP' });
    expect(reading.l2vcs[0]).toMatchObject({ acInterfaceName: 'GigabitEthernet0/0/1', vcId: 100 });

    expect(sent).toEqual(
      expect.arrayContaining([
        'display vsi verbose',
        'display mpls ldp session',
        'display mpls l2vc',
      ]),
    );
    for (const command of sent) {
      expect(validateReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it('trata comando de VSI nao suportado sem inventar dados', async () => {
    const execute = simulator({});
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const reading = await service.readVsi(host());

    expect(reading).toMatchObject({ available: false, supported: false, vsis: [] });
    expect(reading.warnings.join(' ')).toContain('não suportado');
  });

  it('devolve erro seguro em timeout, sem vazar credencial', async () => {
    const execute = vi.fn(async () => {
      throw new Error('timeout containing protected-password');
    });
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const reading = await service.readVsi(host());

    expect(reading.available).toBe(false);
    expect(reading.errorSafe).toBe('SSH connection timeout');
    expect(JSON.stringify(reading)).not.toContain('protected-password');
  });

  it('falha de autenticacao vira erro seguro, nao excecao', async () => {
    const service = new HuaweiVsiSshService(repository(), () => {
      throw new Error('All configured authentication methods failed');
    });

    const reading = await service.readVsi(host());

    expect(reading).toMatchObject({ available: false, errorSafe: 'SSH authentication failed' });
  });

  it('detalha VSI uma a uma quando o verbose global nao traz blocos', async () => {
    const sent: string[] = [];
    const execute = simulator(
      {
        'display vsi verbose': 'VSI Name                        VSI Index       VSI State',
        'display vsi': 'Total VSI number: 1\nVSI-GERENCIA   0   up',
        'display vsi name VSI-GERENCIA verbose': VSI_VERBOSE,
        'display mpls ldp session': LDP_TABLE,
        'display mpls l2vc': L2VC,
      },
      sent,
    );
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const reading = await service.readVsi(host());

    expect(reading.vsis.map((vsi) => vsi.name)).toEqual(['VSI-GERENCIA']);
    expect(sent).toContain('display vsi name VSI-GERENCIA verbose');
  });

  it('rotula a sessao LDP com o nome do remote-peer', async () => {
    const execute = simulator({
      'display vsi verbose': VSI_VERBOSE,
      'display mpls ldp session': LDP_TABLE,
      'display mpls ldp remote-peer': ' Peer Name : rr-sba\n Peer IP Address : 10.20.30.40',
      'display mpls l2vc': L2VC,
    });
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const reading = await service.readVsi(host());

    expect(reading.ldpPeers[0]).toMatchObject({ peerLdpId: '10.20.30.40:0', name: 'rr-sba' });
  });

  it('nao aceita nome de VSI com caracteres de comando', async () => {
    const sent: string[] = [];
    const execute = simulator({ 'display vsi verbose': VSI_VERBOSE }, sent);
    const service = new HuaweiVsiSshService(repository(), () => ({ execute } as unknown as SshClient));

    const detail = await service.readVsiDetail(host(), 'VSI;reset saved-configuration');

    expect(detail).toBeNull();
    expect(sent).toEqual([]);
  });
});
