import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService, classifySshReadFailure } from './huawei-bgp-ssh';
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
const PROMPT = '<BHE-VTA-F1A-BGP-01>';
const SCREEN = 'screen-length 0 temporary';

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

/**
 * `per-command`: one CommandResult per command (test doubles). `session`: what the REAL
 * `SshClientImpl` returns - ONE result with the stdout of the whole interactive session, with the
 * prompt echo of every command (the shape confirmed on the F1A).
 */
type Transport = 'per-command' | 'session';

function sessionStdout(commands: string[], outputs: Record<string, string>, bad?: string): string {
  const lines: string[] = [
    'Info: The max number of VTY users is 21, the number of current VTY users online is 3.',
    PROMPT,
  ];
  for (const c of commands) {
    lines.push(`${PROMPT}${c}`);
    if (c === SCREEN)
      lines.push(
        'Info: The configuration takes effect on the current user terminal interface only.',
      );
    else if (c === bad) lines.push('Error: Unrecognized command found at ^ position.');
    else lines.push(outputs[c] ?? 'ok');
  }
  lines.push(PROMPT);
  return lines.join('\r\n');
}

function harness(
  options: {
    failExecute?: boolean | string;
    badCommand?: string;
    outputs?: Record<string, string>;
    transport?: Transport;
    delayMs?: number;
    /** Drop the echo of this command from the session text (unattributable output). */
    dropEcho?: string;
  } = {},
) {
  const sessions: string[][] = [];
  const outputs = { ...OUT, ...(options.outputs ?? {}) };
  const stats = { active: 0, maxActive: 0, started: 0, finished: 0 };
  const service = new HuaweiBgpSshService(
    {
      getDecryptedSshCredentials: async () => ({ username: 'u', password: 'hunter2-secret' }),
    } as unknown as HostRepository,
    () =>
      ({
        execute: async (_host: string, commands: string[]): Promise<CommandResult[]> => {
          sessions.push([...commands]);
          stats.started += 1;
          stats.active += 1;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          try {
            if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
            if (options.failExecute)
              throw new Error(
                typeof options.failExecute === 'string' ? options.failExecute : 'boom',
              );
            if (options.transport === 'session') {
              let text = sessionStdout(commands, outputs, options.badCommand);
              if (options.dropEcho)
                text = text
                  .split('\r\n')
                  .filter((l) => l !== `${PROMPT}${options.dropEcho}`)
                  .join('\r\n');
              return [{ stdout: text, stderr: '', exitCode: 0 }];
            }
            return commands.map((c) =>
              c === SCREEN
                ? { stdout: '', stderr: '', exitCode: 0 }
                : c === options.badCommand
                  ? { stdout: 'Error: Unrecognized command', stderr: '', exitCode: 0 }
                  : { stdout: outputs[c] ?? 'ok', stderr: '', exitCode: 0 },
            );
          } finally {
            stats.active -= 1;
            stats.finished += 1;
          }
        },
      }) as SshClient,
  );
  return { service, sessions, stats };
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

  it.each(['per-command', 'session'] as const)(
    'inside the scope the pre-write reads share ONE session (%s transport) and return the same data',
    async (transport) => {
      const plain = harness({ transport: 'per-command' });
      const expected = await reads(plain.service);
      const scoped = harness({ transport });
      const got = await scoped.service.withActivationReadScope(scope, () => reads(scoped.service));
      if (transport === 'per-command') expect(got).toEqual(expected);
      else {
        // The real transport carries the prompt echo; the DATA the parsers consume is the same.
        const strip = (text: string) =>
          text
            .split('\n')
            .filter((l) => !l.startsWith('<BHE'))
            .join('\n')
            .trim();
        expect(strip(got[0] as string)).toEqual(expected[0]);
        const config = got[1] as {
          routePolicyConfiguration: string;
          prefixListConfiguration: string;
        };
        const plainConfig = expected[1] as typeof config;
        expect(strip(config.routePolicyConfiguration)).toEqual(
          plainConfig.routePolicyConfiguration,
        );
        expect(strip(config.prefixListConfiguration)).toEqual(plainConfig.prefixListConfiguration);
        expect(strip((got[3] as { bgpConfiguration: string }).bgpConfiguration)).toEqual(
          (expected[3] as { bgpConfiguration: string }).bgpConfiguration,
        );
      }
      // ONE session = ONE VTY. Regression guard for the VTY exhaustion (the F1A has 5 channels).
      expect(scoped.sessions).toHaveLength(1);
      expect(scoped.stats.maxActive).toBe(1);
      const [session] = scoped.sessions;
      expect(session![0]).toBe(SCREEN);
      expect(session!.slice(1)).toEqual(Object.values(CMD)); // the same four displays, in order
      for (const c of session!) expect(c).toMatch(/^(screen-length 0 temporary|display )/);
    },
  );

  it('the first write closes the scope: the read-back hits the equipment again', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(1);
      await service.applyMitigationCommands(DEVICE, ['system-view', 'commit']);
      expect(sessions).toHaveLength(2);
      await service.readMitigationRoutePolicy(DEVICE, POLICY); // read-back
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      expect(sessions).toHaveLength(4);
    });
  });

  it('closeActivationReadScope() (write authorization) sends every later read to the equipment', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationConfiguration(DEVICE);
      expect(sessions).toHaveLength(1);
      await service.readMitigationConfiguration(DEVICE); // still the snapshot
      expect(sessions).toHaveLength(1);
      service.closeActivationReadScope();
      await service.readMitigationConfiguration(DEVICE); // baseline capture right before the write
      expect(sessions).toHaveLength(3);
    });
  });

  it('other devices, other policies and calls outside the async scope are never served from it', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, async () => {
      await service.readMitigationRoutePolicy(DEVICE, POLICY);
      await service.readMitigationRoutePolicy(OTHER, POLICY);
      await service.readMitigationRoutePolicy(DEVICE, 'PL-OTHER_IPv4-IN');
      expect(sessions).toHaveLength(3);
    });
    const before = sessions.length;
    await service.readMitigationRoutePolicy(DEVICE, POLICY);
    expect(sessions.length).toBe(before + 1);
  });

  it('no cache between attempts: every attempt takes its own snapshot', async () => {
    const { service, sessions } = harness();
    await service.withActivationReadScope(scope, () => reads(service));
    await service.withActivationReadScope(scope, () => reads(service));
    expect(sessions).toHaveLength(2);
    await Promise.all([
      service.withActivationReadScope(scope, () => reads(service)),
      service.withActivationReadScope(scope, () => reads(service)),
    ]);
    expect(sessions).toHaveLength(4);
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

  it('transport failure: the whole attempt is fail-closed (no partial data), with ONE session tried', async () => {
    const down = harness({ failExecute: true });
    await down.service.withActivationReadScope(scope, async () => {
      await expect(down.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_SSH_FAILED',
      );
      const config = await down.service.readMitigationConfiguration(DEVICE);
      expect(config.routePolicyConfiguration).toBeNull();
      expect(config.prefixListConfiguration).toBeNull();
      expect(config.warnings.length).toBeGreaterThan(0);
      expect((await down.service.readBgpConfiguration(DEVICE)).bgpConfiguration).toBeNull();
    });
    // the failed snapshot is the attempt's only result: no retry storm of sessions inside the scope
    expect(down.sessions).toHaveLength(1);
  });

  it.each(['per-command', 'session'] as const)(
    'ONE failed read invalidates all of them: no partial result is accepted (%s)',
    async (transport) => {
      for (const bad of [CMD.prefix, CMD.bgp, CMD.policyConfig, CMD.policyDisplay]) {
        const partial = harness({ badCommand: bad, transport });
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
    },
  );

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

const credentialsRepo = {
  getDecryptedSshCredentials: async () => ({ username: 'u', password: 'p' }),
} as unknown as HostRepository;

describe('single-session snapshot: attribution, classification and cleanup', () => {
  it('a session whose prompt echo of one command is missing is NEVER attributed to another command', async () => {
    for (const dropped of [CMD.prefix, CMD.bgp, CMD.policyDisplay, CMD.policyConfig]) {
      const h = harness({ transport: 'session', dropEcho: dropped });
      await h.service.withActivationReadScope(scope, async () => {
        await expect(h.service.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
          'ACTIVATION_SNAPSHOT_INCOMPLETE',
        );
      });
      expect(h.sessions).toHaveLength(1);
    }
  });

  it('an unrecognizable session (no prompt) yields no data instead of guessing', async () => {
    const svc = new HuaweiBgpSshService(
      credentialsRepo,
      () =>
        ({
          execute: async () => [{ stdout: 'garbage without any prompt', stderr: '', exitCode: 0 }],
        }) as SshClient,
    );
    await svc.withActivationReadScope(scope, async () => {
      await expect(svc.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_INCOMPLETE',
      );
    });
  });

  it('a non-zero exit code of the session invalidates every command', async () => {
    const svc = new HuaweiBgpSshService(
      credentialsRepo,
      () =>
        ({
          execute: async (_h: string, commands: string[]) => [
            { stdout: sessionStdout(commands, OUT), stderr: '', exitCode: 1 },
          ],
        }) as SshClient,
    );
    await svc.withActivationReadScope(scope, async () => {
      await expect(svc.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_INCOMPLETE',
      );
    });
  });

  it.each([
    ['All configured authentication methods failed', 'SSH_AUTH_FAILED'],
    ['Timed out while waiting for handshake', 'SSH_TIMEOUT'],
    ['connect ECONNREFUSED 10.200.1.1:22', 'SSH_UNREACHABLE'],
    ['read ECONNRESET', 'SSH_UNREACHABLE'],
    ['Connection closed by remote host', 'SSH_UNREACHABLE'],
    ['SSH_INTERACTIVE_PROMPT blocked', 'SSH_PROMPT_BLOCKED'],
    ['command_rejected by device', 'SSH_COMMAND_REJECTED'],
    ['something nobody planned for', 'SSH_SESSION_FAILED'],
  ])(
    'SSH failure %j is classified as %s without leaking the raw text or credentials',
    async (raw, expected) => {
      expect(classifySshReadFailure(new Error(raw))).toBe(expected);
      const h = harness({
        failExecute: `${raw} password=hunter2-secret user=netvision host=10.200.1.1`,
      });
      let caught: Error | null = null;
      await h.service.withActivationReadScope(scope, async () => {
        await h.service.readMitigationRoutePolicy(DEVICE, POLICY).catch((e: Error) => (caught = e));
      });
      expect(caught).not.toBeNull();
      const message = (caught as unknown as Error).message;
      expect(message).toBe(`ACTIVATION_SNAPSHOT_SSH_FAILED:${expected}`);
      expect(message).not.toMatch(/hunter2|netvision|10\.200\.1\.1|password/i);
      expect(message).toMatch(/^[A-Z][A-Z0-9_]+:[A-Z][A-Z0-9_]+$/); // closed vocabulary only
    },
  );

  it('every session started is finished on success, error and slow reads (never >1 in parallel)', async () => {
    for (const options of [
      {},
      { failExecute: true },
      { failExecute: 'Timed out while waiting for handshake', delayMs: 5 },
      { delayMs: 20 },
      { badCommand: CMD.bgp, transport: 'session' as const },
    ]) {
      const h = harness(options);
      await h.service
        .withActivationReadScope(scope, async () => {
          await Promise.allSettled([
            h.service.readMitigationRoutePolicy(DEVICE, POLICY),
            h.service.readMitigationConfiguration(DEVICE),
            h.service.readBgpConfiguration(DEVICE),
          ]);
        })
        .catch(() => undefined);
      expect(h.stats.started).toBe(1); // the three concurrent readers share the ONE snapshot
      expect(h.stats.finished).toBe(h.stats.started);
      expect(h.stats.active).toBe(0);
      expect(h.stats.maxActive).toBe(1);
    }
  });

  it('after a failed snapshot a NEW attempt starts clean (no poisoned state) with a single new session', async () => {
    let fail = true;
    const sessions: string[][] = [];
    const svc = new HuaweiBgpSshService(
      credentialsRepo,
      () =>
        ({
          execute: async (_h: string, commands: string[]): Promise<CommandResult[]> => {
            sessions.push(commands);
            if (fail) throw new Error('read ECONNRESET');
            return commands.map((c) => ({
              stdout: c === SCREEN ? '' : (OUT[c] ?? 'ok'),
              stderr: '',
              exitCode: 0,
            }));
          },
        }) as SshClient,
    );
    await svc.withActivationReadScope(scope, async () => {
      await expect(svc.readMitigationRoutePolicy(DEVICE, POLICY)).rejects.toThrow(
        'ACTIVATION_SNAPSHOT_SSH_FAILED:SSH_UNREACHABLE',
      );
    });
    fail = false;
    const ok = await svc.withActivationReadScope(scope, () =>
      svc.readMitigationRoutePolicy(DEVICE, POLICY),
    );
    expect(ok).toContain(`Route-policy: ${POLICY}`);
    expect(sessions).toHaveLength(2);
  });

  it('only read-only display commands (plus screen-length) are ever sent in the snapshot session', async () => {
    const h = harness();
    await h.service.withActivationReadScope(scope, () => reads(h.service));
    for (const session of h.sessions)
      for (const c of session) {
        expect(c).toMatch(/^(screen-length 0 temporary|display )/);
        expect(c).not.toMatch(/system-view|commit|undo |apply |if-match/);
      }
  });
});
