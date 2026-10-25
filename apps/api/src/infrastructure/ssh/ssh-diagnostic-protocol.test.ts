import { generateKeyPairSync, createHash } from 'node:crypto';
import { Server, utils, type Connection } from 'ssh2';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SshClientImpl } from './ssh-client-impl';
import { probeWindowCommand } from '../mpls/vsi-probe-window';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
});
const parsed = utils.parseKey(key);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test key');
const fingerprint =
  'SHA256:' +
  createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
async function server(
  output = 'UNIT OUTPUT',
  prompt = '<UNIT>',
  prepare = false,
  context?: string,
  onOutput?: (stdout: string) => void,
  expectedPrompt = '<UNIT>',
  fragmentInitialPrompt = false,
  preparationReply = '',
  audit?: {
    before: (command: string) => void;
    complete: (result: { command: string; stdout: string; completedAt: string }) => void;
  },
  conditional?: {
    allowed: string[];
    resolve: (result: { command: string; stdout: string; completedAt: string }) => string | null;
  },
) {
  const connections = new Set<Connection>(),
    commands: string[] = [];
  let authentications = 0;
  let connectionsCreated = 0;
  const ssh = new Server({ hostKeys: [key] }, (client) => {
    connectionsCreated++;
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', (ctx) => {
      authentications++;
      if (ctx.method === 'password' && ctx.password === 'unit-secret') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a());
        session.on('shell', (a) => {
          const channel = a();
          channel.on('error', () => {});
          if (fragmentInitialPrompt) {
            const split = prompt.indexOf('Password') + 'Password'.length;
            channel.write(prompt.slice(0, split));
            setTimeout(() => channel.write(prompt.slice(split) + '\r\n'), 25);
          } else channel.write(prompt + '\r\n');
          let buffer = '';
          let currentPrompt = prompt.trim().split(/\r?\n/).at(-1)!;
          channel.on('data', (data: Buffer) => {
            buffer += data.toString();
            if (!buffer.includes('\r\n')) return;
            const command = buffer.split('\r\n')[0]!;
            buffer = '';
            commands.push(command);
            if (command === 'switch virtual-system TEST-VR') currentPrompt = '<TEST-VR>';
            if (output === 'STALL') return;
            if (output === 'EOF') {
              channel.end(command + '\r\nPARTIAL');
              return;
            }
            const body = command === 'screen-length 0 temporary' ? preparationReply : output;
            channel.write(command + '\r\n' + body + '\r\n' + currentPrompt + '\r\n', () => {
              if (output === 'DISCONNECT_AT_FINAL_PROMPT') client.end();
            });
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  clean.push(async () => {
    connections.forEach((c) => c.end());
    await new Promise<void>((resolve) => ssh.close(() => resolve()));
  });
  const controller = new AbortController();
  const client = new SshClientImpl({
    port: (ssh.address() as AddressInfo).port,
    username: 'unit',
    password: 'unit-secret',
    contextCommand: context ?? null,
    readyTimeout: 1500,
    shellTimeoutMs: 1500,
    diagnostic: {
      fingerprint,
      initialPrompt: expectedPrompt,
      expectedPrompt: context === 'switch virtual-system TEST-VR' ? '<TEST-VR>' : expectedPrompt,
      allowedCommands: conditional?.allowed ?? ['display mpls ldp'],
      outputBytes: 131072,
      signal: controller.signal,
      onCommand: (command) => {
        // At this point the peer must not have received this command yet.
        expect(commands).not.toContain(command);
        audit?.before(command);
      },
      ...(audit ? { onCommandComplete: audit.complete } : {}),
      ...(conditional ? { interfaceAfterVsi: conditional.resolve } : {}),
      ...(onOutput ? { onOutput } : {}),
      ...(prepare ? { sessionPreparation: 'screen-length 0 temporary' as const } : {}),
    },
  });
  return {
    client,
    controller,
    commands,
    authentications: () => authentications,
    connectionsCreated: () => connectionsCreated,
    connections,
    port: (ssh.address() as AddressInfo).port,
  };
}
async function closed(connections: Set<Connection>) {
  for (let i = 0; i < 100; i++) {
    if (!connections.size) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Connection was not closed');
}
describe('existing SSH transport, opt-in diagnostic protection over local SSH protocol', () => {
  it.each(['LOCAL', 'REMOTE'] as const)(
    'sends only the fixed %s ping and closes, with no preparation/context/quit',
    async (direction) => {
      const command = probeWindowCommand(direction, 'PING');
      const test = await server(
        'BOUNDED PROBE OUTPUT',
        '<UNIT>',
        false,
        undefined,
        undefined,
        '<UNIT>',
        false,
        '',
        undefined,
        { allowed: [command], resolve: () => null },
      );
      await test.client.execute('127.0.0.1', [command]);
      await closed(test.connections);
      expect(test.commands).toEqual([command]);
      expect(test.connectionsCreated()).toBe(1);
    },
  );
  it.each(['STALL', 'EOF', 'Error: Unknown command', 'X'.repeat(131073)])(
    'closes a failing probe session without retry or additional commands: case %#',
    async (output) => {
      const command = probeWindowCommand('LOCAL', 'PING');
      const test = await server(
        output,
        '<UNIT>',
        false,
        undefined,
        undefined,
        '<UNIT>',
        false,
        '',
        undefined,
        { allowed: [command], resolve: () => null },
      );
      await expect(test.client.execute('127.0.0.1', [command])).rejects.toThrow();
      await closed(test.connections);
      expect(test.commands).toEqual([command]);
      expect(test.connectionsCreated()).toBe(1);
    },
  );
  it('appends one exact allowlisted interface read only after a completed VSI in the same session', async () => {
    const vsi = 'display vsi name SERVICE-A verbose';
    const ac = 'display interface Vlanif777';
    const test = await server(
      'BODY',
      '<UNIT>',
      true,
      undefined,
      undefined,
      '<UNIT>',
      false,
      '',
      undefined,
      {
        allowed: [vsi, ac],
        resolve: (r) => (r.command === vsi ? ac : null),
      },
    );
    await test.client.execute('127.0.0.1', [vsi]);
    await closed(test.connections);
    expect(test.commands).toEqual(['screen-length 0 temporary', vsi, ac]);
    expect(test.connectionsCreated()).toBe(1);
  });
  it.each([
    'system-view',
    'display interface Vlanif777;save',
    'display interface Vlanif777\nsave',
    'display interface Vlanif777 | display version',
    'display interface Vlanif999',
  ])('rejects a conditional command outside the exact AC policy: %j', async (next) => {
    const vsi = 'display vsi name SERVICE-A verbose';
    const test = await server(
      'BODY',
      '<UNIT>',
      false,
      undefined,
      undefined,
      '<UNIT>',
      false,
      '',
      undefined,
      {
        allowed: [
          vsi,
          'display interface Vlanif777',
          ...(next === 'display interface Vlanif999' ? [] : [next]),
        ],
        resolve: () => next,
      },
    );
    await expect(test.client.execute('127.0.0.1', [vsi])).rejects.toThrow('POLICY_BLOCKED');
    await closed(test.connections);
    expect(test.commands).toEqual([vsi]);
  });
  it('cannot append an interface after a non-VSI command', async () => {
    const test = await server(
      'BODY',
      '<UNIT>',
      false,
      undefined,
      undefined,
      '<UNIT>',
      false,
      '',
      undefined,
      {
        allowed: ['display mpls ldp', 'display interface Vlanif777'],
        resolve: () => 'display interface Vlanif777',
      },
    );
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'POLICY_BLOCKED',
    );
    await closed(test.connections);
    expect(test.commands).toEqual(['display mpls ldp']);
  });
  it('cannot append a second interface or follow a paginated VSI', async () => {
    const vsi = 'display vsi name SERVICE-A verbose',
      ac = 'display interface Vlanif777';
    for (const body of ['BODY', '---- More ----']) {
      const test = await server(
        body,
        '<UNIT>',
        false,
        undefined,
        undefined,
        '<UNIT>',
        false,
        '',
        undefined,
        {
          allowed: [vsi, ac],
          resolve: () => ac,
        },
      );
      await expect(test.client.execute('127.0.0.1', [vsi])).rejects.toThrow();
      await closed(test.connections);
      expect(test.commands).toEqual(body === 'BODY' ? [vsi, ac] : [vsi]);
    }
  });
  it('audits each send before the wire and each complete response before the next send', async () => {
    const events: string[] = [];
    const test = await server('BODY', '<UNIT>', true, undefined, undefined, '<UNIT>', false, '', {
      before: (command) => events.push('SEND:' + command),
      complete: (result) => {
        expect(result.stdout.trimEnd()).toMatch(/<UNIT>$/);
        expect(Number.isNaN(Date.parse(result.completedAt))).toBe(false);
        events.push('COMPLETE:' + result.command);
      },
    });
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    await closed(test.connections);
    expect(events).toEqual([
      'SEND:screen-length 0 temporary',
      'COMPLETE:screen-length 0 temporary',
      'SEND:display mpls ldp',
      'COMPLETE:display mpls ldp',
    ]);
  });
  it('closes without sending any command if the before-send audit fails', async () => {
    const test = await server('BODY', '<UNIT>', true, undefined, undefined, '<UNIT>', false, '', {
      before: () => {
        throw new Error('disk unavailable');
      },
      complete: () => {},
    });
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'AUDIT_FAILED',
    );
    await closed(test.connections);
    expect(test.commands).toEqual([]);
  });
  it('closes before displays when preparation completion cannot be audited', async () => {
    const test = await server('BODY', '<UNIT>', true, undefined, undefined, '<UNIT>', false, '', {
      before: () => {},
      complete: () => {
        throw new Error('disk unavailable');
      },
    });
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'AUDIT_FAILED',
    );
    await closed(test.connections);
    expect(test.commands).toEqual(['screen-length 0 temporary']);
  });
  it.each([
    'Error: Permission denied',
    'Permission denied',
    'OK',
    'Info: Unknown response',
    'Continue? [Y/N]:',
    '---- More ----',
    '<OTHER>',
    '[UNIT]',
  ])(
    'stops before any display when preparation is refused, unknown or unsafe %j',
    async (response) => {
      const test = await server(
        'UNUSED',
        '<UNIT>',
        true,
        undefined,
        undefined,
        '<UNIT>',
        false,
        response,
      );
      await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow();
      await closed(test.connections);
      expect(test.commands).toEqual(['screen-length 0 temporary']);
    },
  );
  it.each([
    'screen-length 0',
    'screen-length 24 temporary',
    'screen-length 0 permanent',
    'screen-length 0 temporary | display version',
    'screen-length 0 temporary\nsave',
    'screen-length 0 temporary;save',
    'screen-length 0 temporary && reboot',
  ])('rejects unsafe preparation at the transport before authentication %j', async (value) => {
    const test = await server();
    const client = new SshClientImpl({
      port: test.port,
      username: 'unit',
      password: 'unit-secret',
      diagnostic: {
        fingerprint,
        initialPrompt: '<UNIT>',
        expectedPrompt: '<UNIT>',
        allowedCommands: ['display mpls ldp'],
        outputBytes: 131072,
        signal: new AbortController().signal,
        onCommand: () => {},
        sessionPreparation: value as 'screen-length 0 temporary',
      },
    });
    await expect(client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'SSH_DIAGNOSTIC_POLICY_BLOCKED',
    );
    expect(test.authentications()).toBe(0);
    expect(test.commands).toEqual([]);
  });
  it('accepts an approved final prompt even when the peer disconnects during channel closure', async () => {
    const test = await server('DISCONNECT_AT_FINAL_PROMPT');
    const result = await test.client.execute('127.0.0.1', ['display mpls ldp']);
    await closed(test.connections);
    expect(result[0]?.exitCode).toBe(0);
    expect(result[0]?.stdout).toContain('<UNIT>');
    expect(test.commands).toEqual(['display mpls ldp']);
  });
  const observedBanner = readFileSync(
    new URL('./__fixtures__/huawei-bhe-vta-login.sanitized.txt', import.meta.url),
    'utf8',
  ).trim();
  it('accepts the exact observed informational login line before a pinned user prompt', async () => {
    const test = await server(
      'OK',
      observedBanner,
      false,
      undefined,
      undefined,
      '<BHE-VTA-6730-MPLS-01>',
    );
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    await closed(test.connections);
    expect(test.commands).toEqual(['display mpls ldp']);
  });
  it('waits for a fragmented exact notice and the pinned prompt without treating a prefix as a question', async () => {
    const test = await server(
      'OK',
      observedBanner,
      false,
      undefined,
      undefined,
      '<BHE-VTA-6730-MPLS-01>',
      true,
    );
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    await closed(test.connections);
    expect(test.commands).toEqual(['display mpls ldp']);
  });
  it.each([' [Y/N]:', ' New password:', '\r\nNew password:'])(
    'does not extend the informational-line exception to an interaction %j',
    async (suffix) => {
      const line = observedBanner.split(/\r?\n/)[0]!;
      const test = await server('UNUSED', line + suffix);
      await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
        'SSH_DIAGNOSTIC_INTERACTION_OR_ERROR',
      );
      await closed(test.connections);
      expect(test.commands).toEqual([]);
    },
  );
  it('observes an informational login notice with no command, context, preparation or answer', async () => {
    const captured: string[] = [];
    const test = await server(
      'UNUSED',
      'Info: The password will expire in 5 days.\r\n<UNIT>',
      false,
      undefined,
      (stdout) => captured.push(stdout),
    );
    await test.client.execute('127.0.0.1', []);
    await closed(test.connections);
    expect(test.commands).toEqual([]);
    expect(captured[0]).toContain('expire in 5 days');
  });
  it('still refuses a credential question in an empty passive session', async () => {
    const test = await server('UNUSED', 'Please enter the new password:');
    await expect(test.client.execute('127.0.0.1', [])).rejects.toThrow(
      'SSH_DIAGNOSTIC_INTERACTION_OR_ERROR',
    );
    await closed(test.connections);
    expect(test.commands).toEqual([]);
  });
  it('captures bounded partial evidence but never answers a pre-command password question', async () => {
    const captured: string[] = [];
    const test = await server('UNUSED', 'Change password now? [Y/N]:', false, undefined, (stdout) =>
      captured.push(stdout),
    );
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'SSH_DIAGNOSTIC_INTERACTION_OR_ERROR',
    );
    await closed(test.connections);
    expect(test.commands).toEqual([]);
    expect(captured).toEqual(['Change password now? [Y/N]:\r\n']);
  });
  it('redacts the configured credential and terminal escapes in collected private evidence', async () => {
    const captured: string[] = [];
    const test = await server(
      '\u001b[31munit-secret\u001b[0m',
      '<UNIT>',
      false,
      undefined,
      (stdout) => captured.push(stdout),
    );
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    await closed(test.connections);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('[REMOVIDO]');
    expect(captured[0]).not.toContain('unit-secret');
    expect(captured[0]).not.toContain('\u001b');
  });
  it('closes safely if the private evidence sink fails', async () => {
    const test = await server('UNUSED', 'Password:', false, undefined, () => {
      throw new Error('private sink failed');
    });
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'SSH_DIAGNOSTIC_AUDIT_FAILED',
    );
    await closed(test.connections);
    expect(test.commands).toEqual([]);
  });
  it('prepares in the physical user view before the explicitly approved virtual user view', async () => {
    const test = await server('OK', '<UNIT>', true, 'switch virtual-system TEST-VR');
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    expect(test.commands).toEqual([
      'screen-length 0 temporary',
      'switch virtual-system TEST-VR',
      'display mpls ldp',
    ]);
    await closed(test.connections);
  });
  it.each(['system-view', 'save', 'switch virtual-system X\nsave', 'switch\nvirtual-system X'])(
    'blocks unsafe context %j before connecting',
    async (context) => {
      const test = await server('OK', '<UNIT>', false, context);
      await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
        'SSH_DIAGNOSTIC_POLICY_BLOCKED',
      );
      expect(test.authentications()).toBe(0);
      expect(test.commands).toEqual([]);
    },
  );
  it('sends only the explicitly authorized session preparation before the display', async () => {
    const test = await server('OK', '<UNIT>', true);
    await test.client.execute('127.0.0.1', ['display mpls ldp']);
    expect(test.commands).toEqual(['screen-length 0 temporary', 'display mpls ldp']);
    await closed(test.connections);
  });
  it('expires and closes a stalled SSH command without advancing', async () => {
    const test = await server('STALL');
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow(
      'SSH_DIAGNOSTIC_TIMEOUT',
    );
    expect(test.commands).toEqual(['display mpls ldp']);
    await closed(test.connections);
  });
  it('collects a full bounded response and closes without sending quit/config commands', async () => {
    const test = await server('X'.repeat(80000) + 'FINAL');
    const result = await test.client.execute('127.0.0.1', ['display mpls ldp']);
    expect(result[0]?.stdout).toContain('FINAL');
    expect(test.commands).toEqual(['display mpls ldp']);
    await closed(test.connections);
  });
  it.each(['---- More ----', 'Error: Unknown command', 'Password:', '[UNIT]'])(
    'stops safely on incomplete/interactive output %s',
    async (output) => {
      const test = await server(output, output === '[UNIT]' ? output : '<UNIT>');
      await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow();
      await closed(test.connections);
      expect(test.commands.every((c) => c === 'display mpls ldp')).toBe(true);
    },
  );
  it.each([
    ['EOF', 'EOF'],
    ['OUTPUT_LIMIT', 'X'.repeat(131073)],
  ])('does not treat %s as completion', async (_label, output) => {
    const test = await server(output);
    await expect(test.client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow();
    await closed(test.connections);
  });
  it('verifies the host key before password authentication', async () => {
    const test = await server();
    const client = new SshClientImpl({
      port: test.port,
      username: 'unit',
      password: 'unit-secret',
      readyTimeout: 1500,
      diagnostic: {
        fingerprint: 'SHA256:' + 'A'.repeat(43),
        initialPrompt: '<UNIT>',
        expectedPrompt: '<UNIT>',
        allowedCommands: ['display mpls ldp'],
        outputBytes: 131072,
        signal: new AbortController().signal,
        onCommand: () => {},
      },
    });
    await expect(client.execute('127.0.0.1', ['display mpls ldp'])).rejects.toThrow();
    expect(test.authentications()).toBe(0);
    expect(test.commands).toEqual([]);
  });
  it('cancels and closes an actual stalled socket', async () => {
    const test = await server('STALL');
    const pending = test.client.execute('127.0.0.1', ['display mpls ldp']);
    const reject = expect(pending).rejects.toThrow();
    setTimeout(() => test.controller.abort(), 150);
    await reject;
    await closed(test.connections);
  });
  it('never sends an unauthorized command even if the selected account has administrative rights', async () => {
    const test = await server();
    await expect(test.client.execute('127.0.0.1', ['system-view'])).rejects.toThrow(
      'SSH_DIAGNOSTIC_POLICY_BLOCKED',
    );
    expect(test.authentications()).toBe(0);
    expect(test.commands).toEqual([]);
  });
});
