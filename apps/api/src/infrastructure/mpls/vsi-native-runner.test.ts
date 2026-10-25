import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Server, utils, type Connection } from 'ssh2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import {
  InventoryVsiDiagnosticRunner,
  parseVsiAccessProfile,
  type ObservationSink,
} from './vsi-diagnostic-ssh';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
});
const parsed = utils.parseKey(key);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid key');
const fingerprint =
  'SHA256:' +
  createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
const cleaners: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleaners.splice(0).reverse()) await c();
});
async function endpoint(
  platform: 'VRP_V200' | 'YUNSHAN_V600',
  failure?: 'VERSION' | 'AC' | 'KEY',
  versionLine?: string,
) {
  const commands: string[] = [],
    connections = new Set<Connection>();
  let authentications = 0;
  const realName = platform === 'VRP_V200' ? 'BHE-VTA-6730-MPLS-01' : 'BHE-VTA-S6750-MPLS-01';
  const folder =
    platform === 'VRP_V200' ? 'bhe-vta-local-full-20261022/' : 'bhe-vta-remote-20261022/';
  const mapping: Record<string, string> = {
    'display version': 'version',
    'display mpls ldp': 'ldp',
    'display ip interface brief': 'brief',
    'display vsi name 1041-IX-BH-V4 verbose': 'vsi',
    'display interface Vlanif1041': 'interface',
  };
  const server = new Server({ hostKeys: [key] }, (client) => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', (ctx) => {
      authentications++;
      if (ctx.method === 'password' && ctx.password === 'offline-secret') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a());
        session.on('shell', (a) => {
          const channel = a();
          channel.on('error', () => {});
          channel.write('<UNIT>\r\n');
          let buffer = '';
          channel.on('data', (data: Buffer) => {
            buffer += data.toString();
            if (!buffer.includes('\r\n')) return;
            const command = buffer.split('\r\n')[0]!;
            buffer = '';
            commands.push(command);
            let body = '';
            if (command !== 'screen-length 0 temporary') {
              const file = mapping[command];
              if (!file) {
                channel.write('Error: Unauthorized\r\n<UNIT>');
                return;
              }
              const capture = readFileSync(
                new URL(
                  './__fixtures__/' +
                    folder +
                    (platform === 'YUNSHAN_V600' ? 'r4-retest-' : '') +
                    file +
                    '.sanitized.txt',
                  import.meta.url,
                ),
                'utf8',
              );
              body = capture
                .slice(
                  capture.indexOf(command) + command.length,
                  capture.lastIndexOf('<' + realName + '>'),
                )
                .trim();
              if (versionLine && file === 'version')
                body = body.replace(
                  /VRP \(R\) software, Version 5\.170 \(S6730 [^)]+\)/,
                  `VRP (R) software, Version 5.170 (S6730 ${versionLine})`,
                );
              if (failure === 'VERSION' && file === 'version') body = 'Unsupported firmware';
              if (failure === 'AC' && file === 'vsi')
                body = body.replace('Vlanif1041', 'UNSAFE;save');
            }
            channel.write(command + '\r\n' + body + '\r\n<UNIT>\r\n');
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleaners.push(async () => {
    connections.forEach((c) => c.end());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const host = {
    id: 'UNIT',
    name: 'UNIT',
    vendor: 'Huawei',
    sshEnabled: true,
    ssh: {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'offline',
      credentialConfigured: true,
    },
  } as unknown as HostRecord;
  const profile = parseVsiAccessProfile({
    vendor: 'HUAWEI',
    hostId: host.id,
    endpoint: host.ssh!.host,
    port: host.ssh!.port,
    username: 'offline',
    context: null,
    fingerprint: failure === 'KEY' ? 'SHA256:' + 'A'.repeat(43) : fingerprint,
    initialPrompt: '<UNIT>',
    expectedPrompt: '<UNIT>',
    routingContext: 'GLOBAL',
    platform,
    firmwareEvidence: 'Real fixture replay over loopback only',
    disablePagingTemporary: true,
    validFrom: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 20000).toISOString(),
    operations: ['VERSION', 'LSR', 'LOOPBACKS', 'VSI', 'INTERFACE', 'PING'],
  });
  const runner = new InventoryVsiDiagnosticRunner(
    {
      getHost: async () => host,
      getDecryptedSshCredentials: async () => ({ username: 'offline', password: 'offline-secret' }),
    },
    async () => [profile],
  );
  return { host, runner, commands, connections, authentications: () => authentications };
}
async function closed(connections: Set<Connection>) {
  for (let n = 0; n < 100; n++) {
    if (connections.size === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Orphan SSH socket');
}
describe('native inventory runner with real fixture replay and actual loopback SSH protocol', () => {
  it.each(['VRP_V200', 'YUNSHAN_V600'] as const)(
    '%s collects all six commands in one audited session and closes without extra CLI',
    async (platform) => {
      const f = await endpoint(platform),
        before: string[] = [],
        observations: Parameters<ObservationSink>[0][] = [];
      const result = await f.runner.collectEndpoint(
        f.host,
        '1041-IX-BH-V4',
        new AbortController().signal,
        (c) => {
          expect(f.commands).not.toContain(c);
          before.push(c);
        },
        (o) => observations.push(o),
      );
      await closed(f.connections);
      expect(f.commands).toEqual([
        'screen-length 0 temporary',
        'display version',
        'display mpls ldp',
        'display ip interface brief',
        'display vsi name 1041-IX-BH-V4 verbose',
        'display interface Vlanif1041',
      ]);
      expect(before).toEqual(f.commands);
      expect(observations).toHaveLength(6);
      expect(Object.keys(result.captures).sort()).toEqual(['ac', 'brief', 'ldp', 'vsi']);
      expect(result.platform).toBe(platform);
    },
  );
  it.each(['VERSION', 'AC', 'KEY'] as const)(
    'stops safely on %s failure with no unauthorized command or retry',
    async (failure) => {
      const f = await endpoint('VRP_V200', failure);
      await expect(
        f.runner.collectEndpoint(
          f.host,
          '1041-IX-BH-V4',
          new AbortController().signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow();
      await closed(f.connections);
      expect(f.commands.some((c) => /system-view|save|commit|quit|UNSAFE/.test(c))).toBe(false);
      if (failure === 'KEY') {
        expect(f.authentications()).toBe(0);
        expect(f.commands).toEqual([]);
      }
      if (failure === 'VERSION')
        expect(f.commands).toEqual(['screen-length 0 temporary', 'display version']);
      if (failure === 'AC')
        expect(f.commands.at(-1)).toBe('display vsi name 1041-IX-BH-V4 verbose');
    },
  );
  it('cancels between completed commands, closes the socket and never sends the next display', async () => {
    const f = await endpoint('VRP_V200'),
      controller = new AbortController();
    const pending = f.runner.collectEndpoint(
      f.host,
      '1041-IX-BH-V4',
      controller.signal,
      () => {},
      (o) => {
        if (o.command === 'display version') controller.abort('OPERATOR_CANCELLED');
      },
    );
    await expect(pending).rejects.toThrow();
    await closed(f.connections);
    expect(f.commands).toEqual(['screen-length 0 temporary', 'display version']);
  });
});

describe('gate de versao do runner: V200R021C00SPC100 por versao exata', () => {
  it('chega ao proximo estagio permitido com S6730 V200R021C00SPC100', async () => {
    const f = await endpoint('VRP_V200', undefined, 'V200R021C00SPC100');
    const result = await f.runner.collectEndpoint(
      f.host,
      '1041-IX-BH-V4',
      new AbortController().signal,
      () => {},
      () => {},
    );
    await closed(f.connections);
    expect(f.commands).toEqual([
      'screen-length 0 temporary',
      'display version',
      'display mpls ldp',
      'display ip interface brief',
      'display vsi name 1041-IX-BH-V4 verbose',
      'display interface Vlanif1041',
    ]);
    expect(Object.keys(result.captures).sort()).toEqual(['ac', 'brief', 'ldp', 'vsi']);
  });

  it.each([
    'V200R021C00SPC101',
    'V200R021C00SPC200',
    'V200R021C10SPC100',
    'V200R021',
    'V200R020C00SPC500',
  ])('mantem fail-closed para %s sem enviar comando extra', async (versionLine) => {
    const f = await endpoint('VRP_V200', undefined, versionLine);
    await expect(
      f.runner.collectEndpoint(
        f.host,
        '1041-IX-BH-V4',
        new AbortController().signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
    await closed(f.connections);
    expect(f.commands).toEqual(['screen-length 0 temporary', 'display version']);
  });
});
