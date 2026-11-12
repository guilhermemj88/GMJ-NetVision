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
