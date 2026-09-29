import type { HostRecord } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import type { SshClient } from '../../domain/ports';
import { HuaweiBgpSshService } from '../../infrastructure/bgp/huawei-bgp-ssh';
import type { HostRepository } from '../../infrastructure/persistence/host-repository';
import { validateReadOnlyCommand } from './read-only-command-guard';

describe('allowlist: comandos do discovery de mitigacao', () => {
  it('aceita os dumps de configuracao BGP e route-policy', () => {
    for (const command of [
      'display current-configuration configuration bgp',
      'display current-configuration configuration route-policy',
      'display current-configuration configuration bgp | include peer 10.200.200.106',
      'display current-configuration | include route-policy',
    ]) {
      expect(validateReadOnlyCommand(command), command).toMatchObject({ allowed: true });
    }
  });

  it('continua recusando comandos de escrita e o dump completo sem filtro', () => {
    for (const command of [
      'system-view',
      'route-policy PL-IN permit node 1',
      'undo route-policy PL-IN permit node 1',
      'apply extcommunity rt 268568:660 additive',
      'peer 10.200.200.106 ignore',
      'commit',
      'save',
      'display current-configuration',
    ]) {
      expect(validateReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });
});

describe('leitura de configuracao do HuaweiBgpSshService', () => {
  it('nunca envia comando de escrita ao SSH', async () => {
    const sent: string[] = [];
    const client: SshClient = {
      async execute(_host: string, commands: string[]) {
        sent.push(...commands);
        return [{ stdout: '#\nreturn\n', stderr: '', exitCode: 0 }];
      },
    };
    const repository = {
      async getDecryptedSshCredentials() {
        return { username: 'netvision', password: 'secret' };
      },
    } as unknown as HostRepository;
    const service = new HuaweiBgpSshService(repository, () => client);
    const device = {
      id: 'device-1',
      sshEnabled: true,
      ssh: { host: '10.0.0.1', port: 22, username: 'netvision', contextCommand: null },
    } as unknown as HostRecord;

    const reading = await service.readBgpConfiguration(device);

    expect(reading.bgpConfiguration).not.toBeNull();
    expect(reading.routePolicyConfiguration).not.toBeNull();
    expect(sent).toContain('display current-configuration configuration route-policy');
    expect(sent.length).toBeGreaterThan(0);
    for (const command of sent) {
      expect(validateReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });
});
