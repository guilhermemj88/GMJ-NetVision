import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  MitigationWorker,
  createMitigationWorkerFromEnv,
  type MitigationSessionHandlers,
  type MitigationSessionPort,
} from './mitigation-worker';
import { WorkerHealthTracker } from './worker-health';
import { installWorkerSignalHandlers, type WorkerSignalSource } from './worker-signals';

class FakeSession implements MitigationSessionPort {
  connected = false;
  closed = false;
  executed: string[] = [];

  constructor(private readonly handlers: MitigationSessionHandlers) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.handlers.onStateChange('READY', { safeError: null });
  }

  async executeReadOnly(command: string): Promise<string> {
    this.executed.push(command);
    return `<output:${command}>`;
  }

  isAlive(): boolean {
    return this.connected && !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.handlers.onStateChange('DISCONNECTED', { safeError: null });
  }
}

interface BuiltWorker {
  worker: MitigationWorker;
  session: FakeSession;
  handlers: MitigationSessionHandlers;
}

function buildWorker(health?: WorkerHealthTracker): BuiltWorker {
  const created: { session?: FakeSession; handlers?: MitigationSessionHandlers } = {};
  const worker = new MitigationWorker({
    createSession: (handlers) => {
      created.handlers = handlers;
      created.session = new FakeSession(handlers);
      return created.session;
    },
    ...(health ? { health } : {}),
  });
  const session = created.session;
  const handlers = created.handlers;
  if (!session || !handlers) throw new Error('sessão não foi criada');
  return { worker, session, handlers };
}

describe('MitigationWorker', () => {
  it('start sobe a sessão e reflete health READY', async () => {
    const { worker, session } = buildWorker();

    await worker.start();

    expect(session.connected).toBe(true);
    expect(worker.isRunning()).toBe(true);
    expect(worker.getHealth().state).toBe('READY');
    expect(worker.getHealth().connectedAt).toBeInstanceOf(Date);
  });

  it('não abre uma segunda sessão quando start() é chamado de novo', async () => {
    const { worker } = buildWorker();
    const connectSpy = vi.spyOn(FakeSession.prototype, 'connect');

    await worker.start();
    await worker.start();

    expect(connectSpy).toHaveBeenCalledTimes(1);
    connectSpy.mockRestore();
  });

  it('stop encerra a sessão e volta para DISCONNECTED', async () => {
    const { worker, session } = buildWorker();
    await worker.start();

    await worker.stop();

    expect(session.closed).toBe(true);
    expect(worker.isRunning()).toBe(false);
    expect(worker.getHealth().state).toBe('DISCONNECTED');
  });

  it('executa leitura e registra lastCommandAt / lastSampleAt', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const health = new WorkerHealthTracker({ now: () => current });
    const { worker, session } = buildWorker(health);
    await worker.start();

    current = new Date('2026-01-01T00:00:05.000Z');
    await worker.executeReadOnly('display bgp peer');
    expect(worker.getHealth().lastCommandAt?.toISOString()).toBe('2026-01-01T00:00:05.000Z');

    current = new Date('2026-01-01T00:00:10.000Z');
    await worker.sampleReadOnly('display interface brief');
    const snapshot = worker.getHealthSnapshot();
    expect(snapshot.lastSampleAt).toBe('2026-01-01T00:00:10.000Z');
    expect(snapshot.lastCommandAt).toBe('2026-01-01T00:00:10.000Z');
    expect(session.executed).toEqual(['display bgp peer', 'display interface brief']);
  });

  it('reflete RECONNECTING/FAILED no health com safeError', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const health = new WorkerHealthTracker({ now: () => current });
    const { worker, handlers } = buildWorker(health);

    current = new Date('2026-01-01T00:00:07.000Z');
    handlers.onStateChange('RECONNECTING', { safeError: 'SSH connection timeout' });

    expect(worker.getHealth().state).toBe('RECONNECTING');
    expect(worker.getHealth().reconnectCount).toBe(1);
    expect(worker.getHealth().lastReconnectAt?.toISOString()).toBe('2026-01-01T00:00:07.000Z');
    expect(worker.getHealth().safeError).toBe('SSH connection timeout');

    handlers.onStateChange('FAILED', { safeError: 'SSH session closed' });
    expect(worker.getHealth().state).toBe('FAILED');
    expect(worker.getHealth().safeError).toBe('SSH session closed');
  });
});

describe('worker signal handling', () => {
  it('SIGTERM fecha a sessão graciosamente e sinaliza saída 0', async () => {
    const { worker, session } = buildWorker();
    await worker.start();

    const source = new EventEmitter();
    const exits: number[] = [];
    installWorkerSignalHandlers(worker, {
      source: source as unknown as WorkerSignalSource,
      onExit: (code) => exits.push(code),
    });

    source.emit('SIGTERM');
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(session.closed).toBe(true);
    expect(worker.getHealth().state).toBe('DISCONNECTED');
  });

  it('SIGINT também encerra e é idempotente', async () => {
    const { worker, session } = buildWorker();
    await worker.start();

    const source = new EventEmitter();
    const exits: number[] = [];
    installWorkerSignalHandlers(worker, {
      source: source as unknown as WorkerSignalSource,
      onExit: (code) => exits.push(code),
    });

    source.emit('SIGINT');
    source.emit('SIGINT');
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(session.closed).toBe(true);
  });
});

describe('createMitigationWorkerFromEnv', () => {
  it('aceita AUTO (o motor roda no processo da API) sem abrir escrita neste processo', () => {
    const worker = createMitigationWorkerFromEnv({
      MITIGATION_MODE: 'AUTO',
      MITIGATION_SSH_HOST: '10.0.0.1',
      MITIGATION_SSH_USERNAME: 'u',
      MITIGATION_SSH_PASSWORD: 'p',
    });
    expect(worker.getHealth().state).toBe('DISCONNECTED');
    // O worker standalone continua apenas LEITURA: nenhuma sessão é aberta aqui.
    expect(worker.isRunning()).toBe(false);
  });

  it('modo desconhecido cai em SIMULATION_ONLY (fail-closed) e nao impede o start', () => {
    const worker = createMitigationWorkerFromEnv({
      MITIGATION_MODE: 'QUALQUER',
      MITIGATION_SSH_HOST: '10.0.0.1',
      MITIGATION_SSH_USERNAME: 'u',
      MITIGATION_SSH_PASSWORD: 'p',
    });
    expect(worker.getHealth().state).toBe('DISCONNECTED');
  });

  it('exige host/usuário/senha', () => {
    expect(() => createMitigationWorkerFromEnv({})).toThrow(/MITIGATION_SSH_HOST/);
    expect(() => createMitigationWorkerFromEnv({ MITIGATION_SSH_HOST: '10.0.0.1' })).toThrow(
      /MITIGATION_SSH_USERNAME/,
    );
  });

  it('monta o worker em SIMULATION_ONLY sem conectar', () => {
    const worker = createMitigationWorkerFromEnv({
      MITIGATION_MODE: 'SIMULATION_ONLY',
      MITIGATION_SSH_HOST: '10.0.0.1',
      MITIGATION_SSH_USERNAME: 'netvision',
      MITIGATION_SSH_PASSWORD: 'secret',
      MITIGATION_SSH_PORT: '22',
    });

    expect(worker.getHealth().state).toBe('DISCONNECTED');
    expect(worker.isRunning()).toBe(false);
  });
});
