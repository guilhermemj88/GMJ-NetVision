import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PersistentHuaweiSession,
  type PersistentHuaweiSessionOptions,
  nextReconnectDelayMs,
} from './persistent-huawei-session';

class FakeSink extends EventEmitter {
  setEncoding(): void {}
}

class FakeChannel extends EventEmitter {
  writes: string[] = [];
  stderr = new FakeSink();
  autoRespond = true;
  private lastCommand = '';

  setEncoding(): void {}

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.lastCommand = chunk.replace(/\r?\n$/, '');
    if (this.autoRespond) queueMicrotask(() => this.respond());
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.writes.push(chunk);
    return this;
  }

  close(): void {
    this.emit('close');
  }

  respond(output?: string): void {
    this.emit('data', output ?? `${this.lastCommand}\r\n<HUAWEI>\r\n`);
  }
}

class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  static failConnect = false;
  static failShell = false;

  channels: FakeChannel[] = [];
  config: Record<string, unknown> = {};
  ended = false;

  constructor() {
    super();
    FakeClient.instances.push(this);
  }

  connect(config: Record<string, unknown>): void {
    this.config = config;
    queueMicrotask(() => {
      if (FakeClient.failConnect) this.emit('error', new Error('SSH connection timeout'));
      else this.emit('ready');
    });
  }

  shell(_options: unknown, callback: (error: Error | undefined, stream: FakeChannel | undefined) => void): void {
    if (FakeClient.failShell) {
      callback(new Error('shell denied'), undefined);
      return;
    }
    const channel = new FakeChannel();
    this.channels.push(channel);
    callback(undefined, channel);
    queueMicrotask(() => channel.emit('data', '\r\nWelcome to VRP\r\n<HUAWEI>\r\n'));
  }

  end(): void {
    this.ended = true;
  }
}

function buildSession(extra: Partial<PersistentHuaweiSessionOptions> = {}): PersistentHuaweiSession {
  return new PersistentHuaweiSession({
    host: '10.0.0.1',
    username: 'netvision',
    password: 'secret',
    connectionFactory: () => new FakeClient() as unknown as Client,
    ...extra,
  });
}

function firstClient(): FakeClient {
  const client = FakeClient.instances[0];
  if (!client) throw new Error('nenhuma conexão foi criada');
  return client;
}

function firstChannel(): FakeChannel {
  const channel = firstClient().channels[0];
  if (!channel) throw new Error('nenhum shell foi aberto');
  return channel;
}

describe('PersistentHuaweiSession', () => {
  beforeEach(() => {
    FakeClient.instances = [];
    FakeClient.failConnect = false;
    FakeClient.failShell = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('conecta, desliga o paging e fica pronta para leitura', async () => {
    const session = buildSession();

    await session.connect();

    expect(session.getState()).toBe('READY');
    expect(session.isAlive()).toBe(true);
    expect(firstClient().channels).toHaveLength(1);
    expect(firstChannel().writes.join('')).toContain('screen-length 0 temporary');
    expect(firstClient().config.keepaliveInterval).toBe(5_000);
    expect(firstClient().config.keepaliveCountMax).toBe(3);
  });

  it('executa comando read-only e devolve a saída', async () => {
    const session = buildSession();
    await session.connect();

    const output = await session.executeReadOnly('display interface brief');

    expect(output).toContain('display interface brief');
    expect(firstChannel().writes.join('')).toContain('display interface brief');
  });

  it('serializa dois comandos no mesmo shell (nunca em paralelo)', async () => {
    const session = buildSession();
    await session.connect();
    const channel = firstChannel();
    channel.autoRespond = false;

    const first = session.executeReadOnly('display interface brief');
    const second = session.executeReadOnly('display bgp peer');
    await vi.advanceTimersByTimeAsync(0);

    const displayWrites = (): string[] => channel.writes.filter((write) => write.startsWith('display'));
    expect(displayWrites()).toHaveLength(1);
    expect(displayWrites()[0]).toContain('display interface brief');

    channel.respond('display interface brief\r\n<HUAWEI>\r\n');
    await expect(first).resolves.toContain('display interface brief');
    await vi.advanceTimersByTimeAsync(0);

    expect(displayWrites()).toHaveLength(2);
    expect(displayWrites()[1]).toContain('display bgp peer');

    channel.respond('display bgp peer\r\n<HUAWEI>\r\n');
    await expect(second).resolves.toContain('display bgp peer');
  });

  it('reconecta quando a conexão cai (close)', async () => {
    const session = buildSession();
    await session.connect();
    expect(FakeClient.instances).toHaveLength(1);

    firstClient().emit('close');
    expect(session.getState()).toBe('FAILED');
    expect(session.isAlive()).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeClient.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.instances).toHaveLength(2);
    expect(session.getState()).toBe('READY');
  });

  it('reconecta em erro de transporte', async () => {
    const session = buildSession();
    await session.connect();

    firstClient().emit('error', new Error('socket hang up'));
    expect(session.getState()).toBe('FAILED');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeClient.instances).toHaveLength(2);
    expect(session.getState()).toBe('READY');
  });

  it('aplica backoff 1s/2s/5s/10s/30s/30s', async () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => nextReconnectDelayMs(attempt))).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000,
    ]);

    const session = buildSession();
    await session.connect();
    FakeClient.failConnect = true;

    firstClient().emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeClient.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeClient.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.instances).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeClient.instances).toHaveLength(4);
  });

  it('reseta o backoff após reconexão bem-sucedida', async () => {
    const session = buildSession();
    await session.connect();

    firstClient().emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeClient.instances).toHaveLength(2);
    expect(session.getState()).toBe('READY');

    FakeClient.instances[1]!.emit('close');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeClient.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.instances).toHaveLength(3);
  });

  it('rejeita comando proibido antes de tocar o SSH', async () => {
    const session = buildSession();

    await expect(session.executeReadOnly('system-view')).rejects.toThrow(/READ_ONLY_VIOLATION/);
    await expect(session.executeReadOnly('apply extcommunity rt 268568:660 additive')).rejects.toThrow(
      /READ_ONLY_VIOLATION/,
    );

    expect(FakeClient.instances).toHaveLength(0);
    expect(session.getState()).toBe('DISCONNECTED');
  });

  it('não abre um segundo login enquanto está READY', async () => {
    const session = buildSession();
    await session.connect();
    await session.connect();

    expect(FakeClient.instances).toHaveLength(1);
    expect(firstClient().channels).toHaveLength(1);
  });

  it('close() encerra sem agendar reconexão', async () => {
    const session = buildSession();
    await session.connect();

    await session.close();

    expect(session.getState()).toBe('DISCONNECTED');
    expect(session.isAlive()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeClient.instances).toHaveLength(1);
  });

  it('trata shell inválido como falha de conexão', async () => {
    const session = buildSession();
    FakeClient.failShell = true;

    await expect(session.connect()).rejects.toThrow(/SSH shell unavailable/);
    expect(session.getState()).toBe('FAILED');
  });

  it('trata timeout de comando reciclando a sessão', async () => {
    const session = buildSession({ commandTimeoutMs: 5_000 });
    await session.connect();
    firstChannel().autoRespond = false;

    const pending = session.executeReadOnly('display interface brief');
    const assertion = expect(pending).rejects.toThrow(/SSH command timeout/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(session.getState()).toBe('FAILED');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeClient.instances).toHaveLength(2);
  });
});
