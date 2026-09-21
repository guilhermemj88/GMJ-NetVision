import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeChannelState {
  writes: string[];
}

const mockState = vi.hoisted(() => ({ channels: [] as FakeChannelState[] }));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeSink extends EventEmitter {
    setEncoding() {}
  }

  class FakeChannel extends EventEmitter {
    writes: string[] = [];
    stderr = new FakeSink();
    setEncoding() {}
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    }
    end(chunk?: string) {
      if (chunk) this.writes.push(chunk);
      queueMicrotask(() => this.emit('close'));
    }
    close() {
      this.emit('close');
    }
  }

  class FakeClient extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
    }
    shell(_options: unknown, callback: (error: undefined, stream: FakeChannel) => void) {
      const stream = new FakeChannel();
      mockState.channels.push(stream);
      callback(undefined, stream);
      queueMicrotask(() => stream.emit('data', '<HUAWEI>'));
    }
    end() {}
  }

  return { Client: FakeClient };
});

import { SshClientImpl } from './ssh-client-impl';

describe('SshClientImpl SSH context command', () => {
  afterEach(() => {
    mockState.channels.length = 0;
  });

  function lastCommands(): string {
    const channel = mockState.channels.at(-1);
    if (!channel) throw new Error('SSH channel was not created');
    return channel.writes.join('');
  }

  it('keeps the current command sequence when no context is configured', async () => {
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p' });
    await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display bgp peer']);
    expect(lastCommands()).toBe('screen-length 0 temporary\r\ndisplay bgp peer\r\nquit\r\n');
  });

  it('runs the context command in the same session before the real command', async () => {
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
    });
    await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display bgp peer']);
    expect(lastCommands()).toBe(
      'screen-length 0 temporary\r\nswitch virtual-system IMPLANTAR-IXBR\r\ndisplay bgp peer\r\nquit\r\nquit\r\n',
    );
  });

  it('applies the context to a BGP route lookup command', async () => {
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
    });
    await client.execute('10.0.0.1', [
      'screen-length 0 temporary',
      'display ip routing-table 200.150.1.193',
    ]);
    expect(lastCommands()).toBe(
      'screen-length 0 temporary\r\nswitch virtual-system IMPLANTAR-IXBR\r\ndisplay ip routing-table 200.150.1.193\r\nquit\r\nquit\r\n',
    );
  });
});
