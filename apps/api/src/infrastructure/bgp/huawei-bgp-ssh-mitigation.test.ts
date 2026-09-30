import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { CommandResult, SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';

/**
 * A escrita de mitigacao termina em SYSTEM-VIEW depois do commit. Se o
 * transporte encerrar com um unico `quit`, o canal nao fecha, o cliente espera o
 * timeout e uma escrita JA APLICADA e reportada como falha (bug observado no
 * primeiro ACTIVATE real). Estes testes travam o contrato do transporte.
 */

const DEVICE = {
  id: 'host-f1a',
  hostname: 'BHE-VTA-F1A-BGP-01',
  displayName: 'BHE-VTA-F1A-BGP-01',
  sshEnabled: true,
  ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
} as unknown as HostRecord;

function repository(): HostRepository {
  return {
    getDecryptedSshCredentials: async () => ({ username: 'netvision', password: 'x' }),
  } as unknown as HostRepository;
}

interface CapturedOptions {
  exitMode?: 'quit' | 'return-quit';
  shellTimeoutMs?: number;
  contextCommand?: string | null;
}

function harness(output: string, exitCode = 0) {
  const captured: CapturedOptions[] = [];
  const client: SshClient = {
    execute: async (): Promise<CommandResult[]> => [{ stdout: output, stderr: '', exitCode }],
  };
  const service = new HuaweiBgpSshService(repository(), (options) => {
    captured.push(options as CapturedOptions);
    return client;
  });
  return { service, captured };
}

describe('transporte SSH da escrita de mitigacao', () => {
  it('a escrita finaliza voltando para user view com `return` e timeout maior', async () => {
    const { service, captured } = harness('ok');
    const result = await service.applyMitigationCommands(DEVICE, ['system-view', 'commit']);
    expect(result.ok).toBe(true);
    expect(captured[0]?.exitMode).toBe('return-quit');
    expect(captured[0]?.shellTimeoutMs).toBe(30_000);
  });

  it('as leituras continuam com o comportamento antigo (quit simples, timeout padrao)', async () => {
    const { service, captured } = harness('route-policy PL-X permit node 11');
    await service.readMitigationRoutePolicy(DEVICE, 'PL-X');
    await service.readMitigationConfiguration(DEVICE);
    expect(captured).toHaveLength(2);
    for (const options of captured) {
      expect(options.exitMode).toBeUndefined();
      expect(options.shellTimeoutMs).toBeUndefined();
    }
  });

  it('a escrita NAO mascara o texto do equipamento quando ele reporta erro', async () => {
    const { service } = harness('Error: The route-policy does not exist.');
    const result = await service.applyMitigationCommands(DEVICE, ['system-view', 'commit']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Error: The route-policy does not exist.');
  });
});
