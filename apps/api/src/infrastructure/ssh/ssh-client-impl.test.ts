import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeChannelState {
  writes: string[];
  events: string[];
  emitData: (data: string) => void;
}

const mockState = vi.hoisted(() => ({
  channels: [] as FakeChannelState[],
  script: null as null | ((command: string, channel: FakeChannelState) => void),
  /** Primeira saida do shell (prompt inicial ou desafio de senha). */
  initialOutput: '<HUAWEI>',
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeSink extends EventEmitter {
    setEncoding() {}
  }

  class FakeChannel extends EventEmitter {
    writes: string[] = [];
    events: string[] = [];
    stderr = new FakeSink();
    setEncoding() {}
    emitData(data: string) {
      this.emit('data', data);
    }
    write(chunk: string) {
      this.writes.push(chunk);
      this.events.push(`write:${chunk}`);
      const command = chunk.replace(/\r\n$/, '');
      const script = mockState.script;
      if (command.length > 0 && script) {
        queueMicrotask(() => script(command, this as unknown as FakeChannelState));
      }
      return true;
    }
    end(chunk?: string) {
      if (chunk) {
        this.writes.push(chunk);
        this.events.push(`write:${chunk}`);
      }
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
      mockState.channels.push(stream as unknown as FakeChannelState);
      callback(undefined, stream);
      queueMicrotask(() => stream.emit('data', mockState.initialOutput));
    }
    end() {}
  }

  return { Client: FakeClient };
});

import { SshClientImpl } from './ssh-client-impl';

const FAST_IDLE = 25;

/** Eco + saida + PROMPT final do comando. */
function echoWithPrompt(
  channel: FakeChannelState,
  command: string,
  chunks: string[] = [],
): void {
  channel.emitData(`<HUAWEI>${command}\r\n`);
  chunks.forEach((chunk, index) => {
    channel.events.push(`chunk:${command}:${index}`);
    channel.emitData(chunk);
  });
  channel.events.push(`prompt:${command}`);
  channel.emitData('\r\n<HUAWEI>');
}

describe('SshClientImpl — execucao sequencial por prompt', () => {
  afterEach(() => {
    mockState.channels.length = 0;
    mockState.script = null;
    mockState.initialOutput = '<HUAWEI>';
  });

  function lastChannel(): FakeChannelState {
    const channel = mockState.channels.at(-1);
    if (!channel) throw new Error('SSH channel was not created');
    return channel;
  }
  function commandsSent(): string {
    return lastChannel().writes.join('');
  }
  function eventIndex(channel: FakeChannelState, event: string): number {
    return channel.events.indexOf(event);
  }

  it('A) comando unico curto: command -> prompt -> quit', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    const [result] = await client.execute('10.0.0.1', ['screen-length 0 temporary']);

    expect(result!.exitCode).toBe(0);
    expect(lastChannel().writes).toEqual(['screen-length 0 temporary\r\n', 'quit\r\n']);
  });

  it('B) dump > 40 KB: nenhum quit antes do prompt final', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      channel.emitData(`<HUAWEI>${command}\r\n`);
      const payload = 'x'.repeat(45_000);
      channel.events.push('chunk:1');
      channel.emitData(payload.slice(0, 20_000));
      channel.events.push('chunk:2');
      channel.emitData(payload.slice(20_000));
      channel.events.push('prompt:final');
      channel.emitData('\r\n<HUAWEI>');
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    const [result] = await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display big']);

    expect(result!.stdout.length).toBeGreaterThan(40_000);
    const channel = lastChannel();
    expect(eventIndex(channel, 'write:quit\r\n')).toBeGreaterThan(eventIndex(channel, 'prompt:final'));
  });

  it('C) tres comandos: cada um so vai apos o prompt do anterior', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      // "display A" tem saida grande em varios chunks; B e C sao curtos.
      const chunks = command === 'display A' ? ['a'.repeat(20_000), 'a'.repeat(25_000)] : ['ok'];
      echoWithPrompt(channel, command, chunks);
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    await client.execute('10.0.0.1', ['display A', 'display B', 'display C']);

    const channel = lastChannel();
    expect(eventIndex(channel, 'write:display B\r\n')).toBeGreaterThan(eventIndex(channel, 'prompt:display A'));
    expect(eventIndex(channel, 'write:display C\r\n')).toBeGreaterThan(eventIndex(channel, 'prompt:display B'));
    expect(eventIndex(channel, 'write:quit\r\n')).toBeGreaterThan(eventIndex(channel, 'prompt:display C'));
    expect(channel.writes.filter((w) => w.includes('display A')).length).toBe(1);
  });

  it('D) contextCommand: cada comando espera o proprio prompt; quit+quit no fim', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
      commandIdleMs: FAST_IDLE,
    });
    await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display bgp peer']);

    const channel = lastChannel();
    expect(commandsSent()).toBe(
      'screen-length 0 temporary\r\nswitch virtual-system IMPLANTAR-IXBR\r\ndisplay bgp peer\r\nquit\r\nquit\r\n',
    );
    expect(eventIndex(channel, 'write:switch virtual-system IMPLANTAR-IXBR\r\n')).toBeGreaterThan(
      eventIndex(channel, 'prompt:screen-length 0 temporary'),
    );
    expect(eventIndex(channel, 'write:display bgp peer\r\n')).toBeGreaterThan(
      eventIndex(channel, 'prompt:switch virtual-system IMPLANTAR-IXBR'),
    );
  });

  it('E) return-quit: so apos o ultimo prompt envia return + quit', async () => {
    mockState.script = (command, channel) => {
      if (command === 'return') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      exitMode: 'return-quit',
      commandIdleMs: FAST_IDLE,
    });
    await client.execute('10.0.0.1', ['system-view', 'route-policy PL-X deny node 1']);

    const channel = lastChannel();
    expect(channel.writes.at(-1)).toBe('return\r\nquit\r\n');
    expect(eventIndex(channel, 'write:return\r\nquit\r\n')).toBeGreaterThan(
      eventIndex(channel, 'prompt:route-policy PL-X deny node 1'),
    );
  });

  it('F) sem prompt reconhecivel: o idle avanca para o PROXIMO comando (nao aborta)', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      if (command === 'display A') {
        // Sem prompt de volta: o idle fallback tem de avancar para o proximo.
        channel.emitData('<HUAWEI>display A\r\nsaida parcial sem prompt');
        return;
      }
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    const [result] = await client.execute('10.0.0.1', ['display A', 'display B']);

    const channel = lastChannel();
    expect(channel.writes.some((w) => w.startsWith('display B'))).toBe(true);
    expect(channel.writes.at(-1)).toBe('quit\r\n');
    expect(result!.stdout).toContain('saida parcial sem prompt');
    expect(result!.stdout).toContain('display B');
  });

  it('G) saida continua com pausas menores que o idle: nao avanca antes do prompt', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      channel.emitData(`<HUAWEI>${command}\r\n`);
      const parts = 4;
      for (let i = 0; i < parts; i += 1) {
        setTimeout(() => {
          channel.events.push(`chunk:${command}:${i}`);
          channel.emitData(`parte-${i}`);
          if (i === parts - 1) {
            channel.events.push(`prompt:${command}`);
            channel.emitData('\r\n<HUAWEI>');
          }
        }, 10 * (i + 1));
      }
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: 20 });
    await client.execute('10.0.0.1', ['display A', 'display B']);

    const channel = lastChannel();
    expect(eventIndex(channel, 'write:display B\r\n')).toBeGreaterThan(
      eventIndex(channel, 'prompt:display A'),
    );
    expect(eventIndex(channel, 'chunk:display A:3')).toBeLessThan(
      eventIndex(channel, 'write:display B\r\n'),
    );
  });

  it('H) timeout global continua encerrando sessao travada', async () => {
    mockState.script = () => undefined; // nunca responde
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      shellTimeoutMs: 40,
      commandIdleMs: 60_000,
    });
    await expect(client.execute('10.0.0.1', ['display travado'])).rejects.toThrow('SSH command timeout');
  });

  it('I) prompt de troca de senha inicial continua sendo respondido com N', async () => {
    mockState.initialOutput =
      'Warning: The initial password poses security risks.\r\nThe password needs to be changed. Change now? [Y/N]:';
    mockState.script = (command, channel) => {
      if (command === 'N') {
        // Depois do N o equipamento mostra o prompt normal.
        channel.emitData('\r\n<HUAWEI>');
        return;
      }
      if (command === 'quit') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    const [result] = await client.execute('10.0.0.1', ['display x']);

    expect(result!.exitCode).toBe(0);
    expect(lastChannel().writes[0]).toBe('N\r\n');
    expect(lastChannel().writes).toContain('display x\r\n');
    expect(lastChannel().writes.at(-1)).toBe('quit\r\n');
  });
});

