import { afterEach, describe, expect, it, vi } from 'vitest';
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

const CMD = {
  policyConfig: 'display current-configuration configuration route-policy',
  prefix: 'display current-configuration | include ip-prefix',
  bgp: 'display current-configuration configuration bgp',
  policyDisplay: `display route-policy ${POLICY}`,
};
const OUT: Record<string, string> = {
  [CMD.policyConfig]: `route-policy ${POLICY} permit node 10\n if-match ip-prefix CLIENT`,
  [CMD.prefix]: 'ip ip-prefix BOGONS index 40 permit 10.0.0.0 8',
  [CMD.bgp]: `bgp 64500\n peer 10.0.0.2 route-policy ${POLICY} import`,
  [CMD.policyDisplay]: `Route-policy: ${POLICY}\n permit : 10 (matched counts: 0)\n  if-match ip-prefix CLIENT`,
};

function harness(
  options: { failExecute?: boolean; badCommand?: string; outputs?: Record<string, string> } = {},
) {
  const sessions: string[][] = [];
  const outputs = { ...OUT, ...(options.outputs ?? {}) };
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
                : { stdout: outputs[c] ?? 'ok', stderr: '', exitCode: 0 },
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
const scope = { deviceId: DEVICE.id, policyName: POLICY };

afterEach(() => vi.restoreAllMocks());

describe('activation read scope (one read-only SSH snapshot per AUTO activation attempt)', () => {
  it('outside a scope every read keeps its own sessions (unchanged behavior)', async () => {
    const { service, sessions } = harness();
    await reads(service);
    expect(sessions).toHaveLength(8); // A=1, B=2, A=1, C=2, B=2
  });

  it('inside the scope the pre-write reads share ONE concurrent snapshot and return the same data', async () => {
    const plain = harness();
    const expected = await reads(plain.service);
    const scoped = harness();
    const got = await scoped.service.withActivationReadScope(scope, () => reads(scoped.service));
    expect(got).toEqual(expected);
    expect(scoped.sessions).toHaveLength(4);
    expect(scoped.sessions.map((s) => s.slice(1).join('|')).sort()).toEqual(
      Object.values(CMD).sort(),
    );
    for (const session of scoped.sessions) {
      expect(session[0]).toBe('screen-length 0 temporary');
      for (const c of session) expect(c).toMatch(/^(screen-length 0 temporary|display )/);
    }
  });

  it('the first write closes the scope: the read-back hits the equipment again', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(4);
      await service.applyMitigationCommands(DEVICE, ['system-view', 'commit']);
      expect(sessions).toHaveLength(5);
      await service.readMitigationRoutePolicy(DEVICE, POLICY); // read-back
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(7);
    });
  });

  it('closeActivationReadScope() (write authorization) sends every later read to the equipment', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationConfiguration(DEVICE);
      expect(sessions).toHaveLength(4);
      await service.readMitigationConfiguration(DEVICE); // still the snapshot
      expect(sessions).toHaveLength(4);
      service.closeActivationReadScope();
      await service.readMitigationConfiguration(DEVICE); // baseline capture right before the write
      expect(sessions).toHaveLength(6);
    });
  });

  it('other devices, other policies and calls outside the async scope are never served from it', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      await service.readMitigationRoutePolicy(OTHER, POLICY);
      await service.readMitigationRoutePolicy(DEVICE, 'PL-OTHER_IPv4-IN');
      expect(sessions).toHaveLength(6);
    });
    const before = sessions.length;
    await service.readMitigationRoutePolicy(DEVICE, POLICY);
    expect(sessions.length).toBe(before + 1);
  });

  it('no cache between attempts: every attempt takes its own snapshot', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, () => reads(service));
    await service.withActivationReadScope(scope, () => reads(service));
    expect(sessions).toHaveLength(8);
    await Promise.all([
      service.withActivationReadScope(scope, () => reads(service)),
      service.withActivationReadScope(scope, () => reads(service)),
    ]);
    expect(sessions).toHaveLength(16);
  });

  it('a snapshot older than 15 s is never served (fail-closed)', async () => {
    const { service } = harness();
    let t = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      t += 14_000;
      await expect(service.readMitigationRoutePolicy(DEVICE, POLICY)).resolves.toContain(POLICY);
      t += 2_000;
      await expect(service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_EXPIRED',
      );
      const config = await service.readMitigationConfiguration(DEVICE);
      expect(config.routePolicyConfiguration).toBeNull();
      expect(config.warnings.length).toBeGreaterThan(0);
    });
  });

  it('transport failure: the whole attempt is fail-closed (no partial data)', async () => {
    const down = harness({ failExecute: true });
    await down.service.withActivationReadScope(scope, async () => {
      await expect(down.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_INCOMPLETE',
      );
      const config = await down.service.readMitigationConfiguration(DEVICE);
      expect(config.routePolicyConfiguration).toBeNull();
      expect(config.prefixListConfiguration).toBeNull();
      expect(config.warnings.length).toBeGreaterThan(0);
      expect((await down.service.readBgpConfiguration(DEVICE)).bgpConfiguration).toBeNull();
    });
  });

  it('ONE failed read invalidates all of them: no partial result is accepted', async () => {
    for (const bad of [CMD.prefix, CMD.bgp, CMD.policyConfig, CMD.policyDisplay]) {
      const partial = harness({ badCommand: bad });
      await partial.service.withActivationReadScope(scope, async () => {
        await expect(partial.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
          'ACTIVATION_SNAPSHOT_INCOMPLETE',
        );
        const config = await partial.service.readMitigationConfiguration(DEVICE);
        expect(config.routePolicyConfiguration).toBeNull();
        expect(config.prefixListConfiguration).toBeNull();
        const bgp = await partial.service.readBgpConfiguration(DEVICE);
        expect(bgp.bgpConfiguration).toBeNull();
        expect(bgp.routePolicyConfiguration).toBeNull();
      });
    }
  });

  it('contradictory reads of the same policy invalidate the snapshot', async () => {
    const contradictory = harness({
      outputs: {
        [CMD.policyDisplay]: `Route-policy: ${POLICY}\n permit : 10\n permit : 2\n  apply extcommunity rt 268568:660`,
      },
    });
    await contradictory.service.withActivationReadScope(scope, async () => {
      await expect(contradictory.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_CONTRADICTORY',
      );
      const config = await contradictory.service.readMitigationConfiguration(DEVICE);
      expect(config.routePolicyConfiguration).toBeNull();
    });
  });
});
