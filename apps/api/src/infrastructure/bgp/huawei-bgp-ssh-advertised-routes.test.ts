import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import { makeHost } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';

const ADVERTISED_OUTPUT = `
 BGP routing table entry information of 45.163.144.0/22:
 Original nexthop: 200.194.223.86
 AS-path 268568 268568 268568, origin igp, MED 1, pref-val 0
`;

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

function clientOf(output: string, exitCode = 0): { client: SshClient; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => [{ stdout: output, stderr: '', exitCode }]);
  return { client: { execute } as unknown as SshClient, execute };
}

describe('Huawei BGP advertised-routes SSH read', () => {
  it('builds the IPv4 user-view command with the persisted peer address', async () => {
    const { client, execute } = clientOf(ADVERTISED_OUTPUT);
    const service = new HuaweiBgpSshService(repository(), () => client);

    const result = await service.readAdvertisedRoutes(host(), {
      peerAddress: '200.194.223.86',
      addressFamily: 'IPV4',
    });

    expect(result).toEqual({ status: 'SUCCESS', output: ADVERTISED_OUTPUT });
    expect(execute).toHaveBeenCalledWith('172.16.0.1', [
      'screen-length 0 temporary',
      'display bgp routing-table peer 200.194.223.86 advertised-routes',
    ]);
  });

  it('builds the IPv6 variant for an IPv6 session', async () => {
    const { client, execute } = clientOf(ADVERTISED_OUTPUT);
    const service = new HuaweiBgpSshService(repository(), () => client);

    await service.readAdvertisedRoutes(host(), {
      peerAddress: '2001:db8::10',
      addressFamily: 'IPV6',
    });

    expect(execute.mock.calls[0]?.[1]).toEqual([
      'screen-length 0 temporary',
      'display bgp ipv6 routing-table peer 2001:db8::10 advertised-routes',
    ]);
  });

  it('never enters system-view or the BGP process for the display', async () => {
    const { client, execute } = clientOf(ADVERTISED_OUTPUT);
    const service = new HuaweiBgpSshService(repository(), () => client);

    await service.readAdvertisedRoutes(host(), {
      peerAddress: '200.194.223.86',
      addressFamily: 'IPV4',
    });

    const commands = execute.mock.calls[0]?.[1] as string[];
    expect(commands.some((command) => command.startsWith('system-view'))).toBe(false);
    expect(commands.some((command) => command.startsWith('bgp '))).toBe(false);
  });

  it('applies the persisted SSH context command to the read', async () => {
    const { client, execute } = clientOf(ADVERTISED_OUTPUT);
    const factory = vi.fn(() => client);
    const service = new HuaweiBgpSshService(repository(), factory);

    await service.readAdvertisedRoutes(
      host({
        ssh: {
          host: '172.16.0.1',
          port: 22,
          username: 'operator',
          credentialConfigured: true,
          authenticationType: 'PASSWORD',
          contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
        },
      }),
      { peerAddress: '200.194.223.86', addressFamily: 'IPV4' },
    );

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ contextCommand: 'switch virtual-system IMPLANTAR-IXBR' }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports UNSUPPORTED when the device rejects the command variant', async () => {
    const { client } = clientOf("Error: Unrecognized command found at '^' position.");
    const service = new HuaweiBgpSshService(repository(), () => client);

    const result = await service.readAdvertisedRoutes(host(), {
      peerAddress: '2001:db8::10',
      addressFamily: 'IPV6',
    });

    expect(result.status).toBe('UNSUPPORTED');
    if (result.status !== 'SUCCESS') {
      expect(result.errorSafe).toMatch(/não reconheceu o comando/);
    }
  });

  it('reports a sanitized COMMAND_FAILED when the transport fails', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('authentication failed: secret-value'));
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    const result = await service.readAdvertisedRoutes(host(), {
      peerAddress: '200.194.223.86',
      addressFamily: 'IPV4',
    });

    expect(result.status).toBe('COMMAND_FAILED');
    if (result.status !== 'SUCCESS') {
      expect(result.errorSafe).toBe('SSH authentication failed');
      expect(result.errorSafe).not.toContain('secret-value');
    }
  });

  it('refuses to touch the device when SSH is disabled for the host', async () => {
    const execute = vi.fn();
    const service = new HuaweiBgpSshService(repository(), () => ({ execute }));

    const result = await service.readAdvertisedRoutes(host({ sshEnabled: false }), {
      peerAddress: '200.194.223.86',
      addressFamily: 'IPV4',
    });

    expect(result.status).toBe('COMMAND_FAILED');
    expect(execute).not.toHaveBeenCalled();
  });
});
