import { describe, expect, it, vi } from 'vitest';

/**
 * B4 — TRANSPORTE DE ESCRITA.
 *
 * O motor so pode avancar para o proximo comando quando o PROMPT normal do
 * equipamento confirma o termino. Silencio NAO e conclusao, prompt desconhecido
 * interrompe a sequencia e erro de CLI nunca deixa o `commit` sair.
 *
 * O `ssh2` e substituido por um transporte em memoria: o estado real de
 * `SshClientImpl` (timeouts, guardas, buffer) roda sem rede.
 */

const fake = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeStream extends EventEmitter {
    stdoutWrites: string[] = [];
    ended = false;
    readonly stderr = Object.assign(new EventEmitter(), {
      setEncoding: (): void => undefined,
    });
    setEncoding(): void {}
    write(chunk: string): boolean {
      this.stdoutWrites.push(chunk);
      return true;
    }
    end(chunk?: string): void {
      if (chunk !== undefined) this.stdoutWrites.push(chunk);
      this.ended = true;
      setImmediate(() => this.emit('close'));
    }
    close(): void {
      if (this.ended) return;
      this.ended = true;
      setImmediate(() => this.emit('close'));
    }
    feed(chunk: string): void {
      this.emit('data', Buffer.from(chunk));
    }
  }
  class FakeClient extends EventEmitter {
    readonly stream = new FakeStream();
    constructor() {
      super();
      fake.clients.push(this);
    }
    connect(): void {
      setImmediate(() => this.emit('ready'));
    }
    shell(_options: unknown, callback: (error: null, stream: FakeStream) => void): void {
      setImmediate(() => callback(null, this.stream));
    }
    end(): void {}
    destroy(): void {}
  }
  return { Client: FakeClient };
});

import { SshClientImpl } from './ssh-client-impl';

type FakeClientShape = {
  stream: {
    stdoutWrites: string[];
    feed(chunk: string): void;
    ended: boolean;
  };
};

function lastClient(): FakeClientShape {
  return fake.clients.at(-1) as FakeClientShape;
}

const WRITE_OPTIONS = {
  port: 22,
  username: 'netvision',
  password: 'x',
  exitMode: 'return-quit' as const,
  shellTimeoutMs: 5_000,
  abortOnInteractivePrompt: true,
  abortOnCommandError: true,
  requirePromptCompletion: true,
  promptIdleMs: 30,
};

const COMMANDS = ['system-view', 'route-policy PL-X permit node 2', 'commit'];

/** Aguarda o proximo tick para o cliente enviar o comando pendente. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('SshClientImpl - escrita exige prompt e nunca commita depois de erro', () => {
  it('erro de CLI impede o commit (sequencia interrompida)', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();

    stream.feed('<BHE-VTA>'); // prompt inicial
    await tick();
    expect(stream.stdoutWrites).toEqual(['system-view\r\n']);

    // echo + erro + prompt: o comando terminou COM erro.
    stream.feed('system-view\r\nError: Unrecognized command found at "^" position.\r\n[BHE-VTA]');
    await expect(execution).rejects.toThrow(/SSH_COMMAND_REJECTED/);
    expect(stream.stdoutWrites).not.toContain('commit\r\n');
    expect(stream.stdoutWrites).toHaveLength(1);
  });

  it('erro dividido em varios chunks SSH tambem impede o commit', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();
    stream.feed('<BHE-VTA>');
    await tick();

    stream.feed('system-view\r\n% Unrecog');
    await tick();
    stream.feed('nized command.\r\n[BHE-VTA]');

    await expect(execution).rejects.toThrow(/SSH_COMMAND_REJECTED/);
    expect(stream.stdoutWrites).toEqual(['system-view\r\n']);
  });

  it('silencio NAO conclui o comando: aborta sem enviar o commit', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();
    stream.feed('<BHE-VTA>');
    await tick();
    // Nada mais chega do equipamento (sem prompt de conclusao).
    stream.feed('system-view\r\n');

    await expect(execution).rejects.toThrow(/SSH_PROMPT_NOT_CONFIRMED/);
    expect(stream.stdoutWrites).toEqual(['system-view\r\n']);
  });

  it('prompt desconhecido interrompe a sequencia', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();
    stream.feed('<BHE-VTA>');
    await tick();
    stream.feed('system-view\r\nPlease wait, the system is busy...');

    await expect(execution).rejects.toThrow(/SSH_PROMPT_NOT_CONFIRMED/);
    expect(stream.stdoutWrites).toEqual(['system-view\r\n']);
  });

  it('prompt interativo ANTES do primeiro comando aborta sem responder', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();
    stream.feed('Are you sure to continue? [Y/N]:');

    await expect(execution).rejects.toThrow(/SSH_INTERACTIVE_PROMPT_BLOCKED/);
    expect(stream.stdoutWrites).toEqual([]);
  });

  it('com prompt em cada comando a sequencia avanca e termina no quit', async () => {
    const client = new SshClientImpl({ ...WRITE_OPTIONS, shellTimeoutMs: 300 });
    const execution = client.execute('10.0.0.1', [...COMMANDS]);
    const stream = lastClient().stream;
    await tick();
    stream.feed('<BHE-VTA>');
    await tick();
    stream.feed('system-view\r\n[BHE-VTA]');
    await tick();
    stream.feed('[BHE-VTA]route-policy PL-X permit node 2\r\n[BHE-VTA]');
    await tick();
    stream.feed('[BHE-VTA]commit\r\n[BHE-VTA]');
    await tick();

    // Cada comando so saiu depois do prompt do anterior, na ordem canonica.
    expect(stream.stdoutWrites.slice(0, 3)).toEqual([
      'system-view\r\n',
      'route-policy PL-X permit node 2\r\n',
      'commit\r\n',
    ]);
    // Sessao encerrada com a finalizacao de transporte (nunca `commit` extra).
    expect(stream.stdoutWrites.at(-1)).toBe('return\r\nquit\r\n');
    const [result] = await execution;
    expect(result?.exitCode).toBe(0);
  });
});
