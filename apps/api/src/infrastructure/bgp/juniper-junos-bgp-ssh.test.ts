import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import { makeHost } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { JuniperJunosBgpSshProvider } from './juniper-junos-bgp-ssh';
import type { JunosSshClientFactory, JunosSshOptions } from './juniper-junos-bgp-ssh';
import { assertJunosReadOnly } from './juniper-junos-bgp-parser';

const SUMMARY = `Groups: 3 Peers: 3 Down peers: 0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.141.1.81           23106   25109521      97966       0      27 4w3d 21:18:46 Establ
  inet.0: 491930/1103955/1103955/0
167.250.0.130         40027      78209      72999       0      17 3w2d 18:13:19 Establ
  inet.0: 0/0/0/0
2001:1291:1602:1::a       16735  250209872     235895       0      15 10w6d 18:57:19 Establ
  inet6.0: 18301/245187/245187/0
`;

const CONFIG = `set protocols bgp group ATC local-as 265185
set protocols bgp group ATC peer-as 23106
set protocols bgp group ATC neighbor 10.141.1.81 description "TRANSITO ATC"
set protocols bgp group NETFLIX description "NETFLIX IX"
set protocols bgp group NETFLIX peer-as 40027
set protocols bgp group NETFLIX neighbor 167.250.0.130
set protocols bgp group IPV6 peer-as 16735
set protocols bgp group IPV6 neighbor 2001:1291:1602:1::a local-as 265185
`;

const ROUTING_OPTIONS = 'set routing-options autonomous-system 52575\n';

const ROUTE_IPV4 = `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
+ = Active Route, - = Last Active, * = Both

167.250.0.64/27    *[Direct/0] 23w1d 18:44:54
                    >  via ae0.2800
`;

const ROUTE_IPV6 = `inet6.0: 263988 destinations, 1202896 routes (263973 active, 15 holddown, 254724 hidden)
+ = Active Route, - = Last Active, * = Both

2804:2bf8:dddd:2::/64
                   *[Direct/0] 23w1d 18:44:44
                    >  via ae0.2810
`;

const NO_ROUTE = `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
+ = Active Route, - = Last Active, * = Both
`;

function device(overrides: Partial<HostRecord> = {}): HostRecord {
  return makeHost({
    id: 'mx-ouropreto',
    hostname: 'VIANET-OUROPRETO',
    vendor: 'Juniper',
    model: 'MX240',
    sshEnabled: true,
    ssh: {
      host: '167.250.0.254',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  });
}

interface Session {
  options: JunosSshOptions;
  execute: ReturnType<typeof vi.fn>;
}

/** Fábrica de sessões: cada chamada devolve um cliente novo, como em produção. */
function factoryFor(outputs: Record<string, string>): {
  factory: JunosSshClientFactory;
  sessions: Session[];
} {
  const sessions: Session[] = [];
  const factory: JunosSshClientFactory = (options) => {
    const execute = vi.fn(async (_host: string, commands: string[]) => {
      const command = commands[0] ?? '';
      if (command in outputs) {
        return [{ command, stdout: outputs[command]!, stderr: '', exitCode: 0 }];
      }
      if (command.startsWith('show route advertising-protocol bgp ')) {
        return [
          {
            command,
            stdout: ADVERTISED,
            stderr: '',
            exitCode: 0,
          },
        ];
      }
      return [{ command, stdout: NO_ROUTE, stderr: '', exitCode: 0 }];
    });
    sessions.push({ options, execute });
    return { execute } as unknown as SshClient;
  };
  return { factory, sessions };
}

const ADVERTISED = `Prefix                  Nexthop              MED     Lclpref    AS path
167.250.0.0/22          Self                                    265185 265185 265185 [265185] I
`;

function repository(): HostRepository {
  return {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'secret', username: 'operator' }),
  } as unknown as HostRepository;
}

const STANDARD_OUTPUTS: Record<string, string> = {
  'show bgp summary | no-more': SUMMARY,
  'show configuration protocols bgp | display set | no-more': CONFIG,
  'show configuration routing-options | display set | no-more': ROUTING_OPTIONS,
  'show route 10.141.1.81 | no-more': ROUTE_IPV4,
  'show route 167.250.0.130 | no-more': NO_ROUTE,
  'show route 2001:1291:1602:1::a | no-more': ROUTE_IPV6,
};