describe('SshClientImpl — contrato e comandos em lote', () => {
  afterEach(() => {
    mockState.channels.length = 0;
    mockState.script = null;
    mockState.initialOutput = '<HUAWEI>';
  });

  afterEach(() => {
    mockState.channels.length = 0;
    mockState.script = null;
    mockState.initialOutput = '<HUAWEI>';
  });

  it('mantem a sequencia de comandos quando nao ha contexto', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({ port: 22, username: 'u', password: 'p', commandIdleMs: FAST_IDLE });
    await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display bgp peer']);
    expect(mockState.channels.at(-1)!.writes.join('')).toBe(
      'screen-length 0 temporary\r\ndisplay bgp peer\r\nquit\r\n',
    );
  });

  it('mantem o contexto virtual-system e o quit duplo', async () => {
    mockState.script = (command, channel) => {
      if (command === 'quit') return;
      echoWithPrompt(channel, command);
    };
    const client = new SshClientImpl({
      port: 22,
      username: 'u',
      password: 'p',
      contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
      commandIdleMs: FAST_IDLE,
    });
    await client.execute('10.0.0.1', ['screen-length 0 temporary', 'display ip routing-table 200.150.1.193']);
    expect(mockState.channels.at(-1)!.writes.join('')).toBe(
      'screen-length 0 temporary\r\nswitch virtual-system IMPLANTAR-IXBR\r\ndisplay ip routing-table 200.150.1.193\r\nquit\r\nquit\r\n',
    );
  });
});
