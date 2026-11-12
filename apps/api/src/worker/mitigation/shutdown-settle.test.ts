import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { settleBeforeClose, shutdownSettleCapMs } from './shutdown-settle';

const log = { warn: () => undefined, error: () => undefined };
function engine() {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  let began = false;
  return {
    finish: resolve,
    get began() {
      return began;
    },
    beginShutdown: () => {
      began = true;
    },
    settleExecutions: () => gate,
    inFlightProfiles: () => ['AGLINK'],
  };
}

describe('encerramento ordenado do motor AUTO', () => {
  it('espera o ACTIVATE em andamento (sem abandonar) e so retorna quando termina', async () => {
    const e = engine();
    let done = false;
    const p = settleBeforeClose(e, log, 5_000).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(e.began).toBe(true);
    expect(done).toBe(false);
    e.finish();
    await expect(p).resolves.toMatchObject({ timedOut: false });
  });

  it('teto: operacao travada nao prende o encerramento para sempre (sem deadlock) e o timeout e registrado', async () => {
    const e = engine();
    const errors: string[] = [];
    const r = await settleBeforeClose(e, { warn: () => undefined, error: (_o, m) => errors.push(m) }, 40);
    expect(r.timedOut).toBe(true);
    expect(errors.join()).toContain('SHUTDOWN_SETTLE_TIMEOUT');
  });

  it('falha do settle nunca lanca', async () => {
    const e = engine();
    e.settleExecutions = () => Promise.reject(new Error('x'));
    await expect(settleBeforeClose(e, log, 1_000)).resolves.toMatchObject({ timedOut: false });
  });

  it('teto configuravel por ambiente; invalido volta ao padrao de 270 s', () => {
    expect(shutdownSettleCapMs({ MITIGATION_SHUTDOWN_SETTLE_MS: '120000' } as never)).toBe(120_000);
    expect(shutdownSettleCapMs({ MITIGATION_SHUTDOWN_SETTLE_MS: 'abc' } as never)).toBe(270_000);
    expect(shutdownSettleCapMs({} as never)).toBe(270_000);
  });

  it('ORDEM REAL do Fastify: o hook onClose registrado POR ULTIMO roda ANTES do que desconecta o banco', async () => {
    const app = Fastify();
    const order: string[] = [];
    const e = engine();
    // espelha routes.ts: hook de liberar/desconectar registrado antes, o de settle por ultimo
    app.addHook('onClose', async () => {
      order.push('disconnect-db');
    });
    app.addHook('onClose', async () => {
      order.push('settle-start');
      const wait = settleBeforeClose(e, log, 5_000);
      setTimeout(() => e.finish(), 30);
      await wait;
      order.push('settle-end');
    });
    await app.ready();
    await app.close();
    expect(order).toEqual(['settle-start', 'settle-end', 'disconnect-db']);
  });
});

describe('encerramento HTTP real: preClose antes do server.close, drenagem sem esperar o keep-alive', () => {
  it('requisicao em voo em conexao keep-alive termina; preClose roda antes de settle/disconnect; close leva segundos (nao 72 s)', async () => {
    const http = await import('node:http');
    const { registerHttpDrain } = await import('../../graceful-shutdown');
    const app = Fastify();
    const order: string[] = [];
    const e = engine();
    const drain = registerHttpDrain(app as never);
    app.get('/slow', async () => {
      await new Promise((r) => setTimeout(r, 800));
      return { ok: true };
    });
    app.get('/fast', async () => ({ ok: true }));
    app.addHook('onClose', async () => {
      order.push('disconnect-db');
    });
    app.addHook('preClose', async () => {
      order.push('preClose');
      e.beginShutdown();
      drain.begin();
    });
    app.addHook('onClose', async () => {
      order.push('settle-start');
      const wait = settleBeforeClose(e, log, 5_000);
      setTimeout(() => e.finish(), 30);
      await wait;
      order.push('settle-end');
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (p: string) =>
      new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: p, agent }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          })
          .on('error', reject);
      });
    expect(await get('/fast')).toBe(200); // deixa uma conexao keep-alive aberta
    const inFlight = get('/slow'); // requisicao em voo na MESMA conexao keep-alive
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await app.close();
    expect(await inFlight).toBe(200); // a requisicao em voo nao foi abandonada
    expect(Date.now() - t0).toBeLessThan(6_000); // sem esperar o keepAliveTimeout de 72 s
    expect(order).toEqual(['preClose', 'settle-start', 'settle-end', 'disconnect-db']);
    agent.destroy();
  }, 20_000);
});

describe('piloto: o ACTIVATE roda DENTRO do tick (nao entra em pendingExecutions)', () => {
  it('settleBeforeClose tambem espera o tick em andamento do runtime (waitTickIdle)', async () => {
    let release!: () => void;
    const tick = new Promise<void>((r) => (release = r));
    const e = { ...engine(), settleExecutions: () => Promise.resolve(), waitTickIdle: () => tick };
    let done = false;
    const p = settleBeforeClose(e, log, 5_000).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(done).toBe(false); // so o tick do piloto segura: nao pode retornar
    release();
    await expect(p).resolves.toMatchObject({ timedOut: false });
  });

  it('MitigationAutoRuntime.waitIdle aguarda o tick real em andamento e nunca lanca', async () => {
    const { MitigationAutoRuntime } = await import('./mitigation-auto-runtime');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runtime = new MitigationAutoRuntime({
      engine: { tick: async () => (await gate, []) },
      intervalMs: 1000,
    } as never);
    const tick = runtime.tickOnce();
    runtime.stop();
    let idle = false;
    const w = runtime.waitIdle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 25));
    expect(idle).toBe(false);
    release();
    await tick;
    await w;
    expect(idle).toBe(true);
    await expect(runtime.waitIdle()).resolves.toBeUndefined(); // sem tick: retorna na hora
  });
});