describe('JuniperJunosBgpSshProvider', () => {
  it('discovers IPv4 and IPv6 peers with per-peer local-AS and correlated interfaces', async () => {
    const { factory } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    const reading = await provider.discover(device());
    const byAddress = new Map(reading.peers.map((peer) => [peer.peerAddress, peer]));

    expect(reading.ipv6Supported).toBe(true);
    expect(reading.logicalUnitFallback).toBe(true);
    expect(reading.warnings).toEqual([]);
    expect(reading.peers).toHaveLength(3);
    expect(byAddress.get('10.141.1.81')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 23_106n,
      // local-as do GRUPO, não o AS global (52575).
      localAs: 265_185n,
      cliReceivedPrefixes: 1_103_955n,
      bgpPeerDescription: 'TRANSITO ATC',
      routeLookup: {
        status: 'SUCCESS',
        lookup: { routeFound: true, interfaceNames: ['ae0.2800'] },
      },
    });
    expect(byAddress.get('2001:1291:1602:1::a')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 16_735n,
      // local-as do VIZINHO tem precedência sobre o grupo/global.
      localAs: 265_185n,
      cliReceivedPrefixes: 245_187n,
      routeLookup: {
        status: 'SUCCESS',
        lookup: { routeFound: true, interfaceNames: ['ae0.2810'] },
      },
    });
    // Sem local-as de grupo/peer, cai no autonomous-system global.
    expect(byAddress.get('167.250.0.130')).toMatchObject({
      remoteAs: 40_027n,
      localAs: 52_575n,
      bgpPeerDescription: 'NETFLIX IX',
      cliReceivedPrefixes: 0n,
    });
  });

  it('opens a separate session per large command so Junos does not drop the transport', async () => {
    const { factory, sessions } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    await provider.discover(device());

    const commands = sessions.flatMap((session) =>
      session.execute.mock.calls.flatMap((call) => call[1] as string[]),
    );
    // summary e cada comando de configuração em sessões distintas...
    const summarySessions = sessions.filter((session) =>
      session.execute.mock.calls.some((call) => call[1][0] === 'show bgp summary | no-more'),
    );
    const configSessions = sessions.filter((session) =>
      session.execute.mock.calls.some(
        (call) => call[1][0] === 'show configuration protocols bgp | display set | no-more',
      ),
    );
    expect(summarySessions).toHaveLength(1);
    expect(configSessions).toHaveLength(1);
    expect(summarySessions[0]).not.toBe(configSessions[0]);
    // ...e cada sessão recebe só o seu comando (nunca uma fila de comandos grandes).
    for (const session of [...summarySessions, ...configSessions]) {
      expect(session.execute).toHaveBeenCalledTimes(1);
    }
    expect(commands).toContain('show configuration routing-options | display set | no-more');
  });

  it('batches the route lookups in a single session', async () => {
    const { factory, sessions } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    await provider.discover(device());

    const routeSessions = sessions.filter((session) =>
      session.execute.mock.calls.some((call) => String(call[1][0]).startsWith('show route ')),
    );
    expect(routeSessions).toHaveLength(1);
    expect(routeSessions[0]?.execute).toHaveBeenCalledTimes(3);
  });

  it('records a command failure in the peer instead of inventing an interface', async () => {
    const outputs = { ...STANDARD_OUTPUTS };
    delete outputs['show route 10.141.1.81 | no-more'];
    const { factory } = factoryFor(outputs);
    const provider = new JuniperJunosBgpSshProvider(
      repository(),
      (options) => {
        const client = factory(options);
        const execute = client.execute.bind(client);
        client.execute = (async (host: string, commands: string[]) => {
          if (commands[0] === 'show route 10.141.1.81 | no-more') {
            return [{ command: commands[0]!, stdout: '', stderr: 'permission denied', exitCode: 1 }];
          }
          return execute(host, commands);
        }) as typeof client.execute;
        return client;
      },
    );

    const reading = await provider.discover(device());
    const peer = reading.peers.find((item) => item.peerAddress === '10.141.1.81');

    expect(peer?.routeLookup).toEqual({ status: 'COMMAND_FAILED', error: 'permission denied' });
  });

  it('keeps the peers when the BGP configuration cannot be read', async () => {
    const outputs = { ...STANDARD_OUTPUTS };
    delete outputs['show configuration protocols bgp | display set | no-more'];
    const { factory } = factoryFor(outputs);
    const provider = new JuniperJunosBgpSshProvider(repository(), (options) => {
      const client = factory(options);
      const execute = client.execute.bind(client);
      client.execute = (async (host: string, commands: string[]) => {
        if (commands[0] === 'show configuration protocols bgp | display set | no-more') {
          return [{ command: commands[0]!, stdout: '', stderr: 'ssh failed', exitCode: 255 }];
        }
        return execute(host, commands);
      }) as typeof client.execute;
      return client;
    });

    const reading = await provider.discover(device());

    expect(reading.peers).toHaveLength(3);
    expect(reading.warnings).toEqual(['Configuração BGP: ssh failed']);
    // Sem config, o AS local só pode vir do autonomous-system global.
    expect(reading.localAs).toBe(52_575n);
  });

  it('fails the discovery when the summary itself fails', async () => {
    const provider = new JuniperJunosBgpSshProvider(repository(), () => {
      return {
        execute: vi.fn().mockResolvedValue([
          { command: 'show bgp summary | no-more', stdout: '', stderr: 'SSH transport failed', exitCode: 255 },
        ]),
      } as unknown as SshClient;
    });

    await expect(provider.discover(device())).rejects.toThrow('SSH transport failed');
  });

  it('reads advertised routes read-only using the peer local-AS', async () => {
    const { factory, sessions } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    const reading = await provider.readAdvertisedRoutes(device(), '10.141.1.81', 265_185n);

    expect(
      sessions.flatMap((session) => session.execute.mock.calls.flatMap((call) => call[1] as string[])),
    ).toEqual(['show route advertising-protocol bgp 10.141.1.81 | no-more']);
    expect(reading.routes[0]).toMatchObject({ prefix: '167.250.0.0/22', nextHop: 'Self' });
    expect(reading.routes[0]?.prependLocal).toBe(2);
  });

  it('never uses show route receive-protocol in the periodic discovery', async () => {
    const { factory, sessions } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    await provider.discover(device());

    const commands = sessions.flatMap((session) =>
      session.execute.mock.calls.flatMap((call) => call[1] as string[]),
    );
    // `show bgp summary` já entrega o total recebido dos 24 peers de uma vez.
    expect(commands.some((command) => command.includes('receive-protocol'))).toBe(false);
    expect(
      commands.filter((command) => command === 'show bgp summary | no-more'),
    ).toHaveLength(1);
  });

  it('passes the context command and never sends a write command', async () => {
    const { factory, sessions } = factoryFor(STANDARD_OUTPUTS);
    const provider = new JuniperJunosBgpSshProvider(repository(), factory);

    await provider.discover(device());

    for (const session of sessions) {
      expect(session.options).toMatchObject({ contextCommand: null, port: 22, username: 'operator' });
      for (const call of session.execute.mock.calls) {
        for (const command of call[1] as string[]) {
          // A allowlist é a garantia real: nada fora dela sai da aplicação.
          expect(() => assertJunosReadOnly(command)).not.toThrow();
          expect(command).toMatch(/^(?:show )/);
          expect(command).not.toMatch(/\b(?:configure|commit|delete|clear|request|edit)\b/);
        }
      }
    }
  });

  it('refuses to open a session without credentials', async () => {
    const provider = new JuniperJunosBgpSshProvider(
      { getDecryptedSshCredentials: vi.fn().mockResolvedValue(null) } as unknown as HostRepository,
      factoryFor(STANDARD_OUTPUTS).factory,
    );

    await expect(provider.discover(device())).rejects.toThrow('Credencial SSH não configurada');
  });
});
