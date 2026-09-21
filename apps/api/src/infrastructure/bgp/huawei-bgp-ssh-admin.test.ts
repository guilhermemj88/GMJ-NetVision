import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { withSshContext } from '../ssh/ssh-context';
import type { SshClient } from '../../domain/ports';
import { makeHost } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return makeHost({
    id: 'ne8000-1',
    hostname: 'NE-8000-1',
    vendor: 'Huawei',
    sshEnabled: true,
    ssh: {
      host: '172.16.0.1',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  });
}

function repository(): HostRepository {
  return {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'protected-password' }),
  } as unknown as HostRepository;
}

function clientOf(outputs: string[] | string): { client: SshClient; execute: ReturnType<typeof vi.fn> } {
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs];
  const execute = vi.fn(async () => [
    { stdout: queue.shift() ?? '', stderr: '', exitCode: 0 },
  ]);
  return { client: { execute } as unknown as SshClient, execute };
}

describe('Huawei BGP administrative SSH commands', () => {
  it('generates the disable sequence with the local AS resolved by the caller', async () => {
    const { client, execute } = clientOf('ok');
    const service = new HuaweiBgpSshService(repository(), () => client);

    const result = await service.applyAdminState(host(), {
      peerAddress: '10.200.200.10',
      localAs: 268568n,
      action: 'DISABLE',
    });

    expect(result).toEqual({ success: true, errorSafe: null });
    expect(execute).toHaveBeenCalledWith('172.16.0.1', [
      'screen-length 0 temporary',
      'system-view',
      'bgp 268568',
      'peer 10.200.200.10 ignore',
      'commit',
    ]);
  });

  it('generates the enable sequence with undo', async () => {
    const { client, execute } = clientOf('ok');
    const service = new HuaweiBgpSshService(repository(), () => client);

    await service.applyAdminState(host(), {
      peerAddress: '10.200.200.10',
      localAs: 268568n,
      action: 'ENABLE',
    });

    expect(execute.mock.calls[0]?.[1]).toEqual([
      'screen-length 0 temporary',
      'system-view',
      'bgp 268568',
      'undo peer 10.200.200.10 ignore',
      'commit',
    ]);
  });

  it('uses the canonical IPv6 address inside the BGP process', async () => {
    const { client, execute } = clientOf('ok');
    const service = new HuaweiBgpSshService(repository(), () => client);

    await service.applyAdminState(host(), {
      peerAddress: '2001:db8::10',
      localAs: 273003n,
      action: 'DISABLE',
    });

    expect(execute.mock.calls[0]?.[1]).toEqual([
      'screen-length 0 temporary',
      'system-view',
      'bgp 273003',
      'peer 2001:db8::10 ignore',
      'commit',
    ]);
  });

  it('keeps the SSH context command before the BGP process commands', () => {
    const commands = [
      'screen-length 0 temporary',
      'system-view',
      'bgp 268568',
      'peer 10.200.200.10 ignore',
      'commit',
    ];
    expect(withSshContext(commands, 'switch virtual-system IMPLANTAR-IXBR')).toEqual([
      'screen-length 0 temporary',
      'switch virtual-system IMPLANTAR-IXBR',
      'system-view',
      'bgp 268568',
      'peer 10.200.200.10 ignore',
      'commit',
    ]);
  });

  it('runs a host without SSH context unchanged', () => {
    expect(withSshContext(['system-view', 'bgp 1', 'peer 10.0.0.1 ignore'], null)).toEqual([
      'system-view',
      'bgp 1',
      'peer 10.0.0.1 ignore',
    ]);
  });

  it('never reports success when the device rejects the commit', async () => {
    const { client } = clientOf("Error: Unrecognized command found at '^' position.");
    const service = new HuaweiBgpSshService(repository(), () => client);

    const result = await service.applyAdminState(host(), {
      peerAddress: '10.200.200.10',
      localAs: 268568n,
      action: 'DISABLE',
    });

    expect(result.success).toBe(false);
    expect(result.errorSafe).toBe('SSH command failed');
  });

  it('returns a sanitized failure when the SSH transport fails', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('authentication failed: secret-value'));
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    const result = await service.applyAdminState(host(), {
      peerAddress: '10.200.200.10',
      localAs: 268568n,
      action: 'DISABLE',
    });

    expect(result.success).toBe(false);
    expect(result.errorSafe).not.toContain('secret-value');
  });
});

describe('Huawei BGP administrative read-back', () => {
  it('confirms an ignored peer from the peer-filtered configuration', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => [
      {
        stdout: commands.at(-1)?.includes('current-configuration')
          ? ' peer 10.200.200.10 ignore'
          : '',
        stderr: '',
        exitCode: 0,
      },
    ]);
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    expect(
      await service.readAdminState(host(), {
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
      }),
    ).toEqual({ state: 'IGNORED', source: 'CONFIGURATION' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual([
      'screen-length 0 temporary',
      'display current-configuration configuration bgp | include peer 10.200.200.10',
    ]);
  });

  it('falls back to the Idle(Admin) peer state when the filter is unsupported', async () => {
    const execute = vi.fn(async (_host: string, commands: string[]) => [
      {
        stdout: commands.at(-1)?.includes('current-configuration')
          ? "Error: Unrecognized command found at '^' position."
          : '2001:DB8::10 4 265424 10 10 0 Never Idle(Admin)',
        stderr: '',
        exitCode: 0,
      },
    ]);
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    expect(
      await service.readAdminState(host(), {
        peerAddress: '2001:db8::10',
        addressFamily: 'IPV6',
      }),
    ).toEqual({ state: 'IGNORED', source: 'PEER_STATE' });
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'screen-length 0 temporary',
      'display bgp ipv6 peer',
    ]);
  });

  it('reports ENABLED when the peer exists without the ignore keyword', async () => {
    const execute = vi.fn(async () => [
      { stdout: ' peer 10.200.200.10 as-number 265424', stderr: '', exitCode: 0 },
    ]);
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    expect(
      await service.readAdminState(host(), {
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
      }),
    ).toEqual({ state: 'ENABLED', source: 'CONFIGURATION' });
  });

  it('stays UNKNOWN when neither read-back source is conclusive', async () => {
    const execute = vi.fn(async () => [
      { stdout: 'Summary Count : 0', stderr: '', exitCode: 0 },
    ]);
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    expect(
      await service.readAdminState(host(), {
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
      }),
    ).toEqual({ state: 'UNKNOWN', source: null });
  });
});
