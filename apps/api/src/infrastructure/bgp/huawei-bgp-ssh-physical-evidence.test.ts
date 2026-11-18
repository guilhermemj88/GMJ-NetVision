import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';
import { HuaweiMitigationExecutor } from './mitigation/huawei-mitigation-executor';
import {
  testDurableBaselineStore,
  testMitigationContract,
} from './mitigation/mitigation-test-support';
import type { CommandResult, SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';

/**
 * Transporte da evidencia fisica: SOMENTE leitura, somente os `display` da verificacao, tudo em
 * UMA sessao, e nunca um comando de configuracao.
 */

const DEVICE = {
  id: 'host-f1a',
  hostname: 'BHE-VTA-F1A-BGP-01',  vendor: 'Huawei',  model: 'NE8000',
  displayName: 'BHE-VTA-F1A-BGP-01',
  sshEnabled: true,
  ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
} as unknown as HostRecord;

const repository = {
  getDecryptedSshCredentials: async () => ({ username: 'netvision', password: 'x' }),
} as unknown as HostRepository;

function harness(outputs: (command: string) => CommandResult) {
  const sessions: string[][] = [];
  const client: SshClient = {
    execute: async (_host, commands) => {
      sessions.push([...commands]);
      return commands.map((command) => outputs(command));
    },
  };
  return { sessions, service: new HuaweiBgpSshService(repository, () => client) };
}

describe('HuaweiBgpSshService.readMitigationDisplays', () => {
  it('executa os displays de evidencia em UMA sessao e devolve cada saida', async () => {
    const { service, sessions } = harness((command) => ({
      stdout: `out:${command}`,
      stderr: '',
      exitCode: 0,
    }));
    const reads = await service.readMitigationDisplays(DEVICE, [
      'display bgp peer 10.200.201.2 verbose',
      'display bgp routing-table 167.250.126.0 23',
      'display ip extcommunity-filter',
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual([
      'screen-length 0 temporary',
      'display bgp peer 10.200.201.2 verbose',
      'display bgp routing-table 167.250.126.0 23',
      'display ip extcommunity-filter',
    ]);
    expect(reads.map((read) => read.output)).toEqual([
      'out:display bgp peer 10.200.201.2 verbose',
      'out:display bgp routing-table 167.250.126.0 23',
      'out:display ip extcommunity-filter',
    ]);
  });

  it('falha isolada de comando vira output null (inconclusivo), nunca lista parcial inventada', async () => {
    const { service } = harness((command) =>
      command.includes('received-routes')
        ? { stdout: 'Error: Wrong parameter found at ^ position.', stderr: '', exitCode: 0 }
        : { stdout: 'ok', stderr: '', exitCode: 0 },
    );
    const reads = await service.readMitigationDisplays(DEVICE, [
      'display bgp routing-table peer 10.200.201.2 received-routes',
      'display bgp peer 10.200.201.2 verbose',
    ]);
    expect(reads.map((read) => read.output)).toEqual([null, 'ok']);
  });

  it.each([
    'system-view',
    'commit',
    'undo route-policy X node 2',
    'display bgp routing-table',
    'display bgp routing-table peer 10.200.201.2 received',
    'display current-configuration | include ip-prefix',
    'display bgp peer 10.200.201.2 verbose; system-view',
  ])('REJEITA %s antes de tocar o SSH', async (command) => {
    const { service, sessions } = harness(() => ({ stdout: 'x', stderr: '', exitCode: 0 }));
    await expect(service.readMitigationDisplays(DEVICE, [command])).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });

  it('um comando invalido na lista impede a sessao inteira (nada e enviado)', async () => {
    const { service, sessions } = harness(() => ({ stdout: 'x', stderr: '', exitCode: 0 }));
    await expect(
      service.readMitigationDisplays(DEVICE, ['display bgp peer 10.200.201.2 verbose', 'commit']),
    ).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });
});

describe('porta de verificacao fisica obrigatoria no executor real (B2)', () => {
  it('sem readMitigationDisplays o executor NEM e construido (nunca VERIFIED sem prova fisica)', () => {
    expect(
      () =>
        new HuaweiMitigationExecutor({
          ssh: {
            readMitigationConfiguration: async () => ({
              routePolicyConfiguration: '',
              prefixListConfiguration: '',
              warnings: [],
            }),
            readMitigationRoutePolicy: async () => '',
            applyMitigationCommands: async () => ({ ok: true, output: '' }),
          } as never,
          config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE.id] },
          baseline: testDurableBaselineStore(),
        }),
    ).toThrow(/MITIGATION_PHYSICAL_PORT_REQUIRED/);
  });

  it('leitura que falha/vem vazia: verifyMitigationPhysical e INCONCLUSIVE, nunca PASS', async () => {
    const executor = new HuaweiMitigationExecutor({
      ssh: {
        readMitigationConfiguration: async () => ({
          routePolicyConfiguration: '',
          prefixListConfiguration: '',
          warnings: [],
        }),
        readMitigationDisplays: async () => {
          throw new Error('SSH command failed');
        },
        readMitigationRoutePolicy: async () => '',
        applyMitigationCommands: async () => ({ ok: true, output: '' }),
      },
      config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE.id] },
      baseline: testDurableBaselineStore(),
    });
    const result = await executor.verifyMitigationPhysical(DEVICE, {
      contract: testMitigationContract('PL-X_IPv4-IN'),
      customerPeers: ['10.200.201.2'],
      before: null,
    });
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(await executor.captureMitigationEvidence(DEVICE, ['10.200.201.2'])).toBeNull();
  });
});
