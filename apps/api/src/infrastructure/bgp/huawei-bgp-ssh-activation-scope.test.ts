import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { CommandResult, SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';

const DEVICE = {
  id: 'host-f1a',
  hostname: 'BHE-VTA-F1A-BGP-01',
  displayName: 'BHE-VTA-F1A-BGP-01',
  sshEnabled: true,
  ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
} as unknown as HostRecord;
const OTHER = { ...DEVICE, id: 'host-other' } as unknown as HostRecord;
const POLICY = 'PL-AGLINK_IPv4-IN';

const OUT: Record<string, string> = {
  'display current-configuration configuration route-policy': 'route-policy ALL permit node 10',
  'display current-configuration | include ip-prefix':
    'ip ip-prefix BOGONS index 40 permit 10.0.0.0 8',
  'display current-configuration configuration bgp':
    'bgp 64500\n peer 10.0.0.2 route-policy X import',
  [`display route-policy ${POLICY}`]: 'Route-policy: PL-AGLINK_IPv4-IN\n permit : 10',
};

function harness(options: { failExecute?: boolean; badCommand?: string } = {}) {
  const sessions: string[][] = [];
  const service = new HuaweiBgpSshService(
    {
      getDecryptedSshCredentials: async () => ({ username: 'u', password: 'p' }),
    } as unknown as HostRepository,
    () =>
      ({
        execute: async (_host: string, commands: string[]): Promise<CommandResult[]> => {
          sessions.push([...commands]);
          if (options.failExecute) throw new Error('boom');
          return commands.map((c) =>
            c === 'screen-length 0 temporary'
              ? { stdout: '', stderr: '', exitCode: 0 }
              : c === options.badCommand
                ? { stdout: 'Error: Unrecognized command', stderr: '', exitCode: 0 }
                : { stdout: OUT[c] ?? 'ok', stderr: '', exitCode: 0 },
          );
        },
      }) as SshClient,
  );
  return { service, sessions };
}
const reads = async (s: HuaweiBgpSshService) => [
  await s.readMitigationRoutePolicy(DEVICE, POLICY),
  await s.readMitigationConfiguration(DEVICE),
  await s.readMitigationRoutePolicy(DEVICE, POLICY),
  await s.readBgpConfiguration(DEVICE),
  await s.readMitigationConfiguration(DEVICE),
];

describe('activation read scope (one read-only SSH snapshot per AUTO activation attempt)', () => {
  it('outside a scope every read keeps its own sessions (unchanged behavior)', async () => {
    const { service, sessions } = harness();
    await reads(service);
    // A=1, B=2, A=1, C=2, B=2
    expect(sessions).toHaveLength(8);
  });

  it('inside the scope the pre-write reads share ONE concurrent snapshot and return the same data', async () => {
    const plain = harness();
    const expected = await reads(plain.service);
    const scoped = harness();
    const got = await scoped.service.withActivationReadScope(
      { deviceId: DEVICE.id, policyName: POLICY },
      () => reads(scoped.service),
    );
    expect(got).toEqual(expected);
    // 5 reads (A,B,A,C,B = 8 sessions outside the scope) -> one snapshot of 4 short sessions
    expect(scoped.sessions).toHaveLength(4);
    expect(scoped.sessions.map((s) => s.slice(1).join('|')).sort()).toEqual(
      [
        'display current-configuration configuration bgp',
        'display current-configuration configuration route-policy',
        'display current-configuration | include ip-prefix',
        `display route-policy ${POLICY}`,
      ].sort(),
    );
    for (const session of scoped.sessions) {
      expect(session[0]).toBe('screen-length 0 temporary');
      for (const c of session) expect(c).toMatch(/^(screen-length 0 temporary|display )/);
    }
  });

  it('the first write closes the scope: the read-back hits the equipment again', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope({ deviceId: DEVICE.id, policyName: POLICY }, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(4);
      await service.applyMitigationCommands(DEVICE, ['system-view', 'commit']);
      expect(sessions).toHaveLength(5);
      await service.readMitigationRoutePolicy(DEVICE, POLICY); // read-back
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(7);
    });
  });

  it('other devices, other policies and calls outside the async scope are never served from it', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope({ deviceId: DEVICE.id, policyName: POLICY }, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      await service.readMitigationRoutePolicy(OTHER, POLICY);
      await service.readMitigationRoutePolicy(DEVICE, 'PL-OTHER_IPv4-IN');
      expect(sessions).toHaveLength(6);
    });
    const before = sessions.length;
    await service.readMitigationRoutePolicy(DEVICE, POLICY);
    expect(sessions.length).toBe(before + 1);
  });

  it('concurrent attempts keep independent snapshots', async () => {
    const { service, sessions } = harness();
    await Promise.all([
      service.withActivationReadScope({ deviceId: DEVICE.id, policyName: POLICY }, () =>
        reads(service),
      ),
      service.withActivationReadScope({ deviceId: DEVICE.id, policyName: POLICY }, () =>
        reads(service),
      ),
    ]);
    expect(sessions).toHaveLength(8);
  });

  it('failures stay fail-closed: transport error and per-command error', async () => {
    const down = harness({ failExecute: true });
    await down.service.withActivationReadScope(
      { deviceId: DEVICE.id, policyName: POLICY },
      async () => {
        await expect(down.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
          'SSH command failed',
        );
        const config = await down.service.readMitigationConfiguration(DEVICE);
        expect(config.routePolicyConfiguration).toBeNull();
        expect(config.prefixListConfiguration).toBeNull();
        expect(config.warnings.length).toBeGreaterThan(0);
      },
    );
    const partial = harness({ badCommand: 'display current-configuration | include ip-prefix' });
    await partial.service.withActivationReadScope(
      { deviceId: DEVICE.id, policyName: POLICY },
      async () => {
        const config = await partial.service.readMitigationConfiguration(DEVICE);
        expect(config.routePolicyConfiguration).not.toBeNull();
        expect(config.prefixListConfiguration).toBeNull();
        expect(config.warnings).toContain('ip-prefix: SSH command failed');
        expect(
          (await partial.service.readBgpConfiguration(DEVICE)).bgpConfiguration,
        ).not.toBeNull();
      },
    );
  });
});
